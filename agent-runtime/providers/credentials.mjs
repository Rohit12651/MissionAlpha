// Multi-Provider Credentials — the encrypted multi-account credential store.
//
// The user may add ANY NUMBER of accounts of ANY type, each with its own token. Two
// files under `dir` (TOKEN_DIR in prod, OUTSIDE the repo):
//   • accounts.json (0600) — METADATA ONLY: { accounts: Account[], activeAccountId }.
//       A plaintext secret is NEVER written here.
//   • credentials.enc (0600) — per-account api_key secrets, keyed by account.id, each
//       sealed via crypto.mjs (AES-256-GCM).
//
// Account = { id, providerType, label, identifier?, authMethod, baseUrl?, model?,
//             hasSecret, capability, createdAt }. `model` is an optional OpenAI-
//             compatible chat model id (custom/openai only; metadata, not a secret).
//             capability is NOT stored and NOT derived from the provider type. It is
//             computed on every read by resolveCapability() from a real tool-capability
//             PROBE of this account's CURRENT model, and falls back to chat_only when
//             nothing has been measured. (This comment used to say "derived from the
//             provider type (claude → swarm, everything else → chat_only)" — that was the
//             deleted table, and leaving the sentence here would have made a
//             security-relevant read path describe a rule the code no longer follows.)
//             `toolProbe` holds the cached verdict; see providers/capability-probe.mjs.
//
// snapshot() returns accounts WITHOUT secrets. getActiveSecret() decrypts the active
// account's api_key on demand (subscription/none → null). Every mutation validates the
// provider type against the preset catalog and the account id against what exists.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";

import { providerTypePreset } from "./registry.mjs";
import { resolveCapability } from "./capability-probe.mjs";
import { sealSecret, openSecret, ensureKey } from "./crypto.mjs";

const ACCOUNTS_FILE = (dir) => join(dir, "accounts.json");
const ENC_FILE = (dir) => join(dir, "credentials.enc");
const DEFAULT_STATE = () => ({ accounts: [], activeAccountId: null, chatAccountId: null });

const LABEL_MAX = 80;
const IDENTIFIER_MAX = 256;
const MODEL_MAX = 128;
// Types for which a chat `model` id is meaningful (OpenAI-compatible chat path).
const MODEL_TYPES = new Set(["custom", "openai"]);
const FILE_MODE = 0o600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Atomic 0600 write: write a sibling temp then rename over the target (no partial-file
// window), then chmod defensively to re-tighten a pre-existing looser file. mode:0600 on
// writeFileSync only applies when CREATING — rename+chmod make 0600 hold on every write.
function writeSecure(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode: FILE_MODE });
  renameSync(tmp, path);
  chmodSync(path, FILE_MODE);
}

// If a credential file already exists, re-tighten it to 0600 on load (best-effort).
function tightenIfExists(f) {
  if (existsSync(f)) {
    try { chmodSync(f, FILE_MODE); } catch { /* best-effort */ }
  }
}

function loadMeta(dir) {
  const f = ACCOUNTS_FILE(dir);
  if (!existsSync(f)) return DEFAULT_STATE();
  tightenIfExists(f);
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8"));
    return {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      activeAccountId: typeof parsed.activeAccountId === "string" ? parsed.activeAccountId : null,
      // Which account answers CHAT. Separate from activeAccountId on purpose: the engine
      // and the chat seat are different jobs and one key can be right for one, wrong for
      // the other. `null` means the operator has not chosen — chat-route.mjs then ASKS.
      chatAccountId: typeof parsed.chatAccountId === "string" ? parsed.chatAccountId : null,
    };
  } catch {
    return DEFAULT_STATE();
  }
}

function loadEnc(dir) {
  const f = ENC_FILE(dir);
  if (!existsSync(f)) return {};
  tightenIfExists(f);
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Validate + normalize an addAccount input into a persistable Account (no secret).
function validateInput(input = {}) {
  const { providerType, label, authMethod, baseUrl, identifier, model } = input;
  const preset = providerTypePreset(providerType);
  if (!preset) throw new Error(`unknown provider type: ${providerType}`);

  if (typeof label !== "string" || label.trim().length === 0 || label.length > LABEL_MAX) {
    throw new Error(`label is required (1-${LABEL_MAX} chars)`);
  }
  if (!preset.authMethods.includes(authMethod)) {
    throw new Error(`provider ${providerType} does not support authMethod '${authMethod}'`);
  }

  const account = {
    id: randomUUID(),
    providerType,
    label,
    authMethod,
    hasSecret: false,
    createdAt: Date.now(),
  };
  if (identifier != null) {
    const id = String(identifier);
    if (id.length > IDENTIFIER_MAX) throw new Error(`identifier is too long (max ${IDENTIFIER_MAX} chars)`);
    account.identifier = id;
  }

  if (preset.needsBaseUrl) {
    if (typeof baseUrl !== "string" || !/^https?:\/\//i.test(baseUrl)) {
      throw new Error(`provider type '${providerType}' requires an http(s) baseUrl`);
    }
    account.baseUrl = baseUrl;
  }

  // Optional chat model id — metadata (never a secret). Persisted ONLY for the
  // OpenAI-compatible chat types; bounded; blank/whitespace is dropped; ignored for
  // every other type (e.g. claude) so it can't linger where the adapter never reads it.
  if (model != null && MODEL_TYPES.has(providerType)) {
    const m = String(model);
    if (m.length > MODEL_MAX) throw new Error(`model is too long (max ${MODEL_MAX} chars)`);
    if (m.trim().length > 0) account.model = m;
  }
  return { account, preset };
}

// PHASE 1 — capability is DERIVED on the way out, never trusted from storage.
//
// It used to be stamped onto the record at creation from a hardcoded per-type table, so any
// value still sitting in an older persisted account is stale by construction. It is
// overwritten here rather than read. resolveCapability() answers for THIS account and THIS
// model, from a real probe, and fails closed when nothing has been measured.
function publicAccount(a) {
  return { ...a, capability: resolveCapability(a) };
}

export function createStore(dir) {
  ensureKey(dir);
  let meta = loadMeta(dir);
  let enc = loadEnc(dir); // accountId → sealed {iv,tag,ct}

  const persistMeta = () => writeSecure(ACCOUNTS_FILE(dir), JSON.stringify(meta, null, 2));
  const persistEnc = () => writeSecure(ENC_FILE(dir), JSON.stringify(enc));

  const findAccount = (id) => meta.accounts.find((a) => a.id === id) || null;
  const requireAccount = (id) => {
    const a = findAccount(id);
    if (!a) throw new Error(`unknown account id: ${id}`);
    return a;
  };

  return {
    // Metadata-only view — safe to serialize to any HTTP response.
    /** Which account the operator picked for CHAT, or null (→ the caller asks). */
    getChatAccountId() {
      return meta.chatAccountId ?? null;
    },

    /**
     * Record the operator's chat choice. `null` CLEARS it, which puts the app back into
     * "ask" — a deliberate way to change your mind, not an error state.
     * Throws on an unknown id: silently accepting one would recreate the exact bug this
     * feature fixes (chat answering from a model nobody selected).
     */
    setChatAccountId(id) {
      if (id === null || id === undefined) {
        meta.chatAccountId = null;
        persistMeta();
        return { chatAccountId: null };
      }
      const wanted = String(id);
      if (!meta.accounts.some((a) => a.id === wanted)) throw new Error(`unknown account: ${wanted}`);
      meta.chatAccountId = wanted;
      persistMeta();
      return { chatAccountId: wanted };
    },

    snapshot() {
      return { accounts: meta.accounts.map(publicAccount), activeAccountId: meta.activeAccountId, chatAccountId: meta.chatAccountId ?? null };
    },

    // Add an account. api_key seals the secret into the enc sidecar under the new
    // account.id; subscription stores no secret. The first account auto-activates so
    // the engine is usable without a separate setActive call.
    addAccount(input) {
      const { account } = validateInput(input);
      if (account.authMethod === "api_key") {
        const secret = input.secret;
        if (typeof secret !== "string" || secret.length === 0) throw new Error("api_key mode requires a non-empty secret");
        enc[account.id] = sealSecret(dir, secret);
        account.hasSecret = true;
        persistEnc();
      }
      meta.accounts.push(account);
      if (meta.activeAccountId === null) meta.activeAccountId = account.id;
      persistMeta();
      return publicAccount(account);
    },

    // Edit an existing account (Phase 1, excellence program).
    //
    // Metadata-only by default. `secret`, when present and non-empty, re-seals a NEW
    // secret over the old one; omitting it leaves the sealed secret untouched — that is
    // the whole point of this method. Before it existed, the runtime told users to "edit
    // the account and add a model id" while the UI offered only delete + re-add, which
    // destroyed the sealed secret.
    //
    // providerType is deliberately IMMUTABLE: the capability tier (swarm vs chat_only)
    // and the secret's meaning were both derived from it at add time, so changing it in
    // place would silently invalidate both. Callers must delete + re-add instead.
    // ATOMICITY (fixed after adversarial review): this method VALIDATES THE ENTIRE PATCH
    // FIRST and only then applies it. The first version mutated the live account object
    // field-by-field as it went, so `updateAccount(id, {label:"X", model:123})` threw on
    // model — but the label was already changed in memory, and the next unrelated
    // persistMeta() (e.g. from setActive) wrote that half-applied patch to disk. Proven
    // with a PoC. Validate-then-apply is the only ordering that makes a throw a no-op.
    //
    // It also enforces the SAME rules as addAccount/validateInput — LABEL_MAX, MODEL_MAX,
    // MODEL_TYPES, preset.needsBaseUrl — because an edit path that is more permissive than
    // the create path is just a slower way to reach an invalid account.
    updateAccount(id, patch = {}) {
      const account = requireAccount(id);
      const preset = providerTypePreset(account.providerType);

      if ("providerType" in patch && patch.providerType !== account.providerType) {
        throw new Error("providerType cannot be changed; delete and re-add the account");
      }

      // ── validate everything into `next`; touch nothing live until it all passes ──
      const next = {};

      if ("label" in patch && patch.label !== undefined) {
        if (typeof patch.label !== "string" || patch.label.trim().length === 0 || patch.label.length > LABEL_MAX) {
          throw new Error(`label is required (1-${LABEL_MAX} chars)`);
        }
        next.label = patch.label.trim();
      }

      if ("model" in patch) {
        if (!MODEL_TYPES.has(account.providerType)) {
          throw new Error(`provider type '${account.providerType}' does not take a model id`);
        }
        if (patch.model !== null && typeof patch.model !== "string") {
          throw new Error("model must be a string or null");
        }
        if (typeof patch.model === "string" && patch.model.length > MODEL_MAX) {
          throw new Error(`model is too long (max ${MODEL_MAX} chars)`);
        }
        next.model = typeof patch.model === "string" && patch.model.trim().length > 0 ? patch.model : null;
      }

      if ("baseUrl" in patch && patch.baseUrl !== undefined) {
        if (!preset?.needsBaseUrl) {
          throw new Error(`provider type '${account.providerType}' does not take a baseUrl`);
        }
        if (typeof patch.baseUrl !== "string" || !/^https?:\/\//i.test(patch.baseUrl)) {
          throw new Error(`provider type '${account.providerType}' requires an http(s) baseUrl`);
        }
        next.baseUrl = patch.baseUrl;
      }

      const replacingSecret = "secret" in patch && patch.secret !== undefined && patch.secret !== "";
      if (replacingSecret) {
        if (typeof patch.secret !== "string") throw new Error("secret must be a string");
        if (account.authMethod !== "api_key") throw new Error(`account ${id} is not api_key mode`);
      }

      // ── all validation passed; APPLY ──
      if ("label" in next) account.label = next.label;
      if ("model" in next) {
        if (next.model === null) delete account.model;
        else account.model = next.model;
      }
      if ("baseUrl" in next) account.baseUrl = next.baseUrl;

      if (replacingSecret) {
        enc[id] = sealSecret(dir, patch.secret);
        account.hasSecret = true;
        persistEnc();
      }

      persistMeta();
      return publicAccount(account);
    },

    // Remove an account and its sealed secret. If it was active, active clears to null.
    removeAccount(id) {
      requireAccount(id);
      meta.accounts = meta.accounts.filter((a) => a.id !== id);
      if (enc[id]) { delete enc[id]; persistEnc(); }
      if (meta.activeAccountId === id) meta.activeAccountId = null;
      // Same for the chat pick — a dangling id would send chat back to "ask" anyway, but
      // clearing it here keeps the stored state honest rather than merely recoverable.
      if (meta.chatAccountId === id) meta.chatAccountId = null;
      persistMeta();
    },

    // Re-seal a new secret for an existing api_key account.
    replaceSecret(id, secret) {
      const a = requireAccount(id);
      if (a.authMethod !== "api_key") throw new Error(`account ${id} is not api_key mode`);
      if (typeof secret !== "string" || secret.length === 0) throw new Error("replaceSecret requires a non-empty secret");
      enc[id] = sealSecret(dir, secret);
      a.hasSecret = true;
      persistEnc();
      persistMeta();
      return publicAccount(a);
    },

    /**
     * PHASE 1 — record a tool-capability PROBE result against an account.
     *
     * Stored rather than recomputed because a probe is a real billed request. It is keyed
     * to the model it measured, so `resolveCapability` ignores it the moment the operator
     * changes the model — a measurement of a different thing is not evidence about this one.
     */
    setToolProbe(id, probe) {
      const a = requireAccount(id);
      if (!probe || typeof probe !== "object") throw new Error("probe result is required");
      const capability = probe.capability === "swarm" ? "swarm" : "chat_only";
      a.toolProbe = {
        capability,
        capable: capability === "swarm",
        reason: typeof probe.reason === "string" ? probe.reason.slice(0, 500) : null,
        model: a.model ?? null,
        // P1-D — did this endpoint report a per-call `usage.cost`? That, and only that, is
        // what the maxUsd ceiling is enforced from. Anything that is not a real boolean is
        // NOT a measurement and stays null: a coerced value here would tell the operator
        // their spend is capped when nothing ever measured it.
        reportsCost: typeof probe.reportsCost === "boolean" ? probe.reportsCost : null,
        probedAt: Number.isFinite(probe.probedAt) ? probe.probedAt : Date.now(),
      };
      persistMeta();
      return publicAccount(a);
    },

    setActive(id) {
      requireAccount(id);
      meta.activeAccountId = id;
      persistMeta();
    },

    // The active Account (metadata incl. capability), or null.
    getActive() {
      if (!meta.activeAccountId) return null;
      const active = findAccount(meta.activeAccountId);
      return active ? publicAccount(active) : null;
    },

    // Decrypted secret for the ACTIVE account IF it is api_key mode; else null.
    getActiveSecret() {
      return meta.activeAccountId ? this.getSecretFor(meta.activeAccountId) : null;
    },

    getSecretFor(id) {
      const a = findAccount(id);
      if (!a || a.authMethod !== "api_key" || !enc[id]) return null;
      return openSecret(dir, enc[id]);
    },

    // Exposed for route-layer id-shape validation before touching the store.
    isUuid: (id) => typeof id === "string" && UUID_RE.test(id),
  };
}

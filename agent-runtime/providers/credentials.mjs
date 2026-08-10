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
//             capability is DERIVED from the provider type
//             (claude → swarm, everything else → chat_only).
//
// snapshot() returns accounts WITHOUT secrets. getActiveSecret() decrypts the active
// account's api_key on demand (subscription/none → null). Every mutation validates the
// provider type against the preset catalog and the account id against what exists.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";

import { providerTypePreset } from "./registry.mjs";
import { sealSecret, openSecret, ensureKey } from "./crypto.mjs";

const ACCOUNTS_FILE = (dir) => join(dir, "accounts.json");
const ENC_FILE = (dir) => join(dir, "credentials.enc");
const DEFAULT_STATE = () => ({ accounts: [], activeAccountId: null });

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
    capability: preset.capability,
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
    snapshot() {
      return { accounts: meta.accounts.map((a) => ({ ...a })), activeAccountId: meta.activeAccountId };
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
      return { ...account };
    },

    // Remove an account and its sealed secret. If it was active, active clears to null.
    removeAccount(id) {
      requireAccount(id);
      meta.accounts = meta.accounts.filter((a) => a.id !== id);
      if (enc[id]) { delete enc[id]; persistEnc(); }
      if (meta.activeAccountId === id) meta.activeAccountId = null;
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
      return { ...a };
    },

    setActive(id) {
      requireAccount(id);
      meta.activeAccountId = id;
      persistMeta();
    },

    // The active Account (metadata incl. capability), or null.
    getActive() {
      return meta.activeAccountId ? (findAccount(meta.activeAccountId) ? { ...findAccount(meta.activeAccountId) } : null) : null;
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

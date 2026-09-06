// Multi-Provider Credentials (multi-account) — registry presets + crypto + store.
// Unit-level, no HTTP. Proves: PROVIDER_TYPES preset catalog + capability derivation;
// AES-256-GCM seal/open round-trip + tamper rejection; the multi-account store adds
// unlimited accounts (incl. 2 of one type + a custom w/ baseUrl), seals secrets per
// account.id (never plaintext in accounts.json/snapshot), removeAccount clears the
// sealed secret, setActive drives getActive/getActiveSecret, 0600 file modes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROVIDER_TYPES, providerTypePreset } from "../providers/registry.mjs";
import { resolveCapability } from "../providers/capability-probe.mjs";
import { sealSecret, openSecret, ensureKey } from "../providers/crypto.mjs";
import { createStore } from "../providers/credentials.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── registry presets ─────────────────────────────────────────────────────────
test("PROVIDER_TYPES is a picker catalog covering the 6 types", () => {
  const types = PROVIDER_TYPES.map((p) => p.type);
  // Phase 13 added `jira`. It is the first entry that is not a MODEL provider — the catalog is
  // what the Accounts page renders and what seals a per-account secret, and a ticket tracker
  // needs both. The list is pinned so a type cannot appear without this assertion moving.
  assert.deepEqual(types, ["claude", "openai", "minimax", "zai", "custom", "jira"]);
});

test("the jira preset needs a base URL, takes an api key, and is NOT probe-capable", () => {
  const jira = providerTypePreset("jira");
  assert.deepEqual(jira.authMethods, ["api_key"]);
  assert.equal(jira.needsBaseUrl, true, "a Jira account without a site is unusable");
  // The capability probe asks a MODEL to call a tool. That question cannot be put to a ticket
  // tracker, and Principle 0 forbids asserting the answer instead of measuring it.
  assert.equal(jira.probeCapable, false);
});

test("claude preset → subscription|api_key; custom needsBaseUrl", () => {
  const claude = providerTypePreset("claude");
  assert.deepEqual(claude.authMethods, ["subscription", "api_key"]);
  assert.equal(providerTypePreset("custom").needsBaseUrl, true);
  assert.equal(providerTypePreset("openai").needsBaseUrl, false);
});

// PHASE 1 — THIS TEST USED TO CERTIFY THE DEFECT, so it was corrected rather than kept.
//
// It previously asserted `capabilityForType("openai") === "chat_only"` and the same for
// minimax/zai/custom — pinning five hardcoded literals that never asked a model anything
// and that refused GPT/Nemotron/MiniMax/Z.ai from autonomous work all of them can do. The
// label described OUR ADAPTER and got written onto the PROVIDER. Fixing the implementation
// while leaving this test would have been impossible: the test WAS the specification of the
// bug. Second instance in this project of "fix the test, not the implementation" (the first
// was spendCell); recorded because that exception has to stay rare and visible.
test("capability is NOT derivable from a provider type — the table is gone", () => {
  for (const p of PROVIDER_TYPES) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(p, "capability"),
      false,
      `${p.type} still carries a hardcoded capability; Principle 0 says it must be probed`,
    );
  }
});

test("capability comes from a PROBE of the specific account and model", () => {
  // A probed custom provider runs the engine — the exact case the old table forbade.
  assert.equal(
    resolveCapability({ providerType: "custom", model: "nemotron", toolProbe: { capability: "swarm", model: "nemotron" } }),
    "swarm",
  );
  // Unprobed fails closed, whatever the brand.
  for (const t of ["openai", "minimax", "zai", "custom"]) {
    assert.equal(resolveCapability({ providerType: t, model: "m" }), "chat_only");
  }
});

test("unknown provider type → null (no throw, prototype-key safe)", () => {
  assert.equal(providerTypePreset("nope"), null);
  assert.equal(providerTypePreset("toString"), null);
});

// ── crypto (unchanged AES-256-GCM) ───────────────────────────────────────────
test("seal→open round-trips; ciphertext ≠ plaintext", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-key-"));
  ensureKey(dir);
  const sealed = sealSecret(dir, "sk-ant-secret-123");
  assert.notEqual(sealed.ct, "sk-ant-secret-123");
  assert.equal(openSecret(dir, sealed), "sk-ant-secret-123");
});

test("tampered ciphertext throws (GCM auth)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-key-"));
  ensureKey(dir);
  const sealed = sealSecret(dir, "x");
  sealed.ct = sealed.ct.slice(0, -2) + "00";
  assert.throws(() => openSecret(dir, sealed));
});

test("key file is created 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-key-"));
  ensureKey(dir);
  assert.equal(statSync(join(dir, "cred.key")).mode & 0o777, 0o600);
});

// ── multi-account store ──────────────────────────────────────────────────────
test("fresh store: empty accounts, no active", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  const snap = s.snapshot();
  assert.deepEqual(snap.accounts, []);
  assert.equal(snap.activeAccountId, null);
  assert.equal(s.getActive(), null);
  assert.equal(s.getActiveSecret(), null);
});

test("addAccount returns a full Account with uuid id + derived capability", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  const a = s.addAccount({ providerType: "claude", label: "work-claude", authMethod: "subscription", identifier: "me@x.co" });
  assert.match(a.id, UUID_RE);
  assert.equal(a.providerType, "claude");
  assert.equal(a.label, "work-claude");
  assert.equal(a.authMethod, "subscription");
  assert.equal(a.identifier, "me@x.co");
  assert.equal(a.capability, "swarm");
  assert.equal(a.hasSecret, false);
  assert.equal(typeof a.createdAt, "number");
  // first account auto-activates so the engine is usable without a second call
  assert.equal(s.snapshot().activeAccountId, a.id);
});

test("unlimited accounts incl. TWO of the same type (distinct labels) + a custom w/ baseUrl", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  const a1 = s.addAccount({ providerType: "claude", label: "personal", authMethod: "api_key", secret: "sk-ant-1" });
  const a2 = s.addAccount({ providerType: "claude", label: "work", authMethod: "api_key", secret: "sk-ant-2" });
  const a3 = s.addAccount({ providerType: "custom", label: "local-llm", authMethod: "api_key", secret: "sk-c", baseUrl: "https://llm.internal/v1" });
  const ids = new Set([a1.id, a2.id, a3.id]);
  assert.equal(ids.size, 3, "each account gets a distinct id");
  const snap = s.snapshot();
  assert.equal(snap.accounts.length, 3);
  assert.equal(a3.baseUrl, "https://llm.internal/v1");
  assert.equal(a3.capability, "chat_only");
  // secrets decrypt per account.id
  assert.equal(s.getSecretFor(a1.id), "sk-ant-1");
  assert.equal(s.getSecretFor(a2.id), "sk-ant-2");
  assert.equal(s.getSecretFor(a3.id), "sk-c");
});

test("secret sealed to credentials.enc, NEVER plaintext in accounts.json or snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  const a = s.addAccount({ providerType: "claude", label: "k", authMethod: "api_key", secret: "sk-ant-SEAL" });
  const rawJson = readFileSync(join(dir, "accounts.json"), "utf8");
  assert.ok(!rawJson.includes("sk-ant-SEAL"), "plaintext must never be in accounts.json");
  assert.ok(!JSON.stringify(s.snapshot()).includes("sk-ant-SEAL"), "snapshot must not carry the secret");
  const rawEnc = readFileSync(join(dir, "credentials.enc"), "utf8");
  assert.ok(!rawEnc.includes("sk-ant-SEAL"), "enc holds ciphertext, not plaintext");
  assert.equal(a.hasSecret, true);
});

test("removeAccount clears the account AND its sealed secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  const a = s.addAccount({ providerType: "openai", label: "gpt", authMethod: "api_key", secret: "sk-oai" });
  assert.equal(s.getSecretFor(a.id), "sk-oai");
  s.removeAccount(a.id);
  assert.equal(s.snapshot().accounts.length, 0);
  assert.equal(s.getSecretFor(a.id), null, "sealed secret is gone");
  // removing the active account clears active
  assert.equal(s.snapshot().activeAccountId, null);
});

test("setActive drives getActive + getActiveSecret; chat_only capability surfaces", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  const claude = s.addAccount({ providerType: "claude", label: "c", authMethod: "api_key", secret: "sk-ant-A" });
  const zai = s.addAccount({ providerType: "zai", label: "z", authMethod: "api_key", secret: "sk-zai" });
  s.setActive(zai.id);
  assert.equal(s.getActive().id, zai.id);
  assert.equal(s.getActive().capability, "chat_only");
  assert.equal(s.getActiveSecret(), "sk-zai");
  s.setActive(claude.id);
  assert.equal(s.getActive().capability, "swarm");
  assert.equal(s.getActiveSecret(), "sk-ant-A");
});

test("subscription active → getActiveSecret null (no key in play)", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  s.addAccount({ providerType: "claude", label: "sub", authMethod: "subscription" });
  assert.equal(s.getActiveSecret(), null);
});

test("replaceSecret swaps the sealed secret; old plaintext never persisted", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  const a = s.addAccount({ providerType: "claude", label: "k", authMethod: "api_key", secret: "sk-old" });
  s.replaceSecret(a.id, "sk-new");
  assert.equal(s.getSecretFor(a.id), "sk-new");
  const rawJson = readFileSync(join(dir, "accounts.json"), "utf8");
  assert.ok(!rawJson.includes("sk-old") && !rawJson.includes("sk-new"));
  const rawEnc = readFileSync(join(dir, "credentials.enc"), "utf8");
  assert.ok(!rawEnc.includes("sk-old") && !rawEnc.includes("sk-new"));
});

// ── validation ───────────────────────────────────────────────────────────────
test("addAccount validation: unknown type, bad label, missing baseUrl, empty api_key", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  assert.throws(() => s.addAccount({ providerType: "bogus", label: "x", authMethod: "api_key", secret: "s" }), /provider type/i);
  assert.throws(() => s.addAccount({ providerType: "claude", label: "", authMethod: "subscription" }), /label/i);
  assert.throws(() => s.addAccount({ providerType: "claude", label: "x".repeat(81), authMethod: "subscription" }), /label/i);
  assert.throws(() => s.addAccount({ providerType: "custom", label: "c", authMethod: "api_key", secret: "s" }), /baseUrl/i);
  assert.throws(() => s.addAccount({ providerType: "custom", label: "c", authMethod: "api_key", secret: "s", baseUrl: "ftp://x" }), /baseUrl/i);
  assert.throws(() => s.addAccount({ providerType: "claude", label: "k", authMethod: "api_key", secret: "" }), /secret/i);
  assert.throws(() => s.addAccount({ providerType: "openai", label: "o", authMethod: "subscription" }), /authMethod/i);
});

// ── optional model field (custom/openai only) ────────────────────────────────
test("addAccount: model persisted for custom + openai, bounded to 128 chars", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  const c = s.addAccount({ providerType: "custom", label: "c", authMethod: "api_key", secret: "s", baseUrl: "https://llm.internal/v1", model: "nvidia/model:free" });
  assert.equal(c.model, "nvidia/model:free");
  const o = s.addAccount({ providerType: "openai", label: "o", authMethod: "api_key", secret: "s", model: "gpt-x" });
  assert.equal(o.model, "gpt-x");
  // survives reload from disk
  const s2 = createStore(dir);
  assert.equal(s2.snapshot().accounts.find((a) => a.id === c.id).model, "nvidia/model:free");
  // over-128 → throws
  assert.throws(
    () => s.addAccount({ providerType: "custom", label: "big", authMethod: "api_key", secret: "s", baseUrl: "https://x/v1", model: "m".repeat(129) }),
    /model/i,
  );
  // exactly 128 accepted
  const ok = s.addAccount({ providerType: "custom", label: "edge", authMethod: "api_key", secret: "s", baseUrl: "https://x/v1", model: "m".repeat(128) });
  assert.equal(ok.model.length, 128);
});

test("addAccount: model ignored for non-openai-compatible types (claude) and when blank", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  const claude = s.addAccount({ providerType: "claude", label: "k", authMethod: "api_key", secret: "s", model: "should-be-ignored" });
  assert.equal(claude.model, undefined, "claude accounts do not carry a model");
  const blank = s.addAccount({ providerType: "custom", label: "b", authMethod: "api_key", secret: "s", baseUrl: "https://x/v1", model: "   " });
  assert.equal(blank.model, undefined, "blank/whitespace model is not persisted");
});

test("setActive/removeAccount/replaceSecret reject unknown ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  assert.throws(() => s.setActive("11111111-1111-1111-1111-111111111111"), /account/i);
  assert.throws(() => s.removeAccount("11111111-1111-1111-1111-111111111111"), /account/i);
  assert.throws(() => s.replaceSecret("11111111-1111-1111-1111-111111111111", "s"), /account/i);
});

// ── persistence + file modes ─────────────────────────────────────────────────
test("accounts.json + credentials.enc written 0600; store reloads from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s1 = createStore(dir);
  const a = s1.addAccount({ providerType: "claude", label: "k", authMethod: "api_key", secret: "sk-persist" });
  assert.equal(statSync(join(dir, "accounts.json")).mode & 0o777, 0o600);
  assert.ok(existsSync(join(dir, "credentials.enc")));
  assert.equal(statSync(join(dir, "credentials.enc")).mode & 0o777, 0o600);
  const s2 = createStore(dir);
  assert.equal(s2.snapshot().accounts.length, 1);
  assert.equal(s2.snapshot().activeAccountId, a.id);
  assert.equal(s2.getActiveSecret(), "sk-persist");
});

test("file mode is re-tightened to 0600 after a SECOND write (pre-existing looser file)", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  s.addAccount({ providerType: "claude", label: "one", authMethod: "api_key", secret: "sk-1" });
  const accts = join(dir, "accounts.json");
  const enc = join(dir, "credentials.enc");
  // Loosen both files, then trigger a second write; 0600 must be restored.
  chmodSync(accts, 0o644);
  chmodSync(enc, 0o644);
  s.addAccount({ providerType: "claude", label: "two", authMethod: "api_key", secret: "sk-2" });
  assert.equal(statSync(accts).mode & 0o777, 0o600, "accounts.json re-tightened");
  assert.equal(statSync(enc).mode & 0o777, 0o600, "credentials.enc re-tightened");
});

// ── FIX C — identifier length is bounded like label ──────────────────────────
test("addAccount: identifier over 256 chars → throws; exactly 256 is accepted", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  assert.throws(
    () => s.addAccount({ providerType: "claude", label: "k", authMethod: "api_key", secret: "s", identifier: "x".repeat(257) }),
    /identifier/i,
  );
  const ok = s.addAccount({ providerType: "claude", label: "k2", authMethod: "api_key", secret: "s", identifier: "x".repeat(256) });
  assert.equal(ok.identifier.length, 256);
});

// ── updateAccount (Phase 1, excellence program) ──────────────────────────────
// Closes a live defect: server.mjs streamed "edit the account and add a model id" while
// AccountsPage offered only Set-active / Remove. These pin the edit path's contract:
// metadata edits must NEVER disturb the sealed secret, and providerType is immutable
// because the capability tier and the secret were stored under it.

test("updateAccount sets a model without touching the sealed secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-upd-"));
  const store = createStore(dir);
  const acct = store.addAccount({
    providerType: "custom", label: "openrouter", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "sk-or-v1-original",
  });
  assert.equal(acct.hasSecret, true);

  const updated = store.updateAccount(acct.id, { model: "nvidia/nemotron-nano-9b-v2:free" });

  assert.equal(updated.model, "nvidia/nemotron-nano-9b-v2:free");
  assert.equal(updated.hasSecret, true, "secret must survive a metadata-only edit");
  assert.equal(store.getSecretFor(acct.id), "sk-or-v1-original", "secret VALUE unchanged");
});

test("updateAccount can edit label and baseUrl together", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-upd-"));
  const store = createStore(dir);
  const a = store.addAccount({
    providerType: "custom", label: "old", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "k",
  });
  const u = store.updateAccount(a.id, { label: "new label", baseUrl: "https://api.example.com/v1/chat/completions" });
  assert.equal(u.label, "new label");
  assert.equal(u.baseUrl, "https://api.example.com/v1/chat/completions");
});

test("updateAccount re-seals a replacement secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-upd-"));
  const store = createStore(dir);
  const a = store.addAccount({
    providerType: "custom", label: "or", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "old-key",
  });
  store.updateAccount(a.id, { secret: "new-key" });
  assert.equal(store.getSecretFor(a.id), "new-key");
});

test("updateAccount refuses a providerType change", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-upd-"));
  const store = createStore(dir);
  const a = store.addAccount({ providerType: "claude", label: "c", authMethod: "subscription" });
  assert.throws(() => store.updateAccount(a.id, { providerType: "openai" }), /providerType cannot be changed/);
});

test("updateAccount refuses a secret on a subscription account", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-upd-"));
  const store = createStore(dir);
  const a = store.addAccount({ providerType: "claude", label: "c", authMethod: "subscription" });
  assert.throws(() => store.updateAccount(a.id, { secret: "nope" }), /not api_key mode/);
});

test("updateAccount rejects a non-http baseUrl", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-upd-"));
  const store = createStore(dir);
  const a = store.addAccount({
    providerType: "custom", label: "or", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "k",
  });
  assert.throws(() => store.updateAccount(a.id, { baseUrl: "file:///etc/passwd" }), /baseUrl/);
});

test("updateAccount caps model length and throws on unknown id", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-upd-"));
  const store = createStore(dir);
  const a = store.addAccount({
    providerType: "custom", label: "or", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "k",
  });
  assert.throws(() => store.updateAccount(a.id, { model: "x".repeat(129) }), /model is too long/);
  assert.throws(() => store.updateAccount("not-a-real-id", { model: "m" }), /unknown account id/);
});

test("updateAccount never writes a plaintext secret into accounts.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-upd-"));
  const store = createStore(dir);
  const a = store.addAccount({
    providerType: "custom", label: "or", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "sk-plain-visible",
  });
  store.updateAccount(a.id, { model: "m", secret: "sk-second-plain" });
  const raw = readFileSync(join(dir, "accounts.json"), "utf8");
  assert.ok(!raw.includes("sk-plain-visible"), "SECURITY: first secret leaked to metadata");
  assert.ok(!raw.includes("sk-second-plain"), "SECURITY: replacement secret leaked to metadata");
});

// ── updateAccount ATOMICITY + parity regressions ─────────────────────────────
// Every test below pins a defect found by adversarial review of the first
// implementation. They exist so those exact bugs cannot come back.

test("REGRESSION: a throwing updateAccount leaves NOTHING mutated (atomicity)", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-atomic-"));
  const store = createStore(dir);
  const a = store.addAccount({
    providerType: "custom", label: "GOOD", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "sk-x",
  });
  // label is valid, model is not — the whole patch must be rejected as one unit.
  assert.throws(() => store.updateAccount(a.id, { label: "EVIL-PARTIAL", model: 123 }));
  assert.equal(store.snapshot().accounts[0].label, "GOOD", "label mutated despite a throw");

  // and the half-applied value must not reach disk via a later unrelated persist
  store.setActive(a.id);
  const onDisk = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8"));
  assert.equal(onDisk.accounts[0].label, "GOOD", "partial mutation persisted to disk");
});

test("REGRESSION: model cannot be set on a provider type that has no model", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-model-"));
  const store = createStore(dir);
  const c = store.addAccount({ providerType: "claude", label: "c", authMethod: "subscription" });
  assert.throws(() => store.updateAccount(c.id, { model: "gpt-4" }), /does not take a model id/);
  assert.equal(store.snapshot().accounts[0].model, undefined);
});

test("REGRESSION: baseUrl cannot be attached to a type that does not need one", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-url-"));
  const store = createStore(dir);
  const c = store.addAccount({ providerType: "claude", label: "c", authMethod: "subscription" });
  assert.throws(() => store.updateAccount(c.id, { baseUrl: "https://evil.example.com" }), /does not take a baseUrl/);
});

test("REGRESSION: updateAccount enforces the SAME label limit as addAccount (80)", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-lbl-"));
  const store = createStore(dir);
  const a = store.addAccount({
    providerType: "custom", label: "ok", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "k",
  });
  assert.throws(() => store.updateAccount(a.id, { label: "x".repeat(81) }), /1-80 chars/);
  assert.throws(() => store.updateAccount(a.id, { label: "   " }), /1-80 chars/);
  assert.equal(store.snapshot().accounts[0].label, "ok");
});

test("REGRESSION: a failed secret replacement does not mutate metadata either", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-sec-"));
  const store = createStore(dir);
  const c = store.addAccount({ providerType: "claude", label: "sub", authMethod: "subscription" });
  assert.throws(() => store.updateAccount(c.id, { label: "RENAMED", secret: "nope" }), /not api_key mode/);
  assert.equal(store.snapshot().accounts[0].label, "sub", "label mutated on a rejected secret patch");
});

test("model:null clears the model on a model-capable type", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-clr-"));
  const store = createStore(dir);
  const a = store.addAccount({
    providerType: "custom", label: "or", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "k", model: "m/one",
  });
  assert.equal(store.snapshot().accounts[0].model, "m/one");
  store.updateAccount(a.id, { model: null });
  assert.equal(store.snapshot().accounts[0].model, undefined, "model not cleared");
});

// ── P1-D — the store must PERSIST the cost-reporting measurement ─────────────
// setToolProbe rebuilt the record field-by-field, so anything the probe measured but the
// whitelist did not name was silently dropped. A measurement that does not survive the
// write is not a measurement — the operator would re-probe forever and still see
// "not measured".
test("setToolProbe persists reportsCost, and survives a reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  const a = s.addAccount({ providerType: "custom", label: "nim", authMethod: "api_key", secret: "k", baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions", model: "nemotron" });
  const updated = s.setToolProbe(a.id, { capability: "swarm", reason: "well-formed tool call", reportsCost: false, probedAt: 42 });
  assert.equal(updated.toolProbe.reportsCost, false);

  const reloaded = createStore(dir).snapshot().accounts.find((x) => x.id === a.id);
  assert.equal(reloaded.toolProbe.reportsCost, false, "the measurement must survive a restart");
});

test("an UNMEASURED cost stays null in the store — never coerced to a boolean", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const s = createStore(dir);
  const a = s.addAccount({ providerType: "custom", label: "nim", authMethod: "api_key", secret: "k", baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions", model: "m" });
  const noField = s.setToolProbe(a.id, { capability: "chat_only", reason: "unreachable" });
  assert.equal(noField.toolProbe.reportsCost, null);
  const garbage = s.setToolProbe(a.id, { capability: "chat_only", reason: "unreachable", reportsCost: "yes" });
  assert.equal(garbage.toolProbe.reportsCost, null, "a non-boolean is not a measurement");
});

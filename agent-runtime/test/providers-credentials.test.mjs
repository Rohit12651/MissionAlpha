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

import { PROVIDER_TYPES, providerTypePreset, capabilityForType } from "../providers/registry.mjs";
import { sealSecret, openSecret, ensureKey } from "../providers/crypto.mjs";
import { createStore } from "../providers/credentials.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── registry presets ─────────────────────────────────────────────────────────
test("PROVIDER_TYPES is a picker catalog covering the 5 types", () => {
  const types = PROVIDER_TYPES.map((p) => p.type);
  assert.deepEqual(types, ["claude", "openai", "minimax", "zai", "custom"]);
});

test("claude preset → swarm + subscription|api_key; custom needsBaseUrl", () => {
  const claude = providerTypePreset("claude");
  assert.equal(claude.capability, "swarm");
  assert.deepEqual(claude.authMethods, ["subscription", "api_key"]);
  assert.equal(providerTypePreset("custom").needsBaseUrl, true);
  assert.equal(providerTypePreset("openai").needsBaseUrl, false);
});

test("capabilityForType: claude→swarm, everything else→chat_only", () => {
  assert.equal(capabilityForType("claude"), "swarm");
  for (const t of ["openai", "minimax", "zai", "custom"]) {
    assert.equal(capabilityForType(t), "chat_only");
  }
});

test("unknown provider type → null (no throw, prototype-key safe)", () => {
  assert.equal(providerTypePreset("nope"), null);
  assert.equal(providerTypePreset("toString"), null);
  assert.equal(capabilityForType("nope"), null);
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

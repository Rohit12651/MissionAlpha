// ADR-029 — Auto-apply policy. The HARD-gate module: policy can relax only the
// apply TRIGGER (auto vs operator) for plain-safe src/* text, NEVER widen what the
// broker allows. Tampered/unknown policy MUST fail closed to manual.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPolicy } from "../policy.mjs";

let dir, file;
const TOKEN = "test-runtime-token-deadbeef";
const mk = (over = {}) => createPolicy({ file, token: TOKEN, ...over });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-policy-test-"));
  file = join(dir, "policy.json");
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

test("default level is manual when no policy file exists (no behavior change)", () => {
  const p = mk();
  assert.equal(p.levelFor("senior-web-1"), "manual");
  assert.equal(p.levelFor("anyone"), "manual");
});

// ── isAutoSafe classifier (ADR-029 §3) — deny-by-default ────────────────────
const SAFE = ["src/App.tsx", "src/components/Card.tsx", "src/theme/tokens.css", "src/data/types.ts", "README.md"];
const RISKY = [
  "package.json",            // CONFIG_GUARD
  "src/run.sh",              // exec extension under src
  "src/loader.mjs",          // exec extension under src
  "src/x.cjs",
  "src/plain.js",
  "src/vite.config.tsx",     // *.config.*
  "scripts/deploy.py",       // scripts dir
  ".env",                    // APPLY_DENY
  ".git/config",             // APPLY_DENY
  "../escape.tsx",           // containment
  "docs/notes.md",           // outside SEED scope
];

test("isAutoSafe accepts plain src/* text + README only", () => {
  const p = mk();
  for (const s of SAFE) assert.equal(p.isAutoSafe(s), true, `${s} should be auto-safe`);
});

test("isAutoSafe rejects every exec/config/out-of-scope path (deny-by-default)", () => {
  const p = mk();
  for (const r of RISKY) assert.equal(p.isAutoSafe(r), false, `${r} must NOT be auto-safe`);
});

test("isAutoSafe ⟹ applyAllowed (auto-eligible is a strict subset of broker-allowed)", () => {
  const p = mk();
  // any path the classifier calls safe must also pass the broker gate
  for (const s of SAFE) assert.equal(p.appliesBrokerGate(s), true);
});

// ── decide() (ADR-029 §4) ───────────────────────────────────────────────────
test("auto-safe agent + all-safe diff → autoApply", () => {
  const p = mk();
  p.setLevel("senior-web-1", "auto-safe");
  const d = p.decide("senior-web-1", ["src/App.tsx", "src/x.css"]);
  assert.equal(d.autoApply, true);
});

test("auto-safe agent + ONE risky path → whole diff HELD (all-or-nothing)", () => {
  const p = mk();
  p.setLevel("senior-web-1", "auto-safe");
  const d = p.decide("senior-web-1", ["src/App.tsx", "package.json"]);
  assert.equal(d.autoApply, false);
  assert.match(d.heldReason, /package\.json/);
});

test("manual agent never auto-applies even an all-safe diff", () => {
  const p = mk();
  const d = p.decide("senior-web-1", ["src/App.tsx"]);
  assert.equal(d.autoApply, false);
  assert.match(d.heldReason, /manual/);
});

test("never agent never auto-applies", () => {
  const p = mk();
  p.setLevel("locked", "never");
  assert.equal(p.decide("locked", ["src/App.tsx"]).autoApply, false);
});

test("empty diff is never auto-applied", () => {
  const p = mk();
  p.setLevel("a", "auto-safe");
  assert.equal(p.decide("a", []).autoApply, false);
});

// ── HMAC integrity (ADR-029 §6) ─────────────────────────────────────────────
test("setLevel persists a signed policy that survives reload", () => {
  const p1 = mk();
  p1.setLevel("senior-web-1", "auto-safe");
  assert.ok(existsSync(file));
  const raw = JSON.parse(readFileSync(file, "utf-8"));
  assert.ok(raw.sig, "signature present");
  const p2 = mk(); // fresh load over same file + same token
  assert.equal(p2.levelFor("senior-web-1"), "auto-safe");
});

test("tampered policy content fails closed to manual + flags blocked", () => {
  const p1 = mk();
  p1.setLevel("senior-web-1", "auto-safe");
  // tamper: flip the level without re-signing
  const raw = JSON.parse(readFileSync(file, "utf-8"));
  raw.policy["senior-web-1"] = "auto-safe-WIDENED";
  writeFileSync(file, JSON.stringify(raw));
  const p2 = mk();
  assert.equal(p2.levelFor("senior-web-1"), "manual", "tamper → fail closed to manual");
  assert.equal(p2.signatureOk(), false);
});

test("wrong token (different signer) fails closed to manual", () => {
  const p1 = mk();
  p1.setLevel("senior-web-1", "auto-safe");
  const p2 = createPolicy({ file, token: "a-different-token" });
  assert.equal(p2.levelFor("senior-web-1"), "manual");
});

test("unknown/forged level in a signed file is treated as manual", () => {
  // sign a policy that names a non-existent level — even validly signed, the enum
  // has no such member, so it must collapse to manual (classifier backstops).
  const p1 = mk();
  p1.setLevelRawForTest("ghost", "auto-config"); // signed, but bogus level
  const p2 = mk();
  assert.equal(p2.levelFor("ghost"), "manual");
});

test("setLevel rejects a level outside the enum", () => {
  const p = mk();
  assert.throws(() => p.setLevel("a", "auto-all"));
});

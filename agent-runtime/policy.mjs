// ADR-029 — Auto-Apply Policy. Per-agent trust engine. DECISION ONLY — never an
// apply path. The auto-apply branch and the operator-confirm branch both call the
// SAME applyChanges (server.mjs L469), so the broker re-validates every path either
// way. Policy gates the TRIGGER, never the broker's verdict.
//
// HARD INVARIANT (sr-security, BLOCKING): policy can RELAX only the trigger for
// plain-safe src/* text. It can NEVER widen applyAllowed/CONFIG_GUARD/APPLY_DENY.
// Exec/config paths ALWAYS hold. Tampered/missing/unknown policy → fail closed to
// manual (most restrictive). isAutoSafe ⟹ applyAllowed by construction.

import { createHmac, timingSafeEqual } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { applyAllowed, CONFIG_GUARD, APPLY_DENY, REPO_ROOT } from "./guards.mjs";

const LEVELS = new Set(["manual", "auto-safe", "never"]);
const DEFAULT_LEVEL = "manual";

// The SAFE classifier (ADR-029 §3). Auto-eligible ONLY if ALL hold (deny-by-default).
// Runs IN ADDITION TO applyAllowed (line a) — it can only ever SUBTRACT from what the
// broker permits, never add. isAutoSafe(p) ⟹ applyAllowed(p).
export function isAutoSafe(relPath) {
  if (!applyAllowed(relPath)) return false;                          // (a) must pass broker gate
  const relNorm = relative(REPO_ROOT, resolve(REPO_ROOT, relPath));
  if (CONFIG_GUARD[relNorm]) return false;                          // (b) any CONFIG_GUARD file
  if (APPLY_DENY.test(relNorm)) return false;                       // (c) belt-and-suspenders
  const top = relNorm.split(sep)[0];
  if (top === "scripts") return false;                              // (d) exec dir
  if (/\.config\./i.test(relNorm)) return false;                    // (e) *.config.*
  if (/\.(sh|bash|mjs|cjs|js)$/i.test(relNorm)) return false;       // (f) exec-capable extensions
  if (/(^|\/)package\.json$/i.test(relNorm)) return false;          // (g) explicit
  return top === "src" || relNorm === "README.md";                 // SAFE: plain src/* text + README
}

export function createPolicy(opts = {}) {
  const file = opts.file;
  const token = opts.token || process.env.RUNTIME_TOKEN || "";
  let levels = { default: DEFAULT_LEVEL };
  let sigOk = true;

  const sign = (policyObj) => createHmac("sha256", token).update(JSON.stringify(policyObj)).digest("hex");

  function verify(policyObj, sig) {
    if (!token || typeof sig !== "string") return false;
    const expected = sign(policyObj);
    if (sig.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // Load + verify. Mismatch / missing sig / parse error → fail closed to manual.
  function load() {
    if (!file || !existsSync(file)) {
      levels = { default: DEFAULT_LEVEL };
      sigOk = true; // no file = pristine default; not a tamper
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8"));
      if (!raw || typeof raw.policy !== "object" || !verify(raw.policy, raw.sig)) {
        levels = { default: DEFAULT_LEVEL };
        sigOk = false; // tamper / wrong signer → fail closed
        return;
      }
      levels = { default: DEFAULT_LEVEL, ...raw.policy };
      sigOk = true;
    } catch {
      levels = { default: DEFAULT_LEVEL };
      sigOk = false;
    }
  }
  load();

  function persist(policyObj) {
    const rec = { policy: policyObj, sig: sign(policyObj), updatedAt: new Date().toISOString() };
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(rec));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    load(); // re-read so in-memory state matches disk + re-verifies
  }

  // Resolve an agent's level. Unknown agent → default → manual. A level not in the
  // enum (forged even if signed) → manual (the classifier backstops regardless).
  function levelFor(agentId) {
    if (!sigOk) return DEFAULT_LEVEL; // fail closed
    const lvl = levels[agentId] ?? levels.default ?? DEFAULT_LEVEL;
    return LEVELS.has(lvl) ? lvl : DEFAULT_LEVEL;
  }

  // The GATING decision (ADR-024 §GATING). auto only if level==='auto-safe' AND
  // EVERY changed path isAutoSafe (all-or-nothing — one risky path holds the lot).
  function decide(agentId, diffPaths) {
    const level = levelFor(agentId);
    if (level !== "auto-safe") return { autoApply: false, level, heldReason: `policy=${level} (operator confirm required)` };
    if (!Array.isArray(diffPaths) || diffPaths.length === 0) return { autoApply: false, level, heldReason: "empty diff" };
    const risky = diffPaths.find((p) => !isAutoSafe(p));
    if (risky) return { autoApply: false, level, heldReason: `risky path holds diff: ${risky}` };
    return { autoApply: true, level, heldReason: null };
  }

  function setLevel(agentId, level) {
    if (!LEVELS.has(level)) throw new Error(`invalid policy level: ${level} (valid: ${[...LEVELS].join(",")})`);
    const next = { ...rawPolicy(), [agentId]: level };
    persist(next);
  }

  // current per-agent map without the synthetic `default` injected at load
  function rawPolicy() {
    const out = {};
    for (const [k, v] of Object.entries(levels)) if (k !== "default" || levels.default !== DEFAULT_LEVEL) out[k] = v;
    return out;
  }

  // test-only: sign a bogus (out-of-enum) level to prove fail-to-manual on load
  function setLevelRawForTest(agentId, level) {
    persist({ ...rawPolicy(), [agentId]: level });
  }

  return {
    levelFor,
    decide,
    setLevel,
    isAutoSafe,
    signatureOk: () => sigOk,
    appliesBrokerGate: (p) => applyAllowed(p),
    setLevelRawForTest,
    reload: load,
  };
}

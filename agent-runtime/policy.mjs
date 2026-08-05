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

// ── ADR-053 — PER-BAND policy (P6) ───────────────────────────────────────────
// A SEPARATE axis from the per-agent trust above. This one reads factory/policy.json
// (plain JSON — BOSS edits it in Settings, so NO HMAC) and decides, per risk band,
// what friction a Delivery needs: auto_approve / notify / human / typed_confirm.
//
// SECURITY (ADR-053, BLOCKING per program plan): this is deny-by-default.
//   • DEFAULTS (no file): auto-approve OFF everywhere — low=notify, medium=human,
//     high=typed_confirm.
//   • Parse error or ANY schema violation → the SAFEST policy (all-human) + logged.
//     A corrupt file can never RELAX the gate, only tighten it.
//   • An always-human DENY-LIST (path globs) forces human regardless of band. It can
//     only ever REMOVE auto-approval, never relax existing friction (a high-risk
//     typed_confirm stays typed_confirm even if it also hits a deny glob).
//   • routeFor() returning 'auto_approve' is the ONLY thing upstream reads as
//     auto-apply-eligible; the server still runs isAutoSafe + the broker after it.

const LOW_BEHAVIORS = new Set(["auto_approve", "notify", "human"]);
const MED_BEHAVIORS = new Set(["human", "notify"]);
const HIGH_BEHAVIORS = new Set(["human", "typed_confirm"]);

// The pristine no-file default: conservative, auto OFF.
const DEFAULT_BANDS = Object.freeze({ low: "notify", medium: "human", high: "typed_confirm" });
// The fail-closed default when a file is present but bad: everything human.
const SAFE_BANDS = Object.freeze({ low: "human", medium: "human", high: "typed_confirm" });
// Built-in deny-list — always-human paths even before the operator edits one.
export const DEFAULT_DENYLIST = Object.freeze([
  "**/.env", "**/.env.*", "**/secrets/**", "**/credentials/**",
  ".github/**", "**/*.pem", "**/*.key", "**/Dockerfile", "**/migrations/**",
]);
// Default SLA windows (ms), overridable by policy.sla and by env in the server.
export const DEFAULT_SLA_MS = Object.freeze({ low: 86_400_000, medium: 28_800_000, high: 3_600_000 });

// Minimal, safe glob → RegExp. Supports **, **/ (cross-segment), * (within a segment).
// Every other char is matched literally. Anchored full-match.
function globToRe(glob) {
  const g = String(glob || "").replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; continue; } // **/ → optional dirs
        re += ".*"; i += 1; continue;                                  // ** → anything
      }
      re += "[^/]*"; continue;                                          // * → within a segment
    }
    re += /[\\^$.|?+()[\]{}]/.test(c) ? `\\${c}` : c;
  }
  // Case-INSENSITIVE: the classifier (risk.mjs, all /i) and the target FS (APFS/NTFS)
  // are case-insensitive, so a case-sensitive deny glob would let `src/Secret/x` slip a
  // deny for `src/secret/**`. Case-insensitive only ever OVER-blocks on a case-sensitive
  // FS — the safe direction. (sr-security P6 blocker.)
  try { return new RegExp(`^${re}$`, "i"); } catch { return /$.^/; } // unusable glob matches nothing
}

export function createBandPolicy(opts = {}) {
  const file = opts.file;
  const log = opts.log || ((m) => console.warn(m));
  let bands = { ...DEFAULT_BANDS };
  let denyGlobs = [...DEFAULT_DENYLIST];
  let denyRes = denyGlobs.map(globToRe);
  let sla = { ...DEFAULT_SLA_MS };
  let ok = true; // false ⇒ we fell back to SAFE_BANDS after a bad file

  const validBands = (b) =>
    b && typeof b === "object"
    && LOW_BEHAVIORS.has(b.low) && MED_BEHAVIORS.has(b.medium) && HIGH_BEHAVIORS.has(b.high);

  function load() {
    if (!file || !existsSync(file)) { bands = { ...DEFAULT_BANDS }; denyGlobs = [...DEFAULT_DENYLIST]; sla = { ...DEFAULT_SLA_MS }; ok = true; denyRes = denyGlobs.map(globToRe); return; }
    let raw;
    try { raw = JSON.parse(readFileSync(file, "utf-8")); }
    catch (e) { log(`[policy] ${file} unparseable → all-human (fail closed): ${e?.message}`); return failClosed(); }
    if (!validBands(raw.bands)) { log(`[policy] ${file} bands invalid → all-human (fail closed)`); return failClosed(); }
    bands = { low: raw.bands.low, medium: raw.bands.medium, high: raw.bands.high };
    // deny-list: operator globs are ADDED to the built-in floor, never replace it. The
    // classifier already keeps .env/secrets/.github/keys at HIGH (unauto-appliable), but
    // the deny-list is defense-in-depth and its built-in entries must be un-removable —
    // an explicit `denyList:[]` (or a malformed one) must NOT be able to clear the floor.
    const extra = Array.isArray(raw.denyList) && raw.denyList.every((s) => typeof s === "string")
      ? raw.denyList.slice(0, 200) : [];
    denyGlobs = [...new Set([...DEFAULT_DENYLIST, ...extra])];
    denyRes = denyGlobs.map(globToRe);
    // sla: optional per-band positive integers; invalid entries fall back per band.
    sla = { ...DEFAULT_SLA_MS };
    if (raw.sla && typeof raw.sla === "object") {
      for (const k of ["low", "medium", "high"]) {
        const v = Number(raw.sla[k]);
        if (Number.isFinite(v) && v > 0) sla[k] = Math.floor(v);
      }
    }
    ok = true;
  }
  function failClosed() { bands = { ...SAFE_BANDS }; denyGlobs = [...DEFAULT_DENYLIST]; denyRes = denyGlobs.map(globToRe); sla = { ...DEFAULT_SLA_MS }; ok = false; }
  load();

  const denyHit = (paths) => (Array.isArray(paths) ? paths : []).some((p) => denyRes.some((re) => re.test(String(p || ""))));
  const behaviorFor = (bandName) => bands[bandName] ?? SAFE_BANDS[bandName] ?? "human";

  // The routing decision. Deny-list forces human, but only ever tightens: it turns
  // auto_approve into human and never relaxes typed_confirm/human.
  function routeFor({ band, changedPaths }) {
    let route = behaviorFor(band);
    if (route === "auto_approve" && denyHit(changedPaths)) route = "human";
    return route;
  }

  const slaFor = (bandName) => sla[bandName] ?? DEFAULT_SLA_MS[bandName] ?? DEFAULT_SLA_MS.high;

  function raw() { return { bands: { ...bands }, denyList: [...denyGlobs], sla: { ...sla } }; }

  // Persist a BOSS edit. Validate FIRST — a rejected write never touches disk, so the
  // in-memory (and file) policy can only move between valid states. Plain JSON, 0600.
  function save(next) {
    if (!next || typeof next !== "object") throw new Error("policy: object required");
    if (!validBands(next.bands)) throw new Error("policy: invalid bands (low∈auto_approve|notify|human, medium∈human|notify, high∈human|typed_confirm)");
    if (next.denyList !== undefined && !(Array.isArray(next.denyList) && next.denyList.every((s) => typeof s === "string"))) {
      throw new Error("policy: denyList must be an array of strings");
    }
    if (next.sla !== undefined) {
      if (typeof next.sla !== "object" || next.sla === null) throw new Error("policy: sla must be an object");
      for (const k of ["low", "medium", "high"]) {
        if (next.sla[k] !== undefined && !(Number.isFinite(Number(next.sla[k])) && Number(next.sla[k]) > 0)) {
          throw new Error(`policy: sla.${k} must be a positive number of ms`);
        }
      }
    }
    if (!file) throw new Error("policy: no file configured");
    const rec = {
      bands: { low: next.bands.low, medium: next.bands.medium, high: next.bands.high },
      denyList: Array.isArray(next.denyList) ? next.denyList.slice(0, 200) : [...DEFAULT_DENYLIST],
      sla: (() => { const s = { ...DEFAULT_SLA_MS }; if (next.sla) for (const k of ["low", "medium", "high"]) if (next.sla[k] !== undefined) s[k] = Math.floor(Number(next.sla[k])); return s; })(),
      updatedAt: new Date().toISOString(),
    };
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify(rec, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    load();
    return raw();
  }

  return { routeFor, behaviorFor, denyHit, slaFor, raw, save, reload: load, valid: () => ok };
}

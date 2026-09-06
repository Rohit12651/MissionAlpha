// Phase 7 / task 7.1 — THE ROSTER. The single file that says who may write where.
//
// Two consumers, deliberately separated:
//   • guards.applyAllowed(path, {seat})  — the REAL control (task 7.2). It calls
//     matchesWriteScope() as its LAST gate, after CORE_GUARD / APPLY_DENY / SEED_DIRS.
//   • the Manager (phase 9) — calls match(skills) to pick a seat for a task.
//
// SECURITY POSTURE, stated once and honestly. writeScope can only ever SUBTRACT: it is
// the last gate in applyAllowed, so nothing here can make a path appliable that was not
// already appliable before Phase 7. Concretely, that means a TAMPERED roster (or a
// tampered matcher) degrades to the pre-Phase-7 allow set — it is a loss of the new
// narrowing, never an escalation past CORE_GUARD, APPLY_DENY or SEED_DIRS. That property
// is what makes it safe for this module to live outside the guarded core; it is also why
// roster.json (and this file) are proposed for CORE_GUARD anyway, as defence in depth.
//
// FAIL-CLOSED means different things for the two failure modes, and conflating them would
// be a lie:
//   • roster.json ABSENT      → an EMPTY roster. No member resolves, so applyAllowed's
//                               LEGACY RULE applies and behaviour is exactly today's.
//                               This is the documented posture, not a silent degrade.
//   • roster.json MALFORMED   → THROW. A roster that exists but cannot be trusted must
//                               not be quietly replaced by "no narrowing at all".

import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { CORE_GUARD, SEED_DIRS } from "./guards.mjs";

// "station" = a real seat this app already dispatches that owns no single code domain
// (reviewer, sre, devops, architect...). Like every non-"worker" role it is NOT narrowed by
// writeScope, so adding a station member changes nothing about what that agent may write.
// "hr" is retained for Phase 10; no seed member holds it — hiring is the Agent Factory.
export const ROLES = Object.freeze(["manager", "hr", "ceo", "station", "worker"]);
/** Tools a roster entry may name. A roster can never invent a capability the CLI lacks. */
export const TOOL_ALLOW = Object.freeze(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** `seat` is a label, not free text — it reaches another agent's prompt. */
const SEAT_RE = /^[a-z0-9][a-z0-9_ \-+/.]{0,47}$/i;
const MAX_IDENTITY_LEN = 64;
/** ReDoS bounds on a writeScope glob — see fatalScopeProblem. Tuned against roster.json. */
const MAX_SCOPE_LEN = 200;
const MAX_DOUBLE_STARS = 2;
const MAX_WILDCARDS_PER_SEGMENT = 3;
const CREATED_BY = Object.freeze(["seed", "hr"]);

// ── glob matching ────────────────────────────────────────────────────────────
// The matcher lives in guards.mjs, NOT here, and the direction of that import is the
// point: `applyAllowed` is the predicate that enforces writeScope, so the code deciding
// whether a glob matches belongs in the guarded file with it. Putting it here instead
// would have made guards.mjs import roster.mjs — a cycle, and an enforcement primitive
// sitting in a less-protected module (PES addendum #15).
// Re-exported so callers and tests have one name for it.
export { globToRegExp, matchesWriteScope } from "./guards.mjs";

// ── CORE_GUARD probe derivation ──────────────────────────────────────────────
/**
 * The concrete paths CORE_GUARD protects, derived FROM the regex in guards.mjs rather
 * than re-listed here, so this list cannot drift from the floor it is checking against
 * (PES addendum #5: a guard is only as good as the thing it is handed).
 * Pinned by CG-PROBE-1/2, which assert the list is non-empty AND that every entry is
 * genuinely CORE_GUARD-matched — an anti-vacuity guard, because a derivation that
 * silently produced `[]` would make the validation below accept everything.
 */
export function coreGuardProbePaths() {
  // `.source` escapes every `/` as `\/`, so the alternation is unwrapped with a pattern
  // rather than a literal prefix compare — the first attempt used `"(^|/)("` and threw,
  // which is precisely what CG-PROBE-1/2 exist to catch (PES addendum #9: check the
  // probe's premise before believing its result).
  const shape = /^\(\^\|\\?\/\)\((.*)\)\$$/.exec(CORE_GUARD.source);
  if (!shape) {
    throw new Error("CORE_GUARD shape changed — roster.coreGuardProbePaths must be updated");
  }
  return shape[1].split("|").map((alt) => {
    const literal = alt.replace(/\\(.)/g, "$1");
    // The one directory clause (`agent-runtime/data/.*`) becomes a concrete probe.
    return literal.endsWith("/.*") ? `${literal.slice(0, -2)}mission.db` : literal;
  });
}

// ── validation ───────────────────────────────────────────────────────────────
// TWO CLASSES OF SCOPE PROBLEM, and conflating them bricked the runtime once already.
//
// FATAL — an authoring error or an attack. Absolute paths, `..` traversal, control
// characters, or a literal CORE_GUARD filename. These can never be right, in any repo,
// under any configuration, so load() throws.
/**
 * FATAL writeScope problems: absolute, traversal, backslash, control chars, a literal
 * CORE_GUARD path, or a ReDoS-shaped glob. Returns a message or null.
 *
 * EXPORTED for Phase 10: HR validates a hire's writeScope before `roster.add` ever sees it,
 * and a SECOND implementation of "is this scope safe" is exactly the drift this repo has
 * been bitten by. One function, two callers.
 */
export function fatalScopeProblem(entry) {
  if (typeof entry !== "string" || entry === "") return "writeScope entry must be a non-empty string";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(entry)) return `writeScope entry has control characters: ${entry}`;
  if (entry.startsWith("/") || /^[a-zA-Z]:/.test(entry) || entry.includes("\\")) {
    return `writeScope entry must be relative, not absolute: ${entry}`;
  }
  if (entry.split("/").includes("..")) return `writeScope entry must not traverse with ..: ${entry}`;

  // ── ReDoS bound ────────────────────────────────────────────────────────────
  // globToRegExp turns `**` into `(?:[^/]+/)*` and `*` into `[^/]*`. Several of either,
  // adjacent, are alternations over the same language and backtrack catastrophically:
  // `src/**/**/…(12)…/x.tsx` against `src/a/a/…/nope.txt` did not return within 6 s.
  // matchesWriteScope runs per-file inside the broker loop on the single-threaded server,
  // so one such entry hangs the whole runtime — and Phase 10's HR is an AGENT writing
  // these. Bound the shape here, where it is cheap.
  //
  // The limits are chosen against the SHIPPED roster, not in the abstract: Bulbasaur's
  // `**/migrations/**` has TWO `**` segments, so "at most one" would refuse a real seat and
  // throw at module scope — the boot-brick this file already caused once. Two total, never
  // adjacent, is the rule.
  if (entry.length > MAX_SCOPE_LEN) return `writeScope entry is too long (${entry.length} > ${MAX_SCOPE_LEN}): ${entry.slice(0, 40)}…`;
  const segs = entry.split("/");
  const doubles = segs.filter((seg) => seg === "**").length;
  if (doubles > MAX_DOUBLE_STARS) return `writeScope entry has too many ** segments (${doubles} > ${MAX_DOUBLE_STARS}): ${entry}`;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] === "**" && segs[i - 1] === "**") return `writeScope entry has adjacent ** segments (they match the same paths and backtrack): ${entry}`;
  }
  for (const seg of segs) {
    const wilds = (seg.match(/[*?]/g) || []).length;
    if (wilds > MAX_WILDCARDS_PER_SEGMENT) return `writeScope entry has too many wildcards in one segment (${wilds} > ${MAX_WILDCARDS_PER_SEGMENT}): ${entry}`;
  }
  const hasWildcard = entry.includes("*") || entry.includes("?");
  // A LITERAL CORE_GUARD path is an explicit attempt to grant the floor away. A broad
  // glob that incidentally spans one is fine — CORE_GUARD is checked BEFORE writeScope
  // and refuses it for every seat regardless.
  if (!hasWildcard && CORE_GUARD.test(entry)) return `writeScope entry names a CORE_GUARD path: ${entry}`;
  if (hasWildcard && entry !== "**" && !entry.startsWith("**/")) {
    const first = entry.split("/")[0];
    if (first.includes("*") || first.includes("?")) {
      return `writeScope entry must be rooted at ** or at a literal directory, not a wildcard: ${entry}`;
    }
  }
  return null;
}

// NON-FATAL — the entry is well-formed but its root is not among THIS install's
// SEED_DIRS. It is dropped, never thrown on.
//
// WHY THIS IS NOT A THROW (this exact throw took the runtime down): SEED_DIRS is
// env-configurable (`RUNTIME_SEED_DIRS`), and the HTTP suites narrow it to `src`. A
// roster authored for the full repo then made `createRoster` throw at module scope, so
// the server never bound its port and 19 suites failed with "server not healthy" — a
// config change bricking the runtime.
//
// Dropping is also the CORRECT semantics, not merely the survivable one. applyAllowed
// checks SEED_DIRS *before* writeScope, so an entry rooted outside them could never match
// anything anyway; removing it changes no decision. And the drop only ever NARROWS a
// seat — a member left with nothing keeps an empty scope, which writes nothing.
function outsideSeedDirs(entry, seedDirs) {
  if (entry === "**" || entry.startsWith("**/")) return false; // intersected at match time
  return !seedDirs.includes(entry.split("/")[0]);
}

function validateMember(m, { valid, takenIds }) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "member must be an object";
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) return `invalid member id: ${JSON.stringify(m?.id)}`;
  if (takenIds.has(m.id)) return `duplicate member id: ${m.id}`;
  // `name` and `seat` are interpolated verbatim into ANOTHER agent's system prompt
  // (server.mjs seatSystemPrompt), right beside the SKILL bodies that are capped and
  // scrubbed precisely because they land there. Bound them for the same reason: today
  // roster.json is CORE_GUARD'd and operator-authored, but add() is HR's write path.
  if (typeof m.name !== "string" || !m.name.trim()) return `member ${m.id}: name is required`;
  if (m.name.length > MAX_IDENTITY_LEN) return `member ${m.id}: name exceeds ${MAX_IDENTITY_LEN} chars`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(m.name)) return `member ${m.id}: name has control characters`;
  if (typeof m.seat !== "string" || !SEAT_RE.test(m.seat)) return `member ${m.id}: seat must match ${SEAT_RE}`;
  if (!ROLES.includes(m.role)) return `member ${m.id}: unknown role ${JSON.stringify(m.role)}`;

  if (!Array.isArray(m.skills)) return `member ${m.id}: skills must be an array`;
  for (const s of m.skills) {
    if (typeof s !== "string") return `member ${m.id}: skill ids must be strings`;
    if (!valid.has(s)) return `member ${m.id}: unknown skill id "${s}" (not in the governed catalog)`;
  }
  if (new Set(m.skills).size !== m.skills.length) return `member ${m.id}: duplicate skill id`;

  if (!Array.isArray(m.tools)) return `member ${m.id}: tools must be an array`;
  for (const t of m.tools) {
    if (!TOOL_ALLOW.includes(t)) return `member ${m.id}: tool "${t}" is not in the allow-list`;
  }

  if (!Array.isArray(m.writeScope)) return `member ${m.id}: writeScope must be an array`;
  for (const entry of m.writeScope) {
    const bad = fatalScopeProblem(entry);
    if (bad) return `member ${m.id}: ${bad}`;
  }

  if (!CREATED_BY.includes(m.createdBy)) return `member ${m.id}: createdBy must be one of ${CREATED_BY.join("|")}`;
  if (typeof m.createdAt !== "string" || Number.isNaN(Date.parse(m.createdAt))) {
    return `member ${m.id}: createdAt must be an ISO timestamp`;
  }
  return null;
}

const clone = (m) => ({
  ...m,
  skills: [...m.skills],
  writeScope: [...m.writeScope],
  tools: [...m.tools],
});

// ── the store ────────────────────────────────────────────────────────────────
export function createRoster({ file, validSkills, seedDirs, emit } = {}) {
  const valid = validSkills instanceof Set ? validSkills : new Set(validSkills || []);
  const dirs = Array.isArray(seedDirs) && seedDirs.length ? seedDirs : SEED_DIRS;
  let members = [];
  let version = 1;

  function parseRoster(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("roster: not an object");
    if (!Array.isArray(obj.members)) throw new Error("roster: members must be an array");
    const takenIds = new Set();
    const out = [];
    for (const m of obj.members) {
      const bad = validateMember(m, { valid, takenIds });
      if (bad) throw new Error(`roster: ${bad}`);
      takenIds.add(m.id);
      const kept = m.writeScope.filter((e) => !outsideSeedDirs(e, dirs));
      if (kept.length !== m.writeScope.length) {
        const dropped = m.writeScope.filter((e) => outsideSeedDirs(e, dirs));
        console.warn(
          `[roster] ${m.id}: dropped ${dropped.length} writeScope entr${dropped.length === 1 ? "y" : "ies"} ` +
          `outside RUNTIME_SEED_DIRS (${dirs.join(", ")}): ${dropped.join(", ")} — the seat is NARROWER here, never wider`,
        );
      }
      out.push({ ...clone(m), writeScope: kept });
    }
    return { version: Number.isInteger(obj.version) ? obj.version : 1, members: out };
  }

  function load() {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      // ABSENT is a documented posture; UNREADABLE is a fault, and conflating them means a
      // `chmod 000`, an EISDIR or an EMFILE under load boots the runtime with zero seats and
      // every write ungated, silently. Only ENOENT takes the legacy path.
      if (e?.code !== "ENOENT") throw new Error(`roster: ${file} exists but could not be read (${e?.code || e?.message})`);
      members = [];
      version = 1;
      return;
    }
    // MALFORMED — loud. A roster that exists must be trustworthy or refuse to load.
    const parsed = parseRoster(JSON.parse(text));
    members = parsed.members;
    version = parsed.version;
  }

  function persist() {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ version, members }, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, file);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw e;
    }
    try { chmodSync(file, 0o600); } catch { /* the tmp was already 0600 */ }
  }

  load();

  return {
    /** Every member, deep-copied — a caller can never widen a seat by mutating a result. */
    all: () => members.map(clone),
    get: (id) => {
      const m = members.find((x) => x.id === id);
      return m ? clone(m) : undefined;
    },
    /**
     * Workers whose skills are a SUPERSET of `skillsRequired`, in roster order.
     * Only `role:"worker"` members are assignable — a manager holding `repo-read`
     * is not a seat you can hand a build task to.
     */
    match(skillsRequired) {
      const need = Array.isArray(skillsRequired) ? skillsRequired : [];
      if (need.length === 0) return [];
      return members
        .filter((m) => m.role === "worker" && need.every((s) => m.skills.includes(s)))
        .map(clone);
    },
    /** Append a member (HR's only write path). Returns {error} without touching disk on refusal. */
    add(member) {
      const takenIds = new Set(members.map((m) => m.id));
      const bad = validateMember(member, { valid, takenIds });
      if (bad) return { error: bad };
      const next = clone(member);
      const prev = members;
      members = [...members, next];
      try {
        persist();
      } catch (e) {
        members = prev; // never report a member the disk does not carry
        return { error: `roster persist failed: ${e?.message}` };
      }
      try { emit?.("roster.changed", { id: next.id, count: members.length }); } catch { /* bus is observational */ }
      return clone(next);
    },
    version: () => version,
    reload: load,
  };
}

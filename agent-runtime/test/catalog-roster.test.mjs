// Phase 7 / 7.0 — ROSTER SKILLS in the closed catalog.
//
// Five worker seats (ui, api, db, test, notifications) join factory.SKILL_CATALOG.
// The catalog is a CLOSED set: a spec may only name an id that lives here, and each
// entry's `tools`/`platforms` are what validateSpec DERIVES onto a minted agent
// (factory.mjs ~line 230 and ~line 318). So a careless entry here is a silent
// privilege grant on every agent that names it — this file is the ratchet against that.
//
// Two things are asserted, and the second is the load-bearing one:
//   1. RESOLVE-*  the five ids exist and each ships a real, bounded SKILL.md.
//   2. GOVERNED-* no entry widens authority: no posting, no platform, no Run/Bash,
//      no dev/station flag, no redirect.
//
// GOVERNED-* runs its predicate over a synthetic BAD/GOOD/UNRELATED trio on every CI
// run, so the check is proven to fire whether or not anyone mutates the real catalog.
// Every assertion matches on VALUES, never on source text.

import test from "node:test";
import assert from "node:assert/strict";
import { statSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_CATALOG } from "../factory.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const CURATED_DIR = join(__dir, "..", "..", ".claude", "skills-curated");

/** The five worker seats added in 7.0. */
const ROSTER_IDS = ["ui", "api", "db", "test", "notifications"];

/** 6 KB hard cap — these bodies get injected into agent prompts (7.3). */
const SKILL_MD_MAX_BYTES = 6 * 1024;

// Mirrors factory.mjs `ALLOWED_TOOLS`. Anything outside it is DROPPED by the
// derivation filter, so an entry naming e.g. "Bash" or "Grep" would be a no-op
// dressed up as a capability.
const ALLOWED_TOOLS = new Set(["Read", "Write", "Run"]);

// What a worker seat may hold. "Run" is deliberately EXCLUDED: Run is the
// exec-broker capability, and factory.mjs only lets it through behind `dev: true`
// plus an allowlisted `redirect` (the G6 guard). A non-dev entry carrying Run
// would hand out exec authority with no redirect check.
const WORKER_TOOLS = new Set(["Read", "Write"]);

/**
 * True when `entry` is a governed worker seat: it widens vocabulary and nothing else.
 * Structural — reads fields, never source text.
 * @param {any} entry
 */
function isGovernedWorkerSeat(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.posting !== false) return false;
  if (!Array.isArray(entry.platforms) || entry.platforms.length !== 0) return false;
  if (!Array.isArray(entry.tools) || entry.tools.length === 0) return false;
  for (const t of entry.tools) {
    if (!ALLOWED_TOOLS.has(t)) return false; // unrepresentable → silently dropped
    if (!WORKER_TOOLS.has(t)) return false;  // Run → exec authority without a redirect
  }
  if (entry.dev !== undefined) return false;
  if (entry.station !== undefined) return false;
  if (entry.redirect !== undefined) return false;
  return true;
}

const find = (id) => SKILL_CATALOG.find((c) => c.id === id);

// ── RESOLVE: the ids exist ───────────────────────────────────────────────────

test("RESOLVE-1: each roster id resolves to a catalog entry", () => {
  for (const id of ROSTER_IDS) {
    const entry = find(id);
    assert.ok(entry, `SKILL_CATALOG has no entry for "${id}" — a spec naming it would be rejected`);
    assert.equal(entry.id, id);
    assert.ok(typeof entry.label === "string" && entry.label.length > 0, `${id}: label required`);
    assert.ok(typeof entry.desc === "string" && entry.desc.length >= 20,
      `${id}: desc is what the BOSS prompt shows for this seat — it must say something`);
  }
});

test("RESOLVE-2: SKILL_CATALOG ids are unique", () => {
  const ids = SKILL_CATALOG.map((s) => s.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate catalog ids shadow each other in every find(): ${dupes}`);
  assert.equal(new Set(ids).size, ids.length);
});

// ── DISK: every roster id ships a real, bounded SKILL.md ─────────────────────

test("DISK-1: each roster id ships a SKILL.md on disk", () => {
  for (const id of ROSTER_IDS) {
    const p = join(CURATED_DIR, id, "SKILL.md");
    assert.ok(existsSync(p), `missing ${p}`);
  }
});

test("DISK-2: each SKILL.md is at most 6 KB — these bodies enter agent prompts", () => {
  for (const id of ROSTER_IDS) {
    const p = join(CURATED_DIR, id, "SKILL.md");
    const bytes = statSync(p).size;
    assert.ok(bytes <= SKILL_MD_MAX_BYTES, `${id}/SKILL.md is ${bytes} bytes, cap is ${SKILL_MD_MAX_BYTES}`);
    assert.ok(bytes > 400, `${id}/SKILL.md is ${bytes} bytes — that is a placeholder, not guidance`);
  }
});

test("DISK-3: each SKILL.md carries frontmatter whose name equals the catalog id", () => {
  // station-skills.mjs readSkillCatalog() keys the curated tier on this frontmatter.
  // A name that drifts from the id makes the body unreachable from the catalog entry.
  for (const id of ROSTER_IDS) {
    const body = readFileSync(join(CURATED_DIR, id, "SKILL.md"), "utf-8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
    assert.ok(m, `${id}/SKILL.md has no YAML frontmatter block`);
    const name = /^name:\s*(\S+)\s*$/m.exec(m[1]);
    assert.ok(name, `${id}/SKILL.md frontmatter has no name:`);
    assert.equal(name[1], id, `${id}/SKILL.md declares name "${name[1]}"`);
    assert.match(m[1], /^description:/m, `${id}/SKILL.md frontmatter has no description:`);
  }
});

test("DISK-4: each SKILL.md states what the seat must never touch", () => {
  // A seat brief that only says what to do is half a brief. The boundary is the
  // half that keeps a minted agent out of another seat's files.
  for (const id of ROSTER_IDS) {
    const body = readFileSync(join(CURATED_DIR, id, "SKILL.md"), "utf-8");
    assert.match(body, /never/i, `${id}/SKILL.md declares no prohibition`);
  }
});

// ── GOVERNED: the anti-privilege-widening ratchet ────────────────────────────

test("GOVERNED-0: the predicate itself is proven to fire (synthetic BAD/GOOD trio)", () => {
  const GOOD = { id: "g", label: "G", desc: "x", tools: ["Read", "Write"], platforms: [], posting: false };
  assert.equal(isGovernedWorkerSeat(GOOD), true, "an honest worker seat must pass");
  assert.equal(isGovernedWorkerSeat({ ...GOOD, tools: ["Read"] }), true, "read-only is also honest");

  const BAD = {
    posting: { ...GOOD, posting: true },
    platform: { ...GOOD, platforms: ["twitter"] },
    run: { ...GOOD, tools: ["Read", "Write", "Run"] },
    bash: { ...GOOD, tools: ["Read", "Bash"] },
    unrepresentable: { ...GOOD, tools: ["Read", "Grep"] },
    dev: { ...GOOD, dev: true },
    station: { ...GOOD, station: true },
    redirect: { ...GOOD, redirect: "golang-pro" },
    noTools: { ...GOOD, tools: [] },
  };
  for (const [why, entry] of Object.entries(BAD)) {
    assert.equal(isGovernedWorkerSeat(entry), false, `predicate failed to reject: ${why}`);
  }

  const UNRELATED = [null, undefined, 42, "ui", []];
  for (const u of UNRELATED) assert.equal(isGovernedWorkerSeat(u), false, `non-entry accepted: ${JSON.stringify(u)}`);
});

test("GOVERNED-1: no roster entry unlocks posting or a platform", () => {
  for (const id of ROSTER_IDS) {
    const entry = find(id);
    assert.ok(entry, `SKILL_CATALOG has no entry for "${id}"`);
    assert.equal(entry.posting, false, `${id}: posting must be exactly false`);
    assert.deepEqual(entry.platforms, [], `${id}: a non-empty platforms unlocks an integration`);
  }
});

test("GOVERNED-2: every roster entry passes the full governance predicate", () => {
  for (const id of ROSTER_IDS) {
    const entry = find(id);
    assert.ok(entry, `SKILL_CATALOG has no entry for "${id}"`);
    assert.equal(isGovernedWorkerSeat(entry), true,
      `${id} widens authority: ${JSON.stringify({ tools: entry.tools, platforms: entry.platforms, posting: entry.posting, dev: entry.dev, station: entry.station, redirect: entry.redirect })}`);
  }
});

test("GOVERNED-3: roster seats grant Read/Write — the tools validateSpec keeps", () => {
  // factory.mjs drops any derived tool outside ALLOWED_TOOLS, so an entry naming
  // "Glob"/"Grep"/"Edit"/"Bash" would present a capability the runtime never grants.
  // Read covers Glob/Grep; Write is what agent-tools.mjs turns into Write+Edit.
  for (const id of ROSTER_IDS) {
    const entry = find(id);
    assert.ok(entry, `SKILL_CATALOG has no entry for "${id}"`);
    assert.deepEqual([...entry.tools].sort(), ["Read", "Write"], `${id}: tools must be exactly {Read, Write}`);
  }
});

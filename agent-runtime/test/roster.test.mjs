// Phase 7 / task 7.1 — roster.mjs: the file that decides WHO may write WHERE.
//
// Every assertion here is written against VALUES (a boolean from the matcher, a member
// list, a thrown error), never against source text — PES addendum #13, which cost this
// repo three vacuous ratchets.
//
// The anti-vacuity guard for the CORE_GUARD probe derivation lives in this file too
// (CG-PROBE-1/2): a derivation that silently produced an empty list would make the
// "no literal CORE_GUARD path in scope" validation pass on everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRoster, matchesWriteScope, coreGuardProbePaths } from "../roster.mjs";
import { CORE_GUARD, SEED_DIRS } from "../guards.mjs";
import { SKILL_CATALOG } from "../factory.mjs";

// The GOVERNED catalog, derived exactly as server.mjs:2371 derives it. This was a hardcoded
// 7-id copy until 2026-09-17, when adding the `ceo` seat (skill "strategy-gate") to the real
// roster.json made the copy stale and this file threw AT IMPORT — `pass 0`, not `fail 1`.
// A cache of a source of truth that lives two files away buys nothing and goes stale silently.
const SKILLS = new Set(SKILL_CATALOG.map((sk) => sk.id));
const seedFile = new URL("../roster.json", import.meta.url).pathname;

function tmpRosterFile(obj) {
  const dir = mkdtempSync(join(tmpdir(), "ma-roster-"));
  const f = join(dir, "roster.json");
  writeFileSync(f, JSON.stringify(obj, null, 2));
  return f;
}
function mk(over = {}) {
  return {
    id: "pikachu", name: "Pikachu", seat: "ui", role: "worker",
    skills: ["ui"], writeScope: ["src/**/*.tsx"],
    tools: ["Read", "Edit", "Write"], createdBy: "seed",
    createdAt: "2026-09-04T00:00:00.000Z", ...over,
  };
}
const rosterOf = (members) => ({ version: 1, members });
const load = (obj, opts = {}) =>
  createRoster({ file: tmpRosterFile(obj), validSkills: SKILLS, seedDirs: SEED_DIRS, ...opts });

// ── GLOB matcher ─────────────────────────────────────────────────────────────
// The GLOB RULE, pinned: a `**`-rooted glob is accepted and intersected with SEED_DIRS
// at match time. That intersection is NOT re-implemented here — it is the ORDER of the
// checks in applyAllowed (SEED_DIRS is tested before writeScope), and GLOB-8 pins the
// consequence the rule exists to describe.
test("GLOB-1: a prefixed glob with ** and an extension matches at any depth", () => {
  assert.equal(matchesWriteScope("src/components/board/X.tsx", ["src/**/*.tsx"]), true);
  assert.equal(matchesWriteScope("src/X.tsx", ["src/**/*.tsx"]), true, "zero intervening dirs must match");
  assert.equal(matchesWriteScope("src/lib/x.ts", ["src/**/*.tsx"]), false, "wrong extension");
});

test("GLOB-2: a trailing ** matches everything below, and nothing above", () => {
  assert.equal(matchesWriteScope("src/lib/a.ts", ["src/lib/**"]), true);
  assert.equal(matchesWriteScope("src/lib/deep/b.ts", ["src/lib/**"]), true);
  assert.equal(matchesWriteScope("src/components/a.ts", ["src/lib/**"]), false);
  assert.equal(matchesWriteScope("src/lib", ["src/lib/**"]), false, "the directory itself is not a file in scope");
});

test("GLOB-3: a **-rooted glob matches at any depth", () => {
  assert.equal(matchesWriteScope("agent-runtime/migrations/001.sql", ["**/migrations/**"]), true);
  assert.equal(matchesWriteScope("src/db/migrations/x.sql", ["**/migrations/**"]), true);
  assert.equal(matchesWriteScope("src/db/migration/x.sql", ["**/migrations/**"]), false);
});

test("GLOB-4: a **-rooted basename prefix glob", () => {
  assert.equal(matchesWriteScope("agent-runtime/schema.json", ["**/schema*"]), true);
  assert.equal(matchesWriteScope("src/schema.ts", ["**/schema*"]), true);
  assert.equal(matchesWriteScope("src/lib/myschema.ts", ["**/schema*"]), false, "prefix, not substring");
});

test("GLOB-5: an exact literal path matches only itself", () => {
  assert.equal(matchesWriteScope("agent-runtime/db.mjs", ["agent-runtime/db.mjs"]), true);
  assert.equal(matchesWriteScope("agent-runtime/db2.mjs", ["agent-runtime/db.mjs"]), false);
  assert.equal(matchesWriteScope("agent-runtime/sub/db.mjs", ["agent-runtime/db.mjs"]), false);
});

test("GLOB-6: `*` never crosses a path separator", () => {
  assert.equal(matchesWriteScope("src/a.tsx", ["src/*.tsx"]), true);
  assert.equal(matchesWriteScope("src/deep/a.tsx", ["src/*.tsx"]), false, "* must not swallow a /");
});

test("GLOB-7: an empty writeScope matches NOTHING (fail closed)", () => {
  assert.equal(matchesWriteScope("src/anything.ts", []), false);
  assert.equal(matchesWriteScope("src/anything.ts", undefined), false);
  assert.equal(matchesWriteScope("src/anything.ts", null), false);
});

test("GLOB-8: the test seat's globs match test files under EVERY seed dir", () => {
  const squirtle = ["**/__tests__/**", "**/*.test.*"];
  assert.equal(matchesWriteScope("src/lib/__tests__/foo.test.ts", squirtle), true);
  assert.equal(matchesWriteScope("agent-runtime/test/roster.test.mjs", squirtle), true);
  // The glob ALSO matches this shape; SEED_DIRS is what refuses it, one gate earlier.
  assert.equal(matchesWriteScope("node_modules/x/__tests__/a.test.ts", squirtle), true);
  assert.equal(SEED_DIRS.includes("node_modules"), false,
    "GLOB RULE: node_modules is refused by the SEED_DIRS gate that runs BEFORE writeScope");
});

test("GLOB-9: glob metacharacters in a literal segment are escaped, not interpreted", () => {
  // A '.' must not behave as regex 'any char'.
  assert.equal(matchesWriteScope("agent-runtime/dbXmjs", ["agent-runtime/db.mjs"]), false);
});

// ── CORE_GUARD probe derivation (anti-vacuity) ───────────────────────────────
test("CG-PROBE-1: the derived probe list is non-empty and includes the guard files", () => {
  const probes = coreGuardProbePaths();
  assert.ok(probes.length >= 10, `expected >=10 probes, got ${probes.length}`);
  assert.ok(probes.includes("agent-runtime/guards.mjs"), "guards.mjs must be probed");
  assert.ok(probes.includes("agent-runtime/broker.mjs"), "broker.mjs must be probed");
  assert.ok(probes.includes("agent-runtime/server.mjs"), "server.mjs must be probed");
});

test("CG-PROBE-2: EVERY derived probe is genuinely CORE_GUARD-matched", () => {
  // If the derivation drifts from guards.mjs, this fails instead of silently
  // validating nothing.
  for (const p of coreGuardProbePaths()) {
    assert.equal(CORE_GUARD.test(p), true, `derived probe ${p} is not actually CORE_GUARD`);
  }
});

// ── load() validation — fails closed ─────────────────────────────────────────
test("LOAD-1: the seeded roster.json loads and yields the 12 REAL agents", () => {
  const r = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });
  assert.equal(r.all().length, 12);
  // EVERY id here is an agent this app already dispatches (factory/registry.json + the
  // built-in `ceo`). The roster describes the real crew; it does not invent a second one.
  assert.deepEqual(r.all().map((m) => m.id), [
    "ceo", "tech-lead", "pm-analyst", "architect", "reviewer", "devops", "sre",
    "docs-writer", "java17-engineer", "sr-frontend", "sr-backend", "qa",
  ]);
});

test("LOAD-2: an unknown skill id is refused", () => {
  assert.throws(() => load(rosterOf([mk({ skills: ["not-a-catalog-id"] })])), /skill/i);
});

test("LOAD-3: a duplicate member id is refused", () => {
  assert.throws(() => load(rosterOf([mk(), mk({ name: "Clone" })])), /duplicate/i);
});

test("LOAD-4: an absolute glob is refused", () => {
  assert.throws(() => load(rosterOf([mk({ writeScope: ["/etc/passwd"] })])), /absolute|relative/i);
});

test("LOAD-5: a glob containing .. is refused", () => {
  assert.throws(() => load(rosterOf([mk({ writeScope: ["src/../../etc/**"] })])), /\.\.|traversal/i);
});

test("LOAD-6: an entry rooted outside SEED_DIRS is DROPPED, not thrown on", () => {
  // Dropping, not throwing, because SEED_DIRS is env-configurable and a narrowed
  // RUNTIME_SEED_DIRS must never brick the runtime. See LOAD-13 for the regression.
  const r = load(rosterOf([mk({ writeScope: ["node_modules/**", "src/**/*.tsx"] })]));
  assert.deepEqual(r.get("pikachu").writeScope, ["src/**/*.tsx"]);
});

test("LOAD-6b: a member left with NO surviving scope writes nothing (fail closed)", () => {
  const r = load(rosterOf([mk({ writeScope: ["node_modules/**"] })]));
  assert.deepEqual(r.get("pikachu").writeScope, []);
  assert.equal(matchesWriteScope("node_modules/x.ts", r.get("pikachu").writeScope), false);
  assert.equal(matchesWriteScope("src/a.tsx", r.get("pikachu").writeScope), false);
});

test("LOAD-7: a LITERAL CORE_GUARD path in writeScope is refused", () => {
  assert.throws(() => load(rosterOf([mk({ writeScope: ["agent-runtime/guards.mjs"] })])), /core.?guard/i);
});

test("LOAD-8: an unknown role is refused", () => {
  assert.throws(() => load(rosterOf([mk({ role: "superuser" })])), /role/i);
});

test("LOAD-9: a broad glob that INCIDENTALLY spans a guarded file is ACCEPTED", () => {
  // Charizard's approved scope. The floor, not the roster, refuses guards.mjs — and
  // LOAD-10 proves the floor is still there.
  const r = load(rosterOf([mk({ id: "charizard", skills: ["api"], writeScope: ["agent-runtime/**"] })]));
  assert.equal(r.all().length, 1);
  assert.equal(matchesWriteScope("agent-runtime/engine.mjs", ["agent-runtime/**"]), true);
});

test("LOAD-10: the seeded sr-backend holds agent-runtime/** and CORE_GUARD still refuses guards.mjs", () => {
  const r = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });
  const chari = r.get("sr-backend");
  assert.ok(chari.writeScope.includes("agent-runtime/**"));
  assert.equal(matchesWriteScope("agent-runtime/guards.mjs", chari.writeScope), true,
    "the glob does span it — which is exactly why the floor must hold");
  assert.equal(CORE_GUARD.test("agent-runtime/guards.mjs"), true,
    "CORE_GUARD is the gate that refuses it, one step before writeScope");
});

test("LOAD-11: a missing roster file yields an EMPTY roster, not a crash (legacy posture)", () => {
  const r = createRoster({ file: join(tmpdir(), "ma-roster-does-not-exist", "roster.json"),
    validSkills: SKILLS, seedDirs: SEED_DIRS });
  assert.deepEqual(r.all(), []);
  assert.equal(r.get("pikachu"), undefined);
});

test("LOAD-12: a structurally invalid roster THROWS rather than silently degrading", () => {
  assert.throws(() => load({ version: 1, members: "not-an-array" }), /members/i);
});

// ── match() ──────────────────────────────────────────────────────────────────
test("MATCH-1: match([db]) returns the real backend seat", () => {
  const r = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });
  assert.deepEqual(r.match(["db"]).map((m) => m.id), ["sr-backend"]);
});

test("MATCH-1b: every worker on the roster is a seat the plan stage can actually dispatch", () => {
  // The whole point of the rewrite: pipeline.mjs ALLOWED_PLAN_SEATS is {sr-backend,
  // sr-frontend} and the qa stage dispatches `qa`. If a worker here is not a real agent id,
  // rosterSeatFor() never resolves it and the narrowing silently never applies.
  const r = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });
  assert.deepEqual(r.all().filter((m) => m.role === "worker").map((m) => m.id).sort(),
    ["qa", "sr-backend", "sr-frontend"]);
});

test("MATCH-2: a skill nobody on the roster holds returns []", () => {
  const r = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });
  assert.deepEqual(r.match(["notifications"]), [],
    "notifications is catalogued but unstaffed — that is what makes the 10.2 hire proof real");
});

test("MATCH-3: only role:worker members are ever returned", () => {
  const r = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });
  // ceo/tech-lead/reviewer/sre… all hold repo-read, and none of them is assignable work.
  assert.deepEqual(r.match(["repo-read"]), []);
});

test("MATCH-4: superset semantics — a worker must hold ALL required skills", () => {
  const r = load(rosterOf([
    mk({ id: "a", skills: ["ui", "api"], writeScope: ["src/**"] }),
    mk({ id: "b", skills: ["ui"], writeScope: ["src/**"] }),
  ]));
  assert.deepEqual(r.match(["ui", "api"]).map((m) => m.id), ["a"]);
  assert.deepEqual(r.match(["ui"]).map((m) => m.id), ["a", "b"]);
});

test("MATCH-5: ordering is deterministic (roster order), repeated calls identical", () => {
  const r = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });
  const a = r.match(["ui"]).map((m) => m.id);
  const b = r.match(["ui"]).map((m) => m.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ["sr-frontend"]);
});

test("MATCH-6: the returned member cannot be mutated into the stored roster", () => {
  const r = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });
  const m = r.get("sr-frontend");
  m.writeScope.push("agent-runtime/**");
  assert.deepEqual(r.get("sr-frontend").writeScope, ["src/**"],
    "a caller must not be able to widen a seat's scope by mutating a returned object");
});

// ── add() ────────────────────────────────────────────────────────────────────
test("ADD-1: a valid member persists 0600 and emits roster.changed", () => {
  const file = tmpRosterFile(rosterOf([mk()]));
  const seen = [];
  const r = createRoster({ file, validSkills: SKILLS, seedDirs: SEED_DIRS,
    emit: (n, p) => seen.push([n, p]) });
  const out = r.add(mk({ id: "eevee", name: "Eevee", skills: ["notifications"],
    writeScope: ["src/lib/**"], createdBy: "hr" }));
  assert.equal(out.error, undefined, `add refused: ${out.error}`);
  assert.equal(r.all().length, 2);
  assert.equal((statSync(file).mode & 0o777), 0o600, "roster file must be 0600");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).members.map((m) => m.id), ["pikachu", "eevee"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "roster.changed");
});

test("ADD-2: an invalid member is refused and the file is left byte-identical", () => {
  const file = tmpRosterFile(rosterOf([mk()]));
  const before = readFileSync(file, "utf8");
  const seen = [];
  const r = createRoster({ file, validSkills: SKILLS, seedDirs: SEED_DIRS, emit: (n) => seen.push(n) });
  const out = r.add(mk({ id: "bad", writeScope: ["agent-runtime/guards.mjs"] }));
  assert.ok(out.error, "a CORE_GUARD literal scope must be refused");
  assert.equal(readFileSync(file, "utf8"), before, "a refused add must not touch the file");
  assert.equal(r.all().length, 1);
  assert.deepEqual(seen, [], "a refused add must not emit roster.changed");
});

test("ADD-3: a duplicate id is refused", () => {
  const file = tmpRosterFile(rosterOf([mk()]));
  const r = createRoster({ file, validSkills: SKILLS, seedDirs: SEED_DIRS });
  assert.ok(r.add(mk()).error, "duplicate id must be refused");
});

test("ADD-4: no temp file is left behind by an atomic write", () => {
  const file = tmpRosterFile(rosterOf([mk()]));
  const r = createRoster({ file, validSkills: SKILLS, seedDirs: SEED_DIRS });
  r.add(mk({ id: "eevee", skills: ["notifications"], writeScope: ["src/lib/**"], createdBy: "hr" }));
  assert.equal(existsSync(`${file}.tmp`), false, "the .tmp staging file must be renamed away");
});

// ── REGRESSION: the narrowed-SEED_DIRS boot brick ────────────────────────────
// THE DEFECT, and it shipped: load() threw on any writeScope entry rooted outside the
// configured SEED_DIRS. 19 HTTP suites spawn the server with RUNTIME_SEED_DIRS="src",
// so the seeded roster's `agent-runtime/**` made createRoster throw at module scope. The
// server never bound its port; 252 tests failed with "server not healthy". A config
// value bricking the runtime.
//
// Proven to fire: reverting the fix (throw instead of drop) turns LOAD-13 red with
//   "roster: member charizard: writeScope entry is outside the seed dirs (src): agent-runtime/**"
test("LOAD-13: the SEEDED roster loads under a NARROWED SEED_DIRS without throwing", () => {
  const r = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: ["src"] });
  assert.equal(r.all().length, 12, "every seat must survive a narrowed SEED_DIRS");
  assert.deepEqual(r.get("sr-backend").writeScope, ["src/lib/**"],
    "agent-runtime/** is dropped because agent-runtime is not a seed dir here");
  assert.deepEqual(r.get("qa").writeScope, ["**/__tests__/**", "**/*.test.*"],
    "the **-rooted globs survive a narrowed SEED_DIRS");
});

test("LOAD-14: the drop only ever NARROWS — no seat gains scope from it", () => {
  const wide = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: SEED_DIRS });
  const narrow = createRoster({ file: seedFile, validSkills: SKILLS, seedDirs: ["src"] });
  for (const m of narrow.all()) {
    const before = wide.get(m.id).writeScope;
    for (const g of m.writeScope) {
      assert.ok(before.includes(g), `${m.id}: narrowing invented a scope entry: ${g}`);
    }
    assert.ok(m.writeScope.length <= before.length, `${m.id}: narrowing widened the seat`);
  }
});

test("LOAD-15: a FATAL scope problem still throws — dropping is only for seed-dir scope", () => {
  for (const bad of ["/etc/passwd", "src/../../etc/**", "agent-runtime/guards.mjs"]) {
    assert.throws(() => load(rosterOf([mk({ writeScope: [bad] })])),
      `${bad} must remain fatal, not silently dropped`);
  }
});

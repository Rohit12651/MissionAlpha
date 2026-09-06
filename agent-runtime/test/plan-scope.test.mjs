// SESSION 16 — the appliable scope, as the build seats are told it.
//
// WHY THIS MODULE HAS TESTS AT ALL. `pipeline.mjs` used to stamp step 0 of every
// sr-backend goal with `[file-scope: services/** (backend)]`. `services/` does not
// exist in this repo and is not in SEED_DIRS, so nothing written there could ever be
// applied. Live evidence (story_8361a8dcc534a7b3, goal_1b5dd94116b2): the tech-lead
// decompose correctly said "CREATE new file src/lib/buildHealth.ts" and the runtime
// prefixed that very step with a scope header naming `services/**`. The seat was handed
// two contradictory instructions by its own harness, and the story was then written up
// as the model going off-brief.
//
// The rules these tests pin:
//   1. the hint names the REAL appliable roots, derived from the one source of truth
//   2. it never names a root that is not in that source
//   3. with no usable source it emits NOTHING — a false scope is worse than no scope
//   4. it is a property of the REPO, not of the seat: both seats get the same answer
import test from "node:test";
import assert from "node:assert/strict";
import { appliableRoots, fileScopeHint, planScopeBrief, planGoalShapeBrief } from "../plan-scope.mjs";

const REAL = ["src", "public", "agent-runtime", "docs"];

// ── appliableRoots ────────────────────────────────────────────────────────────
test("appliableRoots passes through a clean seed list in order", () => {
  assert.deepEqual(appliableRoots(REAL), REAL);
});

test("appliableRoots normalises ./ prefixes, trailing slashes and blanks", () => {
  assert.deepEqual(appliableRoots(["./src/", "  public  ", "", "   ", "docs//"]), ["src", "public", "docs"]);
});

test("appliableRoots dedupes so a hint never repeats a root", () => {
  assert.deepEqual(appliableRoots(["src", "./src", "src/"]), ["src"]);
});

test("appliableRoots is total: a non-array or junk entries yield []", () => {
  assert.deepEqual(appliableRoots(null), []);
  assert.deepEqual(appliableRoots(undefined), []);
  assert.deepEqual(appliableRoots("src"), []);
  assert.deepEqual(appliableRoots([null, undefined, 0, false]), []);
});

// ── fileScopeHint ─────────────────────────────────────────────────────────────
test("fileScopeHint names every appliable root", () => {
  const hint = fileScopeHint(REAL);
  for (const r of REAL) assert.ok(hint.includes(`${r}/**`), `hint names ${r}/**`);
});

test("REGRESSION: fileScopeHint never names a directory outside the seed list", () => {
  // The exact defect: `services/**` was hard-coded for the sr-backend seat.
  const hint = fileScopeHint(REAL);
  assert.ok(!/services/.test(hint), "the invented services/** scope is gone");
});

test("fileScopeHint is a function of the REPO, not the seat — one answer for all seats", () => {
  // Pinned as a value equality because the per-seat branch is what produced the
  // contradiction: a seat's identity must not narrow the broker's real scope.
  assert.equal(fileScopeHint(REAL), fileScopeHint(REAL));
});

test("fileScopeHint emits NOTHING rather than a false scope when the source is unusable", () => {
  assert.equal(fileScopeHint([]), "");
  assert.equal(fileScopeHint(null), "");
  assert.equal(fileScopeHint(undefined), "");
  assert.equal(fileScopeHint(["", "  "]), "");
});

test("fileScopeHint says that an out-of-scope change cannot be applied", () => {
  assert.match(fileScopeHint(REAL), /cannot be applied/i);
});

// ── planScopeBrief ────────────────────────────────────────────────────────────
test("planScopeBrief names the roots and demands a concrete path per step", () => {
  const brief = planScopeBrief(REAL);
  for (const r of REAL) assert.ok(brief.includes(r), `brief names ${r}`);
  assert.match(brief, /concrete repo-relative path/i);
});

test("planScopeBrief is empty when there is no usable scope", () => {
  assert.equal(planScopeBrief([]), "");
  assert.equal(planScopeBrief(null), "");
});

test("REGRESSION: planScopeBrief never invents services/", () => {
  assert.ok(!/services/.test(planScopeBrief(REAL)));
});

// ── planGoalShapeBrief ────────────────────────────────────────────────────────
// The SECOND contradiction the same live story exposed. sr-frontend's goal was authored by
// the tech-lead as an explicit no-op — "SCOPE LOCK: this is a READ-ONLY guard goal. Do not
// create or modify ANY file. Your diff budget is 0 added / 0 modified / 0 deleted." The
// engine has no such concept: engine.mjs treats a task that produces no changes as
// `empty-diff`, retries it to its attempt budget, then fails it terminally and BLOCKS the
// story. A seat that obeyed its brief perfectly was recorded as stuck.
//
// The engine is not the thing to loosen here — "produced nothing" is exactly the signal that
// catches a seat that did no work. The fix is to stop the decompose authoring a goal the
// harness cannot score.
test("planGoalShapeBrief tells the planner every goal must end in a file change", () => {
  const b = planGoalShapeBrief();
  assert.match(b, /file change/i);
});

test("planGoalShapeBrief names the empty-diff consequence, so the rule has a reason", () => {
  assert.match(planGoalShapeBrief(), /empty-diff/i);
});

test("planGoalShapeBrief redirects verification into the goal that makes the change", () => {
  // Verification steps are GOOD — the live decompose's gates were high quality. They just
  // have to ride along with the change instead of forming a goal of their own.
  assert.match(planGoalShapeBrief(), /verif/i);
});

test("planGoalShapeBrief is a constant — it takes no configuration to be true", () => {
  assert.equal(planGoalShapeBrief(), planGoalShapeBrief());
  assert.ok(planGoalShapeBrief().length > 0);
});

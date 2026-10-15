// Phase 11 · task 11.1 — THE REVIEW TURN: one summary, one gate, one decision.
//
// Until now a job reached `review` and STOPPED. There was no `review` branch in tick(), so
// every job that finished its tasks sat there forever — visible in the Phase 9 and Phase 10
// live runs, all of which ended at `review` and never asked anyone anything.
//
// The review turn closes it: the Manager reads every task's diff AND the RE-RUN of that task's
// scoped test gate (not the recorded tail — a result recorded minutes ago is a claim, not a
// check), writes ONE summary, and mints ONE `job-approval` gate. The BOSS says yes once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createManager, validateReview, MAX_REVIEW_DIFF_BYTES } from "../manager.mjs";
import { createJobs } from "../jobs.mjs";
import { openDb } from "../db.mjs";

const CATALOG = ["ui", "api", "db", "test", "notifications"];
const ROSTER = {
  all: () => [{ id: "sr-backend", role: "worker", skills: ["api"], writeScope: ["src/lib/**"] }],
  match: (skills) => (skills || []).every((s) => ["api"].includes(s))
    ? [{ id: "sr-backend", skills: ["api"] }] : [],
};

function harness(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mr-"));
  const db = openDb({ path: join(dir, "mission.db"), patchesDir: join(dir, "patches") });
  const jobs = createJobs({ db, scrub: (t) => t });
  const gates = [];
  const sent = [];
  const logs = [];
  const seen = [];              // what the review stage was handed
  const mgr = createManager({
    jobs, roster: ROSTER, catalog: CATALOG,
    mailbox: { read: () => [], send: (m) => { sent.push(m); return {}; } },
    enqueueGoal: () => ({ goalId: "g1", firstTaskId: "t1" }),
    deliveries: {
      mintGate: (g) => { const row = { id: `d${gates.length + 1}`, ...g }; gates.push(row); return row; },
      // REAL behaviour: gates already minted for this job come back. The first version of this
      // fake returned [] unconditionally, which made the "already gated" guard unreachable —
      // MR-8 then passed because the job had moved to `awaiting-you`, not because the guard
      // worked. Mutating the guard out did not fail a single test.
      listGates: (jobId, kind) => gates.filter((g) => g.jobId === jobId && (!kind || g.kind === kind)),
    },
    queue: { all: () => [] },
    clock: () => 1_000_000,
    log: (r) => logs.push(r),
    diffFor: (taskId) => `--- a/src/lib/${taskId}.ts\n+++ b/src/lib/${taskId}.ts\n+export const x = 1;\n`,
    retest: async (taskId) => ({ ok: true, tail: `1 pass 0 fail (${taskId})` }),
    dispatch: async ({ stage, ctx }) => {
      if (stage === "review") { seen.push(ctx); return { ok: true, done: ["one"], notDone: [], risk: "low", notes: "clean", filesChanged: 1, testsRun: 1 }; }
      return { ok: true, findings: [], needs: [] };
    },
    ...over,
  });
  return { jobs, mgr, gates, sent, logs, seen };
}

/** A job whose tasks are all finished — the state the review turn triggers on. */
function readyJob(h, n = 1) {
  const j = h.jobs.create({ title: "Add a formatter", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  h.jobs.setTasks(j.id, Array.from({ length: n }, (_, i) => ({
    title: `task ${i + 1}`, skillsRequired: ["api"], steps: [`step ${i + 1}`],
  })));
  for (const [i, t] of h.jobs.tasks(j.id).entries()) {
    h.jobs.updateTask(t.id, { seat: "sr-backend", taskId: `task_${i + 1}`, status: "done", changedPaths: [`src/lib/a${i + 1}.ts`] });
  }
  h.jobs.setStatus(j.id, "building");
  h.jobs.setStatus(j.id, "review");
  return j;
}

test("MR-1: a job in `review` mints ONE job-approval gate and waits for the BOSS", async () => {
  const h = harness();
  const j = readyJob(h, 2);
  const r = await h.mgr.tick(j.id);
  assert.equal(h.gates.length, 1, `expected exactly one gate, got ${h.gates.length}`);
  assert.equal(h.gates[0].kind, "job-approval");
  assert.equal(h.gates[0].jobId, j.id);
  assert.equal(h.jobs.get(j.id).status, "awaiting-you");
  assert.equal(r.action, "review-gated");
});

test("MR-2: the review turn is handed each task's DIFF and a FRESH test re-run", async () => {
  const h = harness();
  const j = readyJob(h, 2);
  await h.mgr.tick(j.id);
  const ctx = h.seen[0];
  assert.ok(ctx, "the review stage was never dispatched");
  assert.equal(ctx.tasks.length, 2);
  for (const t of ctx.tasks) {
    assert.ok(t.diff && t.diff.length, `task ${t.title} carried no diff`);
    assert.ok(t.retest, "the gate was not RE-RUN — a recorded tail is a claim, not a check");
    assert.equal(t.retest.ok, true);
  }
});

test("MR-3: a task whose re-run FAILS is carried into the summary, not hidden", async () => {
  const h = harness({
    retest: async (taskId) => (taskId === "task_2"
      ? { ok: false, tail: "1 fail — assert.equal(2,3)" }
      : { ok: true, tail: "1 pass" }),
    dispatch: async ({ stage, ctx }) => (stage === "review"
      ? { ok: true, done: ["task 1"], notDone: ctx.tasks.filter((t) => !t.retest.ok).map((t) => t.title), risk: "high", notes: "one suite fails", filesChanged: 2, testsRun: 2 }
      : { ok: true, findings: [], needs: [] }),
  });
  const j = readyJob(h, 2);
  await h.mgr.tick(j.id);
  assert.equal(h.gates.length, 1);
  assert.match(h.gates[0].body, /task 2/, "the failing task must appear in what the BOSS reads");
  assert.match(h.gates[0].body, /high/i, "the risk the review reported must reach the gate");
});

test("MR-4: a malformed review reply BLOCKS the job — it never ships on a guess", async () => {
  const h = harness({ dispatch: async ({ stage }) => (stage === "review" ? { ok: false, error: "no fenced json block in the reply" } : { ok: true }) });
  const j = readyJob(h);
  const r = await h.mgr.tick(j.id);
  assert.equal(h.gates.length, 0, "a gate minted from an unreadable review is a yes on unknown content");
  assert.notEqual(h.jobs.get(j.id).status, "awaiting-you");
  // A malformed reply is DETERMINISTIC (classifyDispatchError), and every other stage blocks
  // the job on one rather than burning retries on a model that just answered badly. The job
  // stops where a person can see it.
  assert.equal(r.action, "blocked");
  assert.equal(h.jobs.get(j.id).status, "blocked");
});

test("MR-5: a review the runtime cannot validate is refused", () => {
  assert.ok(validateReview({ done: ["a"], notDone: [], risk: "low", notes: "ok", filesChanged: 1, testsRun: 1 }).ok);
  assert.equal(validateReview(null).ok, false);
  assert.equal(validateReview({ risk: "catastrophic" }).ok, false, "risk must be one of the three bands");
  assert.equal(validateReview({ done: "not-an-array", risk: "low" }).ok, false);
});

test("MR-6: the summary is BOUNDED — an agent-authored blob cannot become the gate body", () => {
  const v = validateReview({ done: [], notDone: [], risk: "low", notes: "x".repeat(50_000), filesChanged: 1, testsRun: 1 });
  assert.ok(v.ok);
  assert.ok(v.review.notes.length <= 1_200, `notes were ${v.review.notes.length} chars`);
});

test("MR-7: the diffs handed to the model are capped in TOTAL, not just per task", async () => {
  // Ten tasks each carrying a large diff would blow the context and the bill. The cap is on
  // the sum, and the model is TOLD when it was truncated rather than silently shown less.
  const big = "+".repeat(40_000);
  const h = harness({ diffFor: () => big });
  const j = readyJob(h, 5);
  await h.mgr.tick(j.id);
  const total = h.seen[0].tasks.reduce((n, t) => n + t.diff.length, 0);
  assert.ok(total <= MAX_REVIEW_DIFF_BYTES, `handed ${total} bytes of diff, cap is ${MAX_REVIEW_DIFF_BYTES}`);
});

test("MR-8: a job already carrying a job-approval is NOT gated twice", async () => {
  // Forced back to `review` between ticks. Without that the second tick returns early on
  // `awaiting-you` and the guard under test is never reached — which is exactly how the first
  // version of this test passed while the guard was mutated out.
  const h = harness();
  const j = readyJob(h);
  await h.mgr.tick(j.id);
  assert.equal(h.gates.length, 1);
  h.jobs.setStatus(j.id, "review");
  const again = await h.mgr.tick(j.id);
  assert.equal(h.gates.length, 1, "two gates means two decisions for one job");
  assert.equal(again.already, true, "the second tick must recognise the open gate, not re-mint");
});

test("MR-9: a review that PARSES but does not VALIDATE blocks — and mints nothing", async () => {
  // The gap MR-4 left: it fed `ok:false`, so runStage blocked before validateReview was ever
  // consulted. Removing the validation check failed no test. This feeds a well-formed reply
  // carrying an impossible risk band — the only path that reaches `!v.ok`.
  const h = harness({
    dispatch: async ({ stage }) => (stage === "review"
      ? { ok: true, done: [], notDone: [], risk: "catastrophic", notes: "n", filesChanged: 1, testsRun: 1 }
      : { ok: true, findings: [], needs: [] }),
  });
  const j = readyJob(h);
  const r = await h.mgr.tick(j.id);
  assert.equal(h.gates.length, 0, "a gate minted from an invalid review asks the BOSS to approve nonsense");
  assert.equal(r.action, "blocked");
  assert.match(h.jobs.get(j.id).blockedOn || "", /review rejected/);
});

test("MR-10: the review diff is asked for the TASK'S PATHS, not the whole worktree", async () => {
  // THE DEFECT, found by the Phase 11 live chain and by nothing before it. `diffFor` ran a bare
  // `git diff` in the seat's worktree. Every seat worktree has had its `.claude/` stripped by
  // worktree.mjs (addendum #24's fix), so a bare diff reads:
  //     3082 files changed, 4 insertions(+), 1045955 deletions(-)
  // The task's actual 4-line change was buried under 3,081 `.claude/` deletions, the 60 KB cap
  // truncated to the deletions, and the Manager — seeing no relevant change — declared a
  // CORRECT green gate stale and refused to ship work that was in fact done.
  const asked = [];
  const h = harness({ diffFor: (taskId, paths) => { asked.push({ taskId, paths }); return "+x"; } });
  const j = readyJob(h, 1);
  await h.mgr.tick(j.id);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].paths, ["src/lib/a1.ts"],
    "diffFor was not told which paths to diff — it will return the whole worktree");
});

test("MR-11: the gate body states what the RUNTIME re-ran, and flags a task where NO tests ran", async () => {
  // Phase 1 (docs/plans/2026-10-14-devin-loop-phase1.md, step 5). The RISK line's test count is
  // the reviewer model's own claim. A scope-empty gate passes (nothing related to run), so a
  // green review could mean nothing was verified. The human must see that, in runtime words.
  const h = harness({
    retest: async (taskId) => (taskId === "task_2"
      ? { ok: true, unverified: true, tail: "no related tests for the changed paths" }
      : taskId === "task_3" ? { ok: false, tail: "1 fail" } : { ok: true, tail: "3 pass 0 fail" }),
  });
  const j = readyJob(h, 3);
  await h.mgr.tick(j.id);
  const body = h.gates[0]?.body || "";
  assert.match(body, /^TESTS \(runtime re-run\): 1 green · 1 failed · 1 with NO tests run$/m,
    `missing runtime test line in:\n${body}`);
  assert.match(body, /UNVERIFIED — no tests ran:\n {2}- task 2/, "the unverified task must be named");
});

test("MR-12: with every task re-run green there is no UNVERIFIED section", async () => {
  const h = harness();
  const j = readyJob(h, 2);
  await h.mgr.tick(j.id);
  const body = h.gates[0]?.body || "";
  assert.match(body, /^TESTS \(runtime re-run\): 2 green · 0 failed · 0 with NO tests run$/m);
  assert.equal(/UNVERIFIED/.test(body), false);
});

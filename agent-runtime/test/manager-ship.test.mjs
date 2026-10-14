// Phase 11 · task 11.3 — SHIP, from the Manager's side.
//
// The BOSS approves ONE gate and this is what happens next: each task's own changed paths are
// committed, in plan order, as its OWN commit on one `ma/job/<id>` branch. Then the PR, when
// `gh` exists. The Job reaches `shipped` or it says why not — it never reports a PR it did not
// open, and never reports shipped on a branch that does not carry the commits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createManager } from "../manager.mjs";
import { createJobs } from "../jobs.mjs";
import { openDb } from "../db.mjs";

const ROSTER = { all: () => [], match: () => [{ id: "sr-backend" }] };

function harness(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ms-"));
  const db = openDb({ path: join(dir, "mission.db"), patchesDir: join(dir, "patches") });
  const jobs = createJobs({ db, scrub: (t) => t });
  const calls = { branch: [], commits: [], pr: [] };
  const pr = {
    createJobBranch: async (jobId, baseSha) => { calls.branch.push({ jobId, baseSha }); return { ok: true, branch: `ma/job/${jobId}`, worktree: "/wt/job", reason: "" }; },
    commitTask: async (a) => { calls.commits.push(a); return { ok: true, sha: `sha${calls.commits.length}`, refused: [], reason: "" }; },
    openJobPr: async (a) => { calls.pr.push(a); return { mode: "pr", prUrl: "https://github.com/a/b/pull/1", reason: "" }; },
  };
  const mgr = createManager({
    jobs, roster: ROSTER, catalog: ["api"],
    mailbox: { read: () => [], send: () => ({}) },
    enqueueGoal: () => ({ goalId: "g", firstTaskId: "t" }),
    deliveries: { mintGate: (g) => ({ id: "d1", ...g }), listGates: () => [] },
    queue: { all: () => [] }, clock: () => 1, log: () => {},
    pr, baseSha: () => "abc1234",
    ...over,
  });
  return { jobs, mgr, calls, pr };
}

function shippableJob(h, n = 2) {
  const j = h.jobs.create({ title: "Add a formatter", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  h.jobs.setTasks(j.id, Array.from({ length: n }, (_, i) => ({ title: `t${i + 1}`, skillsRequired: ["api"], steps: ["s"] })));
  for (const [i, t] of h.jobs.tasks(j.id).entries()) {
    h.jobs.updateTask(t.id, { seat: "sr-backend", taskId: `task_${i + 1}`, status: "done", changedPaths: [`src/lib/f${i + 1}.ts`] });
  }
  h.jobs.setStatus(j.id, "building");
  h.jobs.setStatus(j.id, "review");
  h.jobs.setStatus(j.id, "awaiting-you");
  return j;
}

test("MS-1: approving ships — one branch, one commit PER TASK, in plan order", async () => {
  const h = harness();
  const j = shippableJob(h, 2);
  const out = await h.mgr.ship(j.id);
  assert.ok(out.ok, out.reason);
  assert.equal(h.calls.branch.length, 1, "exactly one branch per job");
  assert.equal(h.calls.branch[0].baseSha, "abc1234");
  assert.equal(h.calls.commits.length, 2, "one commit per task");
  assert.deepEqual(h.calls.commits.map((c) => c.taskId), ["task_1", "task_2"], "commits must follow plan order");
  assert.deepEqual(h.calls.commits[0].paths, ["src/lib/f1.ts"]);
  assert.deepEqual(h.calls.commits[1].paths, ["src/lib/f2.ts"]);
});

test("MS-2: the job reaches `shipped` and records the branch and the PR", async () => {
  const h = harness();
  const j = shippableJob(h);
  await h.mgr.ship(j.id);
  const after = h.jobs.get(j.id);
  assert.equal(after.status, "shipped");
  assert.equal(after.prUrl, "https://github.com/a/b/pull/1");
});

test("MS-3: EACH task is committed with ITS OWN paths — never the union", async () => {
  // The union would land task 2's files inside task 1's commit, and the per-task attribution
  // the whole ladder exists for would be gone.
  const h = harness();
  const j = shippableJob(h, 3);
  await h.mgr.ship(j.id);
  for (const [i, c] of h.calls.commits.entries()) {
    assert.deepEqual(c.paths, [`src/lib/f${i + 1}.ts`], `commit ${i + 1} carried the wrong paths`);
  }
});

test("MS-4: a failed commit STOPS the ship — no PR, and the job does not claim shipped", async () => {
  const h = harness({
    pr: {
      createJobBranch: async (jobId) => ({ ok: true, branch: `ma/job/${jobId}`, worktree: "/wt", reason: "" }),
      commitTask: async ({ taskId }) => (taskId === "task_2"
        ? { ok: false, sha: null, refused: ["src/lib/f2.ts"], reason: "path not allowed" }
        : { ok: true, sha: "s1", refused: [], reason: "" }),
      openJobPr: async () => { throw new Error("openJobPr must not be reached"); },
    },
    baseSha: () => "abc1234",
  });
  const j = shippableJob(h, 2);
  const out = await h.mgr.ship(j.id);
  assert.equal(out.ok, false);
  assert.notEqual(h.jobs.get(j.id).status, "shipped", "a partial ship must never read as shipped");
  assert.match(out.reason, /path not allowed|task_2/);
});

test("MS-5: `gh` absent → shipped as a BRANCH, and the absence is recorded, not hidden", async () => {
  const h = harness({
    pr: {
      createJobBranch: async (jobId) => ({ ok: true, branch: `ma/job/${jobId}`, worktree: "/wt", reason: "" }),
      commitTask: async () => ({ ok: true, sha: "s", refused: [], reason: "" }),
      openJobPr: async () => ({ mode: "branch", prUrl: null, reason: "gh unavailable or unauthenticated" }),
    },
    baseSha: () => "abc1234",
  });
  const j = shippableJob(h);
  const out = await h.mgr.ship(j.id);
  assert.ok(out.ok, out.reason);
  assert.equal(h.jobs.get(j.id).status, "shipped");
  assert.equal(h.jobs.get(j.id).prUrl, null, "a branch-only ship must not fabricate a PR url");
  assert.match(out.mode, /branch/);
});

test("MS-6: a branch that cannot be created stops the ship before any commit", async () => {
  const h = harness({
    pr: {
      createJobBranch: async () => ({ ok: false, branch: null, worktree: null, reason: "branch already exists" }),
      commitTask: async () => { throw new Error("commitTask must not be reached"); },
      openJobPr: async () => { throw new Error("openJobPr must not be reached"); },
    },
    baseSha: () => "abc1234",
  });
  const j = shippableJob(h);
  const out = await h.mgr.ship(j.id);
  assert.equal(out.ok, false);
  assert.match(out.reason, /already exists/);
  assert.notEqual(h.jobs.get(j.id).status, "shipped");
});

test("MS-7: a task with NO changed paths is skipped, not committed empty", async () => {
  const h = harness();
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  h.jobs.setTasks(j.id, [{ title: "a", skillsRequired: ["api"], steps: ["s"] }, { title: "b", skillsRequired: ["api"], steps: ["s"] }]);
  const [t1, t2] = h.jobs.tasks(j.id);
  h.jobs.updateTask(t1.id, { seat: "sr-backend", taskId: "task_1", status: "done", changedPaths: ["src/lib/x.ts"] });
  h.jobs.updateTask(t2.id, { seat: "sr-backend", taskId: "task_2", status: "done", changedPaths: [] });
  h.jobs.setStatus(j.id, "building"); h.jobs.setStatus(j.id, "review"); h.jobs.setStatus(j.id, "awaiting-you");
  await h.mgr.ship(j.id);
  assert.equal(h.calls.commits.length, 1, "a task that changed nothing must not produce a commit");
});

test("MS-8: shipping an already-shipped job is refused — no second branch", async () => {
  const h = harness();
  const j = shippableJob(h);
  await h.mgr.ship(j.id);
  const again = await h.mgr.ship(j.id);
  assert.equal(again.ok, false);
  assert.equal(h.calls.branch.length, 1, "a second ship would open a second branch for one job");
});

test("SHIP-1: a task whose worktree is gone BLOCKS the job with a reason naming the task — never a silent return", async () => {
  // Phase B · Task 4. The commit rung already returns { ok:false, reason:"no worktree for task …" }
  // when pathFor(taskId) is null; the Manager returned that silently and the job sat in
  // awaiting-you with its gate decided (Codex F09 half). Mutation proof (2026-09-17): setStatus("blocked") removed →
  //   ✖ SHIP-1  actual: 'awaiting-you', expected: 'blocked'. Restored, md5 matched.
  const failing = {
    createJobBranch: async (jobId) => ({ ok: true, branch: `ma/job/${jobId}`, worktree: "/wt/job", reason: "" }),
    commitTask: async ({ taskId }) => ({ ok: false, sha: null, refused: [], reason: `no worktree for task ${taskId}` }),
    openJobPr: async () => ({ mode: "pr", prUrl: "x", reason: "" }),
  };
  const h = harness({ pr: failing });
  const j = shippableJob(h, 2);
  const out = await h.mgr.ship(j.id);
  assert.equal(out.ok, false);
  const job = h.jobs.get(j.id);
  assert.equal(job.status, "blocked", "the job must not stay awaiting-you with nobody waiting on the human");
  assert.match(String(job.blockedOn || ""), /t1/, "the reason names the task title");
  assert.match(String(job.blockedOn || ""), /no worktree/);
});

// ── Phase B · Task 5 — "shipped" means shipped ──────────────────────────────────────────
// PES addendum #39 / Codex F12, reproduced: zero commits, no PR, and the job still flipped to
// `shipped`. Mutation proofs (2026-09-17): guard `=== 0` → `=== -1` → ✖ SHIP-2 actual: true, expected: false;
// outcome hard-coded "local-branch" → ✖ SHIP-3 actual: 'local-branch', expected: 'pr'. Both restored, md5 matched.
test("SHIP-2: a job whose tasks produced NO commits is not shipped — it blocks, by reason", async () => {
  const h = harness();
  const j = h.jobs.create({ title: "Nothing happened", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  h.jobs.setTasks(j.id, [{ title: "t1", skillsRequired: ["api"], steps: ["s"] }, { title: "t2", skillsRequired: ["api"], steps: ["s"] }]);
  for (const t of h.jobs.tasks(j.id)) h.jobs.updateTask(t.id, { seat: "sr-backend", taskId: `task_${t.id}`, status: "done", changedPaths: [] });
  h.jobs.setStatus(j.id, "building"); h.jobs.setStatus(j.id, "review"); h.jobs.setStatus(j.id, "awaiting-you");
  const out = await h.mgr.ship(j.id);
  assert.equal(out.ok, false);
  assert.equal(h.calls.commits.length, 0, "nothing was there to commit");
  assert.equal(h.calls.pr.length, 0, "no PR is opened for an empty branch");
  const job = h.jobs.get(j.id);
  assert.notEqual(job.status, "shipped", "an empty ship must not report success");
  assert.equal(job.status, "blocked");
  assert.match(String(job.blockedOn || ""), /no commits|nothing to ship/i);
});

test("SHIP-3: the outcome is recorded — pr / pushed / local-branch — and shipped only on a real commit", async () => {
  for (const [pr, expectOutcome] of [
    [{ mode: "pr", prUrl: "https://github.com/a/b/pull/7", pushed: true, reason: "" }, "pr"],
    [{ mode: "branch", prUrl: null, pushed: true, reason: "no gh" }, "pushed"],
    [{ mode: "branch", prUrl: null, pushed: false, reason: "no remote" }, "local-branch"],
  ]) {
    const h = harness({ pr: {
      createJobBranch: async (jobId) => ({ ok: true, branch: `ma/job/${jobId}`, worktree: "/wt/job", reason: "" }),
      commitTask: async () => ({ ok: true, sha: "abc", refused: [], reason: "" }),
      openJobPr: async () => pr,
    } });
    const j = shippableJob(h, 1);
    const out = await h.mgr.ship(j.id);
    assert.ok(out.ok, out.reason);
    const job = h.jobs.get(j.id);
    assert.equal(job.status, "shipped");
    assert.equal(job.summary?.ship?.outcome, expectOutcome, JSON.stringify(job.summary?.ship));
  }
});

test("SHIP-4 (GOOD leg): a job with one task that changed files and one honest no-op task ships with one commit", async () => {
  const h = harness();
  const j = h.jobs.create({ title: "Mixed", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  h.jobs.setTasks(j.id, [{ title: "real", skillsRequired: ["api"], steps: ["s"] }, { title: "noop", skillsRequired: ["api"], steps: ["s"] }]);
  const [a, b] = h.jobs.tasks(j.id);
  h.jobs.updateTask(a.id, { seat: "sr-backend", taskId: "task_a", status: "done", changedPaths: ["src/lib/a.ts"] });
  h.jobs.updateTask(b.id, { seat: "sr-backend", taskId: "task_b", status: "done", changedPaths: [] });
  h.jobs.setStatus(j.id, "building"); h.jobs.setStatus(j.id, "review"); h.jobs.setStatus(j.id, "awaiting-you");
  const out = await h.mgr.ship(j.id);
  assert.ok(out.ok, out.reason);
  assert.equal(h.calls.commits.length, 1);
  assert.equal(h.jobs.get(j.id).status, "shipped");
});

test("SHIP-5: the ship stage is persisted BEFORE each rung, and a failed branch rung blocks the job by reason", async () => {
  // Phase B · Task 6. A crash or failure between the BOSS's yes and the PR left no record of how
  // far the ladder got (Codex F09). Mutation proof (2026-09-17): `stage("branch")` commented out →
  //   ✖ SHIP-5 actual: undefined, expected: 'branch'. Restored, md5 matched.
  const failing = {
    createJobBranch: async () => ({ ok: false, branch: "", worktree: "", reason: "git worktree add failed" }),
    commitTask: async () => ({ ok: true, sha: "x", refused: [], reason: "" }),
    openJobPr: async () => ({ mode: "pr", prUrl: "x", reason: "" }),
  };
  const h = harness({ pr: failing });
  const j = shippableJob(h, 1);
  const out = await h.mgr.ship(j.id);
  assert.equal(out.ok, false);
  const job = h.jobs.get(j.id);
  assert.equal(job.summary?.ship?.stage, "branch", "the stage that was attempted is on the job");
  assert.equal(job.status, "blocked");
  assert.match(String(job.blockedOn || ""), /ship failed after approval/);
  assert.match(String(job.blockedOn || ""), /git worktree add failed/);
});

test("SHIP-6 (GOOD leg): a full ship records stage=pr and the outcome", async () => {
  const h = harness();
  const j = shippableJob(h, 1);
  const out = await h.mgr.ship(j.id);
  assert.ok(out.ok, out.reason);
  const job = h.jobs.get(j.id);
  assert.equal(job.summary?.ship?.stage, "pr");
  assert.equal(job.summary?.ship?.outcome, "pr");
});

test("SHIP-7: a rung that THROWS blocks the job by reason instead of rejecting into a decided gate", async () => {
  // G7 (2026-09-17) LOW: the rungs had no try/catch; safety rested on pr.mjs never throwing.
  // Mutation proof (2026-09-17): catch rewritten to `throw e` → ✖ SHIP-7 (fail 1). Restored, md5 ok.
  const h = harness({ pr: {
    createJobBranch: async () => { throw new Error("boom: git exploded"); },
    commitTask: async () => ({ ok: true, sha: "x", refused: [], reason: "" }),
    openJobPr: async () => ({ mode: "pr", prUrl: "x", reason: "" }),
  } });
  const j = shippableJob(h, 1);
  const out = await h.mgr.ship(j.id);
  assert.equal(out.ok, false);
  assert.equal(h.jobs.get(j.id).status, "blocked");
  assert.match(String(h.jobs.get(j.id).blockedOn || ""), /boom: git exploded/);
});

test("SHIP-TREE-KEEP-1: shipping PRESERVES the approved tree pin — a re-ship must still be able to refuse a moved branch", async () => {
  // FOUND BY LIVE RUN 6, not by a test. The gate carried
  // `"tree": "bc3351c364337f…"`; the shipped record carried `"tree": null`, and `worktree`
  // was gone too. The final setSummary in ship() builds a FRESH `ship` object instead of
  // spreading the one already there, so every field the review rung wrote is erased at the
  // moment of shipping.
  //
  // This is not only a lost audit line. `ship()` refuses when `known.tree` disagrees with the
  // branch's current tree — so once the pin is gone, a SECOND ship (a resume, a retry, an
  // operator re-approval) reads `known.tree` as undefined, skips the comparison entirely, and
  // the branch-moved refusal silently stops existing. A guard that disarms itself on its own
  // success is worse than one that was never wired (addendum #1).
  const h = harness({ pr: {
    createJobBranch: async (jobId) => ({ ok: true, branch: `ma/job/${jobId}`, worktree: "/wt/job", reason: "" }),
    commitTask: async () => ({ ok: true, sha: "sha1", refused: [], reason: "" }),
    openJobPr: async () => ({ mode: "branch", prUrl: null, pushed: false, reason: "no remote" }),
    treeOf: async () => "tree_approved_aaaa",
  } });
  const j = shippableJob(h, 1);
  // The review rung records what the BOSS approved.
  const before = h.jobs.get(j.id);
  h.jobs.setSummary(j.id, { ...(before.summary || {}), ship: { ...(before.summary?.ship || {}), branch: `ma/job/${j.id}`, worktree: "/wt/job", tree: "tree_approved_aaaa" } }, null);

  const out = await h.mgr.ship(j.id);
  assert.ok(out.ok, out.reason);

  const ship = h.jobs.get(j.id).summary.ship;
  assert.equal(ship.tree, "tree_approved_aaaa",
    `the approved tree must survive the ship: ${JSON.stringify(ship)}`);
  assert.equal(ship.worktree, "/wt/job", "and the worktree the commits were assembled in");
  // The fields ship() itself writes are still there — this is a merge, not a revert.
  assert.equal(ship.outcome, "local-branch");
  assert.equal(ship.commits.length, 1);
});

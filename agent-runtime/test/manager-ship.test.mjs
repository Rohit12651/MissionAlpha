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

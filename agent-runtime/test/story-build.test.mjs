// Story-Pipeline S3 — the Build-stage aggregator + goal-completion → stage-advance driver.
//
// Two layers of proof:
//   1. UNIT — createStoryBuild over injected fakes (goal plans + a queue.all() stub + a stories
//      stub + a captured mintAlert). Pins aggregate() shape and the onTerminalTask() verdicts:
//      running → no-op, all-done → advance build→review-qa, ≥N failures → blocked + one alert,
//      and idempotency (a second terminal event does not double-advance / double-mint).
//   2. INTEGRATION — the REAL engine + REAL queue + a deterministic writing dispatch + REAL
//      stories, driven all the way to DONE, proving the terminal-task seam advances the story
//      through the same machinery the booted runtime wires (the happy-path wire proof).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createStoryBuild } from "../story-build.mjs";
import { createQueue } from "../queue.mjs";
import { createPolicy } from "../policy.mjs";
import { createWorktreeMgr } from "../worktree.mjs";
import { createBroker } from "../broker.mjs";
import { createScheduler } from "../scheduler.mjs";
import { createEngine } from "../engine.mjs";
import { openDb } from "../db.mjs";
import { createStories } from "../stories.mjs";

// ── UNIT: a fake world (goal plans + task table + a stories stub) ─────────────────────
function fakeWorld({ failThreshold } = {}) {
  const goalPlans = []; // {goalId, agentId, storyId, steps, tier}
  const tasks = [];      // {taskId, goalId, stepIndex, status, ...}
  const alerts = [];
  const advances = [];
  const updates = [];
  const storiesById = new Map();
  const stories = {
    getStory: (id) => storiesById.get(id) || null,
    advance: (id, m) => { advances.push({ id, m }); const s = storiesById.get(id); if (s) { s.stage = "review-qa"; s.status = "active"; } return s; },
    update: (id, m) => { updates.push({ id, m }); const s = storiesById.get(id); if (s && m.status) s.status = m.status; return s; },
  };
  const queue = { all: () => tasks };
  const sb = createStoryBuild({
    goals: () => goalPlans,
    queue,
    stories,
    loopSteps: { list: (taskId) => [{ seq: 1, kind: "think", tool: "", summary: `step for ${taskId}` }] },
    mintAlert: (info) => alerts.push(info),
    failThreshold,
  });
  const putStory = (id, stage = "build", status = "active") => storiesById.set(id, { id, stage, status });
  const addGoal = (g) => goalPlans.push(g);
  const addTask = (t) => tasks.push({ attempts: 0, ...t });
  return { sb, addGoal, addTask, putStory, alerts, advances, updates };
}

test("aggregate folds goals + tasks + loop steps into the Build-panel shape", () => {
  const w = fakeWorld();
  w.putStory("story_1");
  w.addGoal({ goalId: "goal_a", agentId: "sr-backend", storyId: "story_1", steps: ["s0", "s1"], tier: "sonnet" });
  w.addGoal({ goalId: "goal_b", agentId: "sr-frontend", storyId: "story_1", steps: ["s0"], tier: "sonnet" });
  w.addGoal({ goalId: "goal_other", agentId: "sr-backend", storyId: "story_2", steps: ["x"] }); // different story
  w.addTask({ taskId: "task_a0", goalId: "goal_a", stepIndex: 0, status: "done" });
  w.addTask({ taskId: "task_a1", goalId: "goal_a", stepIndex: 1, status: "held", heldReason: "policy=manual" });
  w.addTask({ taskId: "task_b0", goalId: "goal_b", stepIndex: 0, status: "done" });

  const out = w.sb.aggregate("story_1");
  assert.equal(out.total, 2, "only this story's goals");
  const backend = out.goals.find((g) => g.seat === "sr-backend");
  assert.equal(backend.tasks.length, 2);
  assert.equal(backend.state, "running", "final step held → not terminal");
  assert.equal(backend.tasks[1].heldReason, "policy=manual", "hold surfaces in the panel");
  assert.equal(backend.tasks[0].loopSteps.length, 1, "loop steps attached per task");
  const frontend = out.goals.find((g) => g.seat === "sr-frontend");
  assert.equal(frontend.state, "done", "single-step goal whose step is done → done");
  assert.deepEqual(out.counts, { done: 1, failed: 0, running: 1 });
});

test("onTerminalTask: still running → no advance, no block", () => {
  const w = fakeWorld();
  w.putStory("story_1");
  w.addGoal({ goalId: "goal_a", agentId: "sr-backend", storyId: "story_1", steps: ["s0"] });
  w.addGoal({ goalId: "goal_b", agentId: "sr-frontend", storyId: "story_1", steps: ["s0"] });
  w.addTask({ taskId: "task_a0", goalId: "goal_a", stepIndex: 0, status: "done" });
  w.addTask({ taskId: "task_b0", goalId: "goal_b", stepIndex: 0, status: "claimed" });
  const r = w.sb.onTerminalTask("story_1");
  assert.equal(r.pending, true);
  assert.equal(w.advances.length, 0);
});

test("onTerminalTask: all goals done → advance build→review-qa, idempotently", () => {
  const w = fakeWorld();
  w.putStory("story_1");
  w.addGoal({ goalId: "goal_a", agentId: "sr-backend", storyId: "story_1", steps: ["s0"] });
  w.addGoal({ goalId: "goal_b", agentId: "sr-frontend", storyId: "story_1", steps: ["s0"] });
  w.addTask({ taskId: "task_a0", goalId: "goal_a", stepIndex: 0, status: "done" });
  w.addTask({ taskId: "task_b0", goalId: "goal_b", stepIndex: 0, status: "done" });
  const r = w.sb.onTerminalTask("story_1");
  assert.equal(r.advanced, true);
  assert.equal(w.advances.length, 1, "advanced once");
  // Story is now at review-qa (the stub moved it) → a second terminal event is a no-op.
  const r2 = w.sb.onTerminalTask("story_1");
  assert.equal(r2.skipped, true);
  assert.equal(w.advances.length, 1, "no double advance");
});

test("onTerminalTask: a failed goal blocks the story and mints exactly one alert", () => {
  const w = fakeWorld(); // default threshold = 1
  w.putStory("story_1");
  w.addGoal({ goalId: "goal_a", agentId: "sr-backend", storyId: "story_1", steps: ["s0"] });
  w.addGoal({ goalId: "goal_b", agentId: "sr-frontend", storyId: "story_1", steps: ["s0"] });
  w.addTask({ taskId: "task_a0", goalId: "goal_a", stepIndex: 0, status: "done" });
  w.addTask({ taskId: "task_b0", goalId: "goal_b", stepIndex: 0, status: "failed" });
  const r = w.sb.onTerminalTask("story_1");
  assert.equal(r.blocked, true);
  assert.equal(r.failed, 1);
  assert.equal(w.updates.at(-1).m.status, "blocked", "story parked blocked");
  assert.equal(w.alerts.length, 1, "one Inbox alert");
  assert.equal(w.alerts[0].taskId, "story_1", "alert keyed to the story (unique per story)");
  assert.equal(w.alerts[0].kind, "build-blocked");

  // Idempotent — a second terminal event finds it already blocked, mints nothing more.
  const r2 = w.sb.onTerminalTask("story_1");
  assert.equal(r2.blocked, true);
  assert.equal(w.alerts.length, 1, "no duplicate alert");
});

test("onTerminalTask: a higher failThreshold tolerates a single failure and still advances when the rest pass", () => {
  const w = fakeWorld({ failThreshold: 2 });
  w.putStory("story_1");
  w.addGoal({ goalId: "goal_a", agentId: "sr-backend", storyId: "story_1", steps: ["s0"] });
  w.addGoal({ goalId: "goal_b", agentId: "sr-frontend", storyId: "story_1", steps: ["s0"] });
  w.addTask({ taskId: "task_a0", goalId: "goal_a", stepIndex: 0, status: "done" });
  w.addTask({ taskId: "task_b0", goalId: "goal_b", stepIndex: 0, status: "failed" });
  const r = w.sb.onTerminalTask("story_1"); // 1 failure < threshold 2 → advance
  assert.equal(r.advanced, true);
  assert.equal(w.alerts.length, 0);
});

// ── INTEGRATION: real engine drives a goal to DONE → the seam advances the story ──────
let root, repoRoot, storeDir, dbh, clock;
const git = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); }
  return false;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-storybuild-")));
  repoRoot = join(root, "repo");
  storeDir = join(root, "store");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
  git(["add", "-A"]); git(["commit", "-q", "-m", "init"]);
  dbh = openDb({ path: join(root, "data", "mission.db"), patchesDir: join(root, "patches") });
  clock = 1_700_000_000_000;
});
afterEach(() => { try { dbh.close(); } catch { /* */ } try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

test("INTEGRATION: a real goal that reaches DONE advances its story build→review-qa", async () => {
  const now = () => clock;
  const queue = createQueue({ dir: storeDir, now, maxPerAgent: 2 });
  const policy = createPolicy({ file: join(storeDir, "policy.json"), token: "tk" });
  policy.setLevel("sr-backend", "auto-safe"); // opt the seat into auto-apply so the goal reaches DONE
  const worktreeMgr = createWorktreeMgr({ repoRoot, worktreeRoot: join(root, "wt") });
  const broker = createBroker({ repoRoot, workdirFor: (id) => worktreeMgr.pathFor(id), scrub: (s) => s });
  let inUse = 0;
  const scheduler = createScheduler({ tryAcquireSlot: () => (inUse >= 2 ? false : (inUse++, true)), releaseSlot: () => { inUse = Math.max(0, inUse - 1); }, claimNext: () => queue.claimNext() });
  const stories = createStories({ db: dbh.db, scrub: (s) => s });

  let sb;
  const engine = createEngine({
    queue, policy, worktreeMgr, scheduler, broker,
    dispatchFn: async (ctx) => {
      // src/* is the policy's auto-safe class → the step auto-applies and reaches DONE.
      const dest = join(ctx.workdir, "src", "impl.ts");
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, `export const impl = "${ctx.task.replace(/[^a-z0-9 ]/gi, "")}";\n`);
      return { acc: "wrote file" };
    },
    now, goalsDir: join(storeDir, "goals"), jitter: () => 0,
    onDone: (task) => { if (task.storyId && sb) sb.onTerminalTask(task.storyId); },
    onTerminalFailure: (task) => { if (task.storyId && sb) sb.onTerminalTask(task.storyId); },
  });
  sb = createStoryBuild({ goals: () => engine._goalPlans.values(), queue, stories });
  engine.start();

  // A story sitting at `build` (drive it there through the closed machine).
  const s = stories.createStory({ title: "Real build", idea: "do the thing" });
  for (let i = 0; i < 4; i++) stories.advance(s.id, {}); // idea→requirements→design→plan→build
  assert.equal(stories.getStory(s.id).stage, "build");

  engine.enqueueGoal({ agentId: "sr-backend", storyId: s.id, steps: ["implement it"] });
  const advanced = await until(() => stories.getStory(s.id).stage === "review-qa", 5000);
  assert.ok(advanced, "the DONE goal advanced the story into review-qa");
  assert.equal(stories.getStory(s.id).status, "active");

  const build = sb.aggregate(s.id);
  assert.equal(build.total, 1);
  assert.equal(build.goals[0].seat, "sr-backend");
  assert.equal(build.goals[0].state, "done");
});

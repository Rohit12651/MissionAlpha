// Story-Pipeline S4 — the RED→GREEN loop proven through the REAL engine. A real queue +
// worktree + broker + stories + storyBuild, a deterministic writing dispatch, and an injected
// test gate that FAILS the first diff then passes. Proves: a failing gate mints a bounded fix
// retry (the seat re-runs), the gate re-runs, green → the diff applies and the story advances
// build→review-qa; and an always-failing gate exhausts the budget → the story blocks.
//
// Time is collapsed: a fast setTimer advances the injected clock by the backoff delay, so the
// engine's real wake/backoff machinery runs at full fidelity without real wall-clock waits.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createQueue } from "../queue.mjs";
import { createPolicy } from "../policy.mjs";
import { createWorktreeMgr } from "../worktree.mjs";
import { createBroker } from "../broker.mjs";
import { createScheduler } from "../scheduler.mjs";
import { createEngine } from "../engine.mjs";
import { openDb } from "../db.mjs";
import { createStories } from "../stories.mjs";
import { createStoryBuild } from "../story-build.mjs";

let root, repoRoot, storeDir, dbh, clock;
const git = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const until = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); }
  return false;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-s4-gate-")));
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

// Build a real engine wired to a story at `build`, with an injected test gate.
function buildWorld({ gate }) {
  const now = () => clock;
  const setTimer = (fn, ms) => { const t = setTimeout(() => { clock += (Number(ms) || 0) + 1; fn(); }, 1); if (t.unref) t.unref(); return t; };
  const queue = createQueue({ dir: storeDir, now, maxPerAgent: 2 });
  const policy = createPolicy({ file: join(storeDir, "policy.json"), token: "tk" });
  policy.setLevel("sr-backend", "auto-safe");
  const worktreeMgr = createWorktreeMgr({ repoRoot, worktreeRoot: join(root, "wt") });
  const broker = createBroker({ repoRoot, workdirFor: (id) => worktreeMgr.pathFor(id), scrub: (s) => s });
  let inUse = 0;
  const scheduler = createScheduler({ tryAcquireSlot: () => (inUse >= 2 ? false : (inUse++, true)), releaseSlot: () => { inUse = Math.max(0, inUse - 1); }, claimNext: () => queue.claimNext() });
  const stories = createStories({ db: dbh.db, scrub: (s) => s });
  let sb;
  const engine = createEngine({
    queue, policy, worktreeMgr, scheduler, broker,
    dispatchFn: async (ctx) => {
      const dest = join(ctx.workdir, "src", "impl.ts");
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, `export const impl = "${String(ctx.task).replace(/[^a-z0-9 ]/gi, "")}";\n`);
      return { acc: "wrote file" };
    },
    testGateFn: gate,
    now, setTimer, goalsDir: join(storeDir, "goals"), jitter: () => 0,
    onDone: (task) => { if (task.storyId && sb) sb.onTerminalTask(task.storyId); },
    onTerminalFailure: (task) => { if (task.storyId && sb) sb.onTerminalTask(task.storyId); },
  });
  sb = createStoryBuild({ goals: () => engine._goalPlans.values(), queue, stories });
  engine.start();
  const s = stories.createStory({ title: "S4 build", idea: "do it well" });
  for (let i = 0; i < 4; i++) stories.advance(s.id, {}); // → build
  return { engine, queue, stories, sb, story: s };
}

test("RED→GREEN: a gate that fails once mints a fix retry, then green advances the story", async () => {
  let calls = 0;
  const gate = async ({ workdir }) => {
    assert.ok(workdir, "gate runs inside the worktree");
    calls += 1;
    return calls === 1 ? { pass: false, tail: "AssertionError: expected 2 to equal 3", exitCode: 1 } : { pass: true };
  };
  const w = buildWorld({ gate });
  w.engine.enqueueGoal({ agentId: "sr-backend", storyId: w.story.id, steps: ["implement it"] });

  const advanced = await until(() => w.stories.getStory(w.story.id).stage === "review-qa", 6000);
  assert.ok(advanced, "green gate advanced the story into review-qa");
  assert.ok(calls >= 2, "the gate ran again after the fix (red→green)");
  // The task carries a retry (attempts incremented by the test-failed loop).
  const tasks = w.queue.all().filter((t) => t.storyId === w.story.id);
  assert.ok(tasks.some((t) => (t.attempts ?? 0) >= 1), "a fix retry was minted");
});

test("EXHAUST: a gate that always fails blocks the story after the retry budget", async () => {
  const gate = async () => ({ pass: false, tail: "still failing", exitCode: 1 });
  const w = buildWorld({ gate });
  w.engine.enqueueGoal({ agentId: "sr-backend", storyId: w.story.id, steps: ["implement it"] });

  const blocked = await until(() => w.stories.getStory(w.story.id).status === "blocked", 8000);
  assert.ok(blocked, "an unfixable test failure blocks the story");
  assert.equal(w.stories.getStory(w.story.id).stage, "build", "the story stays at build when blocked");
});

test("NON-story tasks skip the gate entirely (pre-S4 behaviour preserved)", async () => {
  let ran = false;
  const gate = async () => { ran = true; return { pass: false, tail: "x" }; };
  const w = buildWorld({ gate });
  // A goal with NO storyId — a manual/cadence run. The gate must never fire.
  w.engine.enqueueGoal({ agentId: "sr-backend", steps: ["do a manual thing"] });
  await until(() => w.queue.all().some((t) => t.status === "done"), 4000);
  assert.equal(ran, false, "the quality gate must not run for a non-story task");
});

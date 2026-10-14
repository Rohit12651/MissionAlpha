// ADR-024 INTEGRATION — the S1 acceptance proof. A BOSS goal ("create a project")
// auto-chains end-to-end: enqueue → worktree → agent edits → diff → policy gate →
// auto-apply (safe) / hold (risky) → reportBack → chain next → DONE. Uses REAL queue
// + REAL git worktrees + REAL broker + REAL policy + REAL scheduler; the agent is an
// injected deterministic fake (no live `claude`). Covers chain, hold, operator-apply,
// retry/self-heal, apply-rejected (non-retryable), parallel drain, cancel, reconcile.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createQueue } from "../queue.mjs";
import { createPolicy } from "../policy.mjs";
import { createWorktreeMgr } from "../worktree.mjs";
import { createBroker } from "../broker.mjs";
import { createScheduler } from "../scheduler.mjs";
import { createEngine } from "../engine.mjs";
import { parse } from "acorn";

let root, repoRoot, worktreeRoot, storeDir, clock;
const TOKEN = "engine-test-token";
const git = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const now = () => clock;

/**
 * Wait until a serialised view of the store stops changing — two identical reads `stableMs`
 * apart, or the budget expires. Used to let an engine whose dispatch never settles finish
 * whatever it was mid-way through BEFORE afterEach deletes the directory under it.
 */
const quietStore = async (read, { stableMs = 250, budgetMs = 3000 } = {}) => {
  const t0 = Date.now();
  let last = read();
  while (Date.now() - t0 < budgetMs) {
    await new Promise((r) => setTimeout(r, stableMs));
    const next = read();
    if (next === last) return true;
    last = next;
  }
  return false;
};

const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-engine-test-")));
  repoRoot = join(root, "repo");
  worktreeRoot = join(root, "worktrees");
  storeDir = join(root, "store");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repoRoot, "src", "seed.ts"), "export const seed = 1;\n");
  writeFileSync(join(repoRoot, "README.md"), "# repo\n");
  writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "vite build" } }, null, 2) + "\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  clock = 1_700_000_000_000;
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

// Build a fully-real engine with an injected agent (dispatchFn). `writeFiles` is a
// map: taskText → [{path, content}] the fake agent writes into the worktree.
// `autoStart: false` builds the engine WITHOUT calling start(), which is the only way
// to exercise reconcile()'s boot-only claimed→requeue branch now that the branch is
// gated on the engine having booted (P4 hardening — see the `booted` flag in engine.mjs).
//
// Timers default to INERT recorders (same posture as autonomy.test.mjs's rig). With
// the real unref'd setTimeout, a retry test's wake outlived its own test: afterEach
// deleted the store dir, `clock` advanced in a LATER test, and the stale timer then
// fired claimNext() against a queue whose directory no longer existed — an ENOENT
// raised as asynchronous activity after the test ended, which node reports as a
// file-level failure. Every test that actually needs a wake to fire injects its own.
function buildEngine({
  writeFiles = {}, maxInflight = 2, dispatchOverride, maxQueued = 500, onTerminalFailure, brokerOverride,
  setTimer = () => ({ __inert: true }), clearTimer = () => {}, autoStart = true, onDone, retryFloorMs,
  watchdogMs, log, stuckAfterMs,
} = {}) {
  const queue = createQueue({ dir: storeDir, now, maxQueued, leaseMs: 600_000, maxPerAgent: 2 });
  const policy = createPolicy({ file: join(storeDir, "policy.json"), token: TOKEN });
  const worktreeMgr = createWorktreeMgr({ repoRoot, worktreeRoot });
  const broker = brokerOverride || createBroker({ repoRoot, workdirFor: (id) => worktreeMgr.pathFor(id), scrub: (s) => s });
  let inUse = 0;
  const tryAcquireSlot = () => (inUse >= maxInflight ? false : (inUse++, true));
  const releaseSlot = () => { inUse = Math.max(0, inUse - 1); };
  const scheduler = createScheduler({ tryAcquireSlot, releaseSlot, claimNext: () => queue.claimNext() });
  const reports = [];
  const escalations = [];
  const dispatchFn = dispatchOverride || (async (ctx) => {
    const files = writeFiles[ctx.task] || writeFiles["*"] || [];
    for (const f of files) {
      const dest = join(ctx.workdir, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
    }
    return { acc: `wrote ${files.length} files` };
  });
  const engine = createEngine({
    queue, policy, worktreeMgr, scheduler, broker, dispatchFn,
    reportBackFn: (agentId, summary) => reports.push({ agentId, summary }),
    escalateFn: (agentId, kind, attempts, reason) => escalations.push({ agentId, kind, attempts, reason }),
    onTerminalFailure, onDone, setTimer, clearTimer, retryFloorMs,
    now, goalsDir: join(storeDir, "goals"), jitter: () => 0,
    ...(watchdogMs === undefined ? {} : { watchdogMs }),
    ...(log ? { log } : {}),
    ...(stuckAfterMs === undefined ? {} : { stuckAfterMs }),
  });
  if (autoStart) engine.start();
  return { engine, queue, policy, worktreeMgr, broker, reports, escalations, inUseRef: () => inUse, scheduler };
}

const goalDone = (queue, goalId) => () => {
  const tasks = queue.all().filter((t) => t.goalId === goalId);
  return tasks.length > 0 && tasks.every((t) => ["done", "failed", "cancelled", "held"].includes(t.status));
};

// ── S3 — enqueueGoal threads storyId into the goal plan AND every task record ─────────
test("S3: storyId lands on the persisted goal plan and on every chained task record", async () => {
  const { engine, queue } = buildEngine({
    writeFiles: {
      "step one": [{ path: "src/one.ts", content: "export const one = 1;\n" }],
      "step two": [{ path: "src/two.ts", content: "export const two = 2;\n" }],
    },
  });
  // (default policy is manual → steps HOLD; that is fine — we assert the storyId TAGGING, not
  // the apply. Each step's task record must carry the story back-pointer regardless of gate.)
  const r = engine.enqueueGoal({ agentId: "senior-web-1", storyId: "story_abc123", steps: ["step one", "step two"] });
  assert.ok(r.goalId, "goal enqueued");

  // The persisted goal plan JSON carries storyId (survives a restart → the Build panel finds it).
  const planFile = join(storeDir, "goals", `${r.goalId}.json`);
  const plan = JSON.parse(readFileSync(planFile, "utf-8"));
  assert.equal(plan.storyId, "story_abc123", "goal plan JSON carries storyId");

  // Step 0's task record carries storyId immediately.
  assert.equal(queue.get(r.firstTaskId).storyId, "story_abc123", "step-0 task tagged");

  // Drive to the first HOLD, approve it → chainNext enqueues step 1, which must ALSO be tagged.
  const held = await until(() => queue.all().some((t) => t.status === "held"));
  assert.ok(held, "step 0 reached a hold");
  const step0 = queue.all().find((t) => t.status === "held");
  engine.onOperatorApplied(step0.taskId);
  const step1 = await until(() => queue.all().some((t) => (t.stepIndex ?? 0) === 1));
  assert.ok(step1, "step 1 enqueued");
  const s1 = queue.all().find((t) => (t.stepIndex ?? 0) === 1);
  assert.equal(s1.storyId, "story_abc123", "the chained step carries storyId too");

  // An untagged goal (every pre-S3 caller) records null — nothing changes for them.
  const r2 = engine.enqueueGoal({ agentId: "senior-web-1", steps: ["step one"] });
  assert.equal(queue.get(r2.firstTaskId).storyId, null, "untagged goal → null storyId");
});

test("ACCEPTANCE: 'create a project' auto-chains 2 safe steps to applied, zero manual clicks", async () => {
  const { engine, queue, policy, reports } = buildEngine({
    writeFiles: {
      "scaffold app shell": [{ path: "src/index.tsx", content: "import './App';\n" }, { path: "src/App.tsx", content: "export const App = () => 'hi';\n" }],
      "add a component": [{ path: "src/Button.tsx", content: "export const Button = () => null;\n" }],
    },
  });
  policy.setLevel("senior-web-1", "auto-safe"); // BOSS opts the agent into auto-apply

  const { goalId } = engine.enqueueGoal({ agentId: "senior-web-1", tier: "sonnet", steps: ["scaffold app shell", "add a component"] });
  assert.ok(await until(() => {
    const t = queue.all().filter((x) => x.goalId === goalId);
    return t.length === 2 && t.every((x) => x.status === "done");
  }, 5000), "both chained steps reached DONE");

  // the files actually landed in the live repo (applied through the broker)
  assert.ok(existsSync(join(repoRoot, "src", "index.tsx")));
  assert.ok(existsSync(join(repoRoot, "src", "App.tsx")));
  assert.ok(existsSync(join(repoRoot, "src", "Button.tsx")));
  assert.equal(reports.length, 2, "reportBack fired per applied step (DONE_CYCLE)");
  // worktrees cleaned up
  const t = queue.all().filter((x) => x.goalId === goalId);
  for (const task of t) assert.equal(engine === engine && existsSync(join(worktreeRoot, task.taskId)), false);
});

test("approval-gated: a manual-policy agent HOLDS the diff (no auto-apply); chain pauses", async () => {
  const { engine, queue } = buildEngine({
    writeFiles: { "step one": [{ path: "src/Held.tsx", content: "export const H = 1;\n" }], "step two": [{ path: "src/Two.tsx", content: "x\n" }] },
  });
  // default policy = manual → must hold
  const { goalId } = engine.enqueueGoal({ agentId: "senior-web-1", steps: ["step one", "step two"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "held")), "step held");
  const tasks = queue.all().filter((t) => t.goalId === goalId);
  assert.equal(tasks.length, 1, "chain paused — step two NOT enqueued while step one held");
  assert.ok(!existsSync(join(repoRoot, "src", "Held.tsx")), "nothing applied to live repo while held");
});

test("risky path always holds even under auto-safe (exec/config gated)", async () => {
  const { engine, queue, policy } = buildEngine({
    writeFiles: { "touch config": [{ path: "src/App.tsx", content: "ok\n" }, { path: "package.json", content: "{}\n" }] },
  });
  policy.setLevel("senior-web-1", "auto-safe");
  const { goalId } = engine.enqueueGoal({ agentId: "senior-web-1", steps: ["touch config"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "held")), "held — risky package.json in diff");
  assert.ok(!existsSync(join(repoRoot, "package.json")) || readFileSync(join(repoRoot, "package.json"), "utf-8").includes("vite build"), "live package.json untouched");
});

test("operator-applies a HELD step → chain advances to the next step", async () => {
  const { engine, queue, broker } = buildEngine({
    writeFiles: { "s1": [{ path: "src/S1.tsx", content: "1\n" }], "s2": [{ path: "src/S2.tsx", content: "2\n" }] },
  });
  const { goalId } = engine.enqueueGoal({ agentId: "senior-web-1", steps: ["s1", "s2"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "held")));
  const held = queue.all().find((t) => t.goalId === goalId && t.status === "held");
  // operator applies via the real broker (as the /apply route would), then notifies engine
  const results = await broker.applyChanges(held.taskId, ["src/S1.tsx"]);
  assert.equal(results[0].ok, true);
  engine.onOperatorApplied(held.taskId);
  assert.ok(await until(() => {
    const t = queue.all().filter((x) => x.goalId === goalId);
    return t.length === 2; // step two now enqueued
  }), "chain advanced after operator apply");
});

test("self-heal: an empty-diff attempt retries, then succeeds", async () => {
  let attempt = 0;
  const { engine, queue } = buildEngine({
    dispatchOverride: async (ctx) => {
      attempt++;
      if (attempt === 1) return { acc: "thought about it" }; // wrote nothing → empty diff
      writeFileSync(join(ctx.workdir, "src", "Late.tsx"), "late\n");
      return { acc: "wrote it" };
    },
  });
  engine.policy?.setLevel?.("a", "auto-safe");
  const { goalId } = engine.enqueueGoal({ agentId: "a", steps: ["do the thing"] });
  // first attempt fails (empty-diff) → retry enqueued with notBefore = clock + backoff
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "failed")), "attempt 0 failed empty-diff");
  // advance the shared clock past the backoff so the retry becomes claimable
  clock += 5000;
  engine.tick();
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.attempts === 1)), "retry attempt enqueued");
});

test("apply-rejected is terminal + NON-retryable + escalates (guard fired)", async () => {
  // broker stub: every apply fails as if a guard fired
  const queue = createQueue({ dir: storeDir, now, maxPerAgent: 2 });
  const policy = createPolicy({ file: join(storeDir, "policy.json"), token: TOKEN });
  policy.setLevel("a", "auto-safe");
  const worktreeMgr = createWorktreeMgr({ repoRoot, worktreeRoot });
  const broker = {
    listChanges: async () => [{ path: "src/x.tsx", status: "new", before: null, after: "y" }],
    applyChanges: async () => [{ path: "src/x.tsx", ok: false, error: "protected key changed: scripts" }],
  };
  let inUse = 0;
  const scheduler = createScheduler({ tryAcquireSlot: () => (inUse >= 2 ? false : (inUse++, true)), releaseSlot: () => { inUse--; }, claimNext: () => queue.claimNext() });
  const escalations = [];
  const engine = createEngine({
    queue, policy, worktreeMgr, scheduler, broker,
    dispatchFn: async () => ({ acc: "x" }),
    escalateFn: (agentId, kind, attempts, reason) => escalations.push({ kind, reason }),
    now, goalsDir: join(storeDir, "goals"), jitter: () => 0,
  });
  engine.start();
  const { goalId } = engine.enqueueGoal({ agentId: "a", steps: ["bad"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "failed")), "terminal failed");
  const tasks = queue.all().filter((t) => t.goalId === goalId);
  assert.equal(tasks.length, 1, "NO retry attempt enqueued (apply-rejected is non-retryable)");
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].kind, "apply-rejected");
});

test("parallel: two independent goals drain concurrently within the slot cap", async () => {
  const { engine, queue, policy } = buildEngine({
    writeFiles: { "g1": [{ path: "src/G1.tsx", content: "1\n" }], "g2": [{ path: "src/G2.tsx", content: "2\n" }] },
    maxInflight: 2,
  });
  policy.setLevel("agent-x", "auto-safe");
  policy.setLevel("agent-y", "auto-safe");
  const a = engine.enqueueGoal({ agentId: "agent-x", steps: ["g1"] });
  const b = engine.enqueueGoal({ agentId: "agent-y", steps: ["g2"] });
  assert.ok(await until(() => goalDone(queue, a.goalId)() && goalDone(queue, b.goalId)(), 5000), "both goals completed");
  assert.ok(existsSync(join(repoRoot, "src", "G1.tsx")));
  assert.ok(existsSync(join(repoRoot, "src", "G2.tsx")));
});

test("cancel: a held step can be cancelled — worktree discarded, never applied", async () => {
  const { engine, queue, worktreeMgr } = buildEngine({
    writeFiles: { "c1": [{ path: "src/C1.tsx", content: "1\n" }] },
  });
  const { goalId } = engine.enqueueGoal({ agentId: "senior-web-1", steps: ["c1"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "held")));
  const held = queue.all().find((t) => t.goalId === goalId);
  engine.cancel(held.taskId);
  assert.equal(queue.get(held.taskId).status, "cancelled");
  assert.equal(worktreeMgr.pathFor(held.taskId), null, "worktree discarded on cancel");
  assert.ok(!existsSync(join(repoRoot, "src", "C1.tsx")), "never applied");
});

test("idempotency: reconcile() on an 'applying' crash marker (empty diff) does not double-apply", async () => {
  const { engine, queue } = buildEngine({});
  // simulate a crash: a task stuck at applyMarker='applying' whose change already landed
  const r = queue.enqueue({ goalId: "goal_x", stepIndex: 0, agentId: "a", tier: "sonnet", task: "x" });
  queue.update(r.taskId, { status: "claimed", engineState: "GATING", applyMarker: "applying" });
  // its worktree has NO pending diff (the apply already completed pre-crash) → empty diff
  await engine.reconcile();
  assert.equal(queue.get(r.taskId).status, "done", "reconciled to done (apply already landed) — no re-apply");
  assert.equal(queue.get(r.taskId).result, "reconciled-applied");
});

test("idempotency: reconcile() RE-APPLIES a still-pending 'applying' diff (the harder branch)", async () => {
  const { engine, queue, worktreeMgr } = buildEngine({});
  const r = queue.enqueue({ goalId: "goal_re", stepIndex: 0, agentId: "a", tier: "sonnet", task: "x" });
  const wt = worktreeMgr.create(r.taskId);             // real worktree
  writeFileSync(join(wt.path, "src", "Recovered.tsx"), "recovered\n"); // a pending, unapplied diff
  queue.update(r.taskId, { status: "claimed", engineState: "GATING", applyMarker: "applying" });
  await engine.reconcile();
  assert.equal(queue.get(r.taskId).status, "done", "re-applied then DONE");
  assert.ok(existsSync(join(repoRoot, "src", "Recovered.tsx")), "pending diff re-applied to the live repo");
});

test("self-heal: empty-diff attempt retries AND the retry succeeds to DONE (recovery closure)", async () => {
  let attempt = 0;
  const { engine, queue, policy } = buildEngine({
    dispatchOverride: async (ctx) => {
      attempt++;
      if (attempt === 1) return { acc: "thought, wrote nothing" };  // empty diff → retryable
      writeFileSync(join(ctx.workdir, "src", "Late.tsx"), "late\n"); // second attempt does the work
      return { acc: "wrote it" };
    },
  });
  policy.setLevel("a", "auto-safe");
  const { goalId } = engine.enqueueGoal({ agentId: "a", steps: ["do the thing"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "failed")), "attempt 0 failed empty-diff");
  clock += 5000; engine.tick(); // past the backoff → retry becomes claimable
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "done" && t.attempts === 1)), "retry reached DONE");
  assert.ok(existsSync(join(repoRoot, "src", "Late.tsx")), "self-heal applied the file on retry");
});

test("self-heal: a retryable failure exhausts maxAttempts → terminal failed + escalation", async () => {
  const { engine, queue, escalations } = buildEngine({ dispatchOverride: async () => ({ acc: "never writes" }) });
  const { goalId } = engine.enqueueGoal({ agentId: "a", steps: ["impossible"] });
  // pump the clock past each backoff until the chain gives up
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 20));
    clock += 70_000; engine.tick();
  }
  assert.ok(await until(() => escalations.some((e) => e.kind === "empty-diff")), "escalated after exhaustion");
  const terminal = queue.all().filter((t) => t.goalId === goalId && t.status === "failed");
  assert.ok(terminal.some((t) => t.attempts >= 3), "reached maxAttempts then stopped retrying");
});

test("cancel during EDITING: dispatch resolving AFTER cancel never applies (killed guard)", async () => {
  let resolveDispatch;
  const { engine, queue, policy } = buildEngine({
    dispatchOverride: (ctx) => new Promise((res) => { ctx.registerKill(() => {}); resolveDispatch = () => res({ acc: "done late" }); }),
  });
  policy.setLevel("a", "auto-safe");
  const { goalId } = engine.enqueueGoal({ agentId: "a", steps: ["slow"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.engineState === "EDITING")), "reached EDITING");
  const t = queue.all().find((x) => x.goalId === goalId);
  engine.cancel(t.taskId);
  resolveDispatch();                       // dispatch settles AFTER cancel
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(queue.get(t.taskId).status, "cancelled", "stays cancelled (killed guard returned before apply)");
});

test("enqueueGoal returns {error} on a full backlog — no silent partial goal", () => {
  const { engine, queue } = buildEngine({ maxQueued: 1 });
  queue.enqueue({ goalId: "g0", stepIndex: 0, agentId: "z", tier: "sonnet", task: "filler" }); // fill the 1 slot
  const r = engine.enqueueGoal({ agentId: "a", steps: ["wont fit"] });
  assert.equal(r.error, "backlog full");
  assert.equal(r.goalId, undefined, "no goal id handed back when it could not start");
});

// ── P4: restart safety + failure-Delivery hook ──────────────────────────────

test("P4 reconcile re-queues a task claimed but never marked EDITING (crash in the gap)", async () => {
  // maxInflight 0 ⇒ the scheduler can never dispatch, so the assertion sees the
  // reconciled state rather than racing the drain reconcile() ends with. autoStart
  // false ⇒ this is a genuine BOOT reconcile, which is the only kind that may requeue.
  const { engine, queue } = buildEngine({ maxInflight: 0, autoStart: false });
  queue.enqueue({ goalId: "goal_gap", stepIndex: 0, agentId: "a", tier: "sonnet", task: "x" });
  const claimed = queue.claimNext();
  assert.equal(claimed.status, "claimed");
  assert.equal(queue.get(claimed.taskId).engineState, undefined, "crashed before the first update()");
  await engine.reconcile();
  const after = queue.get(claimed.taskId);
  assert.equal(after.status, "queued", "a claim held by a dead process must return to the queue");
  assert.equal(after.claimedAt, null);
  assert.equal(after.leaseExpiry, null);
});

test("P4 reconcile still re-queues a claimed task that DID reach EDITING", async () => {
  const { engine, queue } = buildEngine({ maxInflight: 0, autoStart: false });
  const r = queue.enqueue({ goalId: "goal_ed", stepIndex: 0, agentId: "a", tier: "sonnet", task: "x" });
  queue.update(r.taskId, { status: "claimed", engineState: "EDITING" });
  await engine.reconcile();
  assert.equal(queue.get(r.taskId).status, "queued");
  assert.equal(queue.get(r.taskId).engineState, null);
});

test("P4 reconcile leaves terminal + held tasks alone", async () => {
  const { engine, queue } = buildEngine({ maxInflight: 0 });
  const done = queue.enqueue({ goalId: "g1", stepIndex: 0, agentId: "a", tier: "sonnet", task: "d" });
  const held = queue.enqueue({ goalId: "g2", stepIndex: 0, agentId: "b", tier: "sonnet", task: "h" });
  queue.update(done.taskId, { status: "done" });
  queue.update(held.taskId, { status: "held", heldReason: "waiting" });
  await engine.reconcile();
  assert.equal(queue.get(done.taskId).status, "done");
  assert.equal(queue.get(held.taskId).status, "held");
});

test("P4 terminal failure fires onTerminalFailure with the classified kind + attempts", async () => {
  const seen = [];
  const { engine, queue } = buildEngine({
    dispatchOverride: async () => ({ error: "spawn ENOENT" }),
    onTerminalFailure: (task, info) => seen.push({ taskId: task.taskId, ...info }),
  });
  const { goalId } = engine.enqueueGoal({ agentId: "a1", steps: ["do it"] });
  // pump the clock past each backoff until the retry budget is spent
  for (let i = 0; i < 6 && !seen.length; i++) {
    await new Promise((r) => setTimeout(r, 20));
    clock += 70_000; engine.tick();
  }
  assert.ok(await until(() => seen.length > 0, 5000), "a failure Delivery was requested");
  assert.equal(seen.length, 1, "exactly one failure Delivery per stuck task");
  assert.equal(seen[0].kind, "spawn");
  assert.equal(seen[0].agentId, "a1");
  assert.ok(seen[0].attempts >= 1);
  assert.match(seen[0].detail, /ENOENT/);
  assert.ok(queue.all().some((t) => t.goalId === goalId && t.status === "failed"));
});

test("P4 a retryable failure with budget left does NOT mint a failure Delivery", async () => {
  const seen = [];
  const { engine, queue } = buildEngine({
    dispatchOverride: async () => ({ error: "spawn EAGAIN" }),
    onTerminalFailure: (task, info) => seen.push(info),
  });
  engine.enqueueGoal({ agentId: "a2", steps: ["do it"] });
  assert.ok(await until(() => queue.all().some((t) => t.attempts === 1 && t.status === "queued"), 5000),
    "a retry attempt is queued behind a backoff");
  assert.deepEqual(seen, [], "the retry is scheduled; the operator is not paged yet");
});

test("P4 apply-rejected (non-retryable) mints a failure Delivery immediately", async () => {
  const seen = [];
  // broker stub: the guard rejects every apply (same recipe as the S1 apply-rejected test)
  const { engine, policy } = buildEngine({
    dispatchOverride: async () => ({ acc: "x" }),
    brokerOverride: {
      listChanges: async () => [{ path: "src/x.tsx", status: "new", before: null, after: "y" }],
      applyChanges: async () => [{ path: "src/x.tsx", ok: false, error: "protected key changed: scripts" }],
    },
    onTerminalFailure: (task, info) => seen.push(info),
  });
  policy.setLevel("a3", "auto-safe");
  engine.enqueueGoal({ agentId: "a3", steps: ["edit config"] });
  assert.ok(await until(() => seen.length > 0, 5000), "guard rejection surfaced");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "apply-rejected");
});

test("P4 a throwing onTerminalFailure never breaks the engine's terminal transition", async () => {
  const { engine, queue } = buildEngine({
    dispatchOverride: async () => ({ error: "spawn ENOENT" }),
    onTerminalFailure: () => { throw new Error("db down"); },
  });
  engine.enqueueGoal({ agentId: "a4", steps: ["do it"] });
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 20));
    clock += 70_000; engine.tick();
  }
  assert.ok(await until(() => queue.all().some((t) => t.status === "failed"), 5000),
    "the task still reaches FAILED even though the Inbox mint threw");
});

test("P4 a backoff'd retry SCHEDULES its own wake — nothing else ticks an idle loop", async () => {
  const timers = [];
  const { engine, queue } = buildEngine({
    dispatchOverride: async () => ({ error: "spawn EAGAIN" }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { __fake: true }; },
  });
  engine.enqueueGoal({ agentId: "aw", steps: ["needs a retry"] });
  assert.ok(await until(() => queue.all().some((t) => t.status === "queued" && t.attempts === 1), 5000),
    "the retry is queued behind a backoff");
  assert.ok(timers.length >= 1, "the engine scheduled a wake for the backoff gate");
  assert.ok(timers[0].ms >= 1 && timers[0].ms <= 70_000, `wake delay ${timers[0].ms}ms is the bounded backoff`);
});

test("P4 firing the scheduled wake re-dispatches the backoff'd retry with no human tick", async () => {
  let attempt = 0;
  const timers = [];
  const { engine, queue, policy } = buildEngine({
    dispatchOverride: async (ctx) => {
      attempt++;
      if (attempt === 1) return { acc: "thought, wrote nothing" }; // empty diff → retryable
      writeFileSync(join(ctx.workdir, "src", "Woken.tsx"), "woken\n");
      return { acc: "wrote it" };
    },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { __fake: true }; },
  });
  policy.setLevel("aw2", "auto-safe");
  const { goalId } = engine.enqueueGoal({ agentId: "aw2", steps: ["do the thing"] });
  assert.ok(await until(() => timers.length > 0, 5000), "a wake was scheduled");
  clock += 70_000;          // the gate has opened in queue-time
  timers[timers.length - 1].fn();  // the timer fires — this is the ONLY nudge
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "done" && t.attempts === 1), 5000),
    "the retry ran itself to DONE off its own wake");
  assert.ok(existsSync(join(repoRoot, "src", "Woken.tsx")));
});

test("P4 reconcile schedules a wake for a backoff'd retry found on disk after a restart", async () => {
  const timers = [];
  const { engine, queue } = buildEngine({ maxInflight: 0, setTimer: (fn, ms) => { timers.push({ fn, ms }); return { __fake: true }; } });
  const r = queue.enqueue({ goalId: "g_w", stepIndex: 0, agentId: "aw3", tier: "sonnet", task: "x", attempts: 1 });
  queue.update(r.taskId, { notBefore: new Date(clock + 30_000).toISOString() });
  timers.length = 0;
  await engine.reconcile();
  assert.equal(timers.length, 1, "the reboot re-armed the backoff gate");
  assert.ok(timers[0].ms > 0 && timers[0].ms <= 30_000);
});

test("P4 the wake timer never stacks — one pending wake at a time, the earliest wins", async () => {
  const timers = [];
  const cleared = [];
  const { engine, queue } = buildEngine({
    maxInflight: 0,
    setTimer: (fn, ms) => { const h = { fn, ms, id: timers.length }; timers.push(h); return h; },
    clearTimer: (h) => cleared.push(h.id),
  });
  const a = queue.enqueue({ goalId: "g_s1", stepIndex: 0, agentId: "s1", tier: "sonnet", task: "x", attempts: 1 });
  queue.update(a.taskId, { notBefore: new Date(clock + 50_000).toISOString() });
  await engine.reconcile();
  const b = queue.enqueue({ goalId: "g_s2", stepIndex: 0, agentId: "s2", tier: "sonnet", task: "y", attempts: 1 });
  queue.update(b.taskId, { notBefore: new Date(clock + 5_000).toISOString() });
  await engine.reconcile();
  assert.equal(timers.length, 2, "a nearer wake replaces the far one");
  assert.deepEqual(cleared, [0], "the superseded timer was cleared, not leaked");
  await engine.reconcile(); // the 5s wake still stands → no third timer
  assert.equal(timers.length, 2, "a later wake does not stack on top of an earlier one");
});

// ── P4 hardening (sr-security LOW ×3) ────────────────────────────────────────

test("HARDENING a notBefore far in the future arms a wake of AT MOST 60s — never a 1ms spin", async () => {
  const timers = [];
  const { engine, queue } = buildEngine({
    maxInflight: 0, autoStart: false,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { __fake: true }; },
  });
  // > 2^31 ms (~24.8 days): setTimeout would silently collapse this to 1ms and the
  // wake would re-fire forever. A corrupt notBefore or a backwards clock jump is
  // enough to produce it.
  const r = queue.enqueue({ goalId: "g_far", stepIndex: 0, agentId: "far1", tier: "sonnet", task: "x", attempts: 1 });
  queue.update(r.taskId, { notBefore: new Date(clock + 90 * 86_400_000).toISOString() });
  timers.length = 0;

  await engine.reconcile();

  assert.equal(timers.length, 1, "a wake was armed");
  assert.ok(timers[0].ms <= 60_000, `wake clamped to <=60s, got ${timers[0].ms}ms`);
  assert.ok(timers[0].ms >= 1, "and never below the 1ms floor");

  // Firing it must re-arm another bounded wake, not spin: the gate is still shut.
  timers[0].fn();
  assert.equal(queue.get(r.taskId).status, "queued", "the gate is still closed — nothing dispatched");
  assert.ok(timers.length >= 2, "the loop re-armed itself instead of giving up");
  assert.ok(timers[timers.length - 1].ms <= 60_000, "the re-arm is bounded too");
});

test("HARDENING a runtime lease sweep never re-queues a task that is still RUNNING", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const timers = [];
  // leaseMs 1000 with a step that outlives it: the wake-gate sweep must not treat the
  // live claim as a dead one, or a second worker lands on the same worktree.
  const queue = createQueue({ dir: storeDir, now, maxQueued: 500, leaseMs: 1000, maxPerAgent: 2 });
  const policy = { decide: () => ({ autoApply: true }) }; // auto-apply: this test is about the lease, not the gate
  const worktreeMgr = createWorktreeMgr({ repoRoot, worktreeRoot });
  const broker = createBroker({ repoRoot, workdirFor: (id) => worktreeMgr.pathFor(id), scrub: (s) => s });
  let inUse = 0;
  const scheduler = createScheduler({
    tryAcquireSlot: () => (inUse >= 2 ? false : (inUse++, true)),
    releaseSlot: () => { inUse = Math.max(0, inUse - 1); },
    claimNext: () => queue.claimNext(),
  });
  const dispatched = [];
  const engine = createEngine({
    queue, policy, worktreeMgr, scheduler, broker,
    dispatchFn: async (ctx) => {
      dispatched.push(ctx.taskId);
      await gate; // the step is STILL RUNNING while its lease expires
      writeFileSync(join(ctx.workdir, "src", "seed.ts"), "export const seed = 2;\n");
      return { acc: "ok" };
    },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { __fake: true }; },
    clearTimer: () => {},
    now, goalsDir: join(storeDir, "goals"), jitter: () => 0,
  });
  engine.start();

  const g = engine.enqueueGoal({ agentId: "live1", steps: ["long step"] });
  assert.ok(await until(() => dispatched.length === 1, 3000), "the step is in flight");
  const taskId = dispatched[0];
  clock += 5000; // the lease is now well past expiry, but the step has not returned

  assert.equal(
    queue.reclaimExpiredLeases((id) => id === taskId), 0,
    "the engine's live-claim veto keeps the sweep off an executing task",
  );
  assert.equal(queue.get(taskId).status, "claimed", "still owned by the live worker");

  release();
  assert.ok(await until(goalDone(queue, g.goalId), 5000), "and the original step still finishes normally");
  assert.equal(queue.get(taskId).status, "done");
  assert.equal(dispatched.length, 1, "the task was dispatched exactly ONCE — no double writer");
});

test("HARDENING reconcile after start() does NOT re-queue a claimed task (the branch is boot-only)", async () => {
  const { engine, queue } = buildEngine({ maxInflight: 0 }); // autoStart: true ⇒ booted
  const r = queue.enqueue({ goalId: "g_boot", stepIndex: 0, agentId: "b1", tier: "sonnet", task: "x" });
  const claimed = queue.claimNext();
  assert.equal(claimed.taskId, r.taskId);

  await engine.reconcile();

  assert.equal(queue.get(r.taskId).status, "claimed", "a claim held by the LIVE loop is never requeued");
  assert.ok(queue.get(r.taskId).claimedAt, "its claim metadata is intact");
});

test("HARDENING the boot reconcile still requeues a claimed task BEFORE start()", async () => {
  const { engine, queue } = buildEngine({ maxInflight: 0, autoStart: false });
  const r = queue.enqueue({ goalId: "g_boot2", stepIndex: 0, agentId: "b2", tier: "sonnet", task: "x" });
  queue.claimNext();
  await engine.reconcile();
  assert.equal(queue.get(r.taskId).status, "queued", "crash recovery is unaffected by the new gate");
});

test("HARDENING a watchdog >= the lease is clamped below it at boot (warn, never throw)", () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const queue = createQueue({ dir: storeDir, now, leaseMs: 5_000 });
    const scheduler = createScheduler({ tryAcquireSlot: () => false, releaseSlot: () => {}, claimNext: () => null });
    assert.doesNotThrow(() => createEngine({
      queue, scheduler,
      policy: { decide: () => ({ autoApply: true }) },
      broker: { listChanges: async () => [], applyChanges: async () => [] },
      dispatchFn: async () => ({ acc: "" }),
      watchdogMs: 300_000, // 60x the lease — a step could outlive its own claim
      now, goalsDir: join(storeDir, "goals"),
    }), "a misconfigured env var must not stop the runtime from booting");
    assert.equal(warnings.length, 1, "but it must be loud");
    assert.match(warnings[0], /RUNTIME_STEP_TIMEOUT_MS/);
    assert.match(warnings[0], /RUNTIME_LEASE_MS/);
    assert.match(warnings[0], /Clamping the watchdog to 4000ms/);
  } finally { console.warn = realWarn; }
});

test("HARDENING a watchdog inside the lease is left alone (no spurious warning)", () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const queue = createQueue({ dir: storeDir, now, leaseMs: 600_000 });
    const scheduler = createScheduler({ tryAcquireSlot: () => false, releaseSlot: () => {}, claimNext: () => null });
    createEngine({
      queue, scheduler,
      policy: { decide: () => ({ autoApply: true }) },
      broker: { listChanges: async () => [], applyChanges: async () => [] },
      dispatchFn: async () => ({ acc: "" }),
      watchdogMs: 300_000, // the production default, well inside the 10-minute lease
      now, goalsDir: join(storeDir, "goals"),
    });
    assert.deepEqual(warnings, []);
  } finally { console.warn = realWarn; }
});

// ── P5 — a committed branch must outlive the chain advance ───────────────────

test("P5 onOperatorApplied({keepBranch:true}) RELEASES the worktree and keeps the branch", async () => {
  const { engine, queue, worktreeMgr } = buildEngine({
    writeFiles: { "held step": [{ path: "src/Kept.tsx", content: "export const K = 1;\n" }] },
  });
  const { goalId } = engine.enqueueGoal({ agentId: "senior-web-1", tier: "sonnet", steps: ["held step"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "held"), 5000), "task HELD");
  const task = queue.all().find((t) => t.goalId === goalId);

  // Simulate pr.mjs having committed on the branch.
  const wtPath = worktreeMgr.pathFor(task.taskId);
  git(["add", "-A"], wtPath);
  git(["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "agent work"], wtPath);
  const branch = worktreeMgr.branchOf(task.taskId);
  const sha = git(["rev-parse", branch]);

  engine.onOperatorApplied(task.taskId, { keepBranch: true });

  assert.equal(queue.get(task.taskId).status, "done");
  assert.equal(existsSync(wtPath), false, "scratch checkout gone");
  assert.equal(git(["rev-parse", branch]), sha, "the approved commit SURVIVES on its branch");
});

// sr-security P5 re-review #6 — cancel() must be a NO-OP on a terminal task.
test("#6 cancel AFTER a branch landing is a no-op — the approved commit is NOT branch -D'd", async () => {
  const { engine, queue, worktreeMgr } = buildEngine({
    writeFiles: { "held step": [{ path: "src/Landed.tsx", content: "export const L = 1;\n" }] },
  });
  const { goalId } = engine.enqueueGoal({ agentId: "senior-web-1", tier: "sonnet", steps: ["held step"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "held"), 5000), "task HELD");
  const task = queue.all().find((t) => t.goalId === goalId);

  // pr.mjs commits on the branch, then the chain advances with keepBranch → status 'done'.
  const wtPath = worktreeMgr.pathFor(task.taskId);
  git(["add", "-A"], wtPath);
  git(["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "approved work"], wtPath);
  const branch = worktreeMgr.branchOf(task.taskId);
  const sha = git(["rev-parse", branch]);
  engine.onOperatorApplied(task.taskId, { keepBranch: true });
  assert.equal(queue.get(task.taskId).status, "done");

  // A late cancel (stale UI, a reject on an already-approved row) used to reach
  // worktreeMgr.remove() → `git branch -D` → the ONLY copy of the work is gone.
  assert.equal(engine.cancel(task.taskId), false, "cancel reports the no-op honestly");
  assert.equal(queue.get(task.taskId).status, "done", "a terminal task is not re-transitioned to cancelled");
  assert.equal(git(["rev-parse", branch]), sha, "the approved commit survives the late cancel");
});

// sr-security P5 re-review MED-3 — the #6 guard was `existing && TERMINAL.has(...)`,
// so an ABSENT record fell straight through to remove() → `git branch -D`.
// queue.sweepTerminal() deletes terminal rows after RUNTIME_TASK_RETENTION_DAYS (7)
// at every boot, so a mode:'branch' landing older than that had no row left to guard
// it: a late cancel destroyed the only copy of approved-but-unpushed work.
test("MED-3 cancel with NO queue record (row swept after retention) is a no-op — the branch survives", async () => {
  const { engine, queue, worktreeMgr } = buildEngine({
    writeFiles: { "held step": [{ path: "src/Swept.tsx", content: "export const S = 1;\n" }] },
  });
  const { goalId } = engine.enqueueGoal({ agentId: "senior-web-1", tier: "sonnet", steps: ["held step"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "held"), 5000), "task HELD");
  const task = queue.all().find((t) => t.goalId === goalId);

  // pr.mjs commits on the branch; the chain advances keeping the ref (rung 'branch').
  const wtPath = worktreeMgr.pathFor(task.taskId);
  git(["add", "-A"], wtPath);
  git(["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "approved work"], wtPath);
  const branch = worktreeMgr.branchOf(task.taskId);
  const sha = git(["rev-parse", branch]);
  engine.onOperatorApplied(task.taskId, { keepBranch: true });
  assert.equal(queue.get(task.taskId).status, "done");

  // …then the retention sweep runs at a later boot and deletes the terminal record.
  assert.equal(queue.sweepTerminal(1, clock + 8 * 86_400_000), 1, "the terminal row is swept");
  assert.equal(queue.get(task.taskId), null, "no record left to consult");

  assert.equal(engine.cancel(task.taskId), false, "nothing in the queue = nothing to cancel");
  assert.equal(git(["rev-parse", branch]), sha, "the approved commit survives a post-sweep cancel");
});

test("#6 cancel on a LIVE (non-terminal) task is unchanged — still discards the worktree", async () => {
  const { engine, queue, worktreeMgr } = buildEngine({
    writeFiles: { "risky step": [{ path: "package.json", content: '{"scripts":{"x":"y"}}' }] },
  });
  const { goalId } = engine.enqueueGoal({ agentId: "senior-web-1", tier: "sonnet", steps: ["risky step"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "held"), 5000), "task HELD");
  const held = queue.all().find((t) => t.goalId === goalId);
  assert.equal(engine.cancel(held.taskId), true);
  assert.equal(queue.get(held.taskId).status, "cancelled");
  assert.equal(worktreeMgr.pathFor(held.taskId), null, "worktree still discarded for a live task");
});

test("P5 onOperatorApplied() with no options still removes the worktree AND the branch (pre-P5)", async () => {
  const { engine, queue, worktreeMgr } = buildEngine({
    writeFiles: { "held step": [{ path: "src/Gone.tsx", content: "export const G = 1;\n" }] },
  });
  const { goalId } = engine.enqueueGoal({ agentId: "senior-web-1", tier: "sonnet", steps: ["held step"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "held"), 5000), "task HELD");
  const task = queue.all().find((t) => t.goalId === goalId);
  const branch = worktreeMgr.branchOf(task.taskId);

  engine.onOperatorApplied(task.taskId);

  assert.equal(queue.get(task.taskId).status, "done");
  assert.equal(git(["branch", "--list", branch]), "", "branch deleted, exactly as before P5");
});

// ── B2 / ADR-055 — the completion choke point feeds the Knowledge Vault ───────
// One hook, BOTH DONE transitions (auto-apply and operator-apply), because both are
// "this task's work is finished". The vault write is idempotent per taskId, so a task
// that somehow reaches both never yields two records.

test("B2 onDone fires at the auto-apply DONE transition with the task's identity + report", async () => {
  const done = [];
  const { engine, queue, policy } = buildEngine({
    writeFiles: { "scan the market": [{ path: "src/Scan.tsx", content: "export const S = 1;\n" }] },
    onDone: (task, info) => done.push({ task, info }),
  });
  policy.setLevel("pm-analyst", "auto-safe");
  const { goalId } = engine.enqueueGoal({ agentId: "pm-analyst", tier: "sonnet", steps: ["scan the market"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "done"), 5000), "task DONE");
  assert.ok(await until(() => done.length === 1, 2000), "onDone fired exactly once");
  assert.equal(done[0].task.agentId, "pm-analyst");
  assert.equal(done[0].task.task, "scan the market");
  assert.match(done[0].task.taskId, /^task_/);
  assert.match(done[0].info.report, /1 file\(s\): src\/Scan\.tsx/, "the reportBack text rides along");
  assert.deepEqual(done[0].info.paths, ["src/Scan.tsx"]);
});

test("B2 onDone also fires on operator-apply — the other DONE transition", async () => {
  const done = [];
  const { engine, queue, broker } = buildEngine({
    writeFiles: { "held work": [{ path: "src/Held2.tsx", content: "export const H = 1;\n" }] },
    onDone: (task, info) => done.push({ task, info }),
  });
  const { goalId } = engine.enqueueGoal({ agentId: "sr-backend", steps: ["held work"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "held"), 5000), "task HELD");
  const held = queue.all().find((t) => t.goalId === goalId && t.status === "held");
  assert.equal(done.length, 0, "a HELD task is not done");
  await broker.applyChanges(held.taskId, ["src/Held2.tsx"]);
  engine.onOperatorApplied(held.taskId);
  assert.equal(done.length, 1);
  assert.equal(done[0].task.agentId, "sr-backend");
  assert.equal(done[0].task.task, "held work");
});

test("B2 a throwing onDone can never strand a task that already finished", async () => {
  const { engine, queue, policy } = buildEngine({
    writeFiles: { "safe step": [{ path: "src/Safe.tsx", content: "export const S = 1;\n" }] },
    onDone: () => { throw new Error("vault exploded"); },
  });
  policy.setLevel("senior-web-1", "auto-safe");
  const { goalId } = engine.enqueueGoal({ agentId: "senior-web-1", tier: "sonnet", steps: ["safe step"] });
  assert.ok(await until(() => queue.all().some((t) => t.goalId === goalId && t.status === "done"), 5000), "task still reached DONE");
  assert.ok(existsSync(join(repoRoot, "src", "Safe.tsx")), "and the apply still landed");
});

// ── PHASE 2 TASK 2.4 — THE WATCHDOG: a claimed task must never be orphaned ───
//
// The gap: `reclaimExpiredLeases` ran in exactly two places — the boot reconcile, and the
// backoff wake timer. The wake timer only arms when some task carries a `notBefore`, so on
// a queue with no pending retry NOTHING re-armed it, and a lease whose holder died was
// never reclaimed for as long as the process stayed up. engine.mjs:139 said in so many
// words that the runtime has no heartbeat; this is the heartbeat, and it rides the ONE
// periodic timer the runtime already owns rather than adding a second (ADR-025: the
// dispatch scheduler owns no wall-clock).

test("sweep() reclaims a lease whose holder died, on a queue with no pending retry", async () => {
  const { engine, queue } = buildEngine({ writeFiles: { "*": [{ path: "src/a.ts", content: "export const a = 1;\n" }] }, autoStart: false });
  const r = queue.enqueue({ goalId: "g-orphan", stepIndex: 0, attempt: 0, agentId: "dev", tier: "sonnet", priority: "normal", task: "step" });
  // Claim it and then simply vanish — the shape of a process killed mid-step.
  const claimed = queue.claimNext();
  assert.equal(claimed.taskId, r.taskId);
  assert.equal(queue.get(r.taskId).status, "claimed");

  // No task carries a notBefore, so nothing arms the backoff wake. Before this task, the
  // row stayed `claimed` until the next restart.
  clock += 600_001; // past the 600s lease
  const reclaimed = engine.sweep();

  assert.equal(reclaimed, 1);
  assert.equal(queue.get(r.taskId).status, "queued", "an expired lease with no live holder must return to the queue");
  assert.equal(queue.get(r.taskId).claimedAt, null);
  assert.equal(queue.get(r.taskId).leaseExpiry, null);
});

test("sweep() does NOT reclaim a lease that has not expired", () => {
  const { engine, queue } = buildEngine({ autoStart: false });
  const r = queue.enqueue({ goalId: "g-live", stepIndex: 0, attempt: 0, agentId: "dev", tier: "sonnet", priority: "normal", task: "step" });
  queue.claimNext();
  clock += 1000; // well inside the lease
  assert.equal(engine.sweep(), 0);
  assert.equal(queue.get(r.taskId).status, "claimed");
});

test("sweep() NEVER reclaims a task that is still executing in-process", async () => {
  // Two writers on one worktree, and a first child whose kill handle is gone from
  // `running`, is strictly worse than a stuck row. A LIVE task is not a dead one, however
  // long it has been going — killing it is the watchdog's job, not the sweep's.
  let release;
  const gate = new Promise((r) => { release = r; });
  const { engine, queue } = buildEngine({
    dispatchOverride: async () => { await gate; return { acc: "late" }; },
  });
  const r = queue.enqueue({ goalId: "g-live2", stepIndex: 0, attempt: 0, agentId: "dev", tier: "sonnet", priority: "normal", task: "slow" });
  engine.tick();
  assert.ok(await until(() => queue.get(r.taskId).status === "claimed"), "task should be claimed and running");

  clock += 600_001; // its lease is long gone, but the step is demonstrably still alive
  assert.equal(engine.sweep(), 0, "a running task must be vetoed out of the reclaim");
  assert.equal(queue.get(r.taskId).status, "claimed");

  release();
  await until(() => ["done", "failed", "held"].includes(queue.get(r.taskId).status));
});

test("sweep() re-dispatches the reclaimed work — a requeue nobody picks up is not a recovery", async () => {
  const { engine, queue } = buildEngine({ writeFiles: { "*": [{ path: "src/a.ts", content: "export const a = 2;\n" }] } });
  const r = queue.enqueue({ goalId: "g-redispatch", stepIndex: 0, attempt: 0, agentId: "dev", tier: "sonnet", priority: "normal", task: "step" });
  // Claim it out from under the scheduler, then let the lease lapse.
  const claimed = queue.claimNext();
  assert.equal(claimed.taskId, r.taskId);
  clock += 600_001;

  assert.equal(engine.sweep(), 1);
  // sweep() ticks the scheduler, so the freed task runs without waiting for the next
  // enqueue to happen to come along.
  assert.ok(await until(() => ["done", "held"].includes(queue.get(r.taskId).status)), `stuck at ${queue.get(r.taskId).status}`);
});

// ── D4 — a dispatch REFUSAL is terminal on the first attempt ─────────────────────
// Live evidence this pins: goal_4f363d708c2c spawned task_f5205c844ff6 →
// task_7f558c33def1 → task_1481afc84a22, each a full live model turn plus a 120s
// container run, each ending in the same post-edit gate veto. Three paid attempts, one
// answer. A hook veto is EVIDENCE, and evidence does not become different on a retry.
test("D4-ENGINE: a HOOK_VETO fails terminally after ONE attempt, with its own kind", async () => {
  let dispatches = 0;
  const terminal = [];
  const h = buildEngine({
    dispatchOverride: async () => { dispatches++; return { error: "quality gate failed in the worktree", code: "HOOK_VETO" }; },
    onTerminalFailure: (task, row) => terminal.push(row),
  });
  const r = h.engine.enqueueGoal({ agentId: "sr-backend", tier: "sonnet", steps: ["do the thing"] });
  assert.ok(r.firstTaskId);
  await until(() => terminal.length > 0);

  assert.equal(dispatches, 1, "exactly one model turn was spent on a settled refusal");
  assert.equal(terminal.length, 1, "one failure Delivery, not three");
  assert.equal(terminal[0].kind, "gate-veto", "the operator is told what actually happened");
  const rec = h.queue.get(r.firstTaskId);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error.kind, "gate-veto");
  // No successor attempt was queued.
  const all = h.queue.list ? h.queue.list() : [];
  if (all.length) assert.equal(all.filter((t) => t.goalId === r.goalId).length, 1, "no retry task was enqueued");
});

test("D4-ENGINE: an UNCODED dispatch error still retries exactly as before", async () => {
  const seen = [];
  const h = buildEngine({
    dispatchOverride: async () => ({ error: "spawn ENOENT" }),   // no `code` — unrecognised
    onTerminalFailure: (task, row) => seen.push(row),
  });
  const r = h.engine.enqueueGoal({ agentId: "sr-backend", tier: "sonnet", steps: ["do the thing"] });
  // Inert timers (this file's default) — assert on the QUEUE, the same way every other
  // retry test here does, instead of sleeping through a real backoff.
  assert.ok(
    await until(() => h.queue.all().some((t) => t.goalId === r.goalId && t.attempts === 1)),
    "an unrecognised failure still schedules another attempt",
  );
  assert.equal(h.queue.get(r.firstTaskId).error.kind, "spawn", "the historical transient bucket is untouched");
  assert.deepEqual(seen, [], "and the operator is not paged while the budget remains");
});

test("empty-diff NAMES a path the guards refused, instead of saying the agent did nothing", async () => {
  // Live: a task told to create a file outside the appliable scope wrote it, and the
  // operator was told "no diff produced" — so they re-queued the same impossible task
  // three times on a live model. The work was blocked, not absent. `scripts/` runs on the
  // HOST via npm and stays out of scope even after #9 widened it to agent-runtime + docs.
  const terminal = [];
  const h = buildEngine({
    dispatchOverride: async (ctx) => {
      mkdirSync(join(ctx.workdir, "scripts"), { recursive: true });
      writeFileSync(join(ctx.workdir, "scripts", "deploy.mjs"), "console.log('nope');\n");
      return { acc: "wrote the script" };
    },
    onTerminalFailure: (task, row) => terminal.push(row),
  });
  const r = h.engine.enqueueGoal({ agentId: "sr-backend", tier: "sonnet", steps: ["create scripts/deploy.mjs"] });
  assert.ok(await until(() => h.queue.get(r.firstTaskId)?.status === "failed"));
  const msg = String(h.queue.get(r.firstTaskId).error.msg);
  assert.match(msg, /scripts\/deploy\.mjs/, `the refused path must be named: ${msg}`);
  assert.match(msg, /not appliable|outside|refused/i, "and the operator must be told WHY it produced nothing");
});

// ── #8 — the engine's retry must not knock before the provider is back ───────────
// A queue of build tasks and a story pipeline share one endpoint. The engine's own
// exponential backoff is about THIS task; the provider hold is about EVERYONE. The wait is
// the longer of the two — taking the engine's alone is what let a full queue re-knock on a
// rate-limited provider every few seconds.
test("#8 a retry is scheduled no earlier than the shared provider hold", async () => {
  const timers = [];
  const h = buildEngine({
    dispatchOverride: async () => ({ error: "openai-compat chat failed: HTTP 429 — rate-limited" }),
    setTimer: (fn, ms) => { timers.push(ms); return { __fake: true }; },
    retryFloorMs: () => 45_000,
  });
  const r = h.engine.enqueueGoal({ agentId: "sr-backend", tier: "sonnet", steps: ["work"] });
  // handleRetryable stamps attempts=1 on the FAILED original AND on its successor, so
  // matching on attempts alone picks the wrong row (and reads notBefore as undefined).
  const successor = () => h.queue.all().find((t) => t.goalId === r.goalId && t.status === "queued" && t.notBefore);
  assert.ok(await until(() => Boolean(successor())));
  const waitMs = Date.parse(successor().notBefore) - clock;
  assert.ok(waitMs >= 45_000, `the retry waits for the provider, not just its own backoff (got ${waitMs}ms)`);
});

test("#8 with no provider hold the historical backoff is unchanged", async () => {
  const h = buildEngine({
    dispatchOverride: async () => ({ error: "spawn ENOENT" }),
  });
  const r = h.engine.enqueueGoal({ agentId: "sr-backend", tier: "sonnet", steps: ["work"] });
  const successor = () => h.queue.all().find((t) => t.goalId === r.goalId && t.status === "queued" && t.notBefore);
  assert.ok(await until(() => Boolean(successor())));
  assert.equal(Date.parse(successor().notBefore) - clock, 2000, "base backoff, jitter 0 — byte-identical to pre-#8");
});

// ── 2026-09-07 — the retry brief must not contradict the refusal ─────────────────
// The stored error names the refused path (test above). The RETRY BRIEF did not: every
// empty-diff retried with "prior attempt produced no diff; make the concrete file edit in
// the working directory NOW." When the cause was an out-of-scope write that is false —
// the seat DID write, and it is being told to repeat exactly what just failed. This text
// was visible on the running install, on the Tech Lead station.
test("ENG-SC1: an out-of-scope empty diff does NOT tell the agent it produced no diff", async () => {
  const h = buildEngine({
    dispatchOverride: async (ctx) => {
      mkdirSync(join(ctx.workdir, "scripts"), { recursive: true });
      writeFileSync(join(ctx.workdir, "scripts", "deploy.mjs"), "console.log('nope');\n");
      return { acc: "wrote the script" };
    },
  });
  const r = h.engine.enqueueGoal({ agentId: "sr-backend", tier: "sonnet", steps: ["create scripts/deploy.mjs"] });
  const successor = () => h.queue.all().find((t) => t.goalId === r.goalId && t.status === "queued" && t.notBefore);
  assert.ok(await until(() => Boolean(successor())), "no retry enqueued");
  const brief = String(successor().task);
  assert.doesNotMatch(brief, /produced no diff/,
    `the agent is told it produced no diff when its writes were REFUSED: ${brief}`);
  assert.match(brief, /outside[^.]*scope/i, `the brief must name the scope breach: ${brief}`);
  assert.match(brief, /scripts\/deploy\.mjs/, `the brief must name the refused path: ${brief}`);
});

// The honest-code half of the pair: the fix must NARROW the message, not replace it
// everywhere. A genuine empty diff still gets the original wording.
test("ENG-SC2: a genuine empty diff still gets the original brief", async () => {
  const h = buildEngine({
    dispatchOverride: async () => ({ acc: "thought about it, wrote nothing" }),
  });
  const r = h.engine.enqueueGoal({ agentId: "sr-backend", tier: "sonnet", steps: ["do a thing"] });
  const successor = () => h.queue.all().find((t) => t.goalId === r.goalId && t.status === "queued" && t.notBefore);
  assert.ok(await until(() => Boolean(successor())), "no retry enqueued");
  const brief = String(successor().task);
  assert.match(brief, /produced no diff/, `an honest empty diff keeps its original brief: ${brief}`);
  assert.doesNotMatch(brief, /outside[^.]*scope/i, "and must NOT claim a scope breach that did not happen");
});

// ── Phase D · task 13 — a REPLY turn ────────────────────────────────────────
// Found by LIVE RUN 8: the backend finished its turn before the frontend asked, so the
// question sat addressed to a seat with no turn left and nobody could ever answer it. The
// Manager now gives that seat a turn whose whole job is to send one mail. Such a turn writes
// no files by design, and the engine read "no files" as `empty-diff` — a failure to retry
// three times. A `replyOnly` goal is done when it has sent its reply, and whatever it writes
// is DISCARDED: a reply turn has no business changing code.
test("ENG-REPLY-1: a replyOnly goal that writes nothing is DONE on its first attempt — no empty-diff retry", async () => {
  const h = buildEngine({ dispatchOverride: async () => ({ acc: "sent the answer by mail" }) });
  const r = h.engine.enqueueGoal({ agentId: "sr-backend", steps: ["answer the question in your inbox"], replyOnly: true });
  assert.ok(await until(() => h.queue.get(r.firstTaskId)?.status === "done"), `not done: ${JSON.stringify(h.queue.get(r.firstTaskId))}`);
  const t = h.queue.get(r.firstTaskId);
  assert.equal(t.engineState, "REPLIED");
  assert.equal(h.queue.all().filter((x) => x.goalId === r.goalId).length, 1, "exactly one attempt — nothing to retry");
});

test("ENG-REPLY-2 (security): whatever a replyOnly turn WRITES is discarded — never held, never applied", async () => {
  const h = buildEngine({ writeFiles: { "*": [{ path: "src/sneaky.ts", content: "export const x = 1;\n" }] } });
  const r = h.engine.enqueueGoal({ agentId: "sr-backend", steps: ["answer the question"], replyOnly: true });
  assert.ok(await until(() => ["done", "failed", "held"].includes(h.queue.get(r.firstTaskId)?.status)));
  const t = h.queue.get(r.firstTaskId);
  assert.equal(t.status, "done", "a reply turn is not a delivery — it is never HELD for review");
  assert.match(String(t.result || ""), /discarded 1/, "the discard is recorded, not silent");
  assert.equal(existsSync(join(repoRoot, "src", "sneaky.ts")), false, "and the file never reaches the repo");
});

test("ENG-REPLY-3 (UNRELATED): an ordinary goal that writes nothing still retries as empty-diff", async () => {
  const h = buildEngine({ dispatchOverride: async () => ({ acc: "wrote nothing" }) });
  const r = h.engine.enqueueGoal({ agentId: "sr-backend", steps: ["do a thing"] });
  const retry = () => h.queue.all().find((t) => t.goalId === r.goalId && t.status === "queued" && t.notBefore);
  assert.ok(await until(() => Boolean(retry())), "an ordinary empty turn is still a failure worth a retry");
});

test("ENG-REPLY-4: only the literal `true` makes a reply turn — the STRING \"false\" is truthy and must not", async () => {
  // A reply turn DISCARDS what it writes. `Boolean("false")` is true, so a stringly-typed
  // value from a config file or a JSON body would silently turn real work into a turn whose
  // files are thrown away. The engine accepts only the boolean.
  const h = buildEngine({ dispatchOverride: async () => ({ acc: "wrote nothing" }) });
  const r = h.engine.enqueueGoal({ agentId: "sr-backend", steps: ["do a thing"], replyOnly: "false" });
  const retry = () => h.queue.all().find((t) => t.goalId === r.goalId && t.status === "queued" && t.notBefore);
  assert.ok(await until(() => Boolean(retry())), "a string is not a reply turn — this empty turn must retry like any other");
});

// ── Phase C · task 9 — the goal's baseRef reaches the WORKTREE, end to end ──────────
test("ENG-BASE-1: a goal enqueued with baseRef cuts its worktree from THAT ref", async () => {
  // Mutation proof (2026-09-18): engine ignoring the goal's base → ✖ ENG-BASE-1 (fail 1);
  // enqueueGoal dropping baseRef from the plan → ✖ ENG-BASE-1 (fail 1). Restored, md5 matched.
  // A THIRD mutation — server.mjs dropping baseRef — left this test GREEN, which is why
  // SEQ-WIRED-1 exists.
  // Proven on the real worktree manager and the real queue, because the value has to survive
  // four hops (manager → server.enqueueGoal → engine goal plan → worktreeMgr.create) and a
  // harness that stops at the first hop would pass while the running engine used HEAD.
  const g = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  writeFileSync(join(repoRoot, "src", "earlier.ts"), "export const earlier = 1;\n");
  g(["add", "-A"]);
  g(["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "earlier work"]);
  g(["branch", "ma/job/j_seq"]);
  const tip = g(["rev-parse", "ma/job/j_seq"]);
  g(["reset", "-q", "--hard", "HEAD~1"]); // HEAD no longer has it — only the branch does

  const { engine, queue } = buildEngine({ writeFiles: { "step one": [] } });
  const r = engine.enqueueGoal({ agentId: "senior-web-1", steps: ["step one"], baseRef: "ma/job/j_seq" });
  assert.ok(r.goalId);

  const plan = JSON.parse(readFileSync(join(storeDir, "goals", `${r.goalId}.json`), "utf-8"));
  assert.equal(plan.baseRef, "ma/job/j_seq", "the goal plan must carry the base");

  await until(() => (queue.get(r.firstTaskId)?.baseRef ?? null) !== null);
  assert.equal(queue.get(r.firstTaskId).baseRef, tip,
    "the task's worktree must be cut from the job branch tip, not from HEAD");
});

test("SEQ-WIRED-1: server.mjs FORWARDS baseRef into engine.enqueueGoal", () => {
  // Found by mutation, not by reading: deleting `baseRef` from server.mjs's enqueueGoal
  // wrapper left ENG-BASE-1 green, because that test calls engine.enqueueGoal directly and
  // never crosses the hop the Manager actually uses. Exactly SEAT-12's shape — a claim proven
  // on every seam except the one in the running server. Asserted on the AST, not on text.
  const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  let forwarded = false;
  (function walk(n) {
    if (!n || typeof n.type !== "string" || forwarded) return;
    if (n.type === "CallExpression"
        && n.callee?.type === "MemberExpression"
        && n.callee.object?.name === "engine"
        && n.callee.property?.name === "enqueueGoal") {
      for (const a of n.arguments) {
        if (a.type === "ObjectExpression" && a.properties.some((pr) => pr.key?.name === "baseRef")) forwarded = true;
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  })(ast);
  assert.ok(forwarded, "engine.enqueueGoal must be called with baseRef — otherwise every seat's worktree is cut from HEAD");
});

// ── C23 · the engine must SAY what it is doing ──────────────────────────────
// The Phase C live run lost a job to a task that sat in `claimed`/`EDITING` for 16 minutes.
// Diagnosing it afterwards was impossible: engine.mjs contained exactly ONE console.warn in
// the whole file, so there was no record of the dispatch starting, the watchdog firing, or a
// retry being scheduled. Three hypotheses were eliminated by loop instead of by evidence,
// which is the expensive way. The engine now emits a structured trace.
test("ENG-TRACE-1: a dispatch that times out leaves a trace — start, watchdog, outcome", async () => {
  // Mutation proof (2026-09-18): removed the task-watchdog log → ✖ ENG-TRACE-1 (fail 1);
  // `stuckTasks()` returning [] → ✖ ENG-TRACE-2 (fail 1), so the two are not redundant.
  // Restored, md5 matched, 55/55 green.
  const seen = [];
  const { engine, queue } = buildEngine({
    dispatchOverride: () => new Promise(() => {}),   // never settles → watchdog must fire
    watchdogMs: 400,
    log: (r) => seen.push(r),
  });
  const r = engine.enqueueGoal({ agentId: "senior-web-1", steps: ["hang forever"] });
  await until(() => queue.get(r.firstTaskId)?.status === "failed");

  const kinds = seen.map((e) => e.event);
  assert.ok(kinds.includes("task-dispatch"), `no dispatch trace: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes("task-watchdog"), `the watchdog fired but said nothing: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes("task-failed"), `no outcome trace: ${JSON.stringify(kinds)}`);
  const wd = seen.find((e) => e.event === "task-watchdog");
  assert.equal(wd.taskId, r.firstTaskId, "the trace must name the task, or it cannot be joined to a job");
  assert.equal(wd.ms, 400, "and the window that elapsed");

  // TEST HYGIENE, and it is load-bearing. This test's dispatch NEVER settles, so the engine is
  // still live when the assertions pass: a watchdog armed for a later attempt can fire after
  // node:test has ended the test, and `afterEach` has by then removed the whole tmpdir — the
  // write lands as `ENOENT ... store/tasks/<id>.json.tmp` and node:test converts it into an
  // uncaughtException that reds the ENTIRE FILE while every individual test reads green.
  //
  // Measured, not assumed: 0/3 in isolation, 1/5 with six CPU hogs running (the shape of the
  // rest of the suite). So it is a genuine leak whose rate is set by machine load, which is
  // precisely the kind of flake that gets waved through as "unrelated" on a busy CI box.
  // Waiting for the store to go QUIET — two consecutive identical reads of the row — keeps any
  // stray write inside the test that caused it, without pinning a magic sleep to a timing race.
  await quietStore(() => JSON.stringify(queue.get(r.firstTaskId) ?? null));
});

test("ENG-TRACE-2: a task that is still claimed is visible as such, with its age", async () => {
  // The exact question nobody could answer during the live run: how long has this been claimed?
  const seen = [];
  const { engine } = buildEngine({
    dispatchOverride: () => new Promise(() => {}),
    watchdogMs: 0,                                   // no watchdog → it really does hang
    log: (r) => seen.push(r),
  });
  const r = engine.enqueueGoal({ agentId: "senior-web-1", steps: ["hang forever"] });
  await until(() => seen.some((e) => e.event === "task-dispatch"));
  const stuck = engine.stuckTasks();
  assert.equal(stuck.length, 1, `one task is in flight: ${JSON.stringify(stuck)}`);
  assert.equal(stuck[0].taskId, r.firstTaskId);
  assert.equal(stuck[0].engineState, "EDITING");
  assert.ok(Number.isFinite(stuck[0].claimedForMs), "and how long it has been there");
});

// ── C23 · the LAST-RESORT reaper ───────────────────────────────────────────
// C23 was never reproduced: three red-capable loops against the real engine all came back
// green, and the live watchdog demonstrably fires (run 2 logged a task-watchdog and a
// classified timeout). Every mechanism was inspected and is coherent — the scheduler releases
// its slot, `running.delete` is in a `finally`, and reclaimExpiredLeases correctly SKIPS a task
// still in `running` because re-queuing a live task would put a second writer on its worktree.
//
// That coherence is the problem. If the watchdog ever fails to fire, nothing else can help:
// the reclaimer is told the task is alive, and it believes it. Live run 1 sat in
// claimed/EDITING for 16 minutes with no process, no error, and a leaked slot.
//
// So this is not a fix for a diagnosed cause. It is a bound on the CLASS: a task held past the
// point its own watchdog should have ended it is a contract violation, whatever caused it. The
// reaper kills the child FIRST (preserving the no-second-writer invariant) and then fails the
// task through the normal retry path.
test("ENG-REAP-1: a task held past its stuck bound is killed and failed, not held forever", async () => {
  // Mutation proof (2026-09-19), three independent legs, each reddening ENG-REAP-1 (fail 1):
  //   the wake no longer calls reapStuck()                 → nothing ever ends the task
  //   a running task arms no wake                          → nothing ever LOOKS (run 1's shape)
  //   reap without handle.kill() first                     → the child outlives its row
  // ENG-REAP-2 stayed green throughout: the reaper does not touch work inside its bound.
  // Restored, md5 matched.
  const seen = [];
  let killed = false;
  let settle = () => {};
  const { engine, queue } = buildEngine({
    // The watchdog is set far out so it CANNOT be what ends this task — the reaper must.
    watchdogMs: 600_000,
    stuckAfterMs: 300,
    dispatchOverride: (ctx) => new Promise((resolve) => {
      settle = () => resolve({ acc: "late" });          // settled at the end of the test
      ctx.registerKill(() => { killed = true; });
    }),
    log: (r) => seen.push(r),
    // UNREF'd on purpose: the engine re-arms its own wake, so a non-unref'd timer keeps node
    // alive after the test ends and the whole file hangs instead of failing.
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: (t) => clearTimeout(t),
  });
  const r = engine.enqueueGoal({ agentId: "senior-web-1", steps: ["hang past the bound"] });
  await until(() => seen.some((e) => e.event === "task-dispatch"));
  // The harness clock is MANUAL (`now = () => clock`), so wall-clock waiting can never make a
  // task look old. Advance it past the bound; the real wake timer then delivers the reap.
  clock += 5_000;
  engine.tick();

  await until(() => queue.get(r.firstTaskId)?.status === "failed", 8000);
  const row = queue.get(r.firstTaskId);
  assert.equal(row.status, "failed", "the reaper must end it");
  assert.equal(row.error?.kind, "timeout", `failed for the right reason: ${JSON.stringify(row.error)}`);
  assert.ok(killed, "the child must be killed BEFORE the row is freed — otherwise a requeue puts a second writer on the worktree");
  assert.ok(seen.some((e) => e.event === "task-reaped"), `the reaping must be traced: ${JSON.stringify(seen.map((e) => e.event))}`);
  assert.equal(engine.stuckTasks().length, 0, "and the slot must not leak");
  // Let the abandoned dispatch settle, or this file's event loop never drains and the RUNNER
  // hangs instead of reporting. A late settle must be harmless — handle.killed makes runStep
  // return at its existing guard rather than writing over the row the reaper just failed.
  settle();
  await new Promise((s) => setTimeout(s, 50));
  assert.equal(queue.get(r.firstTaskId).status, "failed", "a late settle must not resurrect the task");
});

test("ENG-REAP-2: a task INSIDE its bound is left alone", async () => {
  // The reaper must not become a second, shorter watchdog — that would kill honest slow work.
  const seen = [];
  let settle2 = () => {};
  const { engine, queue } = buildEngine({
    watchdogMs: 600_000,
    stuckAfterMs: 8_000,   // >> the 5s the clock advances below, and far below MAX_WAKE_MS
    dispatchOverride: () => new Promise((resolve) => { settle2 = () => resolve({ acc: "done" }); }),
    log: (r) => seen.push(r),
    // UNREF'd on purpose: the engine re-arms its own wake, so a non-unref'd timer keeps node
    // alive after the test ends and the whole file hangs instead of failing.
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: (t) => clearTimeout(t),
  });
  const r = engine.enqueueGoal({ agentId: "senior-web-1", steps: ["still working"] });
  await until(() => seen.some((e) => e.event === "task-dispatch"));
  clock += 5_000;            // well past REAP-1's bound, still inside this test's 8s one
  engine.tick();
  await new Promise((s) => setTimeout(s, 700));
  assert.equal(queue.get(r.firstTaskId)?.status, "claimed", "honest in-flight work must survive");
  assert.ok(!seen.some((e) => e.event === "task-reaped"), "and must not be reaped");
  settle2();
  await new Promise((s) => setTimeout(s, 50));
});

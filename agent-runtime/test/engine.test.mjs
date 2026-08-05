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

let root, repoRoot, worktreeRoot, storeDir, clock;
const TOKEN = "engine-test-token";
const git = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const now = () => clock;

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
  setTimer = () => ({ __inert: true }), clearTimer = () => {}, autoStart = true, onDone,
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
    onTerminalFailure, onDone, setTimer, clearTimer,
    now, goalsDir: join(storeDir, "goals"), jitter: () => 0,
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

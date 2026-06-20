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
function buildEngine({ writeFiles = {}, maxInflight = 2, dispatchOverride, maxQueued = 500 } = {}) {
  const queue = createQueue({ dir: storeDir, now, maxQueued, leaseMs: 600_000, maxPerAgent: 2 });
  const policy = createPolicy({ file: join(storeDir, "policy.json"), token: TOKEN });
  const worktreeMgr = createWorktreeMgr({ repoRoot, worktreeRoot });
  const broker = createBroker({ repoRoot, workdirFor: (id) => worktreeMgr.pathFor(id), scrub: (s) => s });
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
    now, goalsDir: join(storeDir, "goals"), jitter: () => 0,
  });
  engine.start();
  return { engine, queue, policy, worktreeMgr, broker, reports, escalations, inUseRef: () => inUse, scheduler };
}

const goalDone = (queue, goalId) => () => {
  const tasks = queue.all().filter((t) => t.goalId === goalId);
  return tasks.length > 0 && tasks.every((t) => ["done", "failed", "cancelled", "held"].includes(t.status));
};

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
  const { engine, queue, broker, worktreeMgr } = buildEngine({});
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
  const { engine, queue, worktreeMgr, policy } = buildEngine({
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

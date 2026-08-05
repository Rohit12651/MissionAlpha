// P4 — AUTONOMY PROOFS. "BOSS queues work and walks away."
//
// Real queue (durable temp dir) + real scheduler + real engine state machine. The
// only injected fake is dispatchFn — a live `claude` child needs the cli backend, so
// agent work itself is mocked here and proven end-to-end against the runtime
// separately (see the P4 exit report's live-probe evidence).
//
// Clock and slot budget are injected so nothing sleeps and nothing races.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQueue } from "../queue.mjs";
import { createScheduler } from "../scheduler.mjs";
import { createEngine } from "../engine.mjs";

let dir;
let clock;
const now = () => clock;
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ma-autonomy-")); clock = 2_000_000; });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

function slots(max) {
  let n = 0, peak = 0;
  return {
    tryAcquireSlot: () => (n >= max ? false : (n++, peak = Math.max(peak, n), true)),
    releaseSlot: () => { n = Math.max(0, n - 1); },
    peak: () => peak,
    inUse: () => n,
  };
}

// One wiring helper — every test builds its rig from this. `queueOpts` reaches
// createQueue so per-agent concurrency can be exercised at its real default.
function rig(opts = {}) {
  const queue = createQueue({ dir, now, emit: opts.emit, ...(opts.queueOpts || {}) });
  const budget = slots(opts.maxInflight ?? 6);
  const scheduler = createScheduler({
    tryAcquireSlot: budget.tryAcquireSlot,
    releaseSlot: budget.releaseSlot,
    claimNext: () => queue.claimNext(),
  });
  const failures = [];
  const applied = [];
  const engine = createEngine({
    queue,
    scheduler,
    policy: { decide: () => ({ autoApply: opts.autoApply !== false, heldReason: "held for review" }) },
    broker: {
      listChanges: opts.listChanges || (async () => [{ path: "a.ts", before: null, after: "hi\n" }]),
      applyChanges: opts.applyChanges || (async (id, paths) => { applied.push(...paths); return paths.map((p) => ({ path: p, ok: true })); }),
    },
    dispatchFn: opts.dispatchFn || (async () => ({ acc: "done" })),
    onTerminalFailure: (task, info) => failures.push(info),
    // deterministic timers — the wake gate never fires on its own inside a test
    setTimer: () => ({ __fake: true }),
    clearTimer: () => {},
    now,
    jitter: () => 0,
    goalsDir: join(dir, "goals"),
  });
  return { queue, engine, scheduler, budget, failures, applied };
}

// ── restart safety ──────────────────────────────────────────────────────────

test("RESTART RESUME: a claim held when the process dies returns to queued — no loss, no duplication", async () => {
  // run 1: claim a task, then "kill -9" (drop the instance, keep the on-disk store)
  const one = rig();
  one.engine.enqueueGoal({ agentId: "a1", steps: ["step one"] });
  const claimed = one.queue.claimNext();
  assert.equal(claimed.status, "claimed");
  const idBefore = claimed.taskId;
  const countBefore = one.queue.all().length;

  // run 2: a brand-new instance over the SAME dir — this is the reboot
  const two = rig();
  assert.equal(two.queue.all().length, countBefore, "no task was lost across the restart");
  assert.equal(two.queue.get(idBefore).status, "claimed", "state survived on disk");
  await two.engine.reconcile();
  const after = two.queue.get(idBefore);
  assert.equal(after.status, "queued", "the orphaned claim is resumable");
  assert.equal(after.claimedAt, null);
  assert.equal(after.leaseExpiry, null);
  assert.equal(two.queue.all().length, countBefore, "recovery DUPLICATED nothing");
  assert.equal(two.queue.all().filter((t) => t.goalId === after.goalId).length, 1);
});

test("RESTART RESUME: the resumed task runs to completion and applies exactly once", async () => {
  const one = rig();
  one.engine.enqueueGoal({ agentId: "a1", steps: ["step one"] });
  const claimed = one.queue.claimNext();

  const two = rig();
  await two.engine.reconcile();
  two.engine.start();
  await flush();
  assert.deepEqual(two.applied, ["a.ts"], "applied exactly once across the crash");
  assert.equal(two.queue.get(claimed.taskId).status, "done");
});

test("RESTART RESUME: an already-DONE task is never re-run by recovery", async () => {
  const one = rig();
  one.engine.enqueueGoal({ agentId: "a1", steps: ["step one"] });
  one.engine.start();
  await flush();
  const doneTask = one.queue.all().find((t) => t.status === "done");
  assert.ok(doneTask, "the first run completed");

  const two = rig();
  await two.engine.reconcile();
  two.engine.start();
  await flush();
  assert.deepEqual(two.applied, [], "a terminal task is not resurrected");
  assert.equal(two.queue.get(doneTask.taskId).status, "done");
});

// ── auto-chain ──────────────────────────────────────────────────────────────

test("AUTO-CHAIN: approving a HELD step dispatches the goal's next step with no human dispatch", async () => {
  const dispatched = [];
  const r = rig({
    autoApply: false, // policy holds → the step waits for the operator
    dispatchFn: async (ctx) => { dispatched.push(ctx.task); return { acc: "ok" }; },
  });
  r.engine.enqueueGoal({ agentId: "a1", steps: ["step one", "step two"] });
  r.engine.start();
  await flush();
  assert.deepEqual(dispatched, ["step one"], "step two must NOT run before the decision");
  const held = r.queue.all().find((t) => t.status === "held");
  assert.ok(held, "step one is HELD awaiting the operator");

  // exactly what deliveries.onApproved(taskId) calls after a successful apply
  r.engine.onOperatorApplied(held.taskId);
  await flush();
  assert.deepEqual(dispatched, ["step one", "step two"], "step two dispatched itself");
  assert.equal(r.queue.get(held.taskId).status, "done");
});

test("AUTO-CHAIN: the chain stays paused until the decision arrives", async () => {
  const r = rig({ autoApply: false });
  r.engine.enqueueGoal({ agentId: "a1", steps: ["one", "two", "three"] });
  r.engine.start();
  await flush(40);
  assert.equal(r.queue.all().length, 1, "no step is enqueued speculatively past a hold");
});

test("AUTO-CHAIN: request-changes feedback enqueues AND dispatches with no human tick", async () => {
  const dispatched = [];
  const r = rig({ dispatchFn: async (ctx) => { dispatched.push(ctx.task); return { acc: "ok" }; } });
  r.engine.start();
  await flush();
  // rerunFn in server.mjs is exactly this call
  const out = r.engine.enqueueGoal({ agentId: "a9", priority: "high", steps: ["fix the thing properly"] });
  assert.ok(out.goalId);
  await flush();
  assert.deepEqual(dispatched, ["fix the thing properly"], "the feedback task ran itself");
});

// ── retry classifier ────────────────────────────────────────────────────────

test("RETRY: a transient failure auto-retries behind a backoff, then exhausts to a failure Delivery", async () => {
  let calls = 0;
  const r = rig({ dispatchFn: async () => { calls++; return { error: "spawn EAGAIN" }; } });
  r.engine.enqueueGoal({ agentId: "a1", steps: ["do it"] });
  r.engine.start();
  await flush();
  assert.equal(calls, 1, "first attempt ran");
  assert.deepEqual(r.failures, [], "budget remains — the operator is not paged yet");
  const retry = r.queue.all().find((t) => t.status === "queued" && t.attempts === 1);
  assert.ok(retry, "a retry attempt is queued");
  assert.ok(Date.parse(retry.notBefore) > clock, "backoff is honoured (notBefore in the future)");

  for (let i = 0; i < 4 && !r.failures.length; i++) {
    clock += 120_000; // past every backoff
    r.engine.tick();
    await flush();
  }
  assert.ok(calls >= 3, `the retries actually re-dispatched (calls=${calls})`);
  assert.equal(r.failures.length, 1, "exactly one failure Delivery once the budget is spent");
  assert.equal(r.failures[0].kind, "spawn");
  assert.equal(r.failures[0].agentId, "a1");
  assert.equal(r.failures[0].attempts, 3);
  assert.match(r.failures[0].detail, /EAGAIN/);
});

test("RETRY: apply-rejected is terminal on the FIRST failure — a guard verdict is deterministic", async () => {
  const r = rig({
    applyChanges: async (id, paths) => paths.map((p) => ({ path: p, ok: false, error: "protected key changed: scripts" })),
  });
  r.engine.enqueueGoal({ agentId: "a1", steps: ["edit config"] });
  r.engine.start();
  await flush();
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].kind, "apply-rejected");
  assert.match(r.failures[0].detail, /protected key/);
  assert.equal(r.queue.all().filter((t) => t.status === "queued").length, 0, "a guard verdict is never retried");
});

test("RETRY: an empty diff is retryable and the re-prompt is enriched (self-heal)", async () => {
  const prompts = [];
  const r = rig({
    dispatchFn: async (ctx) => { prompts.push(ctx.task); return { acc: "thought hard, wrote nothing" }; },
    listChanges: async () => [],
  });
  r.engine.enqueueGoal({ agentId: "a1", steps: ["make the edit"] });
  r.engine.start();
  await flush();
  clock += 120_000; r.engine.tick(); await flush();
  assert.ok(prompts.length >= 2, "it retried");
  assert.match(prompts[1], /no diff/i, "the retry prompt carries the self-heal note");
});

// ── parallelism ─────────────────────────────────────────────────────────────

test("PARALLEL: 5 tasks across 3 agents — ≤ MAX_INFLIGHT concurrent, each agent serial", async () => {
  const live = new Map();
  let peakPerAgent = 0;
  const release = [];
  const r = rig({
    maxInflight: 6,
    dispatchFn: (ctx) => new Promise((resolve) => {
      const n = (live.get(ctx.agentId) || 0) + 1;
      live.set(ctx.agentId, n);
      peakPerAgent = Math.max(peakPerAgent, n);
      release.push(() => { live.set(ctx.agentId, live.get(ctx.agentId) - 1); resolve({ acc: "ok" }); });
    }),
  });
  for (const [agentId, count] of [["a1", 2], ["a2", 2], ["a3", 1]]) {
    for (let i = 0; i < count; i++) r.engine.enqueueGoal({ agentId, steps: [`t${i}`] });
  }
  r.engine.start();
  await flush();
  assert.ok(r.budget.peak() <= 6, `peak inflight ${r.budget.peak()} must stay ≤ MAX_INFLIGHT 6`);
  assert.equal(peakPerAgent, 1, "each agent runs strictly one task at a time");
  assert.equal(r.budget.inUse(), 3, "3 agents → 3 concurrent children, not 5");
  assert.equal(r.queue.counts().queued, 2, "the other 2 wait their agent's turn — none dropped");
  while (release.length) release.shift()();
  await flush(60);
});

test("PARALLEL: a 10-task burst across 10 agents never exceeds MAX_INFLIGHT", async () => {
  const release = [];
  const r = rig({
    maxInflight: 6,
    dispatchFn: () => new Promise((resolve) => release.push(() => resolve({ acc: "ok" }))),
  });
  for (let i = 0; i < 10; i++) r.engine.enqueueGoal({ agentId: `agent-${i}`, steps: [`t${i}`] });
  r.engine.start();
  await flush();
  assert.equal(r.budget.peak(), 6, "the shared budget is the hard ceiling");
  assert.equal(r.queue.counts().claimed, 6);
  assert.equal(r.queue.counts().queued, 4, "the rest wait in the backlog — none are dropped");
  while (release.length) release.shift()();
  await flush(80);
});

test("PARALLEL: a freed slot backfills the next queued task automatically", async () => {
  const release = [];
  const started = [];
  const r = rig({
    maxInflight: 2,
    dispatchFn: (ctx) => new Promise((resolve) => { started.push(ctx.agentId); release.push(resolve); }),
  });
  for (let i = 0; i < 4; i++) r.engine.enqueueGoal({ agentId: `p${i}`, steps: ["x"] });
  r.engine.start();
  await flush();
  assert.equal(started.length, 2);
  release.shift()({ acc: "ok" }); // one child settles
  await flush(40);
  assert.equal(started.length, 3, "the freed slot pulled the next task with no external tick");
  while (release.length) release.shift()({ acc: "ok" });
  await flush(60);
});

// ── event contract ──────────────────────────────────────────────────────────

test("EVENTS: a happy-path task emits queued → started → done, exactly once each", async () => {
  const seen = [];
  const r = rig({ emit: (name, data) => seen.push({ name, taskId: data.taskId }) });
  r.engine.enqueueGoal({ agentId: "a1", steps: ["only step"] });
  r.engine.start();
  await flush();
  // task.done is the 2026-07-30 plan amendment: the catalog's success-terminal name,
  // so the strip drops a finished task on the frame instead of on the re-truth poll.
  assert.deepEqual(seen.map((e) => e.name), ["task.queued", "task.started", "task.done"]);
  assert.equal(new Set(seen.map((e) => e.taskId)).size, 1, "all three frames describe the same task");
});

test("EVENTS: a retry ladder emits queued → started → failed → retried, in order", async () => {
  const seen = [];
  const r = rig({
    emit: (name) => seen.push(name),
    dispatchFn: async () => ({ error: "spawn EAGAIN" }),
  });
  r.engine.enqueueGoal({ agentId: "a1", steps: ["do it"] });
  r.engine.start();
  await flush();
  assert.deepEqual(seen, ["task.queued", "task.started", "task.failed", "task.retried"]);
});

test("EVENTS: a chained step emits its own task.queued when the predecessor completes", async () => {
  const seen = [];
  const r = rig({ emit: (name) => seen.push(name) });
  r.engine.enqueueGoal({ agentId: "a1", steps: ["one", "two"] });
  r.engine.start();
  await flush(40);
  assert.equal(seen.filter((n) => n === "task.queued").length, 2, "one frame per chained step");
  assert.equal(seen.filter((n) => n === "task.started").length, 2);
});

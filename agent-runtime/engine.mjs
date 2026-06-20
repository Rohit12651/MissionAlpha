// ADR-024 — Autonomous Loop Engine. The SPINE. Orchestrates the EXISTING handlers
// (broker.listChanges/applyChanges, worktree isolation, reportBack) into an
// auto-chaining state machine: QUEUED→DISPATCHED→EDITING→DIFFED→GATING→
// (APPLIED|HELD)→REPORTED→DONE, with idempotency, retry (ADR-028), and per-task git
// worktrees (ADR-026). It NEVER writes to the live repo itself — every apply flows
// through broker.applyChanges, so applyAllowed/CONFIG_GUARD/symlink/realpath re-run
// identically whether the apply was auto (policy ADR-029) or operator-confirmed.
//
// Dispatch is INJECTED (dispatchFn) so tests run deterministically without a live
// `claude` binary; production wires it to a headless claude-write run in the worktree.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { classify, shouldRetry, backoffMs } from "./self-heal.mjs";

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export function createEngine(deps = {}) {
  const queue = deps.queue;
  const policy = deps.policy;
  const worktreeMgr = deps.worktreeMgr || null;
  const scheduler = deps.scheduler;
  const broker = deps.broker; // { listChanges(id), applyChanges(id, paths) }
  const dispatchFn = deps.dispatchFn; // async (ctx) → { acc } | { error }
  const reportBackFn = deps.reportBackFn || (() => {});
  const escalateFn = deps.escalateFn || (() => {});
  const now = deps.now || (() => Date.now());
  const watchdogMs = deps.watchdogMs ?? 0; // 0 = no watchdog (tests)
  const jitter = deps.jitter || (() => 0);
  const goalsDir = deps.goalsDir;

  const goalPlans = new Map(); // goalId → { agentId, tier, priority, steps:[text] }
  const running = new Map();   // taskId → { killed, kill }

  if (goalsDir) {
    mkdirSync(goalsDir, { recursive: true });
    for (const name of (() => { try { return readdirSync(goalsDir); } catch { return []; } })()) {
      if (!name.endsWith(".json")) continue;
      try {
        const g = JSON.parse(readFileSync(join(goalsDir, name), "utf-8"));
        if (g && g.goalId) goalPlans.set(g.goalId, g);
      } catch { /* skip corrupt */ }
    }
  }

  function persistGoal(plan) {
    if (!goalsDir) return;
    const file = join(goalsDir, `${plan.goalId}.json`);
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify(plan)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  }

  // Enqueue a goal as an ordered chain of steps. Step 0 is enqueued now; each next
  // step is enqueued only when its predecessor reaches DONE (ADR-024 §3).
  function enqueueGoal({ agentId, tier = "sonnet", priority = "normal", steps }) {
    if (!Array.isArray(steps) || !steps.length) throw new Error("enqueueGoal: steps[] required");
    const goalId = `goal_${randomBytes(6).toString("hex")}`;
    const plan = { goalId, agentId, tier, priority, steps: steps.map((s) => String(s).slice(0, 4000)) };
    const r = queue.enqueue({ goalId, stepIndex: 0, attempt: 0, agentId, tier, priority, task: plan.steps[0] });
    if (r.error) return { error: r.error }; // backlog full → do NOT persist a goal that can't start
    goalPlans.set(goalId, plan);
    persistGoal(plan);
    tick();
    return { goalId, firstTaskId: r.taskId };
  }

  function tick() {
    scheduler.tick();
  }

  function withWatchdog(promise, ms, onTimeout) {
    if (!ms) return promise;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { try { onTimeout?.(); } catch { /* */ } const e = new Error("watchdog timeout"); e.__timeout = true; reject(e); }, ms);
      Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  function chainNext(task) {
    const plan = goalPlans.get(task.goalId);
    if (!plan) return;
    const nextIndex = (task.stepIndex ?? 0) + 1;
    if (nextIndex >= plan.steps.length) return; // goal complete
    const r = queue.enqueue({
      goalId: plan.goalId, stepIndex: nextIndex, attempt: 0,
      agentId: plan.agentId, tier: plan.tier, priority: plan.priority,
      task: plan.steps[nextIndex], parentTaskId: task.taskId,
    });
    // Backlog full mid-chain → do NOT stall silently; escalate so the operator sees it.
    if (r.error) {
      escalateFn(plan.agentId, "chain-stalled", task.attempts ?? 0, `cannot enqueue step ${nextIndex}: ${r.error}`);
      return;
    }
    tick();
  }

  function finishApplied(task, okPaths) {
    worktreeMgr?.remove(task.taskId);
    queue.update(task.taskId, { status: "done", engineState: "DONE", applyMarker: "applied", result: `applied ${okPaths.length}: ${okPaths.join(", ")}` });
    reportBackFn(task.agentId, `${okPaths.length} file(s): ${okPaths.join(", ")}`);
    chainNext(task);
  }

  // Terminal failure (apply-rejected OR retries exhausted): discard worktree, escalate,
  // PAUSE the goal chain (do not enqueue the next step). OQ-028.2 = pause + escalate.
  function failTerminal(task, kind, reason, attempts) {
    worktreeMgr?.remove(task.taskId);
    queue.update(task.taskId, { status: "failed", engineState: "FAILED", applyMarker: null, error: { kind, msg: reason } });
    escalateFn(task.agentId, kind, attempts ?? task.attempts, reason);
  }

  // Retryable failure: discard worktree, mark this attempt failed, re-enqueue a fresh
  // attempt (new idemKey + new worktree) with backoff + self-heal re-prompt enrichment.
  function handleRetryable(task, kind, reason) {
    worktreeMgr?.remove(task.taskId);
    const attempts = (task.attempts ?? 0) + 1;
    queue.update(task.taskId, { status: "failed", engineState: "FAILED", error: { kind, msg: reason }, attempts });
    if (!shouldRetry(kind, attempts, task.maxAttempts ?? 3)) {
      return failTerminal(task, kind, reason, attempts); // exhausted
    }
    const plan = goalPlans.get(task.goalId);
    const baseText = plan ? plan.steps[task.stepIndex ?? 0] : task.task;
    const enrich = (kind === "empty-diff" || kind === "no-output")
      ? "\n\n(prior attempt produced no diff; make the concrete file edit in the working directory NOW.)" : "";
    const delay = backoffMs(attempts, { jitter });
    queue.enqueue({
      goalId: task.goalId, stepIndex: task.stepIndex,
      attempt: attempts,   // idemKey differentiator (distinct attempt → distinct task)
      attempts,            // the RETRY COUNTER must carry forward, else retries never exhaust
      agentId: task.agentId, tier: task.tier, priority: task.priority,
      task: `${baseText}${enrich}`, parentTaskId: task.taskId, maxAttempts: task.maxAttempts ?? 3,
      notBefore: new Date(now() + delay).toISOString(),
    });
    tick();
  }

  // The step state machine. One agent, one worktree, one diff, one gate decision.
  async function runStep(task) {
    const id = task.taskId;
    const cur = queue.get(id);
    if (!cur || TERMINAL.has(cur.status) || cur.status === "held") return; // re-entry guard

    // DISPATCHED — create per-task git worktree (ADR-026).
    let workdir = null, wtInfo = {};
    if (worktreeMgr) {
      try { wtInfo = worktreeMgr.create(id); workdir = wtInfo.path; }
      catch (e) { return handleRetryable(task, "spawn", `worktree create failed: ${e.message}`); }
    }
    queue.update(id, { engineState: "EDITING", branch: wtInfo.branch || null, baseRef: wtInfo.baseRef || null, claimedAt: cur.claimedAt });
    const handle = { killed: false, kill: null };
    running.set(id, handle);

    try {
      // EDITING — dispatch the agent (writes into the worktree), watchdog-guarded.
      let res;
      try {
        const ctx = { taskId: id, agentId: task.agentId, tier: task.tier, task: task.task, workdir, registerKill: (fn) => { handle.kill = fn; } };
        res = await withWatchdog(dispatchFn(ctx), watchdogMs, () => { handle.kill?.(); });
      } catch (e) {
        return handleRetryable(task, e.__timeout ? "timeout" : "spawn", e.message);
      }
      if (handle.killed) return; // cancelled mid-edit — cancel() already cleaned up
      if (res && res.error) return handleRetryable(task, "spawn", String(res.error));

      // DIFFED — compute the diff from the worktree via the shared broker.
      const changes = await broker.listChanges(id);
      if (!changes.length) return handleRetryable(task, "empty-diff", "no diff produced");
      queue.update(id, { engineState: "DIFFED" });

      // GATING — policy decides auto-apply vs hold (ADR-029). Broker re-validates either way.
      const paths = changes.map((c) => c.path);
      const decision = policy.decide(task.agentId, paths);
      if (!decision.autoApply) {
        // HELD — keep the worktree so the operator can /apply from it; chain pauses.
        queue.update(id, { status: "held", engineState: "HELD", heldReason: decision.heldReason });
        return;
      }

      // APPLIED (auto) — persist the pre-apply marker BEFORE applyChanges (idempotency §4),
      // then converge on the SAME broker.applyChanges the operator path uses.
      queue.update(id, { engineState: "GATING", applyMarker: "applying" });
      const results = await broker.applyChanges(id, paths);
      if (handle.killed) return; // cancelled during apply — cancel() already set terminal + cleaned up
      const cls = classify({ type: "apply", applyResults: results });
      if (cls.kind === "apply-rejected") {
        const why = results.filter((r) => !r.ok).map((r) => r.error).join("; ");
        return failTerminal(task, "apply-rejected", why); // NON-retryable (guard fired)
      }
      const okPaths = results.filter((r) => r.ok).map((r) => r.path);
      finishApplied(task, okPaths);
    } finally {
      running.delete(id);
    }
  }

  // Operator confirmed a HELD step via the existing /apply route → advance the chain.
  function onOperatorApplied(taskId) {
    const task = queue.get(taskId);
    if (!task || task.status !== "held") return;
    worktreeMgr?.remove(taskId);
    queue.update(taskId, { status: "done", engineState: "DONE", applyMarker: "applied", result: "operator-applied" });
    chainNext(task);
  }

  // Cancellation (ADR-025 §5) — kill the in-flight child, discard worktree, never apply.
  function cancel(taskId) {
    const h = running.get(taskId);
    if (h) { h.killed = true; try { h.kill?.(); } catch { /* */ } }
    worktreeMgr?.remove(taskId);
    queue.update(taskId, { status: "cancelled", engineState: "CANCELLED" });
    tick();
  }

  // Crash recovery (ADR-024 §4 + ADR-026 §6).
  async function reconcile() {
    worktreeMgr?.pruneOrphans();
    queue.reclaimExpiredLeases();
    for (const task of queue.all()) {
      if (task.applyMarker === "applying") {
        // crashed mid-apply — re-converge: empty diff ⇒ already landed; else re-apply.
        const changes = await broker.listChanges(task.taskId);
        if (!changes.length) {
          queue.update(task.taskId, { status: "done", engineState: "DONE", applyMarker: "applied", result: "reconciled-applied" });
        } else {
          const results = await broker.applyChanges(task.taskId, changes.map((c) => c.path));
          const okPaths = results.filter((r) => r.ok).map((r) => r.path);
          if (okPaths.length) finishApplied(task, okPaths);
          else {
            // re-apply rejected (a guard now fires) → don't strand at 'applying'; terminal + escalate.
            const why = results.filter((r) => !r.ok).map((r) => r.error).join("; ") || "reconcile re-apply produced no applied paths";
            failTerminal(task, "apply-rejected", why);
          }
        }
      } else if (task.status === "claimed" && task.engineState && !TERMINAL.has(task.status)) {
        // dispatched/editing but child died with the process → safe to re-attempt
        queue.update(task.taskId, { status: "queued", engineState: null, claimedAt: null, leaseExpiry: null });
      }
    }
    tick();
  }

  function start() {
    scheduler.start(runStep);
  }

  return { enqueueGoal, runStep, tick, start, cancel, onOperatorApplied, reconcile, _goalPlans: goalPlans };
}

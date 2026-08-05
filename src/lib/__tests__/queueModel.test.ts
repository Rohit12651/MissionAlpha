// P4 — QueueStrip reducer. Pure arithmetic, no DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_QUEUE,
  MAX_AGENT_CHIPS,
  agentChips,
  applyQueueEvent,
  fromSnapshot,
  queueCounts,
} from "../queueModel.ts";
import type { RuntimeEvent } from "../useRuntimeEvents.ts";

const ev = (name: string, data: Record<string, unknown>) => ({ name, data }) as unknown as RuntimeEvent;

test("EMPTY_QUEUE has zero of everything", () => {
  assert.deepEqual(queueCounts(EMPTY_QUEUE), { queued: 0, running: 0, retrying: 0, failed: 0, total: 0 });
  assert.deepEqual(agentChips(EMPTY_QUEUE), []);
});

test("task.queued adds a queued task", () => {
  const s = applyQueueEvent(EMPTY_QUEUE, ev("task.queued", { taskId: "task_a", agentId: "web-1" }));
  assert.equal(queueCounts(s).queued, 1);
  assert.equal(queueCounts(s).total, 1);
});

test("task.started moves the SAME task from queued to running — never double-counts", () => {
  let s = applyQueueEvent(EMPTY_QUEUE, ev("task.queued", { taskId: "task_a", agentId: "web-1" }));
  s = applyQueueEvent(s, ev("task.started", { taskId: "task_a", agentId: "web-1" }));
  assert.deepEqual(queueCounts(s), { queued: 0, running: 1, retrying: 0, failed: 0, total: 1 });
});

test("a replayed task.started is idempotent (Last-Event-ID replay must not inflate counts)", () => {
  let s = applyQueueEvent(EMPTY_QUEUE, ev("task.started", { taskId: "task_a", agentId: "web-1" }));
  const once = s;
  s = applyQueueEvent(s, ev("task.started", { taskId: "task_a", agentId: "web-1" }));
  assert.equal(queueCounts(s).running, 1);
  assert.equal(s, once, "an unchanged fold returns the same reference — no re-render");
});

test("task.retried registers the NEW attempt as retrying alongside the failed original", () => {
  let s = applyQueueEvent(EMPTY_QUEUE, ev("task.started", { taskId: "task_a", agentId: "web-1" }));
  s = applyQueueEvent(s, ev("task.failed", { taskId: "task_a", agentId: "web-1", kind: "timeout" }));
  s = applyQueueEvent(s, ev("task.retried", { taskId: "task_b", agentId: "web-1", attempts: 1 }));
  const c = queueCounts(s);
  assert.equal(c.retrying, 1);
  assert.equal(c.failed, 1);
  assert.equal(c.running, 0);
  assert.equal(c.total, 2);
});

test("task.failed keeps the failure visible but out of running, carrying its kind", () => {
  let s = applyQueueEvent(EMPTY_QUEUE, ev("task.started", { taskId: "task_a", agentId: "web-1" }));
  s = applyQueueEvent(s, ev("task.failed", { taskId: "task_a", agentId: "web-1", kind: "spawn" }));
  assert.deepEqual(queueCounts(s), { queued: 0, running: 0, retrying: 0, failed: 1, total: 1 });
  assert.equal(s.tasks["task_a"].kind, "spawn");
});

test("task.failed with no kind degrades to 'unknown' rather than null", () => {
  const s = applyQueueEvent(EMPTY_QUEUE, ev("task.failed", { taskId: "task_a", agentId: "web-1" }));
  assert.equal(s.tasks["task_a"].kind, "unknown");
});

test("an event outside the four task.* names is ignored", () => {
  const s = applyQueueEvent(EMPTY_QUEUE, ev("delivery.created", { id: "x" }));
  assert.equal(s, EMPTY_QUEUE, "same reference — no needless re-render");
});

test("an event with no taskId is ignored rather than creating an 'undefined' task", () => {
  const s = applyQueueEvent(EMPTY_QUEUE, ev("task.queued", { agentId: "web-1" }));
  assert.equal(queueCounts(s).total, 0);
});

test("a task with no agentId is bucketed under 'unknown', never dropped", () => {
  const s = applyQueueEvent(EMPTY_QUEUE, ev("task.queued", { taskId: "task_a" }));
  assert.equal(s.tasks["task_a"].agentId, "unknown");
});

test("fromSnapshot maps runtime statuses onto the strip's four buckets", () => {
  const s = fromSnapshot([
    { taskId: "t1", agentId: "web-1", status: "queued", attempts: 0 },
    { taskId: "t2", agentId: "web-1", status: "queued", attempts: 2 },
    { taskId: "t3", agentId: "api-1", status: "claimed", attempts: 0 },
    { taskId: "t4", agentId: "api-1", status: "failed", attempts: 3, error: { kind: "timeout" } },
    { taskId: "t5", agentId: "api-1", status: "done", attempts: 0 },
    { taskId: "t6", agentId: "api-1", status: "held", attempts: 0 },
    { taskId: "t7", agentId: "api-1", status: "cancelled", attempts: 0 },
  ]);
  assert.deepEqual(queueCounts(s), { queued: 1, running: 1, retrying: 1, failed: 1, total: 4 });
  assert.equal(s.tasks["t4"].kind, "timeout");
});

test("fromSnapshot replaces state wholesale — a settled task disappears", () => {
  const stale = fromSnapshot([{ taskId: "t1", agentId: "web-1", status: "claimed", attempts: 0 }]);
  assert.equal(queueCounts(stale).running, 1);
  assert.deepEqual(queueCounts(fromSnapshot([])), { queued: 0, running: 0, retrying: 0, failed: 0, total: 0 });
});

test("fromSnapshot tolerates a malformed payload without throwing", () => {
  const s = fromSnapshot([
    { taskId: "", agentId: "x", status: "queued" },
    { agentId: "y", status: "queued" } as never,
    { taskId: "ok", agentId: "z", status: "claimed" },
  ]);
  assert.equal(queueCounts(s).total, 1);
});

test("agentChips are sorted busiest-first, then alphabetically", () => {
  const s = fromSnapshot([
    { taskId: "a", agentId: "zeta", status: "claimed" },
    { taskId: "b", agentId: "alpha", status: "queued" },
    { taskId: "c", agentId: "alpha", status: "queued" },
    { taskId: "d", agentId: "beta", status: "claimed" },
  ]);
  const chips = agentChips(s);
  assert.equal(chips[0].agentId, "alpha");
  assert.equal(chips[0].total, 2);
  assert.deepEqual(chips.slice(1).map((c) => c.agentId), ["beta", "zeta"]);
});

test("agentChips caps the list at MAX_AGENT_CHIPS", () => {
  const s = fromSnapshot(
    Array.from({ length: 12 }, (_, i) => ({ taskId: `t${i}`, agentId: `agent-${i}`, status: "queued" })),
  );
  assert.equal(agentChips(s).length, MAX_AGENT_CHIPS);
});

test("an agent chip breaks its own total down by bucket", () => {
  const s = fromSnapshot([
    { taskId: "a", agentId: "solo", status: "claimed" },
    { taskId: "b", agentId: "solo", status: "queued", attempts: 0 },
    { taskId: "c", agentId: "solo", status: "queued", attempts: 1 },
    { taskId: "d", agentId: "solo", status: "failed", error: { kind: "crash" } },
  ]);
  assert.deepEqual(agentChips(s)[0], { agentId: "solo", queued: 1, running: 1, retrying: 1, failed: 1, total: 4 });
});

// ── task.done (program plan §2 amendment, 2026-07-30) ───────────────────────

test("task.done DROPS the task from the strip — no waiting on the debounced re-truth", () => {
  let s = applyQueueEvent(EMPTY_QUEUE, ev("task.queued", { taskId: "task_a", agentId: "web-1" }));
  s = applyQueueEvent(s, ev("task.started", { taskId: "task_a", agentId: "web-1" }));
  assert.equal(queueCounts(s).running, 1);

  s = applyQueueEvent(s, ev("task.done", { taskId: "task_a", agentId: "web-1", status: "done" }));
  assert.deepEqual(queueCounts(s), { queued: 0, running: 0, retrying: 0, failed: 0, total: 0 });
  assert.deepEqual(agentChips(s), [], "the agent chip goes with its last task");
});

test("task.done leaves every OTHER task untouched", () => {
  let s = applyQueueEvent(EMPTY_QUEUE, ev("task.started", { taskId: "task_a", agentId: "web-1" }));
  s = applyQueueEvent(s, ev("task.started", { taskId: "task_b", agentId: "web-2" }));
  s = applyQueueEvent(s, ev("task.done", { taskId: "task_a", agentId: "web-1" }));
  assert.deepEqual(queueCounts(s), { queued: 0, running: 1, retrying: 0, failed: 0, total: 1 });
  assert.deepEqual(agentChips(s).map((c) => c.agentId), ["web-2"]);
});

test("a replayed task.done for an unknown task is a no-op and does not re-render", () => {
  const s = applyQueueEvent(EMPTY_QUEUE, ev("task.done", { taskId: "task_gone", agentId: "web-1" }));
  assert.equal(s, EMPTY_QUEUE, "same reference — Last-Event-ID replay must be free");
});

test("task.done without a taskId is ignored", () => {
  const base = applyQueueEvent(EMPTY_QUEUE, ev("task.started", { taskId: "task_a", agentId: "web-1" }));
  const s = applyQueueEvent(base, ev("task.done", { agentId: "web-1" }));
  assert.equal(s, base);
  assert.equal(queueCounts(s).running, 1);
});

test("task.done is idempotent — replaying it twice cannot underflow the counts", () => {
  let s = applyQueueEvent(EMPTY_QUEUE, ev("task.started", { taskId: "task_a", agentId: "web-1" }));
  s = applyQueueEvent(s, ev("task.done", { taskId: "task_a", agentId: "web-1" }));
  const once = s;
  s = applyQueueEvent(s, ev("task.done", { taskId: "task_a", agentId: "web-1" }));
  assert.equal(s, once);
  assert.deepEqual(queueCounts(s), { queued: 0, running: 0, retrying: 0, failed: 0, total: 0 });
});

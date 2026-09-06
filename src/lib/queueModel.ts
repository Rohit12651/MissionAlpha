// QueueStrip model (P4). PURE — zero DOM, zero network — so `node --test` imports it
// directly and the strip's arithmetic is provable without a browser.
//
// The strip is push-driven off the `task.*` names in the CLOSED v1 catalog (program
// plan §2). `task.done` (plan amendment, 2026-07-30) DROPS the task in realtime; HELD
// and CANCELLED still leave the queue silently, so `fromSnapshot` replaces state
// wholesale from the runtime's authoritative `GET /runtime/engine/runs` and the deltas
// below are the optimistic in-between.
//
// State is keyed by taskId (not counters) so a Last-Event-ID replay after an SSE
// reconnect re-applies the same frames without inflating anything.
import type { RuntimeEvent } from "./useRuntimeEvents.ts";

/** The four buckets the strip renders. `failed` is terminal-and-visible. */
export type QueueBucket = "queued" | "running" | "retrying" | "failed";

export interface QueueTask {
  agentId: string;
  bucket: QueueBucket;
  /** Classified error kind on a failure (self-heal.mjs), else null. */
  kind: string | null;
}

export interface QueueState {
  tasks: Readonly<Record<string, QueueTask>>;
}

export interface QueueCounts {
  queued: number;
  running: number;
  retrying: number;
  failed: number;
  total: number;
}

export interface AgentChip {
  agentId: string;
  queued: number;
  running: number;
  retrying: number;
  failed: number;
  total: number;
}

export const EMPTY_QUEUE: QueueState = Object.freeze({ tasks: Object.freeze({}) });

/** Max chips rendered before the strip stops listing agents. */
export const MAX_AGENT_CHIPS = 6;

const EVENT_BUCKET: Record<string, QueueBucket> = {
  "task.queued": "queued",
  "task.started": "running",
  "task.retried": "retrying",
  "task.failed": "failed",
};

// D7 — the frames that move the queue. App bumps a COUNTER on these (updater form, so a
// batched SSE burst cannot collapse them) and the strip re-reads authoritative state off
// that counter. Before it, both the delta and the re-truth hung off a single `lastEvent`
// value slot: SSE delivers several frames in one chunk, React batches the assignments,
// and only the last frame of the burst survived — usually `usage.tick`, which the strip
// ignores. Measured result: `/runtime/engine/runs` fetched twice in twenty minutes of
// continuous churn while the strip insisted nothing was running.
//
// `delivery.*` are here because a mint/decision is the moment a task leaves the queue
// without any `task.*` frame naming it (the v1 catalog has no success-terminal for HELD).
const QUEUE_EVENT_NAMES: ReadonlySet<string> = new Set([
  "task.queued", "task.started", "task.retried", "task.failed", "task.done",
  "delivery.created", "delivery.decided",
]);

/** Does this catalog event name change what the queue strip should show? */
export const isQueueEvent = (name: string): boolean => QUEUE_EVENT_NAMES.has(name);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Fold one catalog event into the state. Non-task events, and events without a
 * taskId, return the SAME reference so React skips the re-render entirely.
 */
export function applyQueueEvent(state: QueueState, e: RuntimeEvent): QueueState {
  // Success-terminal: the task has left the queue, so drop it now rather than waiting
  // for the debounced re-truth fetch. Unknown taskId ⇒ same reference, no re-render.
  if (e.name === "task.done") {
    const doneId = str(e.data.taskId);
    if (!doneId || !(doneId in state.tasks)) return state;
    const { [doneId]: _removed, ...rest } = state.tasks;
    return { tasks: rest };
  }
  const bucket = EVENT_BUCKET[e.name];
  if (!bucket) return state;
  const taskId = str(e.data.taskId);
  if (!taskId) return state;
  const agentId = str(e.data.agentId) || "unknown";
  const kind = bucket === "failed" ? str(e.data.kind) || "unknown" : null;
  const prev = state.tasks[taskId];
  if (prev && prev.bucket === bucket && prev.agentId === agentId && prev.kind === kind) return state;
  return { tasks: { ...state.tasks, [taskId]: { agentId, bucket, kind } } };
}

/** One task row of GET /runtime/engine/runs. */
export interface QueueSnapshotTask {
  taskId: string;
  agentId: string;
  status: string;
  attempts?: number;
  error?: { kind?: string } | null;
}

/**
 * Authoritative replacement. A `queued` task with attempts>0 is one waiting out its
 * retry backoff, which the strip shows as `retrying`. Settled statuses (done / held /
 * cancelled) are simply absent — they have left the queue.
 */
export function fromSnapshot(tasks: readonly QueueSnapshotTask[]): QueueState {
  const out: Record<string, QueueTask> = {};
  for (const t of tasks || []) {
    const taskId = str(t?.taskId);
    if (!taskId) continue;
    const agentId = str(t?.agentId) || "unknown";
    let bucket: QueueBucket | null = null;
    if (t.status === "queued") bucket = (t.attempts ?? 0) > 0 ? "retrying" : "queued";
    else if (t.status === "claimed") bucket = "running";
    else if (t.status === "failed") bucket = "failed";
    if (!bucket) continue;
    out[taskId] = { agentId, bucket, kind: bucket === "failed" ? str(t.error?.kind) || "unknown" : null };
  }
  return { tasks: out };
}

export function queueCounts(state: QueueState): QueueCounts {
  const c: QueueCounts = { queued: 0, running: 0, retrying: 0, failed: 0, total: 0 };
  for (const t of Object.values(state.tasks)) {
    c[t.bucket] += 1;
    c.total += 1;
  }
  return c;
}

/** Busiest agent first, ties broken alphabetically. Capped at MAX_AGENT_CHIPS. */
export function agentChips(state: QueueState): AgentChip[] {
  const by = new Map<string, AgentChip>();
  for (const t of Object.values(state.tasks)) {
    const chip = by.get(t.agentId) ?? { agentId: t.agentId, queued: 0, running: 0, retrying: 0, failed: 0, total: 0 };
    chip[t.bucket] += 1;
    chip.total += 1;
    by.set(t.agentId, chip);
  }
  return [...by.values()]
    .sort((a, b) => (b.total !== a.total ? b.total - a.total : a.agentId.localeCompare(b.agentId)))
    .slice(0, MAX_AGENT_CHIPS);
}

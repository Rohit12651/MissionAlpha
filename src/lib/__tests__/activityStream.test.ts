// PHASE 5 — the activity stream reducer. Pure, DOM-free, node:test.
//
// The feed is a CONSUMER of events ADR-052 already fans out. It adds no infrastructure,
// no polling and no server work. What it must not do is lie: every field it renders has
// to come from a real event, and anything the wire does not carry has to be named for
// what it actually is.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVITY_CAP,
  activityRow,
  applyActivity,
  agentsIn,
  filterActivity,
  fallbackSeq,
} from "../activityStream.ts";
import type { RuntimeEvent } from "../useRuntimeEvents.ts";

const ev = (name: string, data: Record<string, unknown> = {}): RuntimeEvent =>
  ({ name, data }) as RuntimeEvent;

// ── row construction ───────────────────────────────────────────────────────────

test("a task.queued event becomes a row with a real verb and target", () => {
  const r = activityRow(ev("task.queued", { agentId: "sr-backend", taskId: "task_ab12cd" }), 1, 1000);
  assert.ok(r);
  assert.equal(r.agentId, "sr-backend");
  assert.equal(r.verb, "queued");
  assert.equal(r.target, "task_ab12cd");
  assert.equal(r.receivedAt, 1000);
  assert.equal(r.seq, 1);
});

test("every catalog event the feed renders produces a non-null row", () => {
  for (const name of [
    "task.queued", "task.started", "task.retried", "task.failed", "task.done",
    "agent.state", "usage.tick", "delivery.created", "delivery.decided",
    "policy.autoapplied", "delivery.sla_halflife", "delivery.expired",
  ]) {
    assert.ok(activityRow(ev(name, { agentId: "a" }), 1, 0), `${name} produced no row`);
  }
});

test("an event outside the feed's vocabulary is dropped, not rendered as undefined", () => {
  // The catalog is larger than what this feed shows. An unknown or reserved name must
  // produce NOTHING rather than a row reading "a undefined undefined".
  assert.equal(activityRow(ev("lead.moved", { agentId: "a" }), 1, 0), null);
  assert.equal(activityRow(ev("not.a.real.event", {}), 1, 0), null);
});

test("no row ever renders the string 'undefined' or 'null'", () => {
  // The single most common feed bug: a missing payload field stringified into the UI.
  for (const name of ["task.queued", "task.done", "delivery.created", "agent.state", "usage.tick"]) {
    const r = activityRow(ev(name, {}), 1, 0);
    if (!r) continue;
    const rendered = `${r.verb} ${r.target ?? ""} ${r.agentId ?? ""}`;
    assert.doesNotMatch(rendered, /undefined|null|NaN|\[object/);
  }
});

test("a missing agentId is null, never invented", () => {
  const r = activityRow(ev("delivery.created", { id: "01J1" }), 1, 0);
  assert.ok(r);
  assert.equal(r.agentId, null);
});

test("agent.state carries the state as the target, and only a known state", () => {
  assert.equal(activityRow(ev("agent.state", { agentId: "a", state: "working" }), 1, 0)?.target, "working");
  // A junk state must not be echoed into the UI verbatim.
  const junk = activityRow(ev("agent.state", { agentId: "a", state: { evil: true } }), 1, 0);
  assert.equal(junk?.target, null);
});

test("tone is derived, and failures are not rendered as neutral", () => {
  assert.equal(activityRow(ev("task.failed", { agentId: "a" }), 1, 0)?.tone, "bad");
  assert.equal(activityRow(ev("delivery.expired", { id: "x" }), 1, 0)?.tone, "bad");
  assert.equal(activityRow(ev("delivery.sla_halflife", { id: "x" }), 1, 0)?.tone, "warn");
  assert.equal(activityRow(ev("task.done", { agentId: "a" }), 1, 0)?.tone, "good");
  assert.equal(activityRow(ev("task.queued", { agentId: "a" }), 1, 0)?.tone, "neutral");
});

test("usage.tick reports tokens, never a dollar figure", () => {
  // agent-runtime/usage.mjs: "NO cost/USD/$ field, ever" for subscription accounts.
  // The feed must not become the place a fabricated cost leaks in.
  const r = activityRow(ev("usage.tick", { agentId: "a", inputTokens: 120, outputTokens: 40 }), 1, 0);
  assert.ok(r);
  assert.match(r.target ?? "", /160 tokens/);
  assert.doesNotMatch(`${r.verb} ${r.target}`, /\$|usd|cost/i);
});

test("the timestamp is named for what it is — client receipt, not server time", () => {
  // The SSE frame carries `id`, `event` and `data`. It does NOT carry a server
  // timestamp, so the only honest time available is when the browser received it.
  const r = activityRow(ev("task.queued", { agentId: "a" }), 1, 1786500000000);
  assert.equal(r?.receivedAt, 1786500000000);
  assert.ok(!("at" in (r as object)), "a field named `at` would imply server time");
});

// ── the ring buffer ────────────────────────────────────────────────────────────

test("rows are newest-first", () => {
  let rows = applyActivity([], ev("task.queued", { agentId: "a" }), 1, 10);
  rows = applyActivity(rows, ev("task.done", { agentId: "b" }), 2, 20);
  assert.equal(rows[0].agentId, "b");
  assert.equal(rows[1].agentId, "a");
});

test("the buffer is bounded — a long session cannot leak memory", () => {
  let rows: ReturnType<typeof applyActivity> = [];
  for (let i = 0; i < ACTIVITY_CAP + 250; i += 1) {
    rows = applyActivity(rows, ev("task.queued", { agentId: `a${i}` }), i, i);
  }
  assert.equal(rows.length, ACTIVITY_CAP);
  assert.equal(rows[0].agentId, `a${ACTIVITY_CAP + 249}`, "newest must survive the cap");
});

test("applyActivity never mutates the array it was given", () => {
  const before = applyActivity([], ev("task.queued", { agentId: "a" }), 1, 0);
  const snapshot = [...before];
  applyActivity(before, ev("task.done", { agentId: "b" }), 2, 1);
  assert.deepEqual(before, snapshot, "the reducer mutated its input");
});

test("a dropped event leaves the buffer identical by reference", () => {
  const rows = applyActivity([], ev("task.queued", { agentId: "a" }), 1, 0);
  assert.equal(applyActivity(rows, ev("lead.moved", {}), 2, 1), rows, "an ignored event forced a re-render");
});

test("a replayed event after a reconnect does not duplicate a row", () => {
  // ADR-052 replays from lastEventId on reconnect. An off-by-one in that watermark must
  // not show the operator the same event twice.
  const e = ev("task.done", { agentId: "a", taskId: "task_ff00aa" });
  const rows = applyActivity([], e, 42, 100);
  const again = applyActivity(rows, e, 42, 900);
  assert.equal(again, rows, "the replayed frame added a duplicate row");
  assert.equal(again.length, 1);
});

test("row ids are unique so React keys never collide", () => {
  let rows: ReturnType<typeof applyActivity> = [];
  for (let i = 0; i < 50; i += 1) rows = applyActivity(rows, ev("task.queued", { agentId: "a" }), i, 0);
  assert.equal(new Set(rows.map((r) => r.id)).size, 50);
});

// ── filtering ──────────────────────────────────────────────────────────────────

test("agentsIn lists the distinct named agents, sorted, with no nulls", () => {
  let rows: ReturnType<typeof applyActivity> = [];
  rows = applyActivity(rows, ev("task.queued", { agentId: "sr-backend" }), 1, 0);
  rows = applyActivity(rows, ev("task.queued", { agentId: "coo-station" }), 2, 1);
  rows = applyActivity(rows, ev("task.queued", { agentId: "sr-backend" }), 3, 2);
  rows = applyActivity(rows, ev("delivery.created", { id: "x" }), 4, 3); // no agentId
  assert.deepEqual(agentsIn(rows), ["coo-station", "sr-backend"]);
});

test("filterActivity with no agent returns the same array reference", () => {
  const rows = applyActivity([], ev("task.queued", { agentId: "a" }), 1, 0);
  assert.equal(filterActivity(rows, null), rows);
});

test("filterActivity narrows to one agent", () => {
  let rows: ReturnType<typeof applyActivity> = [];
  rows = applyActivity(rows, ev("task.queued", { agentId: "a" }), 1, 0);
  rows = applyActivity(rows, ev("task.queued", { agentId: "b" }), 2, 1);
  assert.deepEqual(filterActivity(rows, "a").map((r) => r.agentId), ["a"]);
});

// ── the seq-less frame (code-review MEDIUM) ───────────────────────────────────
test("fallbackSeq is stable for the same frame, so a replayed frame dedupes", () => {
  const frame = { name: "task.started", agentId: "sr-backend", taskId: "t1" };
  assert.equal(fallbackSeq(frame), fallbackSeq({ ...frame }));
  // The old decrementing counter produced a NEW id per delivery — this is the assertion
  // that would have caught the duplicate-on-reconnect bug.
  const rows1 = applyActivity([], frame as never, fallbackSeq(frame), 1000);
  const rows2 = applyActivity(rows1, { ...frame } as never, fallbackSeq({ ...frame }), 2000);
  assert.equal(rows2.length, 1, "a redelivered seq-less frame rendered twice");
});

test("fallbackSeq ignores any seq already on the frame and stays negative", () => {
  const a = { name: "task.started", agentId: "x" };
  assert.equal(fallbackSeq(a), fallbackSeq({ ...a, seq: 99 }));
  assert.ok(fallbackSeq(a) < 0, "a fallback id could collide with a real bus sequence");
});

test("fallbackSeq separates frames that differ in content", () => {
  assert.notEqual(
    fallbackSeq({ name: "task.started", agentId: "a" }),
    fallbackSeq({ name: "task.started", agentId: "b" }),
  );
});

// ── Phase 1 (UI) — run.killed and worker.deferred ────────────────────────────
//
// Both frames have been on the wire and rendered by NOBODY. That is the failure mode this
// whole program exists to kill: `run.killed` is the ONLY place a hook veto is explained, so
// without it a killed run reads as "failed" with no cause; and `worker.deferred` is the one
// signal that separates "the workers are quiet" from "the workers are broken" — the exact
// distinction that let a three-day outage stay invisible.

test("run.killed renders WHY the run died, not just that it did", () => {
  const r = activityRow(
    ev("run.killed", {
      agentId: "sr-backend",
      taskId: "task_ab12cd",
      event: "post-edit",
      reason: "quality gate failed in the worktree — 1 failing\nAssertionError",
    }),
    1,
    1000,
  );
  assert.ok(r);
  assert.equal(r.agentId, "sr-backend");
  assert.equal(r.verb, "run killed");
  // The REASON is the whole point. A row that says only "run killed" is the failure this
  // surface exists to fix.
  assert.ok(r.target?.includes("quality gate failed"), `target was ${JSON.stringify(r.target)}`);
  assert.equal(r.tone, "bad");
});

test("run.killed with no reason falls back to the lifecycle event, never to 'undefined'", () => {
  const r = activityRow(ev("run.killed", { agentId: "qa", taskId: "task_ff00ff", event: "pre-task" }), 2, 1000);
  assert.ok(r);
  assert.equal(r.target, "pre-task");
});

test("run.killed reason is truncated, not allowed to flood the feed", () => {
  const r = activityRow(ev("run.killed", { agentId: "qa", reason: "x".repeat(5000) }), 3, 1000);
  assert.ok(r);
  assert.ok((r.target?.length ?? 0) <= 200, `target was ${r.target?.length} chars`);
});

test("worker.deferred names the reason — 'quiet' and 'broken' must be distinguishable", () => {
  const r = activityRow(ev("worker.deferred", { reason: "memory-pressure", id: "worker-audit" }), 4, 1000);
  assert.ok(r);
  assert.equal(r.verb, "workers deferred");
  assert.equal(r.target, "memory-pressure");
  assert.equal(r.tone, "warn", "a deferral is not a failure — the work is postponed, not lost");
});

test("worker.deferred is NOT agent-scoped — it is a system condition, not one agent's fault", () => {
  const r = activityRow(ev("worker.deferred", { reason: "daily-cap", id: "worker-testgaps" }), 5, 1000);
  assert.ok(r);
  assert.equal(r.agentId, null);
});

test("worker.deferred with no reason still renders rather than vanishing", () => {
  const r = activityRow(ev("worker.deferred", {}), 6, 1000);
  assert.ok(r, "a deferral with an unknown cause is still a deferral the operator should see");
  assert.equal(r.target, null);
});

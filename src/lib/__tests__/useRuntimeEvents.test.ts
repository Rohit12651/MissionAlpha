import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_EVENT_NAMES,
  backoffMs,
  parseEvent,
  applyBadge,
  streamPath,
  type RuntimeEvent,
} from "../useRuntimeEvents.ts";

// ── the closed catalog (program plan §2 / ADR-052 §2) ───────────────────────
test("the catalog is P2's names plus the documented amendments, no more, no less", () => {
  assert.deepEqual([...RUNTIME_EVENT_NAMES].sort(), [
    "agent.state",
    // B2 amendment (ADR-052 §Amendment B2) — the five Business-OS names, registered in
    // ONE catalog change (sorted in, hence scattered through this list):
    // content.changed, lead.moved, output.created, vault.written, workflow.run.
    // `vault.written` fires from B2; the other four are RESERVED so B4/B6/B7 emit
    // without a second catalog change.
    "content.changed",
    "delivery.created",
    "delivery.decided",
    // delivery.expired + delivery.sla_halflife — P6/ADR-053 SLA amendment (2026-07-30).
    "delivery.expired",
    "delivery.sla_halflife",
    "lead.moved",
    // loop.step — CC-Primitives P2 amendment (2026-08-04), sorts here.
    "loop.step",
    // memory.changed — CC-Primitives P4 amendment (2026-08-04), sorts here.
    "memory.changed",
    "output.created",
    "policy.autoapplied",
    // skills.changed — CC-Primitives P3 amendment (2026-08-04), sorts here.
    "skills.changed",
    // station.perm.changed — CC-Primitives P1 amendment (2026-08-03), sorts here.
    "station.perm.changed",
    // story.changed — Story-Pipeline S1 amendment (2026-08-04), sorts between
    // station.perm.changed and task.done.
    "story.changed",
    // task.done — plan amendment 2026-07-30. MUST stay in lockstep with
    // agent-runtime/events.mjs EVENT_NAMES: a name here that the server does not
    // emit is dead, and a name the server emits that is missing here is dropped by
    // parseEvent and never subscribed to.
    "task.done",
    "task.failed",
    "task.queued",
    "task.retried",
    "task.started",
    "usage.tick",
    "vault.written",
    "workflow.run",
  ]);
});

test("vault.written parses as a catalog event (the hook subscribes to it)", () => {
  const parsed = parseEvent("vault.written", JSON.stringify({ id: "abc", node: "market", venture: "waahyu", agent: "pm-analyst" }));
  assert.ok(parsed, "not rejected by the closed catalog");
  assert.equal(parsed.name, "vault.written");
  assert.equal(parsed.data.node, "market");
});

test("a vault name outside the catalog is still rejected", () => {
  assert.equal(parseEvent("vault.deleted", "{}"), null);
});

test("task.done parses as a catalog event (the hook subscribes to it)", () => {
  const parsed = parseEvent("task.done", JSON.stringify({ taskId: "task_a", agentId: "web-1", status: "done" }));
  assert.ok(parsed, "not rejected by the closed catalog");
  assert.equal(parsed.name, "task.done");
  assert.equal(parsed.data.taskId, "task_a");
});

// ── reconnect backoff ───────────────────────────────────────────────────────
test("backoff doubles from 1s and caps at 30s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs), [
    1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000,
  ]);
});

test("backoff never returns a negative or sub-second delay for a bad attempt", () => {
  assert.equal(backoffMs(-5), 1000);
  assert.equal(backoffMs(Number.NaN), 1000);
});

// ── frame → typed event ─────────────────────────────────────────────────────
test("parseEvent accepts catalog names and returns typed payloads", () => {
  assert.deepEqual(parseEvent("delivery.created", '{"id":"01J","status":"pending"}'), {
    name: "delivery.created",
    data: { id: "01J", status: "pending" },
  });
  assert.deepEqual(parseEvent("delivery.decided", '{"id":"01J","status":"approved","by":"BOSS"}'), {
    name: "delivery.decided",
    data: { id: "01J", status: "approved", by: "BOSS" },
  });
});

test("parseEvent rejects an off-catalog name (the catalog is closed client-side too)", () => {
  assert.equal(parseEvent("delivery.exploded", "{}"), null);
  assert.equal(parseEvent("", "{}"), null);
});

test("parseEvent survives malformed JSON without throwing", () => {
  assert.deepEqual(parseEvent("agent.state", "{not json"), { name: "agent.state", data: {} });
  assert.deepEqual(parseEvent("agent.state", ""), { name: "agent.state", data: {} });
});

test("parseEvent coerces a non-object payload to an empty object", () => {
  assert.deepEqual(parseEvent("usage.tick", "42"), { name: "usage.tick", data: {} });
  assert.deepEqual(parseEvent("usage.tick", "null"), { name: "usage.tick", data: {} });
});

// ── badge reducer ───────────────────────────────────────────────────────────
const ev = (name: string, data: Record<string, unknown> = {}) => ({ name, data }) as RuntimeEvent;

test("badge reducer: created increments, decided decrements, floors at 0", () => {
  assert.equal(applyBadge(0, ev("delivery.created")), 1);
  assert.equal(applyBadge(3, ev("delivery.created")), 4);
  assert.equal(applyBadge(3, ev("delivery.decided", { status: "approved" })), 2);
  assert.equal(applyBadge(0, ev("delivery.decided", { status: "approved" })), 0);
});

test("badge reducer ignores every non-delivery event", () => {
  for (const n of [
    "agent.state",
    "usage.tick",
    "task.queued",
    "task.started",
    "task.retried",
    "task.failed",
  ]) {
    assert.equal(applyBadge(2, ev(n)), 2);
  }
});

test("policy.autoapplied decrements — an auto-applied Delivery leaves the pending queue", () => {
  assert.equal(applyBadge(2, ev("policy.autoapplied", { id: "x" })), 1);
  assert.equal(applyBadge(0, ev("policy.autoapplied", { id: "x" })), 0);
});

// ── stream URL ──────────────────────────────────────────────────────────────
test("streamPath carries the ticket, and the replay watermark only when present", () => {
  assert.equal(streamPath("abc123"), "/runtime/events?ticket=abc123");
  assert.equal(streamPath("abc123", "41"), "/runtime/events?ticket=abc123&lastEventId=41");
});

test("streamPath url-encodes and drops a non-numeric watermark", () => {
  assert.equal(streamPath("a b"), "/runtime/events?ticket=a%20b");
  assert.equal(streamPath("abc", "nope"), "/runtime/events?ticket=abc");
  assert.equal(streamPath("abc", null), "/runtime/events?ticket=abc");
});

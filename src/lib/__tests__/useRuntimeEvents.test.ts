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
    // RUFLO-ADOPTION amendment (2026-08-18): doctor.status (LIVE) + run.killed,
    // worker.deferred, retrieval.hit, selfgrade.changed, trust.changed (RESERVED),
    // registered in ONE catalog change. Sorted in, hence scattered above.
    // MUNDER-ADOPTION amendment (2026-08-20): breaker.state (LIVE) + usage.transcript,
    // vault.condensed, engine.roster, run.output (RESERVED), registered in ONE catalog
    // change. Sorted in, hence scattered below.
    // MISSIONALPHA PHASE 7.0b amendment (2026-09-04): roster.changed, job.changed and
    // mail, RESERVED and registered in ONE catalog change (declared before their
    // emitters land: 7.1 roster.add, 9 Job store, 8.1 mailbox route). Sorted in,
    // hence scattered below.
    "agent.state",
    "breaker.state",
    "content.changed",
    "delivery.created",
    "delivery.decided",
    "delivery.expired",
    "delivery.sla_halflife",
    "doctor.status",
    "engine.roster",
    "job.changed",
    "lead.moved",
    "loop.step",
    "mail",
    "memory.changed",
    "output.created",
    "policy.autoapplied",
    "retrieval.hit",
    "roster.changed",
    "run.killed",
    "run.output",
    "selfgrade.changed",
    "skills.changed",
    "station.perm.changed",
    "story.changed",
    "task.done",
    "task.failed",
    "task.queued",
    "task.retried",
    "task.started",
    "trust.changed",
    "usage.tick",
    "usage.transcript",
    "vault.condensed",
    "vault.written",
    "worker.deferred",
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

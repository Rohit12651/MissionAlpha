// ADR-028 — Retry / self-heal. Pure logic: failure classification, retryability,
// bounded backoff, escalation arg-building (sanitized for the bus).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, backoffMs, escalationArgs } from "../self-heal.mjs";

test("classify maps each detection signal to a kind + retryability", () => {
  assert.deepEqual(classify({ type: "spawn-error" }), { kind: "spawn", retryable: true });
  assert.deepEqual(classify({ type: "timeout" }), { kind: "timeout", retryable: true });
  assert.deepEqual(classify({ type: "close", acc: "", changes: [] }), { kind: "no-output", retryable: true });
  assert.deepEqual(classify({ type: "diffed", changes: [] }), { kind: "empty-diff", retryable: true });
  assert.deepEqual(classify({ type: "crash" }), { kind: "crash", retryable: true });
});

test("apply-rejected is NON-retryable (guard fired — retrying is guard-hammering)", () => {
  const c = classify({ type: "apply", applyResults: [{ ok: false, error: "protected key changed: scripts" }] });
  assert.equal(c.kind, "apply-rejected");
  assert.equal(c.retryable, false);
});

test("apply with at least one ok is NOT a failure", () => {
  const c = classify({ type: "apply", applyResults: [{ ok: true }, { ok: false }] });
  assert.equal(c.kind, "none");
  assert.equal(c.retryable, false);
});

test("backoff is exponential, capped, and deterministic with injected jitter", () => {
  const opts = { base: 2000, max: 60000, jitter: () => 0 };
  assert.equal(backoffMs(1, opts), 2000);
  assert.equal(backoffMs(2, opts), 4000);
  assert.equal(backoffMs(3, opts), 8000);
  assert.equal(backoffMs(10, opts), 60000, "capped at max");
});

test("backoff jitter stays within bounds", () => {
  const ms = backoffMs(2, { base: 2000, max: 60000, jitter: () => 500 });
  assert.equal(ms, 4500);
});

test("escalationArgs builds sanitized heartbeat + sync arg arrays (no bus-format injection)", () => {
  const { heartbeat, sync } = escalationArgs("senior-web-1", "timeout", 3, 'boom "quote" |pipe| $var');
  // agentId sanitized to [a-z0-9_-]
  assert.equal(heartbeat[0], "senior-web-1");
  assert.equal(heartbeat[1], "BLOCKED");
  // reason has metachars stripped (matches reportBack L530 sanitization)
  assert.ok(!sync.join(" ").includes('"'));
  assert.ok(!sync.join(" ").includes("|"));
  assert.ok(!sync.join(" ").includes("$"));
  assert.equal(sync[1], "BOSS");
});

test("escalationArgs sanitizes a crafted agentId", () => {
  const { heartbeat } = escalationArgs('evil";rm -rf /', "spawn", 2, "x");
  assert.match(heartbeat[0], /^[a-z0-9_-]*$/i);
});

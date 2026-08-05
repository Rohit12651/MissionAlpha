// P8 (ADR-030) — the bus-driven usage reducer. Tokens + context% ONLY; asserts the
// meter state never carries a cost/$ field and never poisons on a malformed payload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyUsageTick, type UsageByKey, type RuntimeEvent } from "../useRuntimeEvents.ts";

const tick = (data: Record<string, unknown>): RuntimeEvent => ({ name: "usage.tick", data });

test("folds a usage.tick into the map keyed by thread::tier", () => {
  const next = applyUsageTick({}, tick({ agentId: "u1", threadId: "u1", tier: "sonnet", inputTokens: 10, outputTokens: 4, turns: 1, contextPct: 0.2 }));
  const row = next["u1::sonnet"];
  assert.ok(row);
  assert.equal(row.inputTokens, 10);
  assert.equal(row.outputTokens, 4);
  assert.equal(row.tier, "sonnet");
  assert.equal(row.contextPct, 0.2);
});

test("non-usage events pass the map through UNCHANGED (same reference)", () => {
  const m: UsageByKey = {};
  assert.equal(applyUsageTick(m, { name: "delivery.created", data: {} }), m);
});

test("a tick missing any identity is ignored (no phantom row)", () => {
  const next = applyUsageTick({}, tick({ inputTokens: 5 }));
  assert.deepEqual(next, {});
});

test("threadId falls back to agentId when absent", () => {
  const next = applyUsageTick({}, tick({ agentId: "solo", tier: "opus", inputTokens: 1 }));
  assert.ok(next["solo::opus"]);
  assert.equal(next["solo::opus"].agentId, "solo");
  assert.equal(next["solo::opus"].threadId, "solo");
});

test("malformed numbers coerce to 0 and contextPct clamps to [0,1]", () => {
  const next = applyUsageTick({}, tick({ agentId: "u1", threadId: "u1", tier: "haiku", inputTokens: "nope", contextPct: 5 }));
  const row = next["u1::haiku"];
  assert.equal(row.inputTokens, 0);
  assert.equal(row.contextPct, 1); // clamped
});

test("different tiers on one thread are separate buckets", () => {
  let m = applyUsageTick({}, tick({ agentId: "u1", threadId: "u1", tier: "sonnet", inputTokens: 10 }));
  m = applyUsageTick(m, tick({ agentId: "u1", threadId: "u1", tier: "opus", inputTokens: 30 }));
  assert.equal(Object.keys(m).length, 2);
  assert.equal(m["u1::sonnet"].inputTokens, 10);
  assert.equal(m["u1::opus"].inputTokens, 30);
});

test("a later tick for the same thread::tier replaces (server sends day-cumulative)", () => {
  let m = applyUsageTick({}, tick({ agentId: "u1", threadId: "u1", tier: "sonnet", inputTokens: 10, turns: 1 }));
  m = applyUsageTick(m, tick({ agentId: "u1", threadId: "u1", tier: "sonnet", inputTokens: 17, turns: 2 }));
  assert.equal(m["u1::sonnet"].inputTokens, 17);
  assert.equal(m["u1::sonnet"].turns, 2);
});

test("the reducer output carries NO cost/USD/$ field (BOSS hard rule)", () => {
  const next = applyUsageTick({}, tick({ agentId: "u1", threadId: "u1", tier: "opus", inputTokens: 1, total_cost_usd: 9.9 }));
  const keys = JSON.stringify(next).toLowerCase();
  assert.ok(!/cost|usd|dollar|price|\$/.test(keys), "no cost-shaped key survives into the meter state");
});

// P10 — the empty→populated transition the UsageOverview empty state depends on: an
// empty map is the zero-data render (rollUsage([]) → [] → "No usage yet"), and the
// first tick must yield a FRESH map (never mutate the empty input) so React re-renders.
test("empty map → populated is immutable (first tick yields a new map, input untouched)", () => {
  const empty: UsageByKey = {};
  const next = applyUsageTick(empty, tick({ agentId: "u1", threadId: "u1", tier: "sonnet", inputTokens: 3 }));
  assert.notEqual(next, empty, "must return a new object, not mutate the empty map");
  assert.deepEqual(empty, {}, "the empty input map stays empty (no in-place write)");
  assert.ok(next["u1::sonnet"], "the populated bucket is present after the first tick");
});

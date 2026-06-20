// ADR-030 — usage math. Token/context ONLY. Asserts NO cost field ever appears.
import { test } from "node:test";
import assert from "node:assert/strict";
import { usageFromResult, estimateUsage, rollupUsage } from "../usage.mjs";

const W = 200000;

test("usageFromResult maps cli result.usage → token + context fields", () => {
  const u = usageFromResult({ input_tokens: 9, output_tokens: 109, cache_creation_input_tokens: 79812, cache_read_input_tokens: 0, output_tokens_details: { thinking_tokens: 100 } }, "haiku", W);
  assert.equal(u.inputTokens, 9);
  assert.equal(u.outputTokens, 109);
  assert.equal(u.cacheCreationTokens, 79812);
  assert.equal(u.thinkingTokens, 100);
  assert.equal(u.contextTokens, 9 + 0 + 79812); // input + cacheRead + cacheCreation
  assert.equal(u.contextWindow, W);
  assert.ok(Math.abs(u.contextPct - (79821 / W)) < 1e-9);
  assert.equal(u.tier, "haiku");
  assert.equal(u.estimated, false);
});

test("usage objects NEVER carry a dollar/cost field (subscription is flat-rate)", () => {
  const u = usageFromResult({ input_tokens: 1, output_tokens: 1, total_cost_usd: 0.1003 }, "sonnet", W);
  const keys = Object.keys(u).join(",").toLowerCase();
  assert.ok(!/cost|usd|dollar|price|\$/.test(keys), "no cost-shaped key");
  assert.equal(u.total_cost_usd, undefined, "total_cost_usd dropped");
});

test("estimateUsage uses ~chars/4 and flags estimated:true", () => {
  const u = estimateUsage(400, 200, "sonnet", W);
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 50);
  assert.equal(u.estimated, true);
});

test("contextPct is clamped to [0,1] even past the window", () => {
  const u = usageFromResult({ input_tokens: 5_000_000 }, "opus", W);
  assert.equal(u.contextPct, 1);
});

test("rollupUsage accumulates lifetime totals across turns; last* tracks the latest", () => {
  let r = rollupUsage(null, usageFromResult({ input_tokens: 10, output_tokens: 20 }, "sonnet", W));
  r = rollupUsage(r, usageFromResult({ input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100 }, "opus", W));
  assert.equal(r.turns, 2);
  assert.equal(r.totalInputTokens, 15);
  assert.equal(r.totalOutputTokens, 27);
  assert.equal(r.lastTier, "opus", "last tier = most recent turn");
  assert.equal(r.lastContextTokens, 105); // 5 + 100 cacheRead
});

test("rollup of an estimated turn carries the estimated flag", () => {
  const r = rollupUsage(null, estimateUsage(40, 40, "haiku", W));
  assert.equal(r.estimated, true);
});

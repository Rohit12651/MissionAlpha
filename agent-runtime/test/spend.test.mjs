// PHASE 7 — metered spend, multi-provider.
//
// THE PREMISE CHANGED, AND THE OLD RULE WAS RIGHT UNDER THE OLD PREMISE.
// `usage.mjs` says "NO DOLLARS, EVER — subscription is flat-rate so a $ figure would be
// false." That was correct when every run went through a Claude Code subscription. The
// multi-provider work (Phase 1) added API-key accounts — OpenRouter and custom endpoints
// bill per token — so cost is now REAL for those accounts and still FALSE for
// subscription ones.
//
// This module's entire job is to keep those two cases from ever mixing:
//   * an api_key account records a real cost, computed from a real reported figure;
//   * a subscription account records `null` — never 0, never an estimate;
//   * a blended "total" across both is IMPOSSIBLE to construct, and that is asserted.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  spendForTurn,
  rollupSpend,
  spendLabel,
  SUBSCRIPTION_LABEL,
  isMeteredAccount,
} from "../spend.mjs";

const apiKey = { id: "acc-1", authMethod: "api_key", providerType: "custom", label: "openrouter" };
const subscription = { id: "acc-2", authMethod: "subscription", providerType: "claude", label: "claude" };

// ── which accounts meter ───────────────────────────────────────────────────────

test("only api_key accounts are metered", () => {
  assert.equal(isMeteredAccount(apiKey), true);
  assert.equal(isMeteredAccount(subscription), false);
});

test("an unknown or missing account is NOT metered — fail closed", () => {
  // Guessing "probably api_key" would invent a dollar figure. Absence means unmetered.
  for (const a of [null, undefined, {}, { authMethod: "" }, { authMethod: "oauth" }]) {
    assert.equal(isMeteredAccount(a), false, `${JSON.stringify(a)} was treated as metered`);
  }
});

// ── per-turn spend ─────────────────────────────────────────────────────────────

test("a subscription turn records null, never 0", () => {
  const s = spendForTurn({ account: subscription, reportedCostUsd: 0.42 });
  assert.equal(s.usd, null, "a subscription run must never carry a dollar figure");
  assert.equal(s.metered, false);
  // Even when the CLI reports a cost, it is meaningless on a flat-rate plan.
  assert.equal(s.reason, "subscription");
});

test("an api_key turn records the REPORTED cost", () => {
  const s = spendForTurn({ account: apiKey, reportedCostUsd: 0.0123 });
  assert.equal(s.metered, true);
  assert.equal(s.usd, 0.0123);
});

test("an api_key turn with NO reported cost records null — never an estimate", () => {
  // The plan is explicit: spend must never be inferred from token counts we did not
  // receive a price for. A missing figure is missing, not zero and not modelled.
  for (const reported of [undefined, null, Number.NaN, "0.5", -1, Number.POSITIVE_INFINITY]) {
    const s = spendForTurn({ account: apiKey, reportedCostUsd: reported });
    assert.equal(s.usd, null, `reported=${String(reported)} produced a number`);
    assert.equal(s.metered, true, "the account is still metered — the figure is just absent");
    assert.equal(s.reason, "no cost reported");
  }
});

test("a zero reported cost on an api_key account is kept — a free tier really is $0", () => {
  const s = spendForTurn({ account: apiKey, reportedCostUsd: 0 });
  assert.equal(s.usd, 0);
  assert.equal(s.metered, true);
});

// ── rollup ─────────────────────────────────────────────────────────────────────

test("rollup sums metered turns only", () => {
  const out = rollupSpend([
    spendForTurn({ account: apiKey, reportedCostUsd: 0.01 }),
    spendForTurn({ account: apiKey, reportedCostUsd: 0.02 }),
  ]);
  assert.equal(out.meteredTurns, 2);
  assert.equal(out.unmeteredTurns, 0);
  assert.ok(Math.abs(out.usd - 0.03) < 1e-9);
});

test("BLENDING IS IMPOSSIBLE: a mixed batch reports the subscription turns separately", () => {
  // The failure this guards: "total spend $0.01" on a day that also ran 40 subscription
  // turns reads as "we spent one cent today". It did not — 40 turns had no price at all.
  const out = rollupSpend([
    spendForTurn({ account: apiKey, reportedCostUsd: 0.01 }),
    spendForTurn({ account: subscription, reportedCostUsd: 9.99 }),
    spendForTurn({ account: subscription }),
  ]);
  assert.equal(out.usd, 0.01, "a subscription turn leaked into the sum");
  assert.equal(out.meteredTurns, 1);
  assert.equal(out.unmeteredTurns, 2);
  assert.equal(out.mixed, true, "a mixed batch must announce itself so the UI can caveat it");
});

test("a rollup with no metered turns has null spend, not 0", () => {
  const out = rollupSpend([spendForTurn({ account: subscription })]);
  assert.equal(out.usd, null);
  assert.equal(out.meteredTurns, 0);
  assert.equal(out.mixed, false);
});

test("an empty rollup is null, and never NaN", () => {
  const out = rollupSpend([]);
  assert.equal(out.usd, null);
  assert.ok(!Number.isNaN(out.usd));
});

test("rollup ignores malformed entries rather than poisoning the sum", () => {
  const out = rollupSpend([null, undefined, {}, { usd: "1.00", metered: true }, spendForTurn({ account: apiKey, reportedCostUsd: 0.05 })]);
  assert.ok(Math.abs(out.usd - 0.05) < 1e-9);
});

// ── the display rule ───────────────────────────────────────────────────────────

test("a subscription account renders 'included', never a number", () => {
  assert.equal(spendLabel({ usd: null, metered: false }), SUBSCRIPTION_LABEL);
  // Even if a figure somehow rode along, an unmetered row must not print it.
  assert.equal(spendLabel({ usd: 1.23, metered: false }), SUBSCRIPTION_LABEL);
});

test("a metered account with no figure says so, and does not print $0.00", () => {
  assert.equal(spendLabel({ usd: null, metered: true }), "not reported");
});

test("a metered account renders a real dollar figure", () => {
  assert.equal(spendLabel({ usd: 0 }, { metered: true }), "$0.00");
  assert.equal(spendLabel({ usd: 0.0123, metered: true }), "$0.0123");
  assert.equal(spendLabel({ usd: 1.5, metered: true }), "$1.50");
  assert.equal(spendLabel({ usd: 12.345, metered: true }), "$12.35");
});

test("SECURITY-ADJACENT: no label path can ever print a $ for an unmetered account", () => {
  // Exhaustive over the shapes that can reach the renderer.
  for (const usd of [null, undefined, 0, 1, 1.23, Number.NaN, Number.POSITIVE_INFINITY]) {
    const label = spendLabel({ usd, metered: false });
    assert.equal(label, SUBSCRIPTION_LABEL, `usd=${String(usd)} produced ${label}`);
    assert.doesNotMatch(label, /\$/);
  }
});

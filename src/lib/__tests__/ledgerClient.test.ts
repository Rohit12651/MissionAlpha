// PHASE 6 — the ledger's DISPLAY layer. Pure, DOM-free.
//
// The runtime already refuses to compute a rate below 5 decisions. These tests pin the
// SECOND refusal, on the client, so a regressed payload or a hand-rolled response still
// cannot put a fabricated percentage in front of an operator.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INSUFFICIENT_DATA,
  durationLabel,
  rateLabel,
  rateTone,
  sortLedger,
  type AgentLedgerRow,
} from "../ledgerClient.ts";

const row = (over: Partial<AgentLedgerRow> = {}): AgentLedgerRow => ({
  agentId: "a",
  delivered: 0,
  approved: 0,
  autoApproved: 0,
  rejected: 0,
  changesRequested: 0,
  expired: 0,
  pending: 0,
  failures: 0,
  decisions: 0,
  approvalRate: null,
  rated: false,
  medianDecisionMs: null,
  ...over,
});

test("an unrated agent shows the honest label, never a percentage", () => {
  assert.equal(rateLabel(row({ rated: false, approvalRate: null })), INSUFFICIENT_DATA);
});

test("SECOND GUARD: a payload claiming rated with no number still refuses", () => {
  // A regressed runtime, or a hand-rolled response, must not be able to render "NaN%".
  for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -0.5, 1.5]) {
    const r = rateLabel(row({ rated: true, approvalRate: bad as unknown as number | null }));
    assert.equal(r, INSUFFICIENT_DATA, `approvalRate ${String(bad)} was rendered`);
  }
});

test("a rated agent renders a whole-number percentage", () => {
  assert.equal(rateLabel(row({ rated: true, approvalRate: 1 })), "100%");
  assert.equal(rateLabel(row({ rated: true, approvalRate: 5 / 6 })), "83%");
  assert.equal(rateLabel(row({ rated: true, approvalRate: 0 })), "0%");
});

test("tone is muted for unrated — an absence is not a warning", () => {
  assert.equal(rateTone(row({ rated: false })), "muted");
  assert.equal(rateTone(row({ rated: true, approvalRate: 0.9 })), "good");
  assert.equal(rateTone(row({ rated: true, approvalRate: 0.6 })), "warn");
  assert.equal(rateTone(row({ rated: true, approvalRate: 0.2 })), "bad");
});

test("durationLabel never renders 0ms or a negative", () => {
  assert.equal(durationLabel(null), "—");
  assert.equal(durationLabel(Number.NaN), "—");
  assert.equal(durationLabel(-5), "—");
  assert.equal(durationLabel(400), "<1s");
  assert.equal(durationLabel(45_000), "45s");
  assert.equal(durationLabel(5 * 60_000), "5m");
  assert.equal(durationLabel(2.5 * 3_600_000), "2.5h");
  assert.equal(durationLabel(50 * 3_600_000), "2d");
});

test("sorting by rate sinks unrated rows in BOTH directions", () => {
  // Treating null as 0 would rank a no-data agent next to a genuinely failing one —
  // the same fabrication the label refuses, expressed as position instead of text.
  const rows = [
    row({ agentId: "unrated", rated: false, approvalRate: null }),
    row({ agentId: "bad", rated: true, approvalRate: 0.1 }),
    row({ agentId: "good", rated: true, approvalRate: 0.9 }),
  ];
  assert.deepEqual(sortLedger(rows, "approvalRate", "desc").map((r) => r.agentId), ["good", "bad", "unrated"]);
  assert.deepEqual(sortLedger(rows, "approvalRate", "asc").map((r) => r.agentId), ["bad", "good", "unrated"]);
});

test("sorting is stable by agent name at equal values", () => {
  const rows = [
    row({ agentId: "zeta", delivered: 3 }),
    row({ agentId: "alpha", delivered: 3 }),
    row({ agentId: "mid", delivered: 9 }),
  ];
  assert.deepEqual(sortLedger(rows, "delivered", "desc").map((r) => r.agentId), ["mid", "alpha", "zeta"]);
});

test("sortLedger does not mutate its input", () => {
  const rows = [row({ agentId: "b", delivered: 1 }), row({ agentId: "a", delivered: 2 })];
  const snapshot = rows.map((r) => r.agentId);
  sortLedger(rows, "delivered", "desc");
  assert.deepEqual(rows.map((r) => r.agentId), snapshot);
});

// ── PHASE 7 — the spend display rule ──────────────────────────────────────────

// THIS TEST USED TO CERTIFY THE DEFECT, and is corrected rather than the code — the
// documented exception to "fix the implementation, not the test". It asserted that an
// unmetered ACTIVE account renders "included" even for a row carrying 9 metered turns and
// $12.34. But `activeMetered` describes the account active right now, not the window on
// screen, and every row in the spend table is by construction from an api_key account.
// Relabelling a week in which real money was spent as "included" is a false statement
// about the period — the same class of lie this phase forbids, pointed the other way.
test("an unmetered ACTIVE account still shows real historical spend, never hides it", async () => {
  const { spendCell } = await import("../ledgerClient.ts");
  assert.equal(spendCell({ agentId: "a", meteredTurns: 9, unpricedTurns: 0, usd: 12.34 }, false), "$12.34");
});

test("with nothing metered in the window, an unmetered account reads 'included'", async () => {
  const { spendCell, SUBSCRIPTION_LABEL } = await import("../ledgerClient.ts");
  for (const row of [undefined, { agentId: "a", meteredTurns: 0, unpricedTurns: 0, usd: null }]) {
    assert.equal(spendCell(row, false), SUBSCRIPTION_LABEL);
    assert.doesNotMatch(spendCell(row, false), /\$/);
  }
});

test("a metered account with no turns shows a dash, not $0.00", async () => {
  const { spendCell } = await import("../ledgerClient.ts");
  assert.equal(spendCell({ agentId: "a", meteredTurns: 0, unpricedTurns: 0, usd: null }, true), "—");
});

test("a metered account with turns but no figure says so", async () => {
  const { spendCell } = await import("../ledgerClient.ts");
  assert.equal(spendCell({ agentId: "a", meteredTurns: 3, unpricedTurns: 3, usd: null }, true), "not reported");
});

test("a metered account renders real dollars, keeping sub-dollar precision", async () => {
  const { spendCell } = await import("../ledgerClient.ts");
  assert.equal(spendCell({ agentId: "a", meteredTurns: 1, unpricedTurns: 0, usd: 0.0123 }, true), "$0.0123");
  assert.equal(spendCell({ agentId: "a", meteredTurns: 1, unpricedTurns: 0, usd: 4.5 }, true), "$4.50");
  assert.equal(spendCell({ agentId: "a", meteredTurns: 1, unpricedTurns: 0, usd: 0 }, true), "$0.00");
});

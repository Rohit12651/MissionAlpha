// Phase G (D-7) — the title bar, sidebar pin and status strip say "N deliveries await you ·
// M need you". In the real Inbox, questions, design gates and failure clusters are themselves
// inbox items, so "need you" is every pending item and "deliveries" is the code-shaped subset.
// Pure, runs under `node --experimental-strip-types --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxKindOf, tallyPending } from "../inboxTally.ts";

const item = (kind: string, status = "pending") => ({ kind, status });

test("every runtime kind maps onto the mockup's four inbox kinds", () => {
  for (const k of ["code", "doc", "post", "command", "job-approval", "release-approval"]) {
    assert.equal(inboxKindOf(k), "delivery", k);
  }
  assert.equal(inboxKindOf("design-approval"), "gate");
  assert.equal(inboxKindOf("question"), "question");
  assert.equal(inboxKindOf("failure"), "cluster");
});

test("an unknown kind is a delivery, never dropped from the count", () => {
  assert.equal(inboxKindOf("something-new"), "delivery");
});

test("need-you counts every pending item; deliveries count only delivery kinds", () => {
  const list = [item("code"), item("release-approval"), item("doc"), item("design-approval"), item("question"), item("failure")];
  assert.deepEqual(tallyPending(list), { deliveries: 3, needYou: 6 });
});

test("decided items count toward neither number", () => {
  const list = [item("code", "approved"), item("question", "rejected"), item("code")];
  assert.deepEqual(tallyPending(list), { deliveries: 1, needYou: 1 });
});

test("an empty inbox is zero and zero, not missing", () => {
  assert.deepEqual(tallyPending([]), { deliveries: 0, needYou: 0 });
});

// ── G4 — the Inbox page's filters, queue strip and bulk rule (mockup RENDER.inbox) ──

import { matchesKindFilter, queueSummary, isBulkSelectable } from "../inboxTally.ts";

const row = (kind: string, band: "low" | "medium" | "high" | null = "low", status = "pending", slaDeadline: string | null = null) =>
  ({ kind, status, slaDeadline, risk: { band } });

test("the mockup's filters: kind filters use the four inbox kinds, High risk uses the band", () => {
  const code = row("code"), gate = row("design-approval"), q = row("question"), fail = row("failure"), hot = row("code", "high");
  assert.deepEqual([code, gate, q, fail, hot].filter((d) => matchesKindFilter(d, "all")).length, 5);
  assert.deepEqual([code, gate, q, fail, hot].filter((d) => matchesKindFilter(d, "delivery")), [code, hot]);
  assert.deepEqual([code, gate, q, fail, hot].filter((d) => matchesKindFilter(d, "gate")), [gate]);
  assert.deepEqual([code, gate, q, fail, hot].filter((d) => matchesKindFilter(d, "question")), [q]);
  assert.deepEqual([code, gate, q, fail, hot].filter((d) => matchesKindFilter(d, "cluster")), [fail]);
  assert.deepEqual([code, gate, q, fail, hot].filter((d) => matchesKindFilter(d, "high")), [hot]);
});

test("queue summary counts pending items per kind and names the soonest SLA", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  const at = (min: number) => new Date(now + min * 60_000).toISOString();
  const s = queueSummary([
    row("code", "low", "pending", at(41)), row("code", "low", "pending", at(18)), row("question", "low", "pending", at(120)),
    row("failure", "medium", "pending", null), row("code", "low", "approved", at(1)),
  ]);
  assert.deepEqual(s.byKind, { delivery: 2, question: 1, gate: 0, cluster: 1 });
  assert.equal(s.waiting, 4);
});

test("queue summary of nothing waiting has nothing waiting and no oldest item", () => {
  assert.equal(queueSummary([]).oldestAt, null);
  assert.equal(queueSummary([]).waiting, 0);
});

test("bulk approval offers only pending, non-high-risk deliveries (the mockup: high risk needs a typed APPLY)", () => {
  assert.equal(isBulkSelectable(row("code", "low")), true);
  assert.equal(isBulkSelectable(row("code", "medium")), true);
  assert.equal(isBulkSelectable(row("code", "high")), false);
  assert.equal(isBulkSelectable(row("question")), false);
  assert.equal(isBulkSelectable(row("design-approval")), false);
  assert.equal(isBulkSelectable(row("failure")), false);
  assert.equal(isBulkSelectable(row("code", "low", "approved")), false);
});

import { slaText } from "../inboxTally.ts";

test("SLA text is the mockup's total minutes:seconds, 'SLA due' once past, null for a bad deadline", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  assert.equal(slaText(new Date(now + 41 * 60_000).toISOString(), now), "SLA 41:00");
  assert.equal(slaText(new Date(now + 120 * 60_000 + 5_000).toISOString(), now), "SLA 120:05");
  assert.equal(slaText(new Date(now - 1).toISOString(), now), "SLA due");
  assert.equal(slaText("not a date", now), null);
});

test("queue summary names the OLDEST pending item by when it arrived, not by its SLA", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const s = queueSummary([
    { ...row("code", "low", "pending", null), createdAt: ago(12) },
    { ...row("question", "low", "pending", null), createdAt: ago(95) },
    { ...row("code", "low", "approved", null), createdAt: ago(600) }, // decided: not waiting
    { ...row("code", "low", "pending", null), createdAt: "not a date" },
  ]);
  assert.equal(s.oldestAt, Date.parse(ago(95)));
  assert.equal(queueSummary([]).oldestAt, null);
});

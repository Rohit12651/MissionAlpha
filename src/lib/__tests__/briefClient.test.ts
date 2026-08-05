// B3 — the CEO brief's PURE layer: the bus-frame → log-row mapper, the pill table, the
// dedupe/prepend reducer and the "last brief" label. Zero DOM, zero network, so
// `node --experimental-strip-types --test` runs it directly.
//
// These tests pin the honesty rules, not just the shapes:
//   • a `vault.written` frame carries NO title on the wire (ADR-055 — identity only),
//     so the row must say what happened rather than invent a headline;
//   • a name outside the closed brief catalog is DROPPED, never given a guessed pill;
//   • an optimistic row and the authoritative frame that follows it are the SAME
//     event, so the log shows one line, not two.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRIEF_LOG_NAMES,
  PILL_BY_EVENT,
  PILL_LABEL,
  PILL_TONE,
  MAX_CAPTAIN_TEXT,
  MAX_BRIEF_HOURS,
  DEFAULT_BRIEF_HOURS,
  BRIEF_ROW_CAP,
  briefLogQuery,
  lastBriefLabel,
  logRow,
  logRows,
  prependRow,
  routedRow,
  type BriefEvent,
  type LogRow,
} from "../briefClient.ts";

const T0 = Date.parse("2026-07-30T12:00:00.000Z");
const at = (msAgo: number) => new Date(T0 - msAgo).toISOString();

// ── the closed catalog ───────────────────────────────────────────────────────

test("BRIEF_LOG_NAMES mirrors the server allow-list exactly (six names, no more)", () => {
  assert.deepEqual([...BRIEF_LOG_NAMES], [
    "vault.written", "task.queued", "task.done", "task.failed", "delivery.created", "delivery.decided",
  ]);
  // every name has a pill, and every pill has a label + a tone entry — no fallback path
  for (const n of BRIEF_LOG_NAMES) assert.ok(PILL_BY_EVENT[n], n);
  for (const p of Object.values(PILL_BY_EVENT)) {
    assert.ok(PILL_LABEL[p], p);
    assert.ok(p in PILL_TONE, p);
  }
  assert.deepEqual(Object.keys(PILL_LABEL).sort(), ["completed", "failed", "logged", "needs-review"]);
});

test("the client caps mirror the server's", () => {
  assert.equal(MAX_CAPTAIN_TEXT, 2000);
  assert.equal(MAX_BRIEF_HOURS, 168);
  assert.equal(DEFAULT_BRIEF_HOURS, 24);
  assert.equal(BRIEF_ROW_CAP, 100);
});

// ── logRow: the mapping the plan specifies ───────────────────────────────────

test("logRow maps every catalog name to its pill", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["vault.written", { id: "r1", node: "market", venture: "waahyu", agent: "pm-analyst" }, "logged"],
    ["task.queued", { taskId: "task_a", agentId: "sr-backend", priority: "normal" }, "logged"],
    ["task.done", { taskId: "task_b", agentId: "sr-backend" }, "completed"],
    ["task.failed", { taskId: "task_c", agentId: "sr-backend", kind: "timeout" }, "failed"],
    ["delivery.created", { id: "d1", agentId: "web-1", title: "Add a module", kind: "code" }, "needs-review"],
    ["delivery.decided", { id: "d1", status: "approved", by: "boss" }, "completed"],
  ];
  for (const [name, data, pill] of cases) {
    const row = logRow({ name, data, seq: 7, ts: at(0) }, T0);
    assert.ok(row, name);
    assert.equal(row.pill, pill, name);
  }
});

test("a vault.written row states what the identity-only frame actually said", () => {
  const row = logRow({ name: "vault.written", seq: 12, ts: at(0), data: { id: "r1", node: "market", venture: "waahyu", agent: "pm-analyst" } }, T0);
  assert.ok(row);
  assert.equal(row.title, "Wrote to shared memory", "no fabricated headline — the frame carries no title");
  assert.equal(row.kind, "market");
  assert.equal(row.venture, "waahyu");
  assert.equal(row.agent, "pm-analyst");
  assert.equal(row.seq, 12);
  assert.equal(row.deliveryId, null);
  assert.equal(row.key, "vault.written|r1");
});

test("a delivery.created row carries the deliveryId the deep-link needs", () => {
  const row = logRow({ name: "delivery.created", seq: 3, ts: at(0), data: { id: "01HZ", agentId: "web-1", title: "Add a module", kind: "code" } }, T0);
  assert.ok(row);
  assert.equal(row.pill, "needs-review");
  assert.equal(row.deliveryId, "01HZ");
  assert.equal(row.title, "Add a module");
  assert.equal(row.kind, "code");
  // and only that row type does
  const other = logRow({ name: "task.done", seq: 4, ts: at(0), data: { taskId: "task_b", agentId: "sr-backend" } }, T0);
  assert.equal(other?.deliveryId, null);
});

test("logRow names the actor the frame names, and admits '—' when it names none", () => {
  assert.equal(logRow({ name: "vault.written", data: { id: "r", agent: "boss" }, seq: 1, ts: at(0) }, T0)?.agent, "boss");
  assert.equal(logRow({ name: "task.done", data: { taskId: "t", agentId: "sr-backend" }, seq: 1, ts: at(0) }, T0)?.agent, "sr-backend");
  assert.equal(logRow({ name: "delivery.decided", data: { id: "d", status: "approved", by: "alice" }, seq: 1, ts: at(0) }, T0)?.agent, "alice");
  assert.equal(logRow({ name: "task.done", data: {}, seq: 1, ts: at(0) }, T0)?.agent, "—");
  assert.equal(logRow({ name: "task.done", data: { agentId: "   " }, seq: 1, ts: at(0) }, T0)?.agent, "—");
});

test("logRow DROPS anything outside the closed brief catalog", () => {
  for (const name of ["usage.tick", "agent.state", "task.started", "task.retried", "policy.autoapplied", "workflow.run", "", "vault.written ", "VAULT.WRITTEN"]) {
    assert.equal(logRow({ name, data: { id: "x" }, seq: 1, ts: at(0) }, T0), null, name);
  }
  // …and never throws on a malformed frame
  assert.equal(logRow({ name: "task.done" } as never, T0)?.agent, "—");
  assert.equal(logRow({ name: "task.done", data: null }, T0)?.title, "Task finished");
});

test("a LIVE frame with no timestamp is stamped at arrival, never left blank", () => {
  const row = logRow({ name: "task.done", data: { taskId: "t1", agentId: "sr-backend" } }, T0);
  assert.ok(row);
  assert.equal(row.ts, new Date(T0).toISOString());
  assert.equal(row.seq, null, "a live frame carries no events_log seq");
  // an unparseable stamp gets the same treatment rather than poisoning the sort
  assert.equal(logRow({ name: "task.done", data: { taskId: "t1" }, ts: "not-a-date" }, T0)?.ts, new Date(T0).toISOString());
});

// ── logRows: a whole fetched page ────────────────────────────────────────────

test("logRows preserves newest-first order, drops unknown names and de-duplicates", () => {
  const events: BriefEvent[] = [
    { seq: 9, name: "vault.written", ts: at(1000), data: { id: "r2", node: "tech", venture: "waahyu", agent: "boss" } },
    { seq: 8, name: "usage.tick", ts: at(2000), data: { agentId: "x" } },
    { seq: 7, name: "task.queued", ts: at(3000), data: { taskId: "task_a", agentId: "pm-analyst" } },
    { seq: 6, name: "vault.written", ts: at(4000), data: { id: "r2", node: "tech", venture: "waahyu", agent: "boss" } },
  ];
  const rows = logRows(events, T0);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.key), ["vault.written|r2", "task.queued|task_a"]);
  assert.deepEqual(logRows(null, T0), []);
  assert.deepEqual(logRows(undefined, T0), []);
  assert.deepEqual(logRows([] as BriefEvent[], T0), []);
});

// ── prependRow: the live path ────────────────────────────────────────────────

test("prependRow puts a new row on top and honours the cap", () => {
  const seed: LogRow[] = logRows([{ seq: 1, name: "task.done", ts: at(0), data: { taskId: "t1", agentId: "a" } }], T0);
  const next = prependRow(seed, logRow({ name: "task.failed", data: { taskId: "t2", agentId: "b" } }, T0));
  assert.deepEqual(next.map((r) => r.key), ["task.failed|t2", "task.done|t1"]);
  assert.equal(prependRow(next, logRow({ name: "task.done", data: { taskId: "t3" } }, T0), 2).length, 2);
  // a null row (an out-of-catalog frame) changes nothing, by reference
  assert.equal(prependRow(next, null), next);
});

test("prependRow is FIRST-WRITE-WINS — one event identity is one line, however it arrived", () => {
  const optimistic = routedRow({ agentId: "pm-analyst", matched: "market", recordId: "rec1", taskId: "task_1" }, "check the market", T0);
  const withRow = prependRow([], optimistic);
  // the authoritative bus frame for the SAME record arrives moments later
  const authoritative = logRow({ name: "vault.written", data: { id: "rec1", node: "market", venture: "waahyu", agent: "boss" } }, T0 + 120);
  const after = prependRow(withRow, authoritative);
  assert.equal(after.length, 1, "one record, one line");
  assert.equal(after[0].title, "check the market", "the operator's own words survive the identity-only frame");
});

// ── routedRow: the optimistic line ───────────────────────────────────────────

test("routedRow carries the REAL ids and states the keyword that decided the route", () => {
  const r = routedRow({ agentId: "pm-analyst", matched: "competitor", recordId: "rec9", taskId: "task_9" }, "run a competitor sweep", T0);
  assert.equal(r.key, "vault.written|rec9", "keyed on the record the runtime actually minted");
  assert.equal(r.agent, "pm-analyst");
  assert.equal(r.pill, "logged");
  assert.equal(r.ts, new Date(T0).toISOString());
  assert.match(r.kind, /competitor/, "the reason is the keyword, shown plainly");
  assert.ok(!/classif/i.test(r.kind), "it is never dressed up as a classification");
});

test("routedRow says so when the Captain kept the order, and caps a long one at 80", () => {
  const kept = routedRow({ agentId: "ceo", matched: null, recordId: "rec8", taskId: "task_8" }, "think about next quarter", T0);
  assert.equal(kept.agent, "ceo");
  assert.match(kept.kind, /kept by the Captain/);
  const long = routedRow({ agentId: "ceo", matched: null, recordId: "r", taskId: "t" }, "x".repeat(500), T0);
  assert.equal(long.title.length, 80);
  const blank = routedRow({ agentId: "ceo", matched: null, recordId: "r", taskId: "t" }, "   ", T0);
  assert.equal(blank.title, "Order routed", "never an empty line");
});

// ── lastBriefLabel ───────────────────────────────────────────────────────────

test("lastBriefLabel reads the NEWEST row, whatever order the list is in", () => {
  const rows = logRows([
    { seq: 3, name: "task.done", ts: at(4 * 60 * 1000), data: { taskId: "t1" } },
    { seq: 5, name: "task.failed", ts: at(30 * 1000), data: { taskId: "t2" } },
    { seq: 4, name: "task.queued", ts: at(90 * 60 * 1000), data: { taskId: "t3" } },
  ], T0);
  assert.equal(lastBriefLabel(rows, T0), "30s ago");
});

test("lastBriefLabel spans the whole scale and is honest about an empty log", () => {
  const only = (ms: number) => logRows([{ seq: 1, name: "task.done", ts: at(ms), data: { taskId: "t" } }], T0);
  assert.equal(lastBriefLabel(only(0), T0), "just now");
  assert.equal(lastBriefLabel(only(4_999), T0), "just now");
  assert.equal(lastBriefLabel(only(5_000), T0), "5s ago");
  assert.equal(lastBriefLabel(only(59_000), T0), "59s ago");
  assert.equal(lastBriefLabel(only(60_000), T0), "1m ago");
  assert.equal(lastBriefLabel(only(3_600_000), T0), "1h ago");
  assert.equal(lastBriefLabel(only(2 * 86_400_000), T0), "2d ago");
  // an empty / absent / unparseable log reads "—", never a fabricated time
  assert.equal(lastBriefLabel([], T0), "—");
  assert.equal(lastBriefLabel(null, T0), "—");
  assert.equal(lastBriefLabel(undefined, T0), "—");
  assert.equal(lastBriefLabel([{ ...only(0)[0], ts: "nonsense" }], T0), "—");
  // a clock skew (a row stamped in the future) floors at "just now", never negative
  assert.equal(lastBriefLabel([{ ...only(0)[0], ts: new Date(T0 + 60_000).toISOString() }], T0), "just now");
});

// ── briefLogQuery ────────────────────────────────────────────────────────────

test("briefLogQuery clamps to the server's own window so it never sends a value it reshapes", () => {
  assert.equal(briefLogQuery(), "/runtime/brief/log?hours=24");
  assert.equal(briefLogQuery(24), "/runtime/brief/log?hours=24");
  assert.equal(briefLogQuery(168), "/runtime/brief/log?hours=168");
  assert.equal(briefLogQuery(999), "/runtime/brief/log?hours=168");
  assert.equal(briefLogQuery(0), "/runtime/brief/log?hours=1");
  assert.equal(briefLogQuery(-5), "/runtime/brief/log?hours=1");
  // finite-check + FLOOR before the clamp — the B2 sr-security LOW-4 rule, client-side
  assert.equal(briefLogQuery(1.9), "/runtime/brief/log?hours=1");
  assert.equal(briefLogQuery(NaN), "/runtime/brief/log?hours=24");
  assert.equal(briefLogQuery(Infinity), "/runtime/brief/log?hours=24");
  assert.equal(briefLogQuery("48" as never), "/runtime/brief/log?hours=48");
  assert.equal(briefLogQuery("abc" as never), "/runtime/brief/log?hours=24");
});

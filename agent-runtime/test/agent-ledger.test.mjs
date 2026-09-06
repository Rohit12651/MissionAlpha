// PHASE 6 — the per-agent performance ledger.
//
// `getScoreboard` already measures dogfood throughput (approved ÷ human-minutes). It does
// NOT say which agent to trust. Every decision is already a row in SQLite, so this is a
// pure read: no new writes, no schema change, no new event.
//
// THE RULE THAT MATTERS MOST IS THE HONESTY RULE. An agent with fewer than 5 decisions
// renders "insufficient data" — never a percentage. "100% approved" off one approval is a
// fabricated confidence signal, and this program forbids fabricated data outright. It
// follows the RiskChip / ADR-053 `unrated` precedent: the label is a DISPLAY state, and
// the underlying rate is null, not zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../db.mjs";
import { agentLedger, MIN_DECISIONS_FOR_RATE } from "../agent-ledger.mjs";

const NOW = Date.parse("2026-08-11T12:00:00.000Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

function freshDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  mkdirSync(join(dir, "db"), { recursive: true });
  const store = openDb({ path: join(dir, "db", "mission.db"), patchesDir: join(dir, "patches") });
  t.after(() => { try { store.db.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
  return store;
}

let rowSeq = 0;
/** Insert one delivery row directly — the ledger is a pure reader, so this is the input. */
function seed(store, { agentId, status, createdAt, decidedAt = null, riskBand = null }) {
  rowSeq += 1;
  const id = `01J${String(rowSeq).padStart(23, "0")}`;
  store.db.prepare(
    `INSERT INTO deliveries (id, agentId, title, summary, source, kind, status, createdAt, decidedAt, riskBand, auditRef)
     VALUES (?, ?, 'a title', 'a summary', 'swarm', 'code', ?, ?, ?, ?, 'ref')`,
  ).run(id, agentId, status, iso(createdAt), decidedAt === null ? null : iso(decidedAt), riskBand);
  return id;
}

const byId = (rows, agentId) => rows.find((r) => r.agentId === agentId);

// ── shape ──────────────────────────────────────────────────────────────────────

test("an empty database yields an empty ledger, not a fabricated row", (t) => {
  const store = freshDb(t);
  const out = agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW });
  assert.deepEqual(out.agents, []);
  assert.equal(out.windowMs, 7 * DAY);
});

test("counts every terminal status separately, and pending is not a decision", (t) => {
  const store = freshDb(t);
  for (const status of ["approved", "approved", "rejected", "changes_requested", "expired", "auto_approved"]) {
    seed(store, { agentId: "sr-backend", status, createdAt: NOW - HOUR, decidedAt: NOW - HOUR / 2 });
  }
  seed(store, { agentId: "sr-backend", status: "pending", createdAt: NOW - HOUR });

  const a = byId(agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents, "sr-backend");
  assert.equal(a.delivered, 7, "delivered counts every row minted in the window");
  assert.equal(a.approved, 2);
  assert.equal(a.rejected, 1);
  assert.equal(a.changesRequested, 1);
  assert.equal(a.expired, 1);
  assert.equal(a.autoApproved, 1);
  assert.equal(a.pending, 1);
  // `decisions` is the denominator of the approval rate, so it holds only rows where a
  // human actually judged the WORK: approved + auto_approved + rejected + changes.
  // PENDING is not yet judged. EXPIRED means the SLA ran out and nobody decided at all —
  // scoring that against the agent would blame it for the operator's backlog. Both are
  // still visible in their own columns; neither is in the rate.
  assert.equal(a.decisions, 5);
});

// ── THE HONESTY RULE ───────────────────────────────────────────────────────────

test("fewer than 5 decisions renders insufficient data, never a percentage", (t) => {
  const store = freshDb(t);
  for (let i = 0; i < MIN_DECISIONS_FOR_RATE - 1; i += 1) {
    seed(store, { agentId: "thin", status: "approved", createdAt: NOW - HOUR, decidedAt: NOW - HOUR / 2 });
  }
  const a = byId(agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents, "thin");
  assert.equal(a.decisions, MIN_DECISIONS_FOR_RATE - 1);
  assert.equal(a.approvalRate, null, "a rate on 4 decisions is a fabricated confidence signal");
  assert.equal(a.rated, false);
});

test("exactly 5 decisions is enough — the threshold is inclusive", (t) => {
  const store = freshDb(t);
  for (let i = 0; i < MIN_DECISIONS_FOR_RATE; i += 1) {
    seed(store, { agentId: "just-enough", status: "approved", createdAt: NOW - HOUR, decidedAt: NOW - HOUR / 2 });
  }
  const a = byId(agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents, "just-enough");
  assert.equal(a.rated, true);
  assert.equal(a.approvalRate, 1);
});

test("zero decisions never renders NaN", (t) => {
  const store = freshDb(t);
  seed(store, { agentId: "quiet", status: "pending", createdAt: NOW - HOUR });
  const a = byId(agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents, "quiet");
  assert.equal(a.decisions, 0);
  assert.equal(a.approvalRate, null);
  assert.ok(!Number.isNaN(a.approvalRate), "division by zero leaked");
  assert.equal(a.medianDecisionMs, null);
});

test("the approval rate counts auto-approved as approved, and says so in its own field", (t) => {
  const store = freshDb(t);
  for (let i = 0; i < 3; i += 1) seed(store, { agentId: "mix", status: "approved", createdAt: NOW - HOUR, decidedAt: NOW - HOUR / 2 });
  for (let i = 0; i < 2; i += 1) seed(store, { agentId: "mix", status: "auto_approved", createdAt: NOW - HOUR, decidedAt: NOW - HOUR / 2 });
  for (let i = 0; i < 5; i += 1) seed(store, { agentId: "mix", status: "rejected", createdAt: NOW - HOUR, decidedAt: NOW - HOUR / 2 });

  const a = byId(agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents, "mix");
  assert.equal(a.decisions, 10);
  assert.equal(a.approvalRate, 0.5, "5 of 10 landed");
  assert.equal(a.autoApproved, 2, "the auto share must stay visible, not be hidden inside the rate");
});

// ── the window ─────────────────────────────────────────────────────────────────

test("rows outside the window are excluded", (t) => {
  const store = freshDb(t);
  for (let i = 0; i < 6; i += 1) seed(store, { agentId: "old", status: "approved", createdAt: NOW - 30 * DAY, decidedAt: NOW - 30 * DAY + HOUR });
  for (let i = 0; i < 6; i += 1) seed(store, { agentId: "new", status: "approved", createdAt: NOW - HOUR, decidedAt: NOW - HOUR / 2 });

  const week = agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents;
  assert.equal(byId(week, "old"), undefined, "a 30-day-old row leaked into a 7-day window");
  assert.equal(byId(week, "new").delivered, 6);

  const quarter = agentLedger({ db: store.db, windowMs: 90 * DAY, nowMs: NOW }).agents;
  assert.equal(byId(quarter, "old").delivered, 6);
});

// ── time to decision ───────────────────────────────────────────────────────────

test("median time-to-decision is a real median over decided rows only", (t) => {
  const store = freshDb(t);
  // Decision latencies: 1h, 2h, 3h → median 2h. Plus a pending row that must be ignored.
  for (const h of [1, 2, 3]) {
    seed(store, { agentId: "timed", status: "approved", createdAt: NOW - 10 * HOUR, decidedAt: NOW - 10 * HOUR + h * HOUR });
  }
  seed(store, { agentId: "timed", status: "pending", createdAt: NOW - 10 * HOUR });
  const a = byId(agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents, "timed");
  assert.equal(a.medianDecisionMs, 2 * HOUR);
});

test("an even count averages the two middle latencies", (t) => {
  const store = freshDb(t);
  for (const h of [1, 2, 3, 4]) {
    seed(store, { agentId: "even", status: "approved", createdAt: NOW - 10 * HOUR, decidedAt: NOW - 10 * HOUR + h * HOUR });
  }
  const a = byId(agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents, "even");
  assert.equal(a.medianDecisionMs, 2.5 * HOUR);
});

test("a decidedAt before createdAt is discarded, not reported as negative", (t) => {
  // Clock skew across a restart is real. A negative latency is not a measurement.
  const store = freshDb(t);
  seed(store, { agentId: "skew", status: "approved", createdAt: NOW - HOUR, decidedAt: NOW - 2 * HOUR });
  const a = byId(agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents, "skew");
  assert.equal(a.medianDecisionMs, null);
});

// CODE-REVIEW HIGH. `decisions` already excluded expired and failure rows, but the
// latency block right below it did not — it fed the median from ANY row carrying a
// `decidedAt`. That column is not exclusively a human decision: deliveries.mjs writes
// `decidedAt = now, decidedBy = 'system'` when a pending row is force-expired (SLA sweep
// or superseded by a failure), and a dismissed "agent is stuck" row gets one too. So an
// agent whose real reviews took minutes could display a median wait of a full day — a
// WRONG number sitting next to an "insufficient data" rate, which is precisely the
// failure mode this phase's honesty rule exists to prevent.
test("a system-written decidedAt (expired / dismissed failure) never enters the median", (t) => {
  const store = freshDb(t);
  // Two REAL decisions, both fast: 1h and 3h → median 2h.
  seed(store, { agentId: "sys", status: "approved", createdAt: NOW - 10 * HOUR, decidedAt: NOW - 9 * HOUR });
  seed(store, { agentId: "sys", status: "approved", createdAt: NOW - 10 * HOUR, decidedAt: NOW - 7 * HOUR });
  // An SLA-expired row the system stamped a full day later. Nobody decided it.
  seed(store, { agentId: "sys", status: "expired", createdAt: NOW - 2 * DAY, decidedAt: NOW - DAY });
  // A dismissed failure row, likewise not a judgement about a diff.
  store.db.prepare(
    `INSERT INTO deliveries (id, agentId, title, summary, source, kind, status, createdAt, decidedAt, auditRef)
     VALUES ('01JSYSFAIL0000000000000', 'sys', 'stuck', 'stuck', 'swarm', 'failure', 'rejected', ?, ?, 'ref')`,
  ).run(iso(NOW - 2 * DAY), iso(NOW - DAY));

  const a = byId(agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents, "sys");
  assert.equal(a.medianDecisionMs, 2 * HOUR, "a system timestamp was reported as a human decision latency");
});

// ── ordering + safety ──────────────────────────────────────────────────────────

test("agents sort by volume, then name — stable for a table", (t) => {
  const store = freshDb(t);
  for (let i = 0; i < 3; i += 1) seed(store, { agentId: "b-agent", status: "approved", createdAt: NOW - HOUR, decidedAt: NOW - HOUR / 2 });
  for (let i = 0; i < 3; i += 1) seed(store, { agentId: "a-agent", status: "approved", createdAt: NOW - HOUR, decidedAt: NOW - HOUR / 2 });
  for (let i = 0; i < 9; i += 1) seed(store, { agentId: "loud", status: "approved", createdAt: NOW - HOUR, decidedAt: NOW - HOUR / 2 });

  const names = agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents.map((r) => r.agentId);
  assert.deepEqual(names, ["loud", "a-agent", "b-agent"]);
});

test("failures are counted from the failure kind, and never inflate the approval rate", (t) => {
  // ADR-051 §9: an agent-stuck row is minted with kind 'failure'. It is a real signal
  // about the agent and belongs in the ledger — but dismissing one is not a rejection
  // of code, so it must not be scored as if it were.
  const store = freshDb(t);
  for (let i = 0; i < 5; i += 1) seed(store, { agentId: "flaky", status: "approved", createdAt: NOW - HOUR, decidedAt: NOW - HOUR / 2 });
  store.db.prepare(
    `INSERT INTO deliveries (id, agentId, title, summary, source, kind, status, createdAt, decidedAt, auditRef)
     VALUES ('01JFAIL0000000000000000001', 'flaky', 't', 's', 'swarm', 'failure', 'rejected', ?, ?, 'ref')`,
  ).run(iso(NOW - HOUR), iso(NOW - HOUR / 2));

  const a = byId(agentLedger({ db: store.db, windowMs: 7 * DAY, nowMs: NOW }).agents, "flaky");
  assert.equal(a.failures, 1);
  assert.equal(a.decisions, 5, "a dismissed failure is not a code decision");
  assert.equal(a.approvalRate, 1);
});

test("the window is clamped rather than trusted", (t) => {
  const store = freshDb(t);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10 ** 15]) {
    const out = agentLedger({ db: store.db, windowMs: bad, nowMs: NOW });
    assert.ok(out.windowMs >= 3600_000 && out.windowMs <= 90 * DAY, `window ${bad} escaped the clamp`);
  }
});

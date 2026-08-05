// B4 — the PURE half of the cadence client. Zero DOM, zero network, so it runs under
// `node --experimental-strip-types`. Pins the cadence label, the status pill, the
// relative-time formatters, the schedule bucketer and the row view-model — the exact
// display logic the Workflows table, the Schedule timeline and the drawer read from.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CADENCE_EXPRS,
  skillLabel,
  stationName,
  cadenceLabel,
  cadenceStatus,
  nextRunLabel,
  lastRunLabel,
  scheduleBuckets,
  cadenceRow,
  type Cadence,
} from "../cadenceClient.ts";

const T0 = Date.UTC(2026, 6, 30, 6, 0, 0); // 2026-07-30 06:00:00 UTC
const HOUR = 3_600_000;
const DAY = 86_400_000;

const mk = (over: Partial<Cadence> = {}): Cadence => ({
  id: "stuck-story-sweep",
  skill: "workflow-audit",
  agent: "tech-lead",
  venture: "waahyu",
  expr: "daily",
  hour: 7,
  enabled: true,
  next_run: T0 + 1 * HOUR,
  last_run: null,
  last_status: null,
  last_fired_slot: null,
  ...over,
});

test("CADENCE_EXPRS is the closed client mirror of the server enum", () => {
  assert.deepEqual([...CADENCE_EXPRS].sort(), ["2xdaily", "daily", "ondemand", "weekly"]);
});

test("skillLabel resolves the station catalog, and title-cases an unknown id", () => {
  assert.equal(skillLabel("workflow-audit"), "Workflow audit");
  assert.equal(skillLabel("repo-health-check"), "Repo health check");
  assert.equal(skillLabel("some-new-skill"), "Some new skill");
});

test("stationName resolves the ten SE seats and falls back to the raw id", () => {
  assert.equal(stationName("tech-lead"), "Tech Lead");
  assert.equal(stationName("docs-writer"), "Docs");
  assert.equal(stationName("mystery-station"), "mystery-station");
});

test("cadenceLabel reads the closed enum + hour, and never invents a cron string", () => {
  assert.equal(cadenceLabel(mk({ expr: "daily", hour: 7 })), "DAILY · 07:00");
  assert.equal(cadenceLabel(mk({ expr: "daily", hour: null })), "DAILY");
  assert.equal(cadenceLabel(mk({ expr: "weekly", hour: null })), "WEEKLY");
  assert.equal(cadenceLabel(mk({ expr: "2xdaily", hour: null })), "2×DAILY");
  assert.equal(cadenceLabel(mk({ expr: "ondemand", hour: null })), "ON DEMAND");
});

test("cadenceStatus maps enabled + last_status to a pill (paused / failed / active / idle)", () => {
  assert.deepEqual(cadenceStatus(mk({ enabled: false })), { label: "Paused", tone: "muted" });
  assert.deepEqual(cadenceStatus(mk({ enabled: true, last_status: "error" })), { label: "Failed", tone: "red" });
  assert.deepEqual(cadenceStatus(mk({ enabled: true, last_status: "dispatched" })), { label: "Active", tone: "green" });
  assert.deepEqual(cadenceStatus(mk({ enabled: true, last_status: null })), { label: "Idle", tone: "brass" });
  // a paused row that previously failed still reads as Paused — enabled state wins
  assert.deepEqual(cadenceStatus(mk({ enabled: false, last_status: "error" })), { label: "Paused", tone: "muted" });
});

test("nextRunLabel is relative and honest — 'on demand' for a null schedule", () => {
  assert.equal(nextRunLabel(null, T0), "on demand");
  assert.equal(nextRunLabel(T0 + 40_000, T0), "under a minute");
  assert.equal(nextRunLabel(T0 + 45 * 60_000, T0), "in 45m");
  assert.equal(nextRunLabel(T0 + 3 * HOUR, T0), "in 3h");
  assert.equal(nextRunLabel(T0 + 2 * DAY, T0), "in 2d");
  assert.equal(nextRunLabel(T0 - 5000, T0), "due now"); // a slot the tick has not yet reached
});

test("lastRunLabel: 'never' until it has run, then a relative stamp", () => {
  assert.equal(lastRunLabel(null, T0), "never");
  assert.equal(lastRunLabel(T0 - 20_000, T0), "just now");
  assert.equal(lastRunLabel(T0 - 5 * 60_000, T0), "5m ago");
  assert.equal(lastRunLabel(T0 - 3 * HOUR, T0), "3h ago");
  assert.equal(lastRunLabel(T0 - 2 * DAY, T0), "2d ago");
});

test("scheduleBuckets groups the next 24h chronologically by UTC hour, dropping on-demand rows", () => {
  const rows: Cadence[] = [
    mk({ id: "a", skill: "workflow-audit", next_run: T0 + 1 * HOUR }),   // 07:00
    mk({ id: "b", skill: "repo-health-check", next_run: T0 + 1 * HOUR + 600_000 }), // 07:10 (same bucket as a)
    mk({ id: "c", skill: "repo-read", next_run: T0 + 6 * HOUR }),         // 12:00
    mk({ id: "d", skill: "claude-code-handoff", expr: "ondemand", hour: null, next_run: null }), // excluded
    mk({ id: "e", skill: "data-summary", next_run: T0 + 40 * HOUR }),      // beyond 24h → excluded
  ];
  const buckets = scheduleBuckets(rows, T0, DAY);
  assert.equal(buckets.length, 2, "two hour-buckets inside the window");
  assert.deepEqual(buckets.map((b) => b.hour), [7, 12], "chronological hour order");
  assert.deepEqual(buckets[0].items.map((i) => i.cadence.id), ["a", "b"], "same-hour rows share a bucket, in time order");
  assert.equal(buckets[1].items.length, 1);
  assert.equal(buckets[0].label, "07:00");
});

test("scheduleBuckets on an all-on-demand set is empty (nothing scheduled)", () => {
  const rows: Cadence[] = [mk({ id: "x", expr: "ondemand", hour: null, next_run: null })];
  assert.deepEqual(scheduleBuckets(rows, T0, DAY), []);
});

test("cadenceRow composes the table row view-model from a raw cadence", () => {
  const row = cadenceRow(mk({ last_run: T0 - 2 * HOUR, last_status: "dispatched" }), T0);
  assert.equal(row.id, "stuck-story-sweep");
  assert.equal(row.name, "Workflow audit");
  assert.equal(row.station, "Tech Lead");
  assert.equal(row.cadence, "DAILY · 07:00");
  assert.equal(row.lastRun, "2h ago");
  assert.deepEqual(row.status, { label: "Active", tone: "green" });
});

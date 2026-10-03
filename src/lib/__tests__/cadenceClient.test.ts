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
  watchSlots,
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

// T0 is a Thursday, 06:00 UTC. TODAY0 is that day's UTC midnight.
const TODAY0 = Date.UTC(2026, 6, 30);
const MONDAY_9 = Date.UTC(2026, 7, 3, 9); // the next Monday, 09:00 UTC

test("watchSlots lays every timed cadence on today's clock, by hour, dropping on-demand and drifting rows", () => {
  const rows: Cadence[] = [
    mk({ id: "late", skill: "data-summary", hour: 18, next_run: TODAY0 + 18 * HOUR }),
    mk({ id: "od", expr: "ondemand", hour: null, next_run: null }),
    mk({ id: "drift", expr: "daily", hour: null, next_run: T0 + DAY }), // no hour: the runtime fires it every 24h from whenever, not at a clock slot
    mk({ id: "twice", skill: "repo-read", expr: "2xdaily", hour: 3, next_run: TODAY0 + 15 * HOUR }),
    mk({ id: "early", skill: "repo-health-check", hour: 2, next_run: TODAY0 + DAY + 2 * HOUR }),
  ];
  const slots = watchSlots(rows, T0);
  assert.deepEqual(slots.map((s) => [s.cadence.id, s.hour]), [["early", 2], ["twice", 3], ["twice", 15], ["late", 18]]);
  assert.equal(slots[0].title, "Repo health check");
});

test("watchSlots: a 2×daily with no hour sits at 00:00 and 12:00, where the runtime fires it", () => {
  const sweep = mk({ id: "stuck-story-sweep", expr: "2xdaily", hour: null, next_run: TODAY0 + 12 * HOUR });
  assert.deepEqual(watchSlots([sweep], T0).map((s) => s.hour), [0, 12]);
});

test("watchSlots: a passed slot is done only when the runtime fired THAT slot and it did not fail", () => {
  const ran = mk({ hour: 2, last_fired_slot: TODAY0 + 2 * HOUR, last_run: TODAY0 + 2 * HOUR + 5_000, last_status: "dispatched" });
  const failed = mk({ hour: 3, last_fired_slot: TODAY0 + 3 * HOUR, last_status: "error" });
  const missed = mk({ hour: 4, last_fired_slot: TODAY0 - DAY + 4 * HOUR });
  const runNow = mk({ hour: 5, last_fired_slot: TODAY0 + 5 * HOUR + 1_234, last_run: TODAY0 + 5 * HOUR + 1_234 }); // a manual run, not the slot
  const ahead = mk({ hour: 9 });
  const atNow = mk({ hour: 6 }); // exactly now: still upcoming (the mockup's rule)
  assert.deepEqual(watchSlots([ran, failed, missed, runNow, ahead, atNow], T0).map((s) => s.state),
    ["done", "failed", "missed", "no record", "upcoming", "upcoming"]);
});

test("watchSlots: the earlier slot of a 2×daily whose later slot fired has no record of its own", () => {
  const twice = mk({ expr: "2xdaily", hour: 0, last_fired_slot: TODAY0 + 12 * HOUR });
  const now = TODAY0 + 13 * HOUR;
  assert.deepEqual(watchSlots([twice], now).map((s) => [s.hour, s.state]), [[0, "no record"], [12, "done"]]);
});

test("watchSlots: a weekly cadence names its weekday and claims today only when today is its slot", () => {
  const monday = mk({ skill: "weekly-dependency-sweep", expr: "weekly", hour: 9, next_run: MONDAY_9 });
  const thursday = mk({ skill: "repo-read", expr: "weekly", hour: 9, next_run: TODAY0 + 9 * HOUR });
  const nextThursday = mk({ skill: "data-summary", expr: "weekly", hour: 9, next_run: TODAY0 + 7 * DAY + 9 * HOUR }); // enabled today: first due next week
  const [a, b, c] = watchSlots([monday, thursday, nextThursday], T0);
  assert.equal(a.title, "Weekly dependency sweep (Mondays)");
  assert.equal(a.state, "not today");
  assert.equal(b.title, "Read Repo (Thursdays)");
  assert.equal(b.state, "upcoming");
  assert.equal(c.state, "not today");
});

test("watchSlots: a paused cadence keeps its slot, says so, and never claims a run", () => {
  const paused = mk({ skill: "release-notes-digest", expr: "weekly", hour: 16, enabled: false, next_run: MONDAY_9 });
  const [s] = watchSlots([paused], T0);
  assert.equal(s.title, "Release notes digest (paused)");
  assert.equal(s.state, "paused");
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

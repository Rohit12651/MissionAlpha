// B4 — cadence store + tick. Injected clock + injected enqueue/emit, NO real timer.
//
// Proves the AUTONOMY MECHANISM in isolation from the queue/scheduler/HTTP:
//   • nextRun() is a PURE closed-enum time function — absolute UTC ms, no cron parse,
//     no eval; every result is STRICTLY future so nothing fires retroactively.
//   • tick() dedupes by (id, scheduled slot) PERSISTED, so a double-tick in the same
//     slot fires exactly once, and a kill-restart (re-open the SAME db) never re-fires
//     the slot it already dispatched.
//   • the 15 seeds arrive ENABLED with next_run computed FORWARD (nothing due on boot).
//   • runNow() bypasses the schedule but keeps a per-manual-slot dedupe + emit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { createCadence, nextRun, CADENCE_EXPRS, CADENCE_SEED } from "../cadence.mjs";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const T0 = Date.UTC(2026, 6, 30, 3, 0, 0); // 2026-07-30 03:00 UTC — a fixed anchor

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ma-cadence-"));
  const db = openDb({ path: join(dir, "mission.db") });
  return { dir, db, clean: () => { try { db.close(); } catch { /* */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

// A capturing enqueue/emit pair for a tick or runNow call.
function sink() {
  const enq = [];
  const events = [];
  return {
    enqueue: (x) => { enq.push(x); return { firstTaskId: `task_${enq.length.toString(16).padStart(6, "0")}` }; },
    emit: (name, data) => events.push({ name, data }),
    enq, events,
  };
}

// ── nextRun: pure, closed enum, strictly future ─────────────────────────────

test("nextRun: ondemand is null — an on-demand cadence never auto-fires", () => {
  assert.equal(nextRun("ondemand", null, T0), null);
  assert.equal(nextRun("ondemand", 9, T0), null);
});

test("nextRun: an unknown expr is null (closed set — no cron, no eval)", () => {
  assert.equal(nextRun("* * * * *", null, T0), null);
  assert.equal(nextRun("hourly", null, T0), null);
  assert.deepEqual([...CADENCE_EXPRS].sort(), ["2xdaily", "daily", "ondemand", "weekly"]);
});

test("nextRun: daily with no hour is exactly +24h", () => {
  assert.equal(nextRun("daily", null, T0), T0 + DAY);
});

test("nextRun: daily with an hour lands on the next UTC occurrence of that hour, strictly future", () => {
  const at = nextRun("daily", 7, T0); // T0 is 03:00 UTC → 07:00 today
  const d = new Date(at);
  assert.equal(d.getUTCHours(), 7);
  assert.equal(d.getUTCMinutes(), 0);
  assert.ok(at > T0);
  assert.ok(at - T0 < DAY, "the next 07:00 is later today, not tomorrow");

  // when the hour already passed today, it rolls to tomorrow (still strictly future)
  const past = nextRun("daily", 1, T0); // 01:00 already gone at 03:00
  assert.ok(past > T0);
  assert.equal(new Date(past).getUTCHours(), 1);
  assert.ok(past - T0 > DAY - 3 * 3600_000);
});

test("nextRun: weekly is roughly a week out and strictly future", () => {
  const at = nextRun("weekly", null, T0);
  assert.equal(at, T0 + WEEK);
  const atH = nextRun("weekly", 9, T0);
  assert.ok(atH > T0 + WEEK - DAY && atH <= T0 + WEEK + DAY);
  assert.equal(new Date(atH).getUTCHours(), 9);
});

test("nextRun: 2xdaily returns the nearer of two daily slots, strictly future", () => {
  const at = nextRun("2xdaily", null, T0); // slots 00:00 / 12:00 → next is 12:00 today
  assert.ok(at > T0);
  assert.equal(new Date(at).getUTCHours(), 12);
  assert.ok(at - T0 <= 12 * 3600_000 + 1);
});

// ── seeds: the 3 SE cadences, forward-scheduled, enabled per the seed row ────

test("seed: the SE cadences arrive with next_run computed FORWARD (nothing due at boot)", () => {
  const { db, clean } = freshDb();
  try {
    const cad = createCadence({ db, now: () => T0 });
    const rows = cad.list();
    assert.equal(rows.length, CADENCE_SEED.length, "every seed present, and nothing else");
    assert.deepEqual(
      [...CADENCE_SEED].map((r) => r.id).sort(),
      rows.map((r) => r.id).sort(),
      "the store holds exactly the seed roster",
    );
    for (const r of rows) {
      const seed = CADENCE_SEED.find((x) => x.id === r.id);
      assert.equal(r.enabled, seed.enabled !== false, `${r.id} honors its seed enabled flag`);
      if (r.expr === "ondemand") {
        assert.equal(r.next_run, null, `${r.id} ondemand never schedules`);
      } else {
        assert.ok(r.next_run > T0, `${r.id} next_run is FORWARD of boot`);
      }
    }
    assert.deepEqual(cad.due(T0), [], "nothing is due the instant the store boots");
  } finally { clean(); }
});

test("seed: a cadence whose stage is not built yet lands DISABLED, not firing into nothing", () => {
  const { db, clean } = freshDb();
  try {
    const cad = createCadence({ db, now: () => T0 });
    assert.equal(cad.get("stuck-story-sweep").enabled, true, "the pipeline watchdog is live from S0");
    assert.equal(cad.get("nightly-regression").enabled, false, "needs S4's test config");
    assert.equal(cad.get("monitor-tick").enabled, true, "S5 ships the monitor — monitor-tick is live");
    // a disabled row is never due, however far the clock moves
    const far = T0 + 30 * DAY;
    const dueIds = cad.due(far).map((r) => r.id);
    assert.ok(!dueIds.includes("nightly-regression"), "the disabled nightly-regression never becomes due");
    assert.ok(dueIds.includes("monitor-tick"), "the enabled monitor-tick IS due once the clock passes its slot");
  } finally { clean(); }
});

test("seed: a retired (non-seed) cadence row is pruned so it cannot dispatch at a dead agent", () => {
  const { db, clean } = freshDb();
  try {
    createCadence({ db, now: () => T0 });
    // stage a pre-pivot row exactly as the old build left it
    db.db.prepare(
      `INSERT INTO cadences (id, skill, agent, venture, expr, hour, enabled, next_run, last_run, last_status, last_fired_slot, created_at, updated_at)
       VALUES ('lead-scorer','lead-scorer','sales-station','waahyu','daily',7,1,?,NULL,NULL,NULL,?,?)`,
    ).run(T0 + DAY, T0, T0);
    const reopened = createCadence({ db, now: () => T0 });
    assert.equal(reopened.get("lead-scorer"), null, "the retired row is gone");
    assert.equal(reopened.list().length, CADENCE_SEED.length, "and only the seed roster remains");
  } finally { clean(); }
});

test("seed: re-opening the same db does not duplicate or overwrite rows (idempotent)", () => {
  const { db, clean, dir } = freshDb();
  try {
    const cad = createCadence({ db, now: () => T0 });
    const before = cad.list().find((r) => r.id === "stuck-story-sweep").next_run;
    // second construction over the SAME handle re-seeds — must be a no-op
    const cad2 = createCadence({ db, now: () => T0 + 5 * DAY });
    assert.equal(cad2.list().length, CADENCE_SEED.length, "no duplicate rows");
    assert.equal(cad2.list().find((r) => r.id === "stuck-story-sweep").next_run, before, "existing next_run untouched");
    assert.ok(dir);
  } finally { clean(); }
});

// ── tick: fire once, dedupe by (id, slot) ───────────────────────────────────

test("tick: a due cadence fires exactly once — a second tick at the same now fires nothing", () => {
  const { db, clean } = freshDb();
  try {
    const cad = createCadence({ db, now: () => T0 });
    const later = T0 + 2 * DAY; // every daily/2xdaily/weekly slot within the seed is now in the past
    const dueIds = cad.due(later).map((r) => r.id);
    assert.ok(dueIds.includes("stuck-story-sweep"), "an enabled cadence is due two days on");

    const s1 = sink();
    const fired1 = cad.tick({ now: later, enqueue: s1.enqueue, emit: s1.emit });
    assert.equal(fired1.length, dueIds.length, "every due row fired");
    // each fired row: enqueue once, workflow.run once, next_run advanced strictly future, status dispatched
    assert.equal(s1.enq.length, fired1.length);
    assert.equal(s1.events.length, fired1.length);
    for (const ev of s1.events) {
      assert.equal(ev.name, "workflow.run");
      assert.equal(ev.data.status, "dispatched");
      assert.ok(ev.data.id && ev.data.skill && ev.data.agent);
    }
    for (const f of fired1) {
      const row = cad.get(f.id);
      assert.ok(row.next_run > later, `${f.id} next_run advanced past now`);
      assert.equal(row.last_status, "dispatched");
      assert.equal(row.last_run, later);
    }

    const s2 = sink();
    const fired2 = cad.tick({ now: later, enqueue: s2.enqueue, emit: s2.emit });
    assert.deepEqual(fired2, [], "idempotent — the same slot never fires twice");
    assert.equal(s2.enq.length, 0);
  } finally { clean(); }
});

test("tick: a disabled cadence is never due and never fires", () => {
  const { db, clean } = freshDb();
  try {
    const cad = createCadence({ db, now: () => T0 });
    cad.setEnabled("stuck-story-sweep", false);
    const later = T0 + 2 * DAY;
    assert.ok(!cad.due(later).some((r) => r.id === "stuck-story-sweep"));
    const s = sink();
    const fired = cad.tick({ now: later, enqueue: s.enqueue, emit: s.emit });
    assert.ok(!fired.some((f) => f.id === "stuck-story-sweep"), "disabled row stays dark");
  } finally { clean(); }
});

// ── restart-resume: re-open the SAME db, never re-fire the just-fired slot ───

test("RESTART RESUME: a slot fired before a kill is NOT re-fired after re-opening the same db", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ma-cadence-rr-")), "mission.db");
  const later = T0 + 2 * DAY;

  // run 1 — tick fires + advances next_run in the DB, then "kill -9" (close the handle)
  const db1 = openDb({ path });
  const cad1 = createCadence({ db1: undefined, db: db1, now: () => T0 });
  const s1 = sink();
  const fired1 = cad1.tick({ now: later, enqueue: s1.enqueue, emit: s1.emit });
  assert.ok(fired1.length > 0, "run 1 fired the due slots");
  const advanced = new Map(fired1.map((f) => [f.id, cad1.get(f.id).next_run]));
  db1.close();

  // run 2 — a brand-new instance over the SAME db file (the reboot)
  const db2 = openDb({ path });
  const cad2 = createCadence({ db: db2, now: () => later }); // re-seed is a no-op; persisted next_run wins
  for (const [id, nr] of advanced) {
    assert.equal(cad2.get(id).next_run, nr, `${id} persisted its advanced next_run across the restart`);
  }
  // the just-fired slots are in the past-relative sense already consumed → due() must not
  // return them for the SAME slot, and a fresh tick at the same clock re-fires NOTHING.
  const s2 = sink();
  const fired2 = cad2.tick({ now: later, enqueue: s2.enqueue, emit: s2.emit });
  assert.equal(s2.enq.length, 0, "no double dispatch after the restart");
  assert.deepEqual(fired2, [], "the just-fired slot is not re-fired on resume");

  db2.close();
  rmSync(path, { force: true });
});

// ── runNow: off-schedule dispatch with the same emit + a per-manual-slot dedupe

test("runNow: dispatches a DISABLED cadence off-schedule, emits workflow.run, and never shifts its clock", () => {
  const { db, clean } = freshDb();
  try {
    const cad = createCadence({ db, now: () => T0 });
    // nightly-regression is seeded disabled — it can never auto-fire, so runNow is the only
    // way it ever dispatches. That is exactly the manual-dispatch contract.
    const row = cad.get("nightly-regression");
    assert.equal(row.enabled, false, "the row never auto-fires");
    const scheduledAt = row.next_run;

    const s = sink();
    const out = cad.runNow(row.id, { enqueue: s.enqueue, emit: s.emit, now: T0 });
    assert.ok(out.taskId, "runNow returns the queued taskId");
    assert.equal(s.enq.length, 1, "dispatched once");
    assert.equal(s.events[0].name, "workflow.run");
    assert.equal(s.events[0].data.status, "dispatched");
    assert.equal(cad.get(row.id).next_run, scheduledAt, "runNow does NOT shift the row's schedule");
    assert.equal(cad.get(row.id).enabled, false, "and does NOT silently enable it");

    // same manual slot (same ms) → deduped, fires nothing more
    const s2 = sink();
    const dup = cad.runNow(row.id, { enqueue: s2.enqueue, emit: s2.emit, now: T0 });
    assert.equal(s2.enq.length, 0, "a double-fire in the same manual slot dedupes");
    assert.ok(dup.deduped, "the dedupe is reported");
  } finally { clean(); }
});

test("runNow: an unknown id is a clean not-found, never a throw", () => {
  const { db, clean } = freshDb();
  try {
    const cad = createCadence({ db, now: () => T0 });
    const s = sink();
    const out = cad.runNow("no-such-cadence", { enqueue: s.enqueue, emit: s.emit, now: T0 });
    assert.equal(out.error ? true : false, true);
    assert.equal(s.enq.length, 0);
  } finally { clean(); }
});

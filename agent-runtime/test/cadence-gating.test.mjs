// Phase 1 / R2b — cadence tick gating.
//
// SLOT-* is the load-bearing group. The CAS advance is what makes a cadence fire exactly
// once per slot; if a gate rejects AFTER the CAS commits, the run is not deferred, it is
// DESTROYED — next_run has already moved on and nothing ever dispatched. Every gate must
// therefore reject BEFORE the claim. These tests pin that ordering.

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createCadence } from "../cadence.mjs";
import { createWorkerCap } from "../worker-cap.mjs";

const T0 = Date.UTC(2026, 7, 18, 12, 0, 0);
const DAY = 86_400_000;

// Minimal in-memory schema matching the cadences table the migration creates.
function makeStore() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE cadences (
    id TEXT PRIMARY KEY, skill TEXT, agent TEXT, venture TEXT,
    expr TEXT, hour INTEGER, enabled INTEGER,
    next_run INTEGER, last_run INTEGER, last_status TEXT,
    last_fired_slot INTEGER, created_at INTEGER, updated_at INTEGER
  )`);
  return { db };
}

function seeded(now = T0) {
  const store = makeStore();
  const cadence = createCadence({ db: store, now: () => now });
  cadence.seed({ now });
  // Force one row due so tick() has work.
  store.db.prepare("UPDATE cadences SET enabled = 1, next_run = ? WHERE id = 'worker-audit'").run(now - 1000);
  return { store, cadence };
}

test("baseline: a due, enabled row dispatches when no gates are wired", () => {
  const { cadence } = seeded();
  const calls = [];
  const fired = cadence.tick({ now: T0, enqueue: (a) => { calls.push(a); return { taskId: "t1" }; } });
  assert.equal(calls.length, 1);
  assert.equal(fired[0].id, "worker-audit");
});

test("SLOT-1: a guard deferral does NOT dispatch", () => {
  const { cadence } = seeded();
  const calls = [];
  const fired = cadence.tick({
    now: T0,
    enqueue: (a) => { calls.push(a); return { taskId: "t1" }; },
    guard: { ok: false, reason: "memory", detail: { availPct: 4 } },
  });
  assert.equal(calls.length, 0, "nothing may dispatch while the guard is red");
  assert.equal(fired[0].deferred, true);
  assert.equal(fired[0].reason, "memory");
});

test("SLOT-2: a guard deferral does NOT consume the slot — the run is postponed, not lost", () => {
  const { store, cadence } = seeded();
  const before = store.db.prepare("SELECT next_run FROM cadences WHERE id='worker-audit'").get().next_run;

  cadence.tick({ now: T0, enqueue: () => ({ taskId: "x" }), guard: { ok: false, reason: "load" } });
  const after = store.db.prepare("SELECT next_run FROM cadences WHERE id='worker-audit'").get().next_run;
  assert.equal(after, before, "next_run must NOT advance on a deferral");

  // and once the guard clears, the same slot still fires
  const calls = [];
  cadence.tick({ now: T0, enqueue: (a) => { calls.push(a); return { taskId: "t" }; }, guard: { ok: true } });
  assert.equal(calls.length, 1, "the deferred run must still be there when pressure clears");
});

test("SLOT-3: a capped worker does NOT consume the slot either", () => {
  const { store, cadence } = seeded();
  const cap = createWorkerCap({ cap: 0 }); // fully spent
  const before = store.db.prepare("SELECT next_run FROM cadences WHERE id='worker-audit'").get().next_run;
  const calls = [];
  const fired = cadence.tick({ now: T0, enqueue: (a) => { calls.push(a); return { taskId: "t" }; }, cap });
  assert.equal(calls.length, 0);
  assert.equal(fired[0].capped, true);
  const after = store.db.prepare("SELECT next_run FROM cadences WHERE id='worker-audit'").get().next_run;
  assert.equal(after, before, "a capped run is skipped today and runs tomorrow — never destroyed");
});

test("LAW3-tick: the cap is consumed exactly once per real dispatch", () => {
  const { store, cadence } = seeded();
  const cap = createWorkerCap({ cap: 2 });
  cadence.tick({ now: T0, enqueue: () => ({ taskId: "t1" }), cap });
  assert.equal(cap.used("worker-audit", T0), 1);

  // make it due again in the same day
  store.db.prepare("UPDATE cadences SET next_run = ? WHERE id='worker-audit'").run(T0 + 1000);
  cadence.tick({ now: T0 + 2000, enqueue: () => ({ taskId: "t2" }), cap });
  assert.equal(cap.used("worker-audit", T0), 2);

  // third is refused
  store.db.prepare("UPDATE cadences SET next_run = ? WHERE id='worker-audit'").run(T0 + 3000);
  const calls = [];
  cadence.tick({ now: T0 + 4000, enqueue: (a) => { calls.push(a); return { taskId: "t3" }; }, cap });
  assert.equal(calls.length, 0, "the third run in a day is refused");
  assert.equal(cap.used("worker-audit", T0), 2);
});

test("LAW3-tick-2: the budget re-opens the next UTC day", () => {
  const { store, cadence } = seeded();
  const cap = createWorkerCap({ cap: 1 });
  cadence.tick({ now: T0, enqueue: () => ({ taskId: "t1" }), cap });
  store.db.prepare("UPDATE cadences SET next_run = ? WHERE id='worker-audit'").run(T0 + DAY - 1000);
  const calls = [];
  cadence.tick({ now: T0 + DAY, enqueue: (a) => { calls.push(a); return { taskId: "t2" }; }, cap });
  // A full day later the other seeded 2xdaily cadences are legitimately due as well, so
  // count only the worker under test rather than every dispatch in the tick.
  assert.equal(calls.filter((c) => c.agent === "sr-security").length, 1, "the worker's budget re-opened");
});

test("REGRESSION: an unwired caller behaves exactly as before R2b", () => {
  const { store, cadence } = seeded();
  const before = store.db.prepare("SELECT next_run FROM cadences WHERE id='worker-audit'").get().next_run;
  const calls = [];
  cadence.tick({ now: T0, enqueue: (a) => { calls.push(a); return { taskId: "t" }; } });
  const after = store.db.prepare("SELECT next_run FROM cadences WHERE id='worker-audit'").get().next_run;
  assert.equal(calls.length, 1, "no gates wired → dispatch, same as before");
  assert.ok(after > before, "and the slot advances, same as before");
});

test("a guard object with ok:true is a no-op", () => {
  const { cadence } = seeded();
  const calls = [];
  cadence.tick({ now: T0, enqueue: (a) => { calls.push(a); return { taskId: "t" }; }, guard: { ok: true, reason: "clear" } });
  assert.equal(calls.length, 1);
});

test("the guard gate short-circuits the whole tick, not one row", () => {
  const { store, cadence } = seeded();
  store.db.prepare("UPDATE cadences SET enabled = 1, next_run = ? WHERE id='worker-testgaps'").run(T0 - 500);
  const calls = [];
  const fired = cadence.tick({ now: T0, enqueue: (a) => { calls.push(a); return { taskId: "t" }; }, guard: { ok: false, reason: "memory" } });
  assert.equal(calls.length, 0);
  assert.equal(fired.length, 1, "one deferral verdict for the tick, not one per row");
});

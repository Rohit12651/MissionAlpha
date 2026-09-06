// Phase 1 / R2b — the WORKER DAILY CAP. Law 3's counting half.
//
// WHY A CAP IS PART OF THE FEATURE, NOT A NICETY: cadence workers exist to fill the Inbox
// without a human. That is exactly the property that makes them dangerous to the Inbox —
// an unbounded generator turns a decision queue back into a monitoring console, which is
// the failure MissionAlpha was built to escape. failure-signature.mjs already documents
// the observed version of this: 97 failures rendering as ~20 near-identical cards. A
// worker that can mint without limit reproduces that by design. So the cap ships WITH the
// workers, in the same phase, pinned by the same tests.
//
// DURABILITY WITHOUT A MIGRATION: counts live in a JSON file, the same pattern
// station-memory.mjs / station-perms.mjs already established for small operator-scale
// state. A schema migration for a per-day integer would be a heavier change than the
// feature it supports, and this store is rebuildable (losing it re-opens today's budget —
// an over-permissive failure bounded by one day, which is the right direction for a
// counter whose absence must never wedge the loop).
//
// UTC DAY, ALWAYS. A local-midnight rollover would silently double the budget for anyone
// running across a DST boundary, and the rest of this runtime is absolute-UTC (cadence
// next_run, SLA deadlines). One clock.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/** Default runs/day per worker. Deliberately small — the Inbox is a decision queue. */
export const DEFAULT_DAILY_CAP = 3;
/** Hard ceiling an operator cannot configure past. A cap of 500 is not a cap. */
export const MAX_DAILY_CAP = 24;

/** UTC calendar day key, e.g. "2026-08-18". */
export function dayKey(ms) {
  const d = new Date(Number(ms) || 0);
  if (Number.isNaN(d.getTime())) return "1970-01-01";
  return d.toISOString().slice(0, 10);
}

/** Clamp an operator-supplied cap into the allowed range. Invalid → default. */
export function normalizeCap(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_DAILY_CAP;
  return Math.max(0, Math.min(MAX_DAILY_CAP, Math.floor(n)));
}

export function createWorkerCap(deps = {}) {
  const file = deps.file || null;
  const cap = normalizeCap(deps.cap ?? process.env.RUNTIME_WORKER_DAILY_CAP ?? DEFAULT_DAILY_CAP);
  const log = typeof deps.log === "function" ? deps.log : () => {};
  // null-proto: a cadence id of "__proto__" is an ordinary key, not a prototype write.
  let counts = Object.create(null);
  let loadedDay = null;

  function load() {
    counts = Object.create(null);
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      loadedDay = typeof raw?.day === "string" ? raw.day : null;
      for (const [k, v] of Object.entries(raw?.counts || {})) {
        if (typeof k === "string" && Number.isFinite(Number(v))) counts[k] = Number(v);
      }
    } catch {
      counts = Object.create(null);
      loadedDay = null;
    }
  }

  function persist(day) {
    if (!file) return true;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ day, counts: { ...counts } }, null, 2) + "\n");
      try { chmodSync(file, 0o600); } catch { /* best effort — perms are not the guarantee */ }
      return true;
    } catch (e) {
      // A persist fault must be a clean false, never an uncaughtException: this runs
      // inside the tick, and a wedged tick is the outage class this program exists to kill.
      log(`[worker-cap] persist failed: ${e?.message}`);
      return false;
    }
  }

  function rollIfNeeded(day) {
    if (loadedDay !== day) {
      counts = Object.create(null);
      loadedDay = day;
    }
  }

  load();

  /** How many runs this worker has already spent today. */
  function used(id, now = Date.now()) {
    rollIfNeeded(dayKey(now));
    return counts[String(id)] || 0;
  }

  /** Would a run be allowed right now? Does NOT consume. */
  function allows(id, now = Date.now()) {
    return used(id, now) < cap;
  }

  /**
   * Consume one unit. Returns {ok, used, cap}. When ok is false the caller MUST NOT
   * dispatch — and must not consume the schedule slot either, or the run is lost rather
   * than skipped.
   */
  function consume(id, now = Date.now()) {
    const day = dayKey(now);
    rollIfNeeded(day);
    const key = String(id);
    const cur = counts[key] || 0;
    if (cur >= cap) return { ok: false, used: cur, cap };
    counts[key] = cur + 1;
    persist(day);
    return { ok: true, used: cur + 1, cap };
  }

  /** Whole-day snapshot for doctor / the cockpit tile. */
  function snapshot(now = Date.now()) {
    rollIfNeeded(dayKey(now));
    return { day: dayKey(now), cap, counts: { ...counts } };
  }

  return { allows, consume, used, snapshot, cap, dayKey };
}

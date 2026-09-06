// B4 — Cadence engine. The autonomy spine's CLOCK: it fires a station's standing skill
// on a schedule, through the EXISTING queue (engine.enqueueGoal), with zero human input.
//
// This module owns the PURE, CLOSED-ENUM time logic + the durable cadence index. It is
// deliberately NOT a cron engine:
//   • expr is a 4-value enum {daily, weekly, 2xdaily, ondemand} — no cron string is ever
//     parsed, no expression is ever eval'd. A fifth cadence shape is a migration, not a
//     caller-supplied string, so the attack surface a cron parser opens does not exist.
//   • time is stored as ABSOLUTE-UTC next-run ms. nextRun() always returns a STRICTLY
//     future instant, so a long outage never replays a backlog of missed slots, and a
//     fresh boot never fires retroactively.
//   • dedupe is by (id, scheduled slot) PERSISTED. The advance of next_run is a
//     compare-and-swap against the slot it fired for, committed BEFORE the enqueue —
//     so a double-tick, or a kill-restart inside the same slot, dispatches exactly once.
//     (A crash in the window between the CAS commit and the enqueue loses ONE run rather
//     than duplicating one — the same honest tradeoff the queue/engine already make.)
//
// The queue's own idempotency does not span cadence re-fires (engine.enqueueGoal mints a
// fresh random goalId per call), so the (id, slot) CAS here is the real guarantee.

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** The closed cadence-expression set. A value outside this set schedules nothing. */
export const CADENCE_EXPRS = Object.freeze(["daily", "weekly", "2xdaily", "ondemand"]);
const EXPR_SET = new Set(CADENCE_EXPRS);

// "End of day" is expressed as a concrete UTC hour so the store never carries a symbol
// the enum cannot validate. 17:00 UTC = a business end-of-day roll-up slot.
const EOD_HOUR = 17;

/**
 * The three standing SE cadences — the SINGLE source of truth for what the swarm runs
 * unattended. `id` is the (globally unique) cadence id, `skill` the catalog skill it
 * fires, `agent` its owning seat, and `expr`/`hour` its schedule. `ondemand` rows carry
 * no schedule (next_run stays null) and fire only via runNow.
 *
 * `enabled` is part of the SEED, not just the store: `nightly-regression` lands DISABLED
 * (it needs S4's quality config to mean anything, and a cadence that fires into an unbuilt
 * stage would be theatre), while `stuck-story-sweep` is live from S0 and `monitor-tick` is
 * LIVE from S5 (S5 ships the SRE monitor it drives). A BOSS toggle after seeding is never
 * reset — seed() is INSERT OR IGNORE, so the stored flag always wins on a later boot (a dev
 * DB seeded before S5 keeps monitor-tick disabled until toggled; a fresh boot lands it enabled).
 */
export const CADENCE_SEED = Object.freeze([
  // Tech lead — the story pipeline's own watchdog. LIVE from S0.
  Object.freeze({ id: "stuck-story-sweep", skill: "workflow-audit", agent: "tech-lead", expr: "2xdaily", hour: null, enabled: true }),
  // QA — the nightly regression run. DISABLED until S4 configures the test command.
  Object.freeze({ id: "nightly-regression", skill: "repo-health-check", agent: "qa", expr: "daily", hour: EOD_HOUR, enabled: false }),
  // SRE — the deployed-surface health poll. LIVE from S5 (S5 ships the monitor it drives).
  Object.freeze({ id: "monitor-tick", skill: "repo-health-check", agent: "sre", expr: "2xdaily", hour: null, enabled: true }),

  // ── Phase 1 / R2b — THE WORKER CATALOG ────────────────────────────────────
  // These four are the "Inbox fills itself" half of the ruflo adoption. Each one is a
  // READ-ONLY analysis run whose product is a low-band Delivery the BOSS can decide on,
  // not a diff. They are the difference between a tool that waits for work and a team
  // that finds it.
  //
  // ALL FOUR LAND **DISABLED**, on purpose, and this is not timidity:
  //   1. Every one of them dispatches a real model run. Enabling four new daily spawns on
  //      an install whose account is not even active would mint four failure Deliveries a
  //      day and call it autonomy — exactly the theatre ruflo's dead daemon performs.
  //   2. The BOSS enables them per-worker from the cockpit once an account is live. That
  //      is one click each, and it is an informed click.
  // The same convention CADENCE_SEED already uses for `nightly-regression` (disabled until
  // the thing it depends on exists). A cadence that fires into an unproven surface is
  // theatre; a disabled row that the operator turns on is a feature.
  Object.freeze({ id: "worker-audit", skill: "security-audit", agent: "sr-security", expr: "daily", hour: 9, enabled: false }),
  Object.freeze({ id: "worker-testgaps", skill: "test-gap-scan", agent: "qa", expr: "daily", hour: 11, enabled: false }),
  Object.freeze({ id: "worker-document", skill: "docs-refresh", agent: "docs-writer", expr: "weekly", hour: 13, enabled: false }),
  Object.freeze({ id: "worker-refactor", skill: "refactor-scan", agent: "tech-lead", expr: "weekly", hour: 15, enabled: false }),
]);

/**
 * The worker rows are the ones Law 3 binds: capped per day, forced to the low band, and
 * structurally unable to auto-apply. Membership is by id prefix so a future worker cannot
 * be added without inheriting the constraint.
 */
export const WORKER_PREFIX = "worker-";
export function isWorkerCadence(id) {
  return typeof id === "string" && id.startsWith(WORKER_PREFIX);
}

const DEFAULT_VENTURE = "waahyu";

// Coerce a raw hour to a valid UTC hour, or null. Number.isFinite + floor + clamp before
// use (B2 LOW-4 numeric discipline) — a hostile/garbage hour never reaches Date math.
function safeHour(hour) {
  if (hour === null || hour === undefined) return null;
  const n = Number(hour);
  if (!Number.isFinite(n)) return null;
  return Math.min(23, Math.max(0, Math.floor(n)));
}

// The next STRICTLY-future instant at UTC hour `h` on/after `now`.
function nextAtHour(now, h) {
  const d = new Date(now);
  d.setUTCHours(h, 0, 0, 0);
  let t = d.getTime();
  while (t <= now) t += DAY; // strictly future — never returns `now` itself
  return t;
}

/**
 * The absolute-UTC ms of the next fire for (expr, hour) after `now`. PURE and closed:
 *   ondemand / unknown → null (schedules nothing)
 *   daily   → next occurrence of `hour`, or now+24h when no hour
 *   weekly  → ~7 days out, aligned to `hour` when given
 *   2xdaily → the nearer of two daily slots (hour & hour+12, or 00:00 & 12:00)
 * Every non-null result is STRICTLY greater than `now`.
 */
export function nextRun(expr, hour, now) {
  if (!EXPR_SET.has(expr) || expr === "ondemand") return null;
  const h = safeHour(hour);
  if (expr === "daily") {
    return h === null ? now + DAY : nextAtHour(now, h);
  }
  if (expr === "weekly") {
    if (h === null) return now + WEEK;
    const d = new Date(now + WEEK);
    d.setUTCHours(h, 0, 0, 0);
    let t = d.getTime();
    while (t <= now) t += DAY; // keep it strictly future even at an exact boundary
    return t;
  }
  // 2xdaily — two slots a day, 12h apart.
  const base = h === null ? 0 : h;
  const a = nextAtHour(now, base % 24);
  const b = nextAtHour(now, (base + 12) % 24);
  return Math.min(a, b);
}

/** The scheduled brief a fired cadence carries into the queue as its goal text. */
function goalFor(row) {
  return `Scheduled ${row.id} run for ${row.venture}. Produce your standing ${row.skill} findings and write them to shared memory. Read-only — you propose reviewable work, you never apply it.`;
}

export function createCadence(deps = {}) {
  const store = deps.db;
  if (!store || !store.db) throw new Error("createCadence: db handle required");
  const db = store.db;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const venture = deps.venture || DEFAULT_VENTURE;

  // Row → the wire/UI shape. `enabled` is a real boolean, times stay absolute-UTC ms.
  const hydrate = (r) => (!r ? null : {
    id: r.id,
    skill: r.skill,
    agent: r.agent,
    venture: r.venture,
    expr: r.expr,
    hour: r.hour,
    enabled: r.enabled === 1,
    next_run: r.next_run,
    last_run: r.last_run,
    last_status: r.last_status,
    last_fired_slot: r.last_fired_slot,
  });

  const selOne = db.prepare("SELECT * FROM cadences WHERE id = ?");
  const getRow = (id) => selOne.get(String(id)) || null;

  // ── seed (idempotent) ──────────────────────────────────────────────────────
  // Insert any seed row the store has never seen, with next_run computed FORWARD from
  // the boot clock so nothing fires retroactively. INSERT OR IGNORE keeps an already-seeded
  // row (and any BOSS edit / advanced next_run / toggle) exactly as it is — a restart never
  // resets a schedule. Mirrors seed-stations.mjs: id-keyed, no bus announcement, self-heal
  // not writer. `enabled` comes from the seed row (default true when the row omits it), so a
  // cadence whose stage is not built yet lands dark rather than firing into nothing.
  function seed() {
    const t = now();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO cadences
         (id, skill, agent, venture, expr, hour, enabled, next_run, last_run, last_status, last_fired_slot, created_at, updated_at)
       VALUES (@id, @skill, @agent, @venture, @expr, @hour, @enabled, @next_run, NULL, NULL, NULL, @t, @t)`,
    );
    // S0 convergence: the cadence table is SEED-ONLY (no create route exists — the HTTP
    // surface is list/toggle/run), so any row whose id is not in CADENCE_SEED is a
    // retired business cadence. Left in place it would keep dispatching goals at an
    // agent id the registry no longer has, so it is dropped here. Row-level convergence
    // of a seed-only index — not a schema migration, and no other table is touched.
    const seedIds = CADENCE_SEED.map((s) => s.id);
    const prune = db.prepare(
      `DELETE FROM cadences WHERE id NOT IN (${seedIds.map(() => "?").join(",")})`,
    );
    db.transaction(() => {
      prune.run(...seedIds);
      for (const s of CADENCE_SEED) {
        insert.run({
          id: s.id, skill: s.skill, agent: s.agent, venture,
          expr: s.expr, hour: safeHour(s.hour),
          enabled: s.enabled === false ? 0 : 1,
          next_run: nextRun(s.expr, s.hour, t),
          t,
        });
      }
    })();
  }
  seed();

  function list() {
    return db.prepare("SELECT * FROM cadences ORDER BY agent, skill").all().map(hydrate);
  }

  function get(id) {
    return hydrate(getRow(id));
  }

  // Rows eligible to fire at `t`: enabled, actually scheduled, and past due.
  function due(t) {
    return db.prepare(
      "SELECT * FROM cadences WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ? ORDER BY next_run",
    ).all(t).map(hydrate);
  }

  // Fire one due row for a scheduled slot. The advance is a COMPARE-AND-SWAP on next_run:
  // it only lands if next_run is STILL the slot we read (WHERE next_run = @slot), so a
  // concurrent/re-entrant tick that already claimed this slot changes 0 rows and we skip.
  // The DB write commits BEFORE the enqueue, so the slot can never dispatch twice.
  const advanceCas = db.prepare(
    `UPDATE cadences
        SET last_run = @t, last_status = 'dispatched', last_fired_slot = @slot,
            next_run = @next_run, updated_at = @t
      WHERE id = @id AND next_run = @slot`,
  );

  // Phase 1 / R2b — two OPTIONAL gates in front of dispatch. Both are injected and both
  // default to absent, so an unwired caller gets byte-identical pre-R2b behaviour (the
  // existing cadence tests pin that).
  //
  //   guard — resource-guard.mjs. Checked ONCE per tick, BEFORE the CAS loop. Deferring
  //           must not consume the slot: if the CAS advanced first, a deferred run would
  //           be a LOST run rather than a postponed one, and the next_run would have
  //           silently skipped forward. So the early return happens before any claim.
  //   cap   — worker-cap.mjs (Law 3). Checked and consumed PER ROW, also before the CAS,
  //           for the same reason. A capped row is skipped today and runs tomorrow.
  function tick({ now: t = now(), enqueue, emit, guard = null, cap = null } = {}) {
    const fired = [];
    if (typeof enqueue !== "function") return fired;

    // Guard is intentionally SYNCHRONOUS here: tick() is called from the runtime's one
    // periodic timer and its contract is a synchronous array return. The async probe is
    // sampled by the caller and handed in as a resolved verdict (server.mjs), so this
    // module stays free of I/O — the same discipline every other pure module here keeps.
    if (guard && guard.ok === false) {
      return [{ deferred: true, reason: guard.reason, detail: guard.detail || null }];
    }

    for (const row of due(t)) {
      // Law 3: a worker that has spent its daily budget is SKIPPED, not queued. Checked
      // before the CAS so the slot survives to the next eligible day.
      if (cap && typeof cap.allows === "function" && !cap.allows(row.id, t)) {
        fired.push({ id: row.id, skill: row.skill, agent: row.agent, capped: true, used: cap.used(row.id, t), cap: cap.cap });
        continue;
      }
      const slot = row.next_run;
      const next = nextRun(row.expr, row.hour, t); // strictly future — no catch-up storm
      const claimed = advanceCas.run({ id: row.id, slot, next_run: next, t }).changes;
      if (!claimed) continue; // another tick already fired this exact slot
      if (cap && typeof cap.consume === "function") cap.consume(row.id, t);
      const r = enqueue({ agent: row.agent, skill: row.skill, goal: goalFor(row) });
      const taskId = r && (r.firstTaskId || r.taskId) || null;
      if (r && r.error) {
        // The slot IS spent (CAS committed); surface the dispatch failure on the row so a
        // backlog-full boot does not silently drop the run, and skip the bus frame.
        db.prepare("UPDATE cadences SET last_status = 'error', updated_at = @t WHERE id = @id").run({ id: row.id, t });
        fired.push({ id: row.id, skill: row.skill, agent: row.agent, slot, next_run: next, error: r.error });
        continue;
      }
      safeEmit(emit, { id: row.id, skill: row.skill, agent: row.agent, status: "dispatched" });
      fired.push({ id: row.id, skill: row.skill, agent: row.agent, slot, next_run: next, taskId });
    }
    return fired;
  }

  // Manual dispatch. Bypasses the schedule (an ondemand row fires here and nowhere else)
  // but keeps the SAME emit and a per-manual-slot dedupe: last_fired_slot is stamped with
  // the manual instant, and a second runNow in the same ms changes 0 rows → deduped, so a
  // double-click never double-dispatches. next_run is left UNTOUCHED — a manual run does
  // not shift a scheduled cadence's clock.
  const runNowCas = db.prepare(
    `UPDATE cadences
        SET last_run = @t, last_status = 'dispatched', last_fired_slot = @t, updated_at = @t
      WHERE id = @id AND (last_fired_slot IS NULL OR last_fired_slot <> @t)`,
  );

  function runNow(id, { now: t = now(), enqueue, emit } = {}) {
    const row = getRow(id);
    if (!row) return { error: "not found", code: 404 };
    if (typeof enqueue !== "function") return { error: "no dispatcher", code: 500 };
    const claimed = runNowCas.run({ id: row.id, t }).changes;
    if (!claimed) return { ...hydrate(getRow(id)), deduped: true };
    const r = enqueue({ agent: row.agent, skill: row.skill, goal: goalFor({ ...row, venture: row.venture }) });
    if (r && r.error) {
      db.prepare("UPDATE cadences SET last_status = 'error', updated_at = @t WHERE id = @id").run({ id: row.id, t });
      return { error: r.error, code: 503 };
    }
    const taskId = r && (r.firstTaskId || r.taskId) || null;
    safeEmit(emit, { id: row.id, skill: row.skill, agent: row.agent, status: "dispatched" });
    return { taskId, id: row.id, skill: row.skill, agent: row.agent };
  }

  function setEnabled(id, enabled) {
    const row = getRow(id);
    if (!row) return { error: "not found", code: 404 };
    db.prepare("UPDATE cadences SET enabled = @e, updated_at = @t WHERE id = @id")
      .run({ e: enabled ? 1 : 0, t: now(), id: row.id });
    return hydrate(getRow(id));
  }

  return { nextRun, seed, list, get, due, tick, runNow, setEnabled };
}

// The bus is OBSERVATIONAL — a throwing or absent emitter must never break a schedule
// write that already committed (same posture as queue.mjs's guarded emit).
function safeEmit(emit, data) {
  if (typeof emit !== "function") return;
  try { emit("workflow.run", data); } catch { /* bus is observational */ }
}

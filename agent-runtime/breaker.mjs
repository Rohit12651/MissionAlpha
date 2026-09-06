// MUNDER-ADOPTION A2 — the RUNAWAY CIRCUIT BREAKER: a graduated response ladder.
//
// WHAT WAS ALREADY THERE (audited before writing a line — this is a COMPLEMENT, not a
// duplicate): anti-drift.mjs catches SILENCE (a queued/claimed task that never moves);
// engine.runStep's watchdog kills a hung SPAWN at 5 minutes; self-heal retries transient
// failures. None of them answers the opposite failure: an agent that is ACTIVELY doing the
// wrong thing — an error storm, tokens pouring out with nothing persisted, a turn that
// runs far past any honest length. That agent looks BUSY on every existing surface.
//
// THE LADDER (ported policy from munder-difflin breaker.ts, adapted to this runtime):
//   healthy → steering → constrained → stopped
//   • ONE level per beat, up or down — never jump to a kill. A single bad beat is
//     information; only a PATTERN climbs the ladder.
//   • De-escalate one level per healthy beat: recovery is automatic, not operator work.
//   • hardStop is OFF by default: the ladder CAPS at `constrained`. `stopped` exists only
//     when the operator opts in (RUNTIME_BREAKER_HARDSTOP=1) — same posture as munder's,
//     and the same reason: a wrong kill costs more than a wrong warning.
//   • VELOCITY IS A DIFF. Every rate is the delta of two consecutive CUMULATIVE samples
//     (Δtokens/beat, Δsteps/beat). A cumulative counter read once is never treated as an
//     increment — the exact bug this module's source repo warned about.
//
// TRIP CONDITIONS (any one trips the beat; multiple in one beat still climb ONE level):
//   errors   — ≥ errorStorm on-error events since the last beat
//   velocity — Δ output tokens ≥ velocityMax while Δ persisted steps == 0 (spend, no work)
//   wall     — an in-flight turn older than turnMs while Δ steps == 0 (busy, no progress)
//   Progress is exonerating: any Δsteps > 0 beat is healthy unless errors storm.
//
// ENFORCEMENT is the caller's, through two seams:
//   gate(agentId)  — engineHooks "pre-task" veto: constrained|stopped agents are refused
//                    NEW turns (an in-flight turn always settles; nothing is killed here).
//   mintFailure    — entering `constrained` mints ONE diff-less escalation Delivery per
//                    EPISODE (Law 3: through deliveries.mintFailure only — zero paths to
//                    apply — and gated by the SHARED worker-cap under CAP_ID 'breaker';
//                    without a cap seam it mints NOTHING, same law as anti-drift).
//
// STATE is in-memory by design: a breaker level is a statement about the CURRENT process;
// after a restart every agent is healthy until observed again. The escalation Delivery is
// the durable trace. emit('breaker.state') fires on level CHANGE only — a frame per beat
// for a stable level is noise that trains the operator to ignore the chip.

export const BREAKER_LEVELS = Object.freeze(["healthy", "steering", "constrained", "stopped"]);
const LEVEL_INDEX = new Map(BREAKER_LEVELS.map((l, i) => [i, l]).map(([i, l]) => [l, i]));

/** One budget id for every breaker escalation — the cap is on the CLASS (Law 3). */
export const CAP_ID = "breaker";

/** ≥ this many on-error events between beats = an error storm. */
export const DEFAULT_ERROR_STORM = 3;
/** Δ output tokens per beat with zero Δ steps = runaway generation. */
export const DEFAULT_VELOCITY_MAX = 20_000;
/** An in-flight turn older than this with zero Δ steps = busy-but-stuck. */
export const DEFAULT_TURN_MS = 10 * 60_000;

export function createBreaker(deps = {}) {
  const cap = deps.cap && typeof deps.cap.consume === "function" ? deps.cap : null;
  const mintFailure = typeof deps.mintFailure === "function" ? deps.mintFailure : null;
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const hardStop = deps.hardStop === true;
  const errorStorm = posInt(deps.errorStorm, DEFAULT_ERROR_STORM);
  const velocityMax = posInt(deps.velocityMax, DEFAULT_VELOCITY_MAX);
  const turnMs = posInt(deps.turnMs, DEFAULT_TURN_MS);

  // agentId → { level, reason, since, errors, last:{outputTokens,steps}|null,
  //             turnStartedAt|null, minted (this episode) }
  const agents = new Map();

  function posInt(v, d) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  }

  function entry(agentId) {
    let a = agents.get(agentId);
    if (!a) {
      a = { level: 0, reason: "", since: now(), errors: 0, last: null, turnStartedAt: null, minted: false };
      agents.set(agentId, a);
    }
    return a;
  }

  /** on-error hook feed. Counted between beats; the beat consumes and resets. */
  function recordError(agentId) {
    if (!agentId) return;
    entry(String(agentId)).errors += 1;
  }

  /** pre-task hook feed — a turn began. */
  function turnStarted(agentId) {
    if (!agentId) return;
    entry(String(agentId)).turnStartedAt = now();
  }

  /** session-end hook feed — the turn settled (any outcome). */
  function turnSettled(agentId) {
    if (!agentId) return;
    entry(String(agentId)).turnStartedAt = null;
  }

  /**
   * The beat. `samples` = [{ agentId, outputTokens, steps }] — BOTH CUMULATIVE counters
   * (day totals are fine: only deltas are read, and a day rollover reads as Δ<0 which is
   * clamped to no-signal rather than a negative rate). Returns the per-agent decisions.
   */
  function beat(samples = []) {
    const t = now();
    const decisions = [];
    for (const s of samples) {
      const agentId = String(s?.agentId || "");
      if (!agentId) continue;
      const a = entry(agentId);

      const outputTokens = num(s.outputTokens);
      const steps = num(s.steps);
      const dTokens = a.last ? Math.max(0, outputTokens - a.last.outputTokens) : 0;
      const dSteps = a.last ? Math.max(0, steps - a.last.steps) : 0;
      const hadBaseline = a.last !== null;
      a.last = { outputTokens, steps };

      const errors = a.errors;
      a.errors = 0;

      const trips = [];
      if (errors >= errorStorm) trips.push(`error-storm ${errors}/beat`);
      // Velocity/wall need a baseline: the FIRST sample of an agent can never trip them.
      if (hadBaseline && dSteps === 0) {
        if (dTokens >= velocityMax) trips.push(`velocity ${dTokens} tok/beat, 0 steps`);
        if (a.turnStartedAt !== null && t - a.turnStartedAt >= turnMs) {
          trips.push(`turn ${Math.round((t - a.turnStartedAt) / 60_000)}m, 0 steps`);
        }
      }

      const prev = a.level;
      if (trips.length) {
        const ceiling = hardStop ? 3 : 2; // stopped only under hardStop
        a.level = Math.min(ceiling, a.level + 1); // ONE level per beat, never jump
        a.reason = trips.join("; ");
      } else if (a.level > 0) {
        a.level -= 1; // ONE level per healthy beat — automatic recovery
        if (a.level === 0) { a.reason = ""; a.minted = false; } // episode over
      }

      if (a.level !== prev) {
        a.since = t;
        try { emit("breaker.state", { agentId, level: BREAKER_LEVELS[a.level], reason: a.reason.slice(0, 300) }); }
        catch { /* bus is observational */ }
        // Entering constrained = the escalation moment, ONCE per episode. Law 3: no cap
        // seam → no mint; a denied cap still leaves the level visible on the bus.
        if (a.level >= 2 && !a.minted && mintFailure && cap) {
          if (cap.consume(CAP_ID, t)) {
            a.minted = true;
            try {
              mintFailure({
                agentId, taskId: null, kind: "breaker-runaway", attempts: a.level,
                detail: `Breaker constrained ${agentId}: ${a.reason}. New turns are refused until it recovers (one level per healthy beat).`,
              });
            } catch (e) { log(`[breaker] escalation delivery skipped for ${agentId}: ${e?.message}`); }
          } else {
            a.minted = true; // the EPISODE consumed its chance — a capped day must not re-try every beat
            log(`[breaker] daily cap reached — escalation for ${agentId} not minted (level still visible on bus)`);
          }
        }
      }
      decisions.push({ agentId, level: BREAKER_LEVELS[a.level], changed: a.level !== prev, reason: a.reason });
    }
    return decisions;
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /** The pre-task gate. Blocked at constrained and above; steering only advises. */
  function gate(agentId) {
    const a = agents.get(String(agentId || ""));
    if (!a || a.level < 2) return { blocked: false, level: BREAKER_LEVELS[a?.level ?? 0] };
    return {
      blocked: true,
      level: BREAKER_LEVELS[a.level],
      reason: `breaker ${BREAKER_LEVELS[a.level]}: ${a.reason || "runaway pattern"} — recovers one level per healthy beat`,
    };
  }

  /** Read model for the status route / doctor. Worst level first. */
  function snapshot() {
    const rows = [...agents.entries()].map(([agentId, a]) => ({
      agentId, level: BREAKER_LEVELS[a.level], reason: a.reason, since: a.since,
    }));
    rows.sort((x, y) => LEVEL_INDEX.get(y.level) - LEVEL_INDEX.get(x.level));
    return rows;
  }

  /** Drop agents no longer on the roster so the map cannot grow unbounded. */
  function prune(liveIds) {
    const keep = new Set([...(liveIds || [])].map(String));
    for (const id of agents.keys()) if (!keep.has(id)) agents.delete(id);
  }

  return { recordError, turnStarted, turnSettled, beat, gate, snapshot, prune, CAP_ID };
}

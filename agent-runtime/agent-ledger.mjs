// PHASE 6 — the per-agent performance ledger.
//
// WHY IT EXISTS. `getScoreboard` measures dogfood THROUGHPUT (approved ÷ human-minutes).
// It cannot tell you which agent to trust, retune, or retire — and for an agent-ops
// product that is close to the whole point. Every decision is already a row in SQLite, so
// this is a pure read: no new writes, no schema change, no new event, no new column.
//
// THE HONESTY RULE IS THE FEATURE. An agent with fewer than 5 decisions has NO approval
// rate — `approvalRate` is null and `rated` is false, so the UI renders "insufficient
// data". "100% approved" off a single approval is a fabricated confidence signal, and it
// is the exact failure this program forbids. This mirrors the RiskChip / ADR-053
// `unrated` precedent: the label is a DISPLAY state; the underlying value is null, never
// a zero that a chart would happily plot.
//
// Three more places this refuses to invent a number:
//   * a pending delivery is not a judgement of the agent, so it is outside `decisions`;
//   * a `kind: 'failure'` row (ADR-051 §9, "agent is stuck") is counted as a FAILURE but
//     never as a code decision — dismissing one is not rejecting work;
//   * a `decidedAt` earlier than `createdAt` (clock skew across a restart is real) is
//     discarded rather than reported as a negative latency.

/** Below this many decisions there is no rate — only "insufficient data". */
export const MIN_DECISIONS_FOR_RATE = 5;

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MIN_WINDOW = HOUR;
const MAX_WINDOW = 90 * DAY;

/** Clamp an untrusted window to 1h..90d. Mirrors kpis.mjs / the scoreboard route. */
export function clampLedgerWindow(windowMs) {
  const n = Number(windowMs);
  if (!Number.isFinite(n)) return 7 * DAY;
  return Math.min(Math.max(Math.floor(n), MIN_WINDOW), MAX_WINDOW);
}

/** True median. Even counts average the two middle values — no silent floor(). */
function median(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per-agent aggregate over a time window.
 *
 * @param {{db: object, windowMs?: number, nowMs?: number}} args
 * @returns {{windowMs:number, since:string, agents:object[]}}
 */
export function agentLedger({ db, windowMs, nowMs = Date.now() } = {}) {
  if (!db) throw new Error("agentLedger: db handle required");
  const win = clampLedgerWindow(windowMs);
  const since = new Date(nowMs - win).toISOString();

  // ONE pass, parameterised, over an indexed column (idx_deliveries_created). The
  // aggregation is deliberately done in SQL for the counts and in JS for the median —
  // SQLite has no median, and faking one with an OFFSET trick is less readable and no
  // faster at this row count.
  const rows = db.prepare(
    `SELECT agentId, kind, status, createdAt, decidedAt
       FROM deliveries
      WHERE createdAt >= ?
      ORDER BY agentId`,
  ).all(since);

  /** @type {Map<string, any>} */
  const byAgent = new Map();
  const latencies = new Map();

  for (const r of rows) {
    const id = String(r.agentId || "");
    if (!id) continue; // a row with no agent cannot be attributed, so it is not attributed
    if (!byAgent.has(id)) {
      byAgent.set(id, {
        agentId: id,
        delivered: 0,
        approved: 0,
        autoApproved: 0,
        rejected: 0,
        changesRequested: 0,
        expired: 0,
        pending: 0,
        failures: 0,
        decisions: 0,
        approvalRate: null,
        rated: false,
        medianDecisionMs: null,
      });
      latencies.set(id, []);
    }
    const a = byAgent.get(id);
    a.delivered += 1;

    const isFailure = r.kind === "failure";
    if (isFailure) a.failures += 1;

    switch (r.status) {
      case "approved": a.approved += 1; break;
      case "auto_approved": a.autoApproved += 1; break;
      case "rejected": a.rejected += 1; break;
      case "changes_requested": a.changesRequested += 1; break;
      case "expired": a.expired += 1; break;
      case "pending": a.pending += 1; break;
      default: break; // an unknown status is counted in `delivered` and nowhere else
    }

    // `decisions` is the denominator of the rate: terminal, and about the agent's WORK.
    // A failure row is a terminal status too, but dismissing "agent is stuck" says
    // nothing about the quality of a diff, so it stays out.
    const isRealDecision = !isFailure && r.status !== "pending" && r.status !== "expired";
    if (isRealDecision) a.decisions += 1;

    // THE SAME PREDICATE GATES THE LATENCY, and it did not before — a real defect found
    // in review. `decidedAt` is not exclusively a human timestamp: deliveries.mjs stamps
    // it with decidedBy 'system' when a pending row is force-expired (the SLA sweep, or
    // superseded by a failure), and a dismissed "agent is stuck" row carries one too.
    // Feeding those into the median reported a WRONG number — an agent whose reviews
    // really took minutes could show a median wait of a day, sitting right next to an
    // honest "insufficient data" rate. An absent number is fine here; a false one is not.
    if (isRealDecision && r.decidedAt) {
      const t0 = Date.parse(r.createdAt);
      const t1 = Date.parse(r.decidedAt);
      // A negative or unparseable latency is not a measurement — discard it rather than
      // letting clock skew across a restart show up as a negative median.
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) latencies.get(id).push(t1 - t0);
    }
  }

  const agents = [...byAgent.values()].map((a) => {
    const landed = a.approved + a.autoApproved;
    return {
      ...a,
      // null, not 0 — a chart plots a 0 and a human reads it as "never approved".
      approvalRate: a.decisions >= MIN_DECISIONS_FOR_RATE ? landed / a.decisions : null,
      rated: a.decisions >= MIN_DECISIONS_FOR_RATE,
      medianDecisionMs: median(latencies.get(a.agentId).slice().sort((x, y) => x - y)),
    };
  });

  // Volume first (the busiest agent is the one worth looking at), then name so the table
  // does not reshuffle between reads at equal volume.
  agents.sort((x, y) => (y.delivered - x.delivered) || (x.agentId < y.agentId ? -1 : x.agentId > y.agentId ? 1 : 0));

  return { windowMs: win, since, minDecisionsForRate: MIN_DECISIONS_FOR_RATE, agents };
}

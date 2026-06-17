// A3 — Time Scrubber / Mini-Replay. Pure reconstruction logic, no React, no side
// effects. Rebuilds the swarm board "as it was" at any past moment purely from
// the client data we already hold (state.json's heartbeats[] time series). No
// backend and no emitter change required for v1.
//
// HONEST FIDELITY LIMITATION (CEO's "small emitter change", §5 of the memo):
//   heartbeats[] carries only {ts, agent, state}. So replay reconstructs the
//   *column / lifecycle state* of each agent frame-accurately (that IS a real
//   time series), but task / file / blockedBy / ttl have no per-tick history —
//   we carry the CURRENT frame's values as an approximation. A future emitter
//   that snapshots those fields per tick (or retains N full snapshots) would
//   make replay fully frame-accurate. Until then the UI shows a REPLAY badge +
//   a disclaimer so the operator never mistakes the past for the present.

import type { AgentState, FeedEvent, Heartbeat } from "../data/types";
import { stateToColumn, isDeadState } from "./agentMeta";

// Mirrors emit_state.py: an agent goes stale when its last heartbeat is ≥120s
// old (relative to "now", here the scrub time) and it is not in a dead state.
const STALE_AGE_SEC = 120;

// Sentinel/junk rows: the live heartbeats array contains a "#" header row
// (agent "Waahyu", ts "#"). Same NaN guard as blockedChain / formatRelative.
function parseTs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Reconstruct every agent's state as it was at `timeMs`.
 *
 * For each agent we find its latest heartbeat with ts ≤ timeMs and derive
 * {state, column, stale, dead, heartbeatAt, ageSec} from it. Static-ish fields
 * (role, tier, id, task, file, blockedBy, ttlSec, pipelineStage, inbox) are
 * carried from the CURRENT frame as an approximation (see limitation above).
 *
 * If an agent has no heartbeat ≤ timeMs it is "pre-history": it had not checked
 * in yet at that moment, so we render it dimmed/offline with state "—".
 */
export function reconstructAt(
  timeMs: number,
  agents: AgentState[],
  heartbeats: Heartbeat[],
): AgentState[] {
  // Latest heartbeat per agent at or before timeMs (single pass).
  const latest = new Map<string, { ts: number; state: string }>();
  for (const h of heartbeats) {
    const t = parseTs(h.ts);
    if (t === null || t > timeMs) continue;
    const cur = latest.get(h.agent);
    if (!cur || t >= cur.ts) latest.set(h.agent, { ts: t, state: h.state });
  }

  return agents.map((a) => {
    const hb = latest.get(a.id);

    if (!hb) {
      // Pre-history: this agent had not emitted a heartbeat yet at timeMs.
      return {
        ...a,
        state: "—",
        column: "offline",
        heartbeatAt: null,
        ageSec: null,
        stale: false,
        dead: true,
      };
    }

    const dead = isDeadState(hb.state);
    const ageSec = Math.max(0, Math.floor((timeMs - hb.ts) / 1000));
    const stale = !dead && ageSec >= STALE_AGE_SEC;

    return {
      ...a, // carry current-frame task/file/blockedBy/ttl/role/tier/inbox (approx)
      state: hb.state,
      column: stateToColumn(hb.state),
      heartbeatAt: new Date(hb.ts).toISOString().replace(/\.\d{3}Z$/, "Z"),
      ageSec,
      stale,
      dead,
    };
  });
}

// ── Timeline annotations ────────────────────────────────────────────────────

export type MarkerKind = "tick" | "stall" | "await" | "strategy";

export interface Marker {
  ts: string;
  timeMs: number;
  kind: MarkerKind;
  label: string;
}

// Cap so a long-running swarm doesn't flood the bar with notches.
const MARKER_CAP = 60;

/**
 * Notable events to annotate the scrubber bar:
 *  - tick     scheduler online / scheduler heartbeats
 *  - stall    feed TOPIC starting "stall" / "pipeline-frozen", or STALE* heartbeat
 *  - await    AWAITING_USER_DECISION heartbeats / "ceo-online-pending" feed
 *  - strategy strategy-approved / STRATEGY_APPROVED_BY_USER moments
 * Deduped by (timeMs,kind) and capped to the most recent MARKER_CAP.
 */
export function timelineMarkers(
  heartbeats: Heartbeat[],
  feed: FeedEvent[],
): Marker[] {
  const out: Marker[] = [];
  const seen = new Set<string>();

  const push = (ts: string, timeMs: number, kind: MarkerKind, label: string) => {
    const key = `${timeMs}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ts, timeMs, kind, label });
  };

  for (const h of heartbeats) {
    const t = parseTs(h.ts);
    if (t === null) continue;
    const s = h.state.toUpperCase();
    if (h.agent === "scheduler" || s === "TICK") {
      push(h.ts, t, "tick", `scheduler · ${h.state}`);
    } else if (s.startsWith("STALE")) {
      push(h.ts, t, "stall", `${h.agent} went stale`);
    } else if (s === "AWAITING_USER_DECISION") {
      push(h.ts, t, "await", `${h.agent} awaiting your decision`);
    } else if (s === "STRATEGY_APPROVED_BY_USER") {
      push(h.ts, t, "strategy", `${h.agent} strategy approved`);
    }
  }

  for (const e of feed) {
    const t = parseTs(e.ts);
    if (t === null) continue;
    const topic = e.topic.toLowerCase();
    if (topic.startsWith("stall") || topic === "pipeline-frozen") {
      push(e.ts, t, "stall", `${e.from}: ${e.topic}`);
    } else if (topic === "scheduler-online") {
      push(e.ts, t, "tick", "scheduler online");
    } else if (topic.includes("pending") || topic === "awaiting-user") {
      push(e.ts, t, "await", `${e.from}: ${e.topic}`);
    } else if (topic.startsWith("strategy-approved")) {
      push(e.ts, t, "strategy", `${e.from}: ${e.topic}`);
    }
  }

  out.sort((a, b) => a.timeMs - b.timeMs);
  return out.length > MARKER_CAP ? out.slice(out.length - MARKER_CAP) : out;
}

// ── Timeline bounds ─────────────────────────────────────────────────────────

export interface TimeBounds {
  startMs: number;
  endMs: number;
}

/**
 * Earliest valid event timestamp → now. Scans heartbeats + feed, ignoring the
 * "#"/unparseable sentinel rows. endMs is `nowMs` (defaults to Date.now()) so
 * the bar always extends to the live edge; the playhead snaps there for LIVE.
 * Falls back to a 1-minute window ending at now if no valid timestamps exist.
 */
export function timeBounds(
  heartbeats: Heartbeat[],
  feed: FeedEvent[],
  nowMs: number = Date.now(),
): TimeBounds {
  let startMs = Infinity;
  for (const h of heartbeats) {
    const t = parseTs(h.ts);
    if (t !== null && t < startMs) startMs = t;
  }
  for (const e of feed) {
    const t = parseTs(e.ts);
    if (t !== null && t < startMs) startMs = t;
  }
  if (!Number.isFinite(startMs) || startMs >= nowMs) {
    return { startMs: nowMs - 60_000, endMs: nowMs };
  }
  return { startMs, endMs: nowMs };
}

/** Recompute swarm counts from a reconstructed agent set (REPLAY view). */
export function countsFrom(agents: AgentState[]): {
  total: number;
  active: number;
  inProgress: number;
  blocked: number;
  stale: number;
  offline: number;
} {
  return {
    total: agents.length,
    active: agents.filter((a) => !a.dead).length,
    inProgress: agents.filter((a) => a.column === "in_progress").length,
    blocked: agents.filter((a) => a.column === "blocked").length,
    stale: agents.filter((a) => a.stale).length,
    offline: agents.filter((a) => a.dead).length,
  };
}

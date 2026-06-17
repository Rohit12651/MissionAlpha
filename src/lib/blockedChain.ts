// A2 — "Why Stuck" pure logic. No React, no side effects. Resolves the transitive
// blockedBy chain (A→B→C…) so the drawer can show the operator the *root cause*
// to fix, not just the proximate blocker. Cycle-safe (visited set guards the
// circular-block case the swarm can produce).

import type { AgentState, FeedEvent, Heartbeat } from "../data/types";

export interface BlockedChain {
  /** The chain starting at the queried agent, each hop the blocker of the prior.
   *  chain[0] is the queried agent; chain[last] is the terminal node. */
  chain: AgentState[];
  /** True if a blockedBy cycle was detected (chain stops at first repeat). */
  cycle: boolean;
  /** Terminal agent — the actual root cause to fix. null if the agent isn't blocked. */
  root: AgentState | null;
}

/**
 * Follow `blockedBy` transitively from `agentId`, resolving each blocker by id.
 * - Unblocked agent → chain=[agent], root=null.
 * - Cycle (A→B→A) → cycle=true, chain stops before re-visiting, root=terminal.
 * - Dangling blockedBy (blocker id not in agents) → chain ends at last resolvable
 *   node; root is that node (the deepest thing we can actually point at).
 */
export function buildBlockedChain(
  agentId: string,
  agents: AgentState[],
): BlockedChain {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const start = byId.get(agentId);
  if (!start) return { chain: [], cycle: false, root: null };

  const chain: AgentState[] = [start];
  const visited = new Set<string>([start.id]);
  let cursor: AgentState = start;
  let cycle = false;

  while (cursor.blockedBy) {
    const nextId = cursor.blockedBy;
    if (visited.has(nextId)) {
      cycle = true;
      break;
    }
    const next = byId.get(nextId);
    if (!next) break; // dangling blocker id — stop at the last resolvable node
    chain.push(next);
    visited.add(next.id);
    cursor = next;
  }

  // root = the actual cause to fix: terminal of the chain when the agent is blocked.
  const root = start.blockedBy ? chain[chain.length - 1] : null;
  return { chain, cycle, root };
}

export interface LastEvents {
  lastSync?: FeedEvent;
  lastHeartbeat?: Heartbeat;
}

/**
 * Most recent feed event involving `agentId` (as FROM or TO) and its most recent
 * heartbeat. Used to surface the proximate cause for a stale/blocked agent
 * without grepping the bus. Skips unparseable timestamps (junk "#" sentinel rows).
 */
export function lastEventFor(
  agentId: string,
  feed: FeedEvent[],
  heartbeats: Heartbeat[],
): LastEvents {
  let lastSync: FeedEvent | undefined;
  let lastSyncT = -Infinity;
  for (const e of feed) {
    if (e.from !== agentId && e.to !== agentId) continue;
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    if (t >= lastSyncT) {
      lastSyncT = t;
      lastSync = e;
    }
  }

  let lastHeartbeat: Heartbeat | undefined;
  let lastHbT = -Infinity;
  for (const h of heartbeats) {
    if (h.agent !== agentId) continue;
    const t = Date.parse(h.ts);
    if (Number.isNaN(t)) continue;
    if (t >= lastHbT) {
      lastHbT = t;
      lastHeartbeat = h;
    }
  }

  return { lastSync, lastHeartbeat };
}

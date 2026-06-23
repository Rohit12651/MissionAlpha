// Pure, React-free helpers for the SwarmHero graph (unit-tested in __tests__/swarmGraph.test.ts).
// No DOM, no canvas, no React — just data → visual contract.
import type { AgentState, FeedEvent } from "../data/types";

/** Visual modifiers a canvas applies to one agent node, derived from live status. */
export interface StatusStyle {
  /** overall opacity multiplier for the node fill + glow (1 = full). */
  alpha: number;
  /** shadowBlur multiplier vs the node's base glow (1 = normal). */
  glow: number;
  /** radius pulse amplitude (0 = calm, larger = more "alive"). */
  pulse: number;
  /** ring stroke color, or null for none. Blocked agents get "#e24b4a". */
  ring: string | null;
  /** stale agents render desaturated (canvas blends fill toward muted gray). */
  desaturate: boolean;
}

const BLOCKED_RING = "#e24b4a";

/**
 * Map an agent's live status to its node appearance. Pure: same input → same output.
 * Precedence: column sets the base; `blocked` owns the red ring; `stale` dims + desaturates on top.
 */
export function statusStyle(
  agent: Pick<AgentState, "column" | "stale" | "heartbeatAt">,
): StatusStyle {
  const blocked = agent.column === "blocked";
  let alpha: number;
  let glow: number;
  let pulse: number;

  switch (agent.column) {
    case "in_progress":
      alpha = 1; glow = 1.4; pulse = 0.18; break;
    case "blocked":
      alpha = 1; glow = 1.2; pulse = 0.10; break;
    case "idle":
      if (agent.heartbeatAt) { alpha = 0.7; glow = 0.9; pulse = 0.04; }
      else { alpha = 0.3; glow = 0.4; pulse = 0; }
      break;
    case "review":
    case "done":
      alpha = 0.85; glow = 1.0; pulse = 0.05; break;
    default: // awaiting_user, offline, any future column
      alpha = 0.7; glow = 0.85; pulse = 0.04; break;
  }

  let desaturate = false;
  if (agent.stale) {
    alpha *= 0.5;
    glow *= 0.6;
    pulse = 0;
    desaturate = true;
  }

  return { alpha, glow, pulse, ring: blocked ? BLOCKED_RING : null, desaturate };
}

/** One packet to spawn along the from→to edge, carrying its message topic (for the P1-2 label). */
export interface PacketSpawn {
  from: string;
  to: string;
  topic: string;
}

/**
 * Compute which packets to spawn from the live feed since `prevTs`. Pure.
 * - First call (`prevTs === null`) establishes a baseline: spawns NOTHING (don't replay history as
 *   a burst on open) and returns the newest ts as `lastTs`.
 * - Subsequent calls spawn one packet per event strictly newer than `prevTs` whose `from` AND `to`
 *   are rendered nodes (`hasNode`). Events touching a non-node are skipped (no packet, no crash).
 * - `lastTs` advances to the newest event ts so the same feed re-fed spawns no duplicates.
 *
 * Ordering uses lexicographic string comparison, which is correct for UTC `Z`-terminated ISO 8601
 * timestamps (the shape emit_state.py produces). Do not feed mixed timezone offsets.
 */
export function packetsFromFeed(
  prevTs: string | null,
  feed: readonly FeedEvent[],
  hasNode: (id: string) => boolean,
): { packets: PacketSpawn[]; lastTs: string | null } {
  if (feed.length === 0) return { packets: [], lastTs: prevTs };

  let newest = prevTs;
  for (const e of feed) if (newest === null || e.ts > newest) newest = e.ts;

  if (prevTs === null) return { packets: [], lastTs: newest };

  const packets: PacketSpawn[] = [];
  for (const e of feed) {
    if (e.ts > prevTs && hasNode(e.from) && hasNode(e.to)) {
      packets.push({ from: e.from, to: e.to, topic: e.topic });
    }
  }
  return { packets, lastTs: newest };
}

/** Minimal node shape the hit-test needs (canvas-space center + radius + optional agent id). */
export interface HitNode {
  x: number;
  y: number;
  r: number;
  agentId?: string;
}

/**
 * Resolve the agent node under a cursor point. Pure.
 * The canvas draws nodes under `ctx.translate(ox, oy)`, so a node at (x,y) appears on screen at
 * (x+ox, y+oy). To hit-test we map the cursor back into node space by subtracting (ox, oy), then
 * pick the NEAREST agent node (has `agentId`) whose center is within its radius. Artifact nodes
 * (no `agentId`) are never returned. Returns the agent id, or null if none.
 *
 * `pad` widens the hit circle by N px so a near-miss on a small, drifting node still registers —
 * critical for clicking (the graph roams under the cursor between aim and click). The hover path
 * uses a small pad; the click path uses a larger one. A minimum effective radius keeps tiny
 * satellite-sized agent nodes clickable.
 */
export function hitTest(
  nodes: readonly HitNode[],
  px: number,
  py: number,
  ox: number,
  oy: number,
  pad = 0,
): string | null {
  const cx = px - ox;
  const cy = py - oy;
  let bestId: string | null = null;
  let bestD2 = Infinity;
  for (const n of nodes) {
    if (!n.agentId) continue;
    const reach = Math.max(n.r, 12) + pad; // floor of 12px so small nodes stay clickable
    const dx = cx - n.x;
    const dy = cy - n.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= reach * reach && d2 < bestD2) {
      bestD2 = d2;
      bestId = n.agentId;
    }
  }
  return bestId;
}

/**
 * The most recent feed events that touch an agent (`from === id || to === id`), newest first,
 * capped at `limit`. Pure. Assumes `feed` is in chronological (oldest-first) order, as the live
 * state serves it — so we walk from the end.
 */
export function recentComms(feed: readonly FeedEvent[], id: string, limit = 14): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (let i = feed.length - 1; i >= 0 && out.length < limit; i--) {
    const e = feed[i];
    if (e.from === id || e.to === id) out.push(e);
  }
  return out;
}

/** Input row for label selection: a packet's topic + its current distance to the cursor (px). */
export interface PacketLabelInput { topic: string; dist: number; }
/** A chosen label: which input `index` it maps to, the truncated text, and emphasis flag. */
export interface PacketLabel { index: number; label: string; emphasized: boolean; }

/**
 * Pick which in-flight packets get a topic label. Pure.
 * Drops empty topics, ranks by nearest-to-cursor, caps at `max` (readability + 60fps), truncates
 * each topic to <=16 chars (15 + ellipsis), and flags packets within `nearPx` as emphasized.
 */
export function selectPacketLabels(
  items: readonly PacketLabelInput[],
  max = 6,
  nearPx = 60,
): PacketLabel[] {
  return items
    .map((it, index) => ({ index, topic: it.topic, dist: it.dist }))
    .filter((it) => it.topic.length > 0)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max)
    .map((it) => ({
      index: it.index,
      label: it.topic.length > 16 ? it.topic.slice(0, 15) + "…" : it.topic,
      emphasized: it.dist <= nearPx,
    }));
}

/**
 * Opacity multiplier for a node/edge/packet of the given `kind` under a tier-focus set. Pure.
 * Empty focus → everything full (1). Otherwise focused kinds stay full; all others (incl. artifact
 * kinds) dim to `dimmed`.
 */
export function focusDim(kind: string, focus: ReadonlySet<string>, dimmed = 0.12): number {
  if (focus.size === 0) return 1;
  return focus.has(kind) ? 1 : dimmed;
}

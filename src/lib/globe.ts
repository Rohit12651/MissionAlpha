// Pure math + visual-intent mapping for the PulseGlobe. THREE.Color cannot parse
// oklch(), so we keep a small hex palette here whose hues MIRROR the OKLCH tokens
// in index.css (cyan active, amber blocked, red stale, green done, gold ceo,
// muted offline). This is the ONE place 3D colors live — views still use tokens.

import type { AgentState, FeedEvent } from "../data/types";

export type GlobeIntent =
  | "active"
  | "blocked"
  | "stale"
  | "done"
  | "ceo"
  | "idle"
  | "offline";

// Hex twins of the dark-theme OKLCH tokens (bright variant for emissive glow).
export const NODE_HEX: Record<GlobeIntent, string> = {
  active: "#38e6f5", // accent-cyan
  blocked: "#f5b23a", // blocked-amber
  stale: "#f5483a", // stale-red
  done: "#3ce58a", // done-green
  ceo: "#f5d23a", // ceo-gold
  idle: "#9aa3b2", // muted
  offline: "#5b6472", // dim muted
};

/** Map a live agent to its globe visual intent (stale/dead override). */
export function agentIntent(agent: AgentState): GlobeIntent {
  if (agent.id === "ceo") return "ceo";
  if (agent.dead) return "offline";
  if (agent.stale) return "stale";
  switch (agent.column) {
    case "in_progress":
      return "active";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "offline":
      return "offline";
    default:
      return "idle";
  }
}

/** Relative node radius by activity. Active largest, offline smallest. */
export function nodeScale(intent: GlobeIntent): number {
  switch (intent) {
    case "ceo":
      return 1.5;
    case "active":
      return 1.25;
    case "blocked":
    case "stale":
      return 1.0;
    case "done":
    case "idle":
      return 0.85;
    case "offline":
      return 0.6;
  }
}

/** Emissive brightness multiplier by activity (feeds bloom). */
export function nodeBrightness(intent: GlobeIntent): number {
  switch (intent) {
    case "ceo":
      return 2.4;
    case "active":
      return 2.2;
    case "stale":
      return 1.8;
    case "blocked":
      return 1.6;
    case "done":
      return 1.4;
    case "idle":
      return 0.9;
    case "offline":
      return 0.4;
  }
}

export interface SpherePoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Fibonacci-sphere distribution for N points on a unit sphere of given radius.
 * Even, organic spacing — no clustering at the poles. CEO is pinned near
 * center-top afterward by the caller.
 */
export function fibonacciSphere(n: number, radius: number): SpherePoint[] {
  const points: SpherePoint[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5)); // ~2.399963 rad
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2; // 1 → -1
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    points.push({
      x: Math.cos(theta) * r * radius,
      y: y * radius,
      z: Math.sin(theta) * r * radius,
    });
  }
  return points;
}

/** Squared distance — cheap nearest-neighbor metric for constellation edges. */
function dist2(a: SpherePoint, b: SpherePoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export interface Edge {
  a: number;
  b: number;
}

/**
 * Build a sparse constellation: connect each node to its `k` nearest neighbors,
 * de-duplicated. Keeps the line count low (GPU-cheap) and looks intentional.
 */
export function constellationEdges(points: SpherePoint[], k = 2): Edge[] {
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (let i = 0; i < points.length; i++) {
    const order = points
      .map((p, j) => ({ j, d: dist2(points[i], p) }))
      .filter((o) => o.j !== i)
      .sort((u, v) => u.d - v.d)
      .slice(0, k);
    for (const { j } of order) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a: Math.min(i, j), b: Math.max(i, j) });
    }
  }
  return edges;
}

/**
 * Recent talk events (feed from→to within `windowSec`). Used to light the edge
 * between those two agents + run a traveling pulse along it.
 */
export function recentTalks(
  feed: FeedEvent[],
  nowMs: number,
  windowSec = 15,
): Array<{ from: string; to: string; ageSec: number }> {
  const out: Array<{ from: string; to: string; ageSec: number }> = [];
  for (const ev of feed) {
    const t = Date.parse(ev.ts);
    if (Number.isNaN(t)) continue;
    const ageSec = (nowMs - t) / 1000;
    if (ageSec >= 0 && ageSec <= windowSec && ev.from !== "system" && ev.to !== "ALL") {
      out.push({ from: ev.from, to: ev.to, ageSec });
    }
  }
  return out;
}

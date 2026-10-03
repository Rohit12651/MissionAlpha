// Phase G (G11, ADR G-2) — the live-ops dock's renderer: the approved mockup's `draw(canvas,
// true)` ported as-is (docs/mockups/missionalpha-sketchbook.html, "swarm + live-ops dock").
// Captain at the centre, the tech lead just above, every other station on a ring per tier,
// dashed brand-ink spokes, tier-coloured nodes, a breathing sage ring on stations on watch,
// and an orange packet for each live event. Colours are read from the theme tokens on every
// frame, so the dock follows the cream / dark switch with no extra wiring.
//
// D-7: nodes are the REAL roster (state.agents), "on watch" is stationBadge(), and a packet
// is a real activity row arriving — nothing here is simulated.

import { useEffect, useRef } from "react";
import type { AgentState, AgentTier } from "../../data/types";
import { stationBadge } from "../../lib/stationMeta";

type Ring = "captain" | "principal" | "senior" | "worker";
const RING: Record<AgentTier, Ring> = { supreme: "captain", principal: "principal", senior: "senior", support: "worker" };
const TIER_VAR: Record<Ring, string> = {
  captain: "--color-honey-gold", principal: "--color-sky-blue", senior: "--color-mint-sage", worker: "--color-warm-sand",
};
const RINGS: readonly [Ring, number][] = [["principal", 0.4], ["senior", 0.72], ["worker", 1]];
const PACKET_MS = 1100;
const MAX_PACKETS = 30;

interface Node { id: string; ring: Ring; on: boolean; x: number; y: number }
interface Packet { to: string; t0: number }

export interface DockSwarmProps {
  agents: readonly AgentState[];
  /** The newest activity row; a new seq sends one packet to its agent. */
  lastEvent: { seq: number; agentId: string | null } | null;
}

const tok = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/** The mockup's `layout(w, h, mini=true)`. */
function layout(agents: readonly AgentState[], w: number, h: number): Node[] {
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 14;
  const on = (a: AgentState) => stationBadge(a) === "on";
  const nodes: Node[] = [];
  const cap = agents.find((a) => RING[a.tier] === "captain");
  if (cap) nodes.push({ id: cap.id, ring: "captain", on: on(cap), x: cx, y: cy });
  const lead = agents.find((a) => a.id === "tech-lead");
  if (lead) nodes.push({ id: lead.id, ring: RING[lead.tier], on: on(lead), x: cx, y: cy - R * 0.22 });
  for (const [ring, f] of RINGS) {
    const members = agents.filter((a) => RING[a.tier] === ring && a.id !== "tech-lead");
    members.forEach((a, i) => {
      const ang = (i / members.length) * Math.PI * 2 + Math.PI / 2 + f * 0.6;
      nodes.push({ id: a.id, ring, on: on(a), x: cx + Math.cos(ang) * R * f, y: cy + Math.sin(ang) * R * f * 0.8 });
    });
  }
  return nodes;
}

function draw(canvas: HTMLCanvasElement, agents: readonly AgentState[], packets: Packet[], now: number, still: boolean): void {
  const dpr = Math.min(2, devicePixelRatio || 1), w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const c = canvas.getContext("2d");
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const nodes = layout(agents, w, h);
  const hub = nodes.find((n) => n.id === "tech-lead") ?? nodes[0];
  const cap = nodes.find((n) => n.ring === "captain");
  if (!hub) return;
  const ink = tok("--brand");
  c.lineWidth = 1; c.strokeStyle = ink; c.globalAlpha = 0.28; c.setLineDash([3, 4]);
  c.beginPath();
  if (cap && cap !== hub) { c.moveTo(cap.x, cap.y); c.lineTo(hub.x, hub.y); }
  for (const n of nodes) if (n !== hub && n !== cap) { c.moveTo(hub.x, hub.y); c.lineTo(n.x, n.y); }
  c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
  c.fillStyle = tok("--color-burnt-orange");
  for (const p of packets) {
    const b = nodes.find((n) => n.id === p.to);
    if (!b) continue;
    const k = (now - p.t0) / PACKET_MS, e = 1 - Math.pow(1 - k, 3);
    c.beginPath(); c.arc(hub.x + (b.x - hub.x) * e, hub.y + (b.y - hub.y) * e, 2.5, 0, 7); c.fill();
  }
  for (const n of nodes) {
    const r = n.ring === "captain" ? 9 : 5;
    c.fillStyle = tok(TIER_VAR[n.ring]); c.strokeStyle = ink; c.lineWidth = 1.2;
    c.beginPath(); c.arc(n.x, n.y, r, 0, 7); c.fill(); c.stroke();
    if (n.on) {
      c.strokeStyle = tok("--color-mint-sage"); c.lineWidth = 1.5;
      c.beginPath(); c.arc(n.x, n.y, r + 4 + (still ? 0 : Math.sin(now / 500) * 1.5), 0, 7); c.stroke();
    }
  }
}

export function DockSwarm({ agents, lastEvent }: DockSwarmProps) {
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const packets = useRef<Packet[]>([]);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const seenSeq = useRef<number | null>(null);

  useEffect(() => {
    if (!lastEvent?.agentId || lastEvent.seq === seenSeq.current) return;
    seenSeq.current = lastEvent.seq;
    packets.current = [...packets.current, { to: lastEvent.agentId, t0: performance.now() }].slice(-MAX_PACKETS);
  }, [lastEvent]);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    const frame = () => {
      const now = performance.now();
      packets.current = packets.current.filter((p) => now - p.t0 < PACKET_MS);
      draw(cv, agentsRef.current, packets.current, now, reduce.matches);
      raf = !reduce.matches && !document.hidden ? requestAnimationFrame(frame) : 0;
    };
    const restart = () => { cancelAnimationFrame(raf); frame(); };
    frame();
    // Theme, resize, visibility and the motion preference all change what a frame looks like.
    const obs = new MutationObserver(restart);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const ro = new ResizeObserver(restart);
    ro.observe(cv);
    document.addEventListener("visibilitychange", restart);
    reduce.addEventListener("change", restart);
    return () => {
      cancelAnimationFrame(raf); obs.disconnect(); ro.disconnect();
      document.removeEventListener("visibilitychange", restart);
      reduce.removeEventListener("change", restart);
    };
  }, []);

  // Reduced motion: no loop, so a roster change must redraw explicitly.
  useEffect(() => {
    const cv = cvRef.current;
    if (cv && matchMedia("(prefers-reduced-motion: reduce)").matches) draw(cv, agents, [], performance.now(), true);
  }, [agents]);

  return (
    <>
      <canvas ref={cvRef} aria-hidden="true" />
      <p className="sr-only">Live agent swarm preview. Use the expand button for the full view; detailed agent data is in the roster and board.</p>
    </>
  );
}

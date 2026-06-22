import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { AgentState, FeedEvent } from "../../data/types";

/*
  SwarmHero (publicity) — a live force-directed knowledge graph of the swarm.
  Agent nodes (sized by tier, CEO is the gold hub) + artifact nodes derived from
  each agent's task/file and the comms feed (refs). Edges = agent→CEO, agent→its
  artifact, feed from→to comms, and blockedBy. Nodes repel, links pull, gravity is
  weak so the graph SPREADS across the whole screen and gently roams (never a
  static loop). Bloom via shadowBlur. Palette: violet / cyan / gold / muted — no pink.

  Self-contained + reusable: pass any agents+feed (live state OR the saved
  docs/demo snapshot) and mount anywhere. Canvas needs concrete colors but tokens
  are CSS vars (tok()→var(--c-…)), so they're resolved via getComputedStyle.
  Honors prefers-reduced-motion (settles to a static frame, no rAF loop).
*/

const MAX_ARTIFACTS = 30;

type Kind = "ceo" | "principal" | "senior" | "support" | "file" | "doc" | "cfg" | "ref";

function tierKind(t: AgentState["tier"]): Kind {
  return t === "supreme" ? "ceo" : t === "principal" ? "principal" : t === "senior" ? "senior" : "support";
}
function artifactKind(label: string): Kind {
  if (/\.(tsx?|jsx?|mjs|cjs|json|css|html|ya?ml|md|sh)$|\//.test(label)) return "file";
  if (/adr|prompt|stage|plan|spec|memo|design|review|audit/i.test(label)) return "doc";
  if (/cache|config|auth|token|model|key|env|registry/i.test(label)) return "cfg";
  return "ref";
}

export function SwarmHero({
  open,
  agents,
  feed = [],
  onClose,
}: {
  open: boolean;
  agents: AgentState[];
  feed?: readonly FeedEvent[];
  onClose: () => void;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const cv = cvRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    // Fixed dark publicity palette (NO pink) — the hero is always dark so the
    // bloom reads regardless of the app theme. Bright hues glow on near-black.
    const BG = "#0a0b14";
    const KCOL: Record<Kind, string> = {
      ceo: "#f5b234",        // gold hub
      principal: "#8b6cf6",  // violet
      senior: "#22d3ee",     // cyan
      support: "#8a8f9c",    // muted
      file: "#22d3ee",
      doc: "#8b6cf6",
      cfg: "#f5b234",
      ref: "#7f8696",
    };
    const linkCol = "#8b6cf6";
    const labelCol = "rgba(210,214,228,0.82)";
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);

    let W = cv.clientWidth || 1;
    let H = cv.clientHeight || 1;
    const size = () => {
      W = cv.clientWidth || 1; H = cv.clientHeight || 1;
      cv.width = W * DPR; cv.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    size();
    const ro = new ResizeObserver(size); ro.observe(cv);

    let s = 20260621;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

    type N = { id: string; kind: Kind; r: number; col: string; x: number; y: number; vx: number; vy: number };
    const nodes: N[] = [];
    const byKey = new Map<string, number>(); // label → node index
    const add = (id: string, kind: Kind, r: number): number => {
      const key = `${kind}:${id}`;
      if (byKey.has(key)) return byKey.get(key)!;
      const idx = nodes.length;
      nodes.push({ id, kind, r, col: KCOL[kind], x: rnd() * W, y: rnd() * H, vx: 0, vy: 0 });
      byKey.set(key, idx);
      return idx;
    };

    const agentIdx = new Map<string, number>();
    let ceoIdx = -1;
    for (const a of agents) {
      const k = tierKind(a.tier);
      const r = k === "ceo" ? 15 : k === "principal" ? 9 : k === "senior" ? 7 : 6;
      const i = add(a.id, k, r);
      agentIdx.set(a.id, i);
      if (k === "ceo") ceoIdx = i;
    }

    const edges: [number, number][] = [];
    const link = (a: number, b: number) => { if (a >= 0 && b >= 0 && a !== b) edges.push([a, b]); };

    // agent → CEO hub; agent → its task/file artifact; blockedBy
    let artCount = 0;
    for (const a of agents) {
      const ai = agentIdx.get(a.id)!;
      if (ceoIdx >= 0 && ai !== ceoIdx) link(ai, ceoIdx);
      const arts = [a.task, a.file].filter((x): x is string => !!x && x !== "-");
      for (const lbl of arts) {
        if (artCount >= MAX_ARTIFACTS) break;
        const before = nodes.length;
        const bi = add(lbl.slice(0, 28), artifactKind(lbl), 5);
        if (nodes.length > before) artCount++;
        link(ai, bi);
      }
      if (a.blockedBy && agentIdx.has(a.blockedBy)) link(ai, agentIdx.get(a.blockedBy)!);
    }
    // feed comms: from → to (agent links) + from → ref (artifact)
    for (const f of feed.slice(-40)) {
      const fi = agentIdx.get(f.from);
      if (fi == null) continue;
      const ti = agentIdx.get(f.to);
      if (ti != null) link(fi, ti);
      if (f.ref && f.ref !== f.from && artCount < MAX_ARTIFACTS && !agentIdx.has(f.ref)) {
        const before = nodes.length;
        const ri = add(f.ref.slice(0, 28), artifactKind(f.ref), 5);
        if (nodes.length > before) artCount++;
        link(fi, ri);
      }
    }

    // ── motion-graphics layers ───────────────────────────────────────────
    // nebula depth field (parallax), data packets flowing along edges, CEO
    // command-waves, and pointer parallax — layered + randomized so it never
    // reads as a looping GIF.
    type Part = { x: number; y: number; r: number; vx: number; vy: number; a: number; depth: number };
    const parts: Part[] = Array.from({ length: 70 }, () => ({
      x: rnd() * W, y: rnd() * H, r: 0.5 + rnd() * 1.8,
      vx: (rnd() - 0.5) * 0.18, vy: (rnd() - 0.5) * 0.18,
      a: 0.05 + rnd() * 0.18, depth: 0.2 + rnd() * 0.8,
    }));
    type Pkt = { a: typeof nodes[number]; b: typeof nodes[number]; p: number; sp: number; col: string };
    const packets: Pkt[] = [];
    const waves: { r0: number }[] = [];
    const spawnPacket = (ia: number, ib: number) => {
      if (ia < 0 || ib < 0 || ia === ib) return;
      packets.push({ a: nodes[ia], b: nodes[ib], p: 0, sp: 0.01 + rnd() * 0.022, col: rnd() < 0.5 ? nodes[ia].col : nodes[ib].col });
    };
    // pointer parallax (spring-eased toward target — decorative, per design-eng)
    let mx = W / 2, my = H / 2, ox = 0, oy = 0;
    const onMove = (e: PointerEvent) => { mx = e.clientX; my = e.clientY; };
    window.addEventListener("pointermove", onMove);

    let raf = 0;
    let t = 0;
    let lastPk = 0, lastWave = 0, lastBurst = 0;
    const tick = () => {
      t += 0.016;
      // forces
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        a.vx *= 0.85; a.vy *= 0.85;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
          const f = 4200 / d2;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
        // very weak pull to center → graph fills the whole screen, doesn't clump
        a.vx += (W / 2 - a.x) * 0.00035;
        a.vy += (H / 2 - a.y) * 0.00035;
        // gentle roam so it never fully stills
        a.vx += Math.sin(t * 0.6 + i) * 0.025;
        a.vy += Math.cos(t * 0.5 + i * 1.3) * 0.025;
      }
      for (const [ia, ib] of edges) {
        const a = nodes[ia], b = nodes[ib];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) + 0.01;
        const f = (d - 120) * 0.006;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
      for (const a of nodes) {
        a.x += Math.max(-3.5, Math.min(3.5, a.vx));
        a.y += Math.max(-3.5, Math.min(3.5, a.vy));
        if (a.x < 24) { a.x = 24; a.vx = Math.abs(a.vx); }
        if (a.x > W - 24) { a.x = W - 24; a.vx = -Math.abs(a.vx); }
        if (a.y < 56) { a.y = 56; a.vy = Math.abs(a.vy); }
        if (a.y > H - 30) { a.y = H - 30; a.vy = -Math.abs(a.vy); }
      }

      // pointer parallax — ease current offset toward target (spring-like)
      const tox = (mx - W / 2) * 0.035, toy = (my - H / 2) * 0.035;
      ox += (tox - ox) * 0.05; oy += (toy - oy) * 0.05;

      // ── paint ──
      // Solid clear each frame → crisp nodes + readable labels (no comet-trail blur).
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(ox, oy);
      ctx.globalCompositeOperation = "lighter";

      // nebula depth field (deeper particles parallax more)
      for (const q of parts) {
        q.x += q.vx; q.y += q.vy;
        if (q.x < 0) q.x += W; if (q.x > W) q.x -= W;
        if (q.y < 0) q.y += H; if (q.y > H) q.y -= H;
        ctx.globalAlpha = q.a;
        ctx.fillStyle = "#5aa9c9";
        ctx.beginPath();
        ctx.arc(q.x + ox * q.depth, q.y + oy * q.depth, q.r, 0, 6.2832);
        ctx.fill();
      }

      // edges — energy pulses along each link
      ctx.lineWidth = 0.8;
      for (let k = 0; k < edges.length; k++) {
        const a = nodes[edges[k][0]], b = nodes[edges[k][1]];
        ctx.globalAlpha = 0.10 + 0.10 * (0.5 + 0.5 * Math.sin(t * 1.6 + k));
        ctx.strokeStyle = linkCol;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // CEO command-waves — expanding gold rings every ~3.2s
      if (ceoIdx >= 0 && t - lastWave > 3.2) { lastWave = t; waves.push({ r0: t }); }
      for (let i = waves.length - 1; i >= 0; i--) {
        const rr = (t - waves[i].r0) * 130;
        const al = 0.5 * (1 - rr / 520);
        if (al <= 0) { waves.splice(i, 1); continue; }
        ctx.globalAlpha = al;
        ctx.strokeStyle = KCOL.ceo;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(nodes[ceoIdx].x, nodes[ceoIdx].y, rr, 0, 6.2832); ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // packets — continuous flow + periodic dispatch bursts from a random agent
      if (edges.length && t - lastPk > 0.16) {
        lastPk = t;
        const e = edges[(rnd() * edges.length) | 0];
        spawnPacket(e[0], e[1]);
      }
      if (t - lastBurst > 2.4 && edges.length) {
        lastBurst = t;
        const src = (rnd() * nodes.length) | 0;
        let fired = 0;
        for (const [ia, ib] of edges) {
          if (fired >= 4) break;
          if (ia === src) { spawnPacket(ia, ib); fired++; }
          else if (ib === src) { spawnPacket(ib, ia); fired++; }
        }
      }
      for (let i = packets.length - 1; i >= 0; i--) {
        const pk = packets[i];
        pk.p += pk.sp;
        if (pk.p >= 1) { packets.splice(i, 1); continue; }
        const x = pk.a.x + (pk.b.x - pk.a.x) * pk.p;
        const y = pk.a.y + (pk.b.y - pk.a.y) * pk.p;
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = pk.col;
        ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;

      // nodes + bloom
      for (const a of nodes) {
        const pulse = a.kind === "ceo" ? 1 + 0.12 * Math.sin(t * 2) : 1 + 0.05 * Math.sin(t * 1.4 + a.x);
        ctx.shadowBlur = a.r * 2;
        ctx.shadowColor = a.col;
        ctx.fillStyle = a.col;
        ctx.beginPath(); ctx.arc(a.x, a.y, a.r * pulse, 0, 6.2832); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(255,255,255,0.82)";
        ctx.beginPath(); ctx.arc(a.x - a.r * 0.3, a.y - a.r * 0.3, a.r * 0.22, 0, 6.2832); ctx.fill();
      }

      // labels
      ctx.globalCompositeOperation = "source-over";
      ctx.shadowBlur = 0;
      ctx.fillStyle = labelCol;
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.textAlign = "left";
      for (const a of nodes) ctx.fillText(a.id, a.x + a.r + 4, a.y + 3);

      ctx.restore();
      if (!reduce) raf = requestAnimationFrame(tick);
    };

    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H); // solid first frame (trails build after)
    if (reduce) { for (let i = 0; i < 160; i++) tick(); }
    else tick();

    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener("pointermove", onMove); };
  }, [open, agents, feed]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden" style={{ backgroundColor: "#0a0b14" }} role="dialog" aria-label="MissionAlpha agent swarm" aria-modal="true">
      <canvas ref={cvRef} className="absolute inset-0 h-full w-full" />
      <div className="pointer-events-none absolute left-8 top-7">
        <div className="text-2xl font-semibold tracking-tight" style={{ color: "#f3f5f8", fontFamily: '"Lato", system-ui, sans-serif' }}>MissionAlpha</div>
        <div className="mt-1 text-xs" style={{ color: "#8a8f9c" }}>agent swarm command tower · {agents.length} agents · live graph</div>
      </div>
      <div className="pointer-events-none absolute bottom-6 left-8 flex flex-wrap gap-4 text-[11px]">
        <span style={{ color: "#f5b234" }}>● CEO</span>
        <span style={{ color: "#8b6cf6" }}>● principal / docs</span>
        <span style={{ color: "#22d3ee" }}>● senior / files</span>
        <span style={{ color: "#8a8f9c" }}>● support</span>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close swarm view"
        title="Close (Esc)"
        className="absolute right-6 top-6 rounded-md p-2 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2"
        style={{ color: "#8a8f9c" }}
      >
        <X size={20} aria-hidden />
      </button>
    </div>
  );
}

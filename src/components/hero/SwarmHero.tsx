import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { AgentState } from "../../data/types";
import { tok } from "../../lib/agentMeta";

/*
  SwarmHero (publicity) — A1 "drift + mesh": every agent is a node that roams the
  canvas, bounces off the edges, and draws a fading link to nearby agents; the CEO
  (tier "supreme") pulses gold and drifts toward center. Self-contained + reusable:
  pass any agent list (live state OR the saved docs/demo snapshot) and mount it
  anywhere — a future landing page, or the in-app full-screen overlay used here.

  Canvas needs concrete colors, but the design tokens are CSS vars (tok() → var(--c-…)),
  so we resolve them once via getComputedStyle and use globalAlpha for translucency.
  Honors prefers-reduced-motion (renders one static frame, no rAF loop).
*/

const TIER_TOK: Record<AgentState["tier"], string> = {
  supreme: "ceo-gold",
  principal: "factory-violet",
  senior: "accent-cyan",
  support: "muted",
};

export function SwarmHero({
  open,
  agents,
  onClose,
}: {
  open: boolean;
  agents: AgentState[];
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

    const cs = getComputedStyle(document.documentElement);
    const rv = (n: string) => cs.getPropertyValue(`--c-${n}`).trim() || "#888";
    const colorFor = (t: AgentState["tier"]) => rv(TIER_TOK[t] ?? "muted");
    const lineCol = rv("accent-cyan");
    const labelCol = rv("muted");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);

    let W = cv.clientWidth || 1;
    let H = cv.clientHeight || 1;
    const size = () => {
      W = cv.clientWidth || 1;
      H = cv.clientHeight || 1;
      cv.width = W * DPR;
      cv.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(cv);

    // Deterministic seed so the opening layout is stable (no flash of randomness).
    let s = 20260621;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

    const nodes = agents.map((a) => {
      const ceo = a.tier === "supreme";
      return {
        a,
        x: rnd() * W,
        y: 70 + rnd() * Math.max(1, H - 120),
        vx: (rnd() - 0.5) * (ceo ? 0.25 : 0.9),
        vy: (rnd() - 0.5) * (ceo ? 0.25 : 0.9),
        r: ceo ? 14 : a.tier === "principal" ? 8 : 6,
        col: colorFor(a.tier),
        ph: rnd() * 6.2832,
      };
    });

    let raf = 0;
    let t = 0;
    const draw = () => {
      t += 0.016;
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;

      for (const n of nodes) {
        if (n.a.tier === "supreme") { n.x += (cx - n.x) * 0.004; n.y += (cy - n.y) * 0.004; }
        n.x += n.vx; n.y += n.vy;
        if (n.x < 30 || n.x > W - 30) n.vx *= -1;
        if (n.y < 70 || n.y > H - 50) n.vy *= -1;
        n.x = Math.max(30, Math.min(W - 30, n.x));
        n.y = Math.max(70, Math.min(H - 50, n.y));
      }

      // mesh — fade link strength by distance via globalAlpha
      ctx.strokeStyle = lineCol;
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 220) {
            ctx.globalAlpha = 0.22 * (1 - d / 220);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;

      for (const n of nodes) {
        const pulse = n.a.tier === "supreme" ? 1 + 0.18 * Math.sin(t * 2 + n.ph) : 1;
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = n.col;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * pulse + 8, 0, 6.2832);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * pulse, 0, 6.2832);
        ctx.fill();
        ctx.fillStyle = labelCol;
        ctx.font = "11px Lato, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(n.a.id, n.x, n.y + n.r + 15);
      }

      if (!reduce) raf = requestAnimationFrame(draw);
    };
    draw();

    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [open, agents]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden" style={{ backgroundColor: tok("bg") }} role="dialog" aria-label="MissionAlpha agent swarm" aria-modal="true">
      <canvas ref={cvRef} className="absolute inset-0 h-full w-full" />
      <div className="pointer-events-none absolute left-8 top-7">
        <div className="text-2xl font-semibold tracking-tight" style={{ color: tok("text"), fontFamily: '"Lato", system-ui, sans-serif' }}>MissionAlpha</div>
        <div className="mt-1 text-xs" style={{ color: tok("muted") }}>agent swarm command tower · {agents.length} agents online</div>
      </div>
      <div className="pointer-events-none absolute bottom-6 left-8 flex flex-wrap gap-4 text-[11px]">
        <span style={{ color: tok("ceo-gold") }}>● CEO</span>
        <span style={{ color: tok("factory-violet") }}>● principal</span>
        <span style={{ color: tok("accent-cyan") }}>● senior</span>
        <span style={{ color: tok("muted") }}>● support</span>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close swarm view"
        title="Close (Esc)"
        className="absolute right-6 top-6 rounded-md p-2 outline-none transition-colors hover:bg-panel-2 focus-visible:ring-2"
        style={{ color: tok("muted") }}
      >
        <X size={20} aria-hidden />
      </button>
    </div>
  );
}

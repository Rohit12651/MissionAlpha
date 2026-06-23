import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { AgentState, FeedEvent } from "../../data/types";
import { statusStyle, packetsFromFeed, hitTest, recentComms, selectPacketLabels, focusDim, type StatusStyle } from "../../lib/swarmGraph";
import { COLUMN_LABEL, TIER_LABEL } from "../../lib/agentMeta";

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
  openAgentId = null,
  onSelectAgent,
  renderChat,
}: {
  open: boolean;
  agents: AgentState[];
  feed?: readonly FeedEvent[];
  onClose: () => void;
  /** Controlled selection — the agent whose inline panel is open (null = none). */
  openAgentId?: string | null;
  /** Click callback. WHEN OMITTED the hero is display-only (landing page) — clicks do nothing. */
  onSelectAgent?: (id: string | null) => void;
  /** Slot returning the existing ChatPane for an agent (App-owned; no chat code lives here). */
  renderChat?: (agentId: string) => ReactNode;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<Map<string, StatusStyle>>(new Map());
  const feedRef = useRef<readonly FeedEvent[]>(feed);
  const [hovered, setHovered] = useState<{ id: string; x: number; y: number } | null>(null);
  const hoveredRef = useRef<string | null>(null);
  // P1-3 tier focus: legend chips toggle this set; canvas reads it via focusRef (no per-frame render).
  const [focusTiers, setFocusTiers] = useState<ReadonlySet<string>>(new Set());
  const focusRef = useRef<ReadonlySet<string>>(focusTiers);
  useEffect(() => { focusRef.current = focusTiers; }, [focusTiers]);
  const toggleTier = (k: string) =>
    setFocusTiers((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  // Selection mirrored into a ref so the rAF draw loop can ring the open node without per-frame renders.
  const openIdRef = useRef<string | null>(openAgentId);
  useEffect(() => { openIdRef.current = openAgentId; }, [openAgentId]);
  // Mirror the click callback into a ref so the canvas effect (deps [open, agentSig]) and the Esc
  // handler always call the current one — no stale closure, no rebuild on prop identity change.
  const onSelectAgentRef = useRef(onSelectAgent);
  useEffect(() => { onSelectAgentRef.current = onSelectAgent; }, [onSelectAgent]);
  const comms = useMemo(
    () => (openAgentId ? recentComms(feed, openAgentId, 14) : []),
    [openAgentId, feed],
  );
  const openAgent = useMemo(
    () => (openAgentId ? agents.find((a) => a.id === openAgentId) ?? null : null),
    [openAgentId, agents],
  );
  // Membership signature — the canvas rebuilds only when the SET of agents changes, not on every
  // status/feed poll. Status flows via statusRef, feed via feedRef (both synced below). Memoized so
  // the map+join doesn't re-run on every poll render.
  const agentSig = useMemo(() => agents.map((a) => a.id).join("|"), [agents]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const cb = onSelectAgentRef.current;
      if (openIdRef.current && cb) cb(null); // Esc once: close the panel
      else onClose();                        // Esc again: close the hero
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Sync live status into a ref the rAF loop reads each frame — status flips live on each
  // /api/state.json poll WITHOUT triggering a per-frame React render (PRD real-time guardrail).
  useEffect(() => {
    const m = new Map<string, StatusStyle>();
    for (const a of agents) m.set(a.id, statusStyle(a));
    statusRef.current = m;
  }, [agents]);

  // Keep the latest feed in a ref the rAF loop drains into packets — feed updates each poll WITHOUT
  // rebuilding the canvas (PRD real-time guardrail). The graph is built once (see canvas effect deps).
  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);

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

    type N = { id: string; kind: Kind; r: number; col: string; x: number; y: number; vx: number; vy: number; agentId?: string; dim: number };
    const nodes: N[] = [];
    const byKey = new Map<string, number>(); // label → node index
    const add = (id: string, kind: Kind, r: number): number => {
      const key = `${kind}:${id}`;
      if (byKey.has(key)) return byKey.get(key)!;
      const idx = nodes.length;
      nodes.push({ id, kind, r, col: KCOL[kind], x: rnd() * W, y: rnd() * H, vx: 0, vy: 0, dim: 1 });
      byKey.set(key, idx);
      return idx;
    };

    const agentIdx = new Map<string, number>();
    let ceoIdx = -1;
    for (const a of agents) {
      const k = tierKind(a.tier);
      const r = k === "ceo" ? 15 : k === "principal" ? 9 : k === "senior" ? 7 : 6;
      const i = add(a.id, k, r);
      nodes[i].agentId = a.id;   // mark agent nodes so the draw loop can look up live status
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
    type Pkt = { a: typeof nodes[number]; b: typeof nodes[number]; p: number; sp: number; col: string; topic: string };
    const packets: Pkt[] = [];
    const waves: { r0: number }[] = [];
    const spawnPacket = (ia: number, ib: number, topic = "") => {
      if (ia < 0 || ib < 0 || ia === ib) return;
      packets.push({ a: nodes[ia], b: nodes[ib], p: 0, sp: 0.01 + rnd() * 0.022, col: rnd() < 0.5 ? nodes[ia].col : nodes[ib].col, topic });
    };
    // pointer parallax (spring-eased toward target — decorative, per design-eng)
    let mx = W / 2, my = H / 2, ox = 0, oy = 0;
    // Parallax-correct hover: hitTest subtracts (ox, oy) — the same offset the draw applies. Only
    // push React state when the hovered agent CHANGES (never per-frame), per the PRD guardrail.
    const updateHover = () => {
      const hitId = hitTest(nodes, mx, my, ox, oy, 6);
      if (hitId !== hoveredRef.current) {
        hoveredRef.current = hitId;
        cv.style.cursor = hitId ? "pointer" : "default";
        setHovered(hitId ? { id: hitId, x: mx, y: my } : null);
      }
    };
    const onMove = (e: PointerEvent) => { mx = e.clientX; my = e.clientY; updateHover(); };
    window.addEventListener("pointermove", onMove);
    // Click → select the node under the cursor (parallax-correct). Empty-canvas click closes the
    // panel. Display-only when onSelectAgent is omitted (landing page). Listener is on the canvas so
    // clicks on the panel chrome (sibling DOM above) never reach here.
    const onClick = (e: MouseEvent) => {
      const cb = onSelectAgentRef.current;
      if (!cb) return; // display-only (landing page) when no callback provided
      const id = hitTest(nodes, e.clientX, e.clientY, ox, oy, 10); // forgiving pad — node drifts under cursor
      cb(id); // id selects/swaps; null (empty canvas) closes
    };
    cv.addEventListener("click", onClick);

    let raf = 0;
    let t = 0;
    let lastWave = 0;
    let lastFeedCheck = 0, lastFeedTs: string | null = null, lastRealPacket = 0, lastTrickle = 0;
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
      updateHover(); // node may drift under a stationary cursor — re-resolve each frame (no setState unless changed)

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
        // P1-3: edge lit if either endpoint is in the focused tier (reuses nodes' eased dim).
        ctx.globalAlpha = (0.10 + 0.10 * (0.5 + 0.5 * Math.sin(t * 1.6 + k))) * Math.max(a.dim, b.dim);
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

      // packets — driven by REAL feed comms (P0-2). Drain new feed events (throttled to the poll
      // cadence) into one packet each, from→to. When the feed is quiet, a subtle idle trickle keeps
      // the view alive (edge case 7) without faking comms volume.
      if (t - lastFeedCheck > 0.5) {
        lastFeedCheck = t;
        const res = packetsFromFeed(lastFeedTs, feedRef.current, (id) => agentIdx.has(id));
        for (const pk of res.packets) {
          // safe: packetsFromFeed used the SAME agentIdx as hasNode, so both ids are present.
          spawnPacket(agentIdx.get(pk.from)!, agentIdx.get(pk.to)!, pk.topic);
          lastRealPacket = t;
        }
        lastFeedTs = res.lastTs;
      }
      // quiet trickle: only when no real comms for a while, emit a faint packet along a random edge.
      if (edges.length && t - lastRealPacket > 2.5 && t - lastTrickle > 0.8) {
        lastTrickle = t;
        const e = edges[(rnd() * edges.length) | 0];
        spawnPacket(e[0], e[1]);
      }
      for (let i = packets.length - 1; i >= 0; i--) {
        const pk = packets[i];
        pk.p += pk.sp;
        if (pk.p >= 1) { packets.splice(i, 1); continue; }
        const x = pk.a.x + (pk.b.x - pk.a.x) * pk.p;
        const y = pk.a.y + (pk.b.y - pk.a.y) * pk.p;
        const pdim = Math.max(pk.a.dim, pk.b.dim); // P1-3: dim packets whose tiers aren't focused
        // Idle-trickle packets (no topic) render fainter than real comms — clearly ambient, never
        // mistaken for real traffic (open-question resolution: subtle ambient at ~1 / 0.8s when quiet).
        const amb = pk.topic ? 1 : 0.55;
        ctx.globalAlpha = 0.5 * pdim * amb;
        ctx.fillStyle = pk.col;
        ctx.beginPath(); ctx.arc(x, y, pk.topic ? 5.5 : 4.2, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = 1 * pdim * amb;
        ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;

      // P1-2: topic labels — capped (≤6), nearest-to-cursor, fading with each packet. None under
      // reduced motion. Selection is the pure selectPacketLabels helper; canvas only renders.
      if (!reduce) {
        const cnx = mx - ox, cny = my - oy; // cursor in node space
        const items = packets.map((pk) => {
          const x = pk.a.x + (pk.b.x - pk.a.x) * pk.p;
          const y = pk.a.y + (pk.b.y - pk.a.y) * pk.p;
          return { topic: pk.topic, dist: Math.hypot(x - cnx, y - cny) };
        });
        const labels = selectPacketLabels(items, 6, 60);
        for (const lab of labels) {
          const pk = packets[lab.index];
          const x = pk.a.x + (pk.b.x - pk.a.x) * pk.p;
          const y = pk.a.y + (pk.b.y - pk.a.y) * pk.p;
          const fade = Math.sin(Math.PI * pk.p); // fade in then out across the packet's life
          ctx.globalAlpha = (lab.emphasized ? 0.95 : 0.5) * fade * Math.max(pk.a.dim, pk.b.dim);
          ctx.fillStyle = lab.emphasized ? "#ffffff" : "#aab0be";
          ctx.font = `${lab.emphasized ? 12 : 11}px ui-monospace, Menlo, monospace`;
          ctx.fillText(lab.label, x + 9, y - 7);
        }
        ctx.globalAlpha = 1;
      }

      // nodes + bloom — status-driven (P0-1): blocked ring, dim/faint/desaturated, brighter pulse.
      for (const a of nodes) {
        // P1-3: ease this node's tier-focus dim toward target (≤200ms; instant under reduced motion).
        const dimTarget = focusDim(a.kind, focusRef.current);
        a.dim += (dimTarget - a.dim) * (reduce ? 1 : 0.2);
        const st = a.agentId ? statusRef.current.get(a.agentId) : undefined;
        const alpha = (st ? st.alpha : 1) * a.dim;
        const glowK = st ? st.glow : 1;
        const pulseAmp = st ? st.pulse : (a.kind === "ceo" ? 0.12 : 0.05);
        const speed = a.kind === "ceo" ? 2 : 1.4;
        const pulse = 1 + pulseAmp * Math.sin(t * speed + a.x);
        // desaturated (stale) agents blend their hue toward muted gray
        const fill = st && st.desaturate ? "#6b7280" : a.col;

        ctx.globalAlpha = alpha;
        ctx.shadowBlur = a.dim < 0.5 ? 0 : a.r * 2 * glowK; // dimmed tiers lose their glow
        ctx.shadowColor = fill;
        ctx.fillStyle = fill;
        ctx.beginPath(); ctx.arc(a.x, a.y, a.r * pulse, 0, 6.2832); ctx.fill();
        ctx.shadowBlur = 0;

        // blocked ring
        if (st && st.ring) {
          ctx.globalAlpha = Math.min(1, alpha + 0.25);
          ctx.strokeStyle = st.ring;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(a.x, a.y, a.r * pulse + 3.5, 0, 6.2832); ctx.stroke();
        }

        // selection ring (P0-4): the open agent gets a crisp white ring.
        if (a.agentId && a.agentId === openIdRef.current) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "rgba(255,255,255,0.95)";
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(a.x, a.y, a.r * pulse + 6, 0, 6.2832); ctx.stroke();
        }

        // specular highlight
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "rgba(255,255,255,0.82)";
        ctx.beginPath(); ctx.arc(a.x - a.r * 0.3, a.y - a.r * 0.3, a.r * 0.22, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;

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

    // baseline: mark all current feed events as "already seen" so opening the hero does NOT
    // burst-replay history — only NEW comms after open become packets.
    lastFeedTs = packetsFromFeed(null, feedRef.current, (id) => agentIdx.has(id)).lastTs;

    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H); // solid first frame (trails build after)
    if (reduce) { for (let i = 0; i < 160; i++) tick(); }
    else tick();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      cv.removeEventListener("click", onClick);
      hoveredRef.current = null; setHovered(null);
    };
    // Build-once: topology is read at build time; live status/feed flow via statusRef/feedRef so the
    // canvas never tears down on a poll. Rebuild only when the agent SET changes (agentSig).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentSig]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden" style={{ backgroundColor: "#0a0b14" }} role="dialog" aria-label="MissionAlpha agent swarm" aria-modal="true">
      <canvas ref={cvRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
      {/* Keyboard/AT path: the canvas hover is pointer-only; the same per-agent data is reachable
          via the cockpit roster/board (WCAG 2.2 SC 2.1.1 path-exception, documented). */}
      <p className="sr-only">
        Keyboard users: detailed agent information (id, role, status, current task) is available in
        the agent roster and board outside this view.
      </p>
      {hovered && (() => {
        const a = agents.find((ag) => ag.id === hovered.id);
        if (!a) return null;
        return (
          <div
            data-testid="agent-tooltip"
            aria-hidden="true"
            className="pointer-events-none absolute z-10 max-w-[260px] rounded-lg px-3 py-2 text-[11px] leading-snug shadow-xl"
            style={{
              left: Math.min(hovered.x + 16, (typeof window !== "undefined" ? window.innerWidth : 1920) - 280),
              top: hovered.y + 16,
              background: "rgba(16,18,28,0.92)",
              border: "1px solid rgba(139,108,246,0.35)",
              backdropFilter: "blur(8px)",
              color: "#e7e9f0",
            }}
          >
            <div className="font-semibold" style={{ fontFamily: "ui-monospace, Menlo, monospace", color: "#f3f5f8" }}>{a.id}</div>
            <div className="mt-0.5" style={{ color: "#aab0be" }}>{a.role} · {TIER_LABEL[a.tier]} · {COLUMN_LABEL[a.column]}</div>
            {a.task && a.task !== "-" && (
              <div className="mt-1" style={{ color: "#c9cdd8" }}>{a.task}</div>
            )}
          </div>
        );
      })()}
      {openAgentId && openAgent && (
        <aside
          className="absolute right-0 top-0 z-20 flex h-full w-[340px] flex-col"
          style={{ background: "rgba(12,13,20,0.96)", borderLeft: "1px solid rgba(139,108,246,0.30)", backdropFilter: "blur(10px)" }}
          aria-label={`Inspect ${openAgent.id}`}
        >
          <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold"
              style={{ background: "rgba(139,108,246,0.18)", color: "#c9b8ff" }}>
              {openAgent.id.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold" style={{ fontFamily: "ui-monospace, Menlo, monospace", color: "#f3f5f8" }}>{openAgent.id}</div>
              <div className="truncate text-[11px]" style={{ color: "#9aa0ad" }}>{openAgent.role} · {TIER_LABEL[openAgent.tier]} · {COLUMN_LABEL[openAgent.column]}</div>
            </div>
            <button type="button" onClick={() => onSelectAgent?.(null)} aria-label="Close inspect panel" title="Close (Esc)"
              className="rounded-md p-1.5 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2" style={{ color: "#8a8f9c" }}>
              <X size={16} aria-hidden />
            </button>
          </div>
          <div className="border-b px-4 py-2" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#6b7280" }}>Recent comms</div>
            <ul className="max-h-[28vh] space-y-1 overflow-y-auto">
              {comms.length === 0 && <li className="text-[11px]" style={{ color: "#6b7280" }}>no recent comms</li>}
              {comms.map((e, i) => {
                const out = e.from === openAgent.id;
                return (
                  <li key={`${e.ts}-${i}`} className="text-[11px] leading-snug">
                    <span style={{ color: out ? "#22d3ee" : "#8b6cf6" }}>{out ? `→ ${e.to}` : `← ${e.from}`}</span>
                    <span style={{ color: "#6b7280" }}> · {e.topic.slice(0, 80)}</span>
                    {e.body && <span style={{ color: "#aab0be" }}> · {e.body.slice(0, 160)}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="min-h-0 flex-1">
            {renderChat && renderChat(openAgent.id)}
          </div>
        </aside>
      )}
      <div className="pointer-events-none absolute left-8 top-7">
        <div className="text-2xl font-semibold tracking-tight" style={{ color: "#f3f5f8", fontFamily: '"Lato", system-ui, sans-serif' }}>MissionAlpha</div>
        <div className="mt-1 text-xs" style={{ color: "#8a8f9c" }}>agent swarm command tower · {agents.length} agents · live graph</div>
      </div>
      <div className="absolute bottom-6 left-8 flex flex-wrap gap-2 text-[11px]" role="group" aria-label="Filter swarm by tier">
        {([["ceo", "CEO", "#f5b234"], ["principal", "principal / docs", "#8b6cf6"], ["senior", "senior / files", "#22d3ee"], ["support", "support", "#8a8f9c"]] as const).map(([k, label, col]) => {
          const active = focusTiers.has(k);
          return (
            <button
              key={k}
              type="button"
              aria-pressed={active}
              onClick={() => toggleTier(k)}
              className="app-no-drag inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 outline-none transition-[background-color,border-color] duration-150 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0b14]"
              style={{
                // text stays AA-contrast in both states (no opacity dimming on the label — WCAG 1.4.3);
                // active is signalled by border + tinted bg + brighter text instead.
                borderColor: active ? col : "rgba(255,255,255,0.22)",
                background: active ? `color-mix(in oklch, ${col} 22%, transparent)` : "transparent",
                color: active ? "#f3f5f8" : "#b8bdc9",
              }}
            >
              <span style={{ color: col }} aria-hidden>●</span>{label}
            </button>
          );
        })}
      </div>
      {/* WCAG 4.1.3: announce the current filter set to assistive tech (multi-select union). */}
      <p className="sr-only" aria-live="polite">
        {focusTiers.size === 0
          ? "No tier filter — showing all tiers"
          : `Filtering swarm by: ${["ceo", "principal", "senior", "support"].filter((k) => focusTiers.has(k)).join(", ")}`}
      </p>
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

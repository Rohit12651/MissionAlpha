// Landing + Setup (spec §5.2) — the landing's live card. Real runtime events when there are
// any (since launch); otherwise the mockup's example job (`HERO_SCRIPT`), honestly chipped
// "Example run · simulated". Mirrors the mockup's own loop (lines 1209–1253): one message
// every 1.7s (3.2s after the sixth), 8 kept, newest first, streamed 2–4 characters per 22ms;
// it holds still while paused, while the document is hidden or while the card is off-screen.
// Reduced motion: a message appears whole and does not slide in.

import { useEffect, useRef, useState } from "react";
import type { ActivityRow } from "../../lib/activityStream";
import { HERO_SCRIPT } from "../../lib/firstRun";
import { stationById, stationInitials } from "../../lib/stationMeta";

const SEATS: Record<string, { init: string; name: string }> = {
  ceo: { init: "CEO", name: "CEO" }, mgr: { init: "MG", name: "Manager" },
  fe: { init: "FE", name: "sr-frontend" }, be: { init: "BE", name: "sr-backend" }, qa: { init: "QA", name: "qa" },
};
const KEEP = 8;
const GAP_MS = 1700;
const ROUND_GAP_MS = 3200;
const STREAM_MS = 22;
const IDLE_MS = 400;

interface Msg { key: string; init: string; name: string; text: string }

const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One message: streamed (with a caret) unless reduced motion, entering transition once. */
function Message({ m, stream }: { m: Msg; stream: boolean }) {
  const [shown, setShown] = useState(stream ? 0 : m.text.length);
  const [entering, setEntering] = useState(stream);
  useEffect(() => {
    if (!entering) return;
    let a = 0, b = 0;
    a = requestAnimationFrame(() => { b = requestAnimationFrame(() => setEntering(false)); });
    return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); };
  }, [entering]);
  useEffect(() => {
    if (shown >= m.text.length) return;
    const t = setTimeout(() => setShown((n) => Math.min(m.text.length, n + 2 + Math.floor(Math.random() * 3))), STREAM_MS);
    return () => clearTimeout(t);
  }, [shown, m.text.length]);
  return (
    <li className="msg" data-entering={entering ? "" : undefined} aria-busy={shown < m.text.length || undefined}>
      <span className="seat" aria-hidden="true">{m.init}</span>
      <div>
        <div className="who"><b>{m.name}</b><span className="ai-tag">AI agent</span></div>
        <div className="body">{m.text.slice(0, shown)}{shown < m.text.length && <span className="caret" />}</div>
      </div>
    </li>
  );
}

const fromRow = (r: ActivityRow): Msg => ({
  key: r.id,
  init: r.agentId ? stationInitials(r.agentId) : "RT",
  name: r.agentId ? stationById(r.agentId)?.name ?? r.agentId : "Runtime",
  text: r.target ? `${r.verb} ${r.target}` : r.verb,
});

export function HeroFeed({ events }: { events: readonly ActivityRow[] }) {
  const real = events.length > 0;
  const [paused, setPaused] = useState(false);
  const [example, setExample] = useState<Msg[]>([]);
  const [frozen, setFrozen] = useState<Msg[] | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const seen = useRef(true);
  const pausedRef = useRef(false);
  const step = useRef(0);
  const stream = !reduceMotion();

  // Off-screen → hold still (the mockup's IntersectionObserver guard).
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(([e]) => { seen.current = e.isIntersecting; });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The example loop: only while there are no real events.
  useEffect(() => {
    if (real) return;
    let t = 0, alive = true;
    const tick = () => {
      if (!alive) return;
      if (pausedRef.current || document.hidden || !seen.current) { t = window.setTimeout(tick, IDLE_MS); return; }
      const n = step.current;
      const [seat, text] = HERO_SCRIPT[n % HERO_SCRIPT.length];
      setExample((rows) => [{ key: `ex-${n}`, init: SEATS[seat].init, name: SEATS[seat].name, text }, ...rows].slice(0, KEEP));
      step.current = n + 1;
      t = window.setTimeout(tick, step.current % HERO_SCRIPT.length === 0 ? ROUND_GAP_MS : GAP_MS);
    };
    tick();
    return () => { alive = false; clearTimeout(t); };
  }, [real]);

  // Pause freezes what is on screen, real or example.
  const live = real ? events.slice(0, KEEP).map(fromRow) : example;
  const rows = paused ? frozen ?? live : live;
  const togglePause = () => { pausedRef.current = !paused; setFrozen(paused ? null : live); setPaused(!paused); };

  return (
    <figure className="live-card" style={{ margin: 0 }} aria-labelledby="live-cap" ref={cardRef}>
      <div className="live-head">
        <span className="label" id="live-cap"><span className="dot live gold" style={{ display: "inline-block", marginRight: 8 }} />The team, right now</span>
        {!real && <span className="chip">Example run · simulated</span>}
      </div>
      <ol className="live-feed" id="hero-feed" aria-live="polite" aria-relevant="additions">
        {rows.map((m) => <Message key={m.key} m={m} stream={stream && !real} />)}
      </ol>
      <div className="live-foot">
        {real
          ? <span className="muted" style={{ fontSize: ".8125rem" }}>Live events from this machine</span>
          : <span className="muted" style={{ fontSize: ".8125rem" }}>Job: <b style={{ color: "var(--brand)" }}>Dark mode for settings</b></span>}
        <button className="btn btn-ghost" id="hero-pause" type="button" aria-pressed={paused} style={{ minHeight: 36, padding: "8px 16px" }} onClick={togglePause}>
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
    </figure>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ACTIVITY_CAP,
  agentsIn,
  filterActivity,
  type ActivityRow,
} from "../../lib/activityStream";
import { stationById } from "../../lib/stationMeta";

/*
  PHASE 5 — the activity stream.

  A pure CONSUMER of the SSE bus (ADR-052). It opens no connection of its own: App.tsx
  owns the single subscription and folds each frame into the buffer this renders. That
  matters — a second EventSource would double the runtime's fan-out for a read-only panel.

  NO INVENTED DATA. Every row is one real event. An event the feed has no verb for is
  never rendered (see activityStream.ts VOCAB). An agentId the frame did not carry shows
  as "unattributed", not a guess. The time is CLIENT RECEIPT time — the SSE frame carries
  no server timestamp — so the field is named `receivedAt` and every row's tooltip says so
  in full. (An earlier version of this comment claimed a "received" label in the HEADER;
  no such text renders. Corrected rather than left as an aspirational description.)

  AUTO-SCROLL WITH PAUSE. The feed sticks to the newest row, but only while the operator
  is not reading. Hovering, focusing inside it, or scrolling away pauses the stick and
  raises a "N new" pill; clicking the pill (or leaving) resumes. A feed that yanks the
  viewport out from under someone mid-read is worse than no feed.

  MOTION. A row that arrives fades+slides in once (the mockup's 320ms `.feed-row`
  transition). Under `prefers-reduced-motion: reduce` the row simply appears — no opacity
  theatre either, because a 500-row feed crossfading is exactly the vestibular load the
  query exists to avoid. The preference is read live (matchMedia listener).
*/

export interface ActivityStreamProps {
  rows: ActivityRow[];
  /** True while the SSE stream is open. A stale feed must say so. */
  connected: boolean;
  /** Collapse state is owned by the parent so it can persist. */
  open: boolean;
  onToggle: () => void;
}

const TONE_LABEL: Record<ActivityRow["tone"], string> = {
  neutral: "",
  good: "succeeded",
  warn: "needs attention",
  bad: "failed",
};

const two = (n: number) => String(n).padStart(2, "0");
/** The mockup's row time: the browser's receipt time as hh:mm. */
const hhmm = (ms: number) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

/** Event tone → the mockup's dot colour. */
const DOT: Record<ActivityRow["tone"], string> = { neutral: "indigo", good: "ok", warn: "warn", bad: "bad" };

// Stable empties for the collapsed rail. Module constants, not fresh literals: a new []
// on every render would defeat the very memoisation they exist to serve.
const NO_AGENTS: string[] = [];
const NO_ROWS: ActivityRow[] = [];

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function ActivityStream({ rows, connected, open, onToggle }: ActivityStreamProps) {
  const [agent, setAgent] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  // Pause pressed explicitly: holds until Resume, whatever the pointer or focus does.
  const [pinned, setPinned] = useState(false);
  // Hover is a READING SIGNAL in its own right, and it has to be readable by the blur
  // handler — Fable verification, phase 5. Resuming on focus-leave while the pointer is
  // still over the rail re-sticks the feed and shifts rows under a stationary cursor,
  // which is the exact "yanks the viewport out from under someone mid-read" this panel
  // refuses to do. `scrollTop` alone cannot see it: the operator is at the top, reading.
  const [hovered, setHovered] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const listRef = useRef<HTMLOListElement | null>(null);
  const lastTopSeq = useRef<number | null>(null);
  const reduced = useReducedMotion();

  // BOTH ARE GATED ON `open` — code-review MEDIUM. Hooks cannot sit behind the collapsed
  // early return below, so a closed rail still paid for a full Set+sort over the buffer
  // and a full filter pass on EVERY accepted SSE frame. The header called the collapsed
  // state cheap; it was not. Gating inside the factory keeps the hook order fixed and
  // makes the closed cost O(1). The lists recompute on the transition to open.
  const agents = useMemo(() => (open ? agentsIn(rows) : NO_AGENTS), [rows, open]);
  const visible = useMemo(() => (open ? filterActivity(rows, agent) : NO_ROWS), [rows, agent, open]);

  // A filter that no longer matches anything must not silently show an empty feed as if
  // the swarm were quiet — clear it when the agent leaves the buffer entirely.
  useEffect(() => {
    if (agent && !agents.includes(agent)) setAgent(null);
  }, [agent, agents]);

  // CHANGING THE FILTER RE-BASELINES THE COUNT — code-review MEDIUM. `lastTopSeq` is a
  // seq from the PREVIOUS filter's top row. Picking a different agent also focuses the
  // <select>, which pauses the feed (onFocusCapture below), and the arrival effect then
  // ran against a freshly filtered list where that seq almost never appears — so it
  // reported the ENTIRE view as new. "N new" has to be a real count of arrivals or it is
  // worse than a dot, because a number invites the operator to trust it.
  useEffect(() => {
    lastTopSeq.current = null;
    setUnseen(0);
  }, [agent]);

  // Track arrivals while paused so the "N new" pill is a real count, not a dot.
  useEffect(() => {
    if (!open) return; // a collapsed rail has no viewport to protect
    const top = visible[0]?.seq ?? null;
    if (top === lastTopSeq.current) return;
    if (paused && lastTopSeq.current !== null) {
      const idx = visible.findIndex((r) => r.seq === lastTopSeq.current);
      setUnseen(idx < 0 ? visible.length : idx);
    } else {
      lastTopSeq.current = top;
      setUnseen(0);
      if (listRef.current) listRef.current.scrollTop = 0;
    }
  }, [visible, paused, open]);

  const resume = useCallback(() => {
    setPaused(false);
    setUnseen(0);
    lastTopSeq.current = visible[0]?.seq ?? null;
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [visible]);

  // Scrolling away from the top is an explicit "I am reading" signal.
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setPaused(el.scrollTop > 8);
  }, []);

  // The mockup's prependFeed(): a row that ARRIVES (not the ones already there when the
  // feed mounts) starts at [data-entering] and loses it two frames later, so the
  // `.feed-row` transition (sketchbook.css) slides it in. Reduced motion: no entering.
  const seenRows = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    const ol = listRef.current;
    if (!ol) return;
    const fresh: HTMLElement[] = [];
    const first = seenRows.current === null;
    const seen = seenRows.current ?? new Set<string>();
    for (const li of ol.querySelectorAll<HTMLElement>("li[data-row]")) {
      const id = li.dataset.row ?? "";
      if (!seen.has(id) && !first && !reduced) fresh.push(li);
      seen.add(id);
    }
    seenRows.current = seen;
    if (!fresh.length) return;
    for (const li of fresh) li.setAttribute("data-entering", "");
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => { for (const li of fresh) li.removeAttribute("data-entering"); });
    });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); for (const li of fresh) li.removeAttribute("data-entering"); };
  }, [visible, reduced]);

  // Phase G (ADR G-2): the mockup's Activity-stream card — a <details> whose summary
  // carries the title and the Pause control, rows as `.feed-row`. The agent filter, the
  // "N new" pill and the buffer note are app-only (data-app-only), restyled in its tokens.
  const togglePinned = () => {
    if (pinned) { setPinned(false); resume(); } else { setPinned(true); setPaused(true); }
  };
  return (
    <details className="card" open={open} aria-label="Activity stream" data-reduced={reduced ? "true" : undefined}>
      <summary
        className="card-h"
        style={{ cursor: "pointer", listStyle: "none" }}
        onClick={(e) => { e.preventDefault(); onToggle(); }}
      >
        <h2>Activity stream</h2>
        <span className="sub">
          {connected ? "live events · " : "reconnecting · "}
          <button
            className="linkish"
            type="button"
            aria-pressed={pinned}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePinned(); }}
          >
            {pinned ? "Resume" : "Pause"}
          </button>
        </span>
      </summary>
      {open && (
        <div
          onMouseEnter={() => { setHovered(true); setPaused(true); }}
          onMouseLeave={(e) => {
            setHovered(false);
            if (pinned) return;
            const active = document.activeElement;
            if (active && e.currentTarget.contains(active)) return;
            if (listRef.current && listRef.current.scrollTop <= 8) resume();
          }}
          onFocusCapture={() => setPaused(true)}
          // A keyboard user must be able to leave: focus moving out un-pauses, unless the
          // pointer is still over the feed, the operator scrolled away, or Pause is pinned.
          onBlurCapture={(e) => {
            const to = e.relatedTarget as Node | null;
            if (to && e.currentTarget.contains(to)) return;
            if (hovered || pinned) return;
            if (listRef.current && listRef.current.scrollTop > 8) return;
            resume();
          }}
        >
          {(agents.length > 1 || unseen > 0) && (
            <div className="pills" data-app-only="activity-filter" style={{ marginBottom: 8 }}>
              {agents.length > 1 && (
                <>
                  <label className="sr-only" htmlFor="activity-agent">Filter activity by agent</label>
                  <select id="activity-agent" className="pill" value={agent ?? ""} onChange={(e) => setAgent(e.target.value || null)}>
                    <option value="">All agents</option>
                    {agents.map((a) => <option key={a} value={a}>{stationById(a)?.name ?? a}</option>)}
                  </select>
                </>
              )}
              {unseen > 0 && <button type="button" className="pill" onClick={resume}>{`${unseen} new`}</button>}
            </div>
          )}
          {visible.length === 0 ? (
            <p className="empty-note"><span className="script">Quiet watch.</span><br />Nothing logged yet.</p>
          ) : (
            // position:relative contains each row's absolutely-positioned .sr-only span; without it
            // they escape this scroller's clipping and stretch .content with blank scroll space.
            <ol className="stream list" ref={listRef} onScroll={onScroll} tabIndex={0} aria-live="polite" aria-relevant="additions" style={{ position: "relative" }}>
              {visible.map((r) => (
                <li key={r.id} className="feed-row" data-row={r.id}>
                  <span className={`dot ${DOT[r.tone]}`} />
                  <span>
                    <span className="who">{r.agentId ? (stationById(r.agentId)?.name ?? r.agentId) : "runtime"}</span>
                    {` ${r.verb}${r.target ? ` ${r.target}` : ""}`}
                    {TONE_LABEL[r.tone] ? <span className="sr-only">{` — ${TONE_LABEL[r.tone]}`}</span> : null}
                  </span>
                  <time
                    dateTime={new Date(r.receivedAt).toISOString()}
                    title="Received by this browser. The event stream does not carry a server timestamp."
                  >
                    {hhmm(r.receivedAt)}
                  </time>
                </li>
              ))}
            </ol>
          )}
          <p className="sub" data-app-only="activity-buffer" style={{ margin: "8px 0 0" }}>{`${visible.length} shown · newest ${ACTIVITY_CAP} kept`}</p>
        </div>
      )}
    </details>
  );
}

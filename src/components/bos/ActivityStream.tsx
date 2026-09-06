import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACTIVITY_CAP,
  agentsIn,
  filterActivity,
  type ActivityRow,
} from "../../lib/activityStream";

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

  MOTION. New rows fade+slide 140ms once. Under `prefers-reduced-motion: reduce` the
  transform is dropped entirely and the row simply appears — no opacity theatre either,
  because a 500-row feed crossfading is exactly the vestibular load the query exists to
  avoid. NO_MOTION is read live (matchMedia listener), not just at mount.
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

/** Relative time from two client-clock readings. Never claims server precision. */
function relTime(receivedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - receivedAt) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

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

/** A ticking clock for relative times. One interval for the whole panel, 15s. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function ActivityStream({ rows, connected, open, onToggle }: ActivityStreamProps) {
  const [agent, setAgent] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
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
  const now = useNow(open);

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

  if (!open) {
    return (
      <button type="button" className="helm-activity-tab" onClick={onToggle} aria-expanded={false}>
        Activity
        {rows.length ? <span className="helm-activity-count">{rows.length}</span> : null}
      </button>
    );
  }

  return (
    <section
      className="helm-activity"
      aria-label="Activity stream"
      data-reduced={reduced ? "true" : undefined}
      onMouseEnter={() => { setHovered(true); setPaused(true); }}
      onMouseLeave={(e) => {
        setHovered(false);
        // Symmetric to onBlurCapture: the pointer leaving does not mean the operator
        // stopped reading if the keyboard is still inside the rail.
        const active = document.activeElement;
        if (active && e.currentTarget.contains(active)) return;
        if (listRef.current && listRef.current.scrollTop <= 8) resume();
      }}
      onFocusCapture={() => setPaused(true)}
      // A KEYBOARD USER MUST BE ABLE TO LEAVE — code-review MEDIUM. Focus entering the
      // rail paused it, and only the MOUSE could un-pause it. Tabbing in and then onward
      // left the feed paused for the rest of the session, silently piling up an unseen
      // count with no visible cause. relatedTarget is where focus is going: still inside
      // means we are only moving between the rail's own controls.
      onBlurCapture={(e) => {
        const to = e.relatedTarget as Node | null;
        if (to && e.currentTarget.contains(to)) return;
        if (hovered) return; // the pointer is still on the rail — still reading
        if (listRef.current && listRef.current.scrollTop > 8) return; // still reading
        resume();
      }}
    >
      <header className="helm-activity-head">
        <span className="helm-activity-title">Activity</span>
        {/* A disconnected feed is stale, and saying so is the whole point of the dot. */}
        <span
          className="helm-activity-live"
          data-live={connected ? "true" : "false"}
          role="status"
        >
          {connected ? "live" : "reconnecting"}
        </span>
        <button type="button" className="helm-btn helm-btn-slim" data-variant="quiet" onClick={onToggle} aria-expanded>
          Hide
        </button>
      </header>

      {agents.length > 1 ? (
        <div className="helm-activity-filter">
          <label className="sr-only" htmlFor="activity-agent">Filter activity by agent</label>
          <select
            id="activity-agent"
            className="helm-input helm-activity-select"
            value={agent ?? ""}
            onChange={(e) => setAgent(e.target.value || null)}
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
      ) : null}

      {unseen > 0 ? (
        <button type="button" className="helm-activity-new" onClick={resume}>
          {`${unseen} new`}
        </button>
      ) : null}

      {visible.length === 0 ? (
        <p className="helm-activity-empty">Quiet watch — nothing logged yet.</p>
      ) : (
        <ol className="helm-activity-list" ref={listRef} onScroll={onScroll} tabIndex={0}>
          {visible.map((r) => (
            <li key={r.id} className="helm-activity-row" data-tone={r.tone}>
              <span className="helm-activity-who helm-mono">{r.agentId ?? "unattributed"}</span>
              <span className="helm-activity-what">
                {r.verb}
                {r.target ? <span className="helm-activity-target"> {r.target}</span> : null}
                {TONE_LABEL[r.tone] ? <span className="sr-only">{` — ${TONE_LABEL[r.tone]}`}</span> : null}
              </span>
              <span
                className="helm-activity-when"
                title={`Received by this browser at ${new Date(r.receivedAt).toLocaleTimeString()}. The event stream does not carry a server timestamp.`}
              >
                {relTime(r.receivedAt, now)}
              </span>
            </li>
          ))}
        </ol>
      )}

      <footer className="helm-activity-foot">
        {`${visible.length} shown · newest ${ACTIVITY_CAP} kept`}
      </footer>
    </section>
  );
}

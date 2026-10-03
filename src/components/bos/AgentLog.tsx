// B3 — the agent log: what the swarm ACTUALLY did in the last 24h, read from the
// runtime's own events_log (GET /runtime/brief/log) and kept live by the app-wide SSE
// subscription. Presentational: BriefPage owns the fetch, the live merge and the retry
// so the topbar chip and this list read ONE array (container/presentational split).
//
// EVERY ROW IS A REAL EVENT. There is no fixture, no filler and no "recent activity"
// placeholder: an empty log renders "Quiet watch — nothing logged yet." and a failed
// read renders a faint mono note + Retry (the PolicyEditor / VaultPage pattern), never
// a fabricated zero.
//
// MOTION: one hover-gated 240ms transform on a row, plus 140ms colour transitions —
// both inside `@media (hover:hover)` in bos.css and both stripped by the global
// reduced-motion net. Nothing animates on mount, nothing loops.
//
// NO innerHTML: agent-authored titles (a delivery title is agent text) reach the DOM as
// React text nodes only.

import { formatRelative } from "../../lib/formatRelative";
import { useTick } from "../../lib/ticker";
import { PILL_LABEL, type BriefPill, type LogRow } from "../../lib/briefClient";
import { stationById } from "../../lib/stationMeta";

/** The mockup's feed dot per outcome. */
const DOT: Record<BriefPill, string> = { logged: "indigo", completed: "ok", "needs-review": "warn", failed: "bad" };
const two = (n: number) => String(n).padStart(2, "0");
const hhmm = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : `${two(d.getHours())}:${two(d.getMinutes())}`; };
/** The log windows the mockup offers, in hours. */
export const LOG_WINDOWS: readonly [number, string][] = [[24, "Last 24h"], [168, "7 days"]];

export interface AgentLogProps {
  /** Newest-first rows, or null while the first read is in flight. */
  rows: LogRow[] | null;
  error: boolean;
  onRetry: () => void;
  /** Deep-link a needs-review row into the Inbox with that delivery selected. */
  onOpenDelivery: (deliveryId: string) => void;
  /** The log window in hours (one of LOG_WINDOWS). */
  windowHours: number;
  onWindow: (hours: number) => void;
}

// Phase G (ADR G-2): the mockup's Agent-log card — a window segment and `.feed-row`s:
// a dot for the outcome, the station, the line, the time. The needs-review deep-link and
// the kind/venture meta are kept (app-only).
export function AgentLog({ rows, error, onRetry, onOpenDelivery, windowHours, onWindow }: AgentLogProps) {
  // The LEAF subscribes to the shared 1s tick so a row's age tooltip stays live without
  // re-rendering the console beside it.
  const nowMs = useTick();
  return (
    <div className="card">
      <div className="card-h">
        <h2>Agent log</h2>
        <div className="seg" aria-label="Window">
          {LOG_WINDOWS.map(([h, label]) => (
            <button key={h} type="button" aria-pressed={windowHours === h} onClick={() => onWindow(h)}>{label}</button>
          ))}
        </div>
      </div>
      <ol className="list stream" style={{ maxHeight: 520, position: "relative" }}>
        {error ? (
          <li className="empty-note">{"Could not read the log. "}<button type="button" className="linkish" onClick={onRetry}>Retry</button></li>
        ) : rows === null ? (
          <li className="empty-note" role="status">Reading the log…</li>
        ) : rows.length === 0 ? (
          <li className="empty-note">Nothing in this window.</li>
        ) : (
          rows.map((r) => (
            <li key={r.key} className="feed-row" title={`${r.kind}${r.venture ? ` · ${r.venture}` : ""} · ${formatRelative(r.ts, nowMs)}`}>
              <span className={`dot ${DOT[r.pill]}`} />
              <span>
                <span className="who">{stationById(r.agent)?.name ?? r.agent}</span>
                {` ${r.title}`}
                {r.pill === "needs-review" && r.deliveryId && (
                  <>{" "}<button type="button" className="linkish" data-app-only="open-delivery" onClick={() => onOpenDelivery(r.deliveryId as string)}>{`${PILL_LABEL[r.pill]} →`}</button></>
                )}
              </span>
              <time dateTime={r.ts}>{hhmm(r.ts)}</time>
            </li>
          ))
        )}
      </ol>
    </div>
  );
}

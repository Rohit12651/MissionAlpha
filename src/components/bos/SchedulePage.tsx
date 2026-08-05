// B4 — the Schedule page (nav id `schedule`). The next 24h of the swarm's autonomous
// watch as a vertical timeline: each scheduled cadence at its UTC fire time, grouped by
// hour, with a "now" hairline. Row click opens the same WorkflowDrawer as Workflows.
//
// LAZY BY CONSTRUCTION (App React.lazy) — kept out of the main index chunk.
//
// HONEST SCOPE: times are UTC (the schedule is UTC, drift-free) and the ‹ Today › control
// is a STATIC label — there is no day-navigation backend in v1 (disclosed). On-demand
// cadences never appear here (they carry no schedule). A fetch failure shows a note + Retry.
// NO innerHTML anywhere.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTick } from "../../lib/ticker";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import {
  scheduleBuckets,
  skillLabel,
  stationName,
  listCadences,
  type Cadence,
} from "../../lib/cadenceClient";
import { BosTopbar } from "./BosTopbar";
import { WorkflowDrawer, type RunEvent } from "./WorkflowDrawer";

export interface SchedulePageProps {
  venture: string | null;
  lastEvent: RuntimeEvent | null;
  liveNonce: number;
}

const dayLabel = (ms: number): string => {
  const d = new Date(ms);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${mon} ${d.getUTCDate()}`;
};

export function SchedulePage({ venture, lastEvent, liveNonce }: SchedulePageProps) {
  const nowMs = useTick();
  const [rows, setRows] = useState<Cadence[] | null>(null);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, RunEvent[]>>({});

  useEffect(() => {
    let live = true;
    setError(false);
    listCadences()
      .then((r) => { if (live) setRows(r.cadences ?? []); })
      .catch(() => { if (live) { setRows(null); setError(true); } });
    return () => { live = false; };
  }, [liveNonce, retryNonce]);

  // A workflow.run re-reads authoritative next_run (a fired slot advances the schedule)
  // and records the run for the drawer's history.
  const lastEventRef = useRef<RuntimeEvent | null>(null);
  useEffect(() => {
    if (!lastEvent || lastEvent === lastEventRef.current) return;
    lastEventRef.current = lastEvent;
    if (lastEvent.name !== "workflow.run") return;
    const id = typeof lastEvent.data.id === "string" ? lastEvent.data.id : "";
    const status = typeof lastEvent.data.status === "string" ? lastEvent.data.status : "dispatched";
    if (!id) return;
    setHistory((h) => ({ ...h, [id]: [{ at: Date.now(), status }, ...(h[id] ?? [])].slice(0, 20) }));
    setRetryNonce((n) => n + 1);
  }, [lastEvent]);

  const scoped = useMemo(
    () => (rows === null ? null : venture ? rows.filter((c) => c.venture === venture) : rows),
    [rows, venture],
  );
  const buckets = useMemo(() => (scoped ? scheduleBuckets(scoped, nowMs) : []), [scoped, nowMs]);
  const scopeLabel = (venture ?? "all ventures").toUpperCase();
  const open = openId && scoped ? scoped.find((c) => c.id === openId) ?? null : null;
  const onChanged = useCallback(() => setRetryNonce((n) => n + 1), []);

  // The "now" hairline sits before the first bucket whose fire time is still ahead.
  const nowIndex = buckets.findIndex((b) => b.items[0].at > nowMs);

  return (
    <div className="bos-deck bos-sched">
      <BosTopbar
        eyebrow={`TODAY'S WATCH · ${scopeLabel}`}
        title="Schedule"
        chips={
          <span className="bos-sched-day helm-mono" title="Day navigation lands in a later phase — this is today, UTC">
            ‹ {dayLabel(nowMs)} · UTC ›
          </span>
        }
      />

      {error ? (
        <p className="bos-wf-note helm-mono">
          schedule unavailable — runtime not reachable{" "}
          <button type="button" className="bos-vault-retry" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button>
        </p>
      ) : scoped === null ? (
        <p className="bos-wf-note helm-mono">reading…</p>
      ) : buckets.length === 0 ? (
        <p className="bos-wf-note helm-mono">Nothing scheduled — the stations rest.</p>
      ) : (
        <ol className="bos-sched-timeline" aria-label="Today's scheduled cadences (UTC)">
          {buckets.map((b, bi) => (
            <li key={`${b.hour}-${bi}`} className="bos-sched-bucket">
              {bi === nowIndex && (
                <div className="bos-sched-now" aria-hidden>
                  <span className="bos-sched-now-dot" />
                  <span className="bos-sched-now-line" />
                </div>
              )}
              <span className="bos-sched-time helm-mono">{b.label}</span>
              <div className="bos-sched-items">
                {b.items.map((it) => (
                  <button
                    key={it.cadence.id}
                    type="button"
                    className="bos-sched-item"
                    onClick={() => setOpenId(it.cadence.id)}
                    aria-label={`${skillLabel(it.cadence.skill)} — ${stationName(it.cadence.agent)}`}
                  >
                    <span className="bos-sched-item-title">{skillLabel(it.cadence.skill)}</span>
                    <span className="bos-sched-item-meta helm-mono">
                      {stationName(it.cadence.agent)} · {it.cadence.skill}
                    </span>
                  </button>
                ))}
              </div>
            </li>
          ))}
          {nowIndex === -1 && (
            <li className="bos-sched-bucket" aria-hidden>
              <div className="bos-sched-now">
                <span className="bos-sched-now-dot" />
                <span className="bos-sched-now-line" />
              </div>
              <span className="bos-sched-time helm-mono bos-sched-time--faint">now</span>
              <div className="bos-sched-items" />
            </li>
          )}
        </ol>
      )}

      {open && (
        <WorkflowDrawer
          cadence={open}
          now={nowMs}
          history={history[open.id] ?? []}
          onClose={() => setOpenId(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

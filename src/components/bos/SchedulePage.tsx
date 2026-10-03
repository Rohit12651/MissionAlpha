// B4 — the Schedule page (nav id `schedule`). Phase G (ADR G-2): the approved mockup's
// `data-page="schedule"` — today's watch, hour by hour: one `.tl` card of `.tl-row`s (time ·
// station · state chip) with the orange `.nowline` before the first slot still ahead. A row
// opens the same WorkflowDrawer as Workflows.
//
// LAZY BY CONSTRUCTION (App React.lazy) — kept out of the main index chunk.
//
// D-7: every row is a real cadence at its UTC hour (watchSlots); a slot claims "done" only
// when the runtime fired THAT slot without an error, and a paused or off-day weekly slot
// says so instead of "upcoming". On-demand cadences carry no slot. NO innerHTML anywhere.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTick } from "../../lib/ticker";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import { listCadences, stationName, watchSlots, type Cadence, type SlotState } from "../../lib/cadenceClient";
import { stationInitials } from "../../lib/stationMeta";
import { BosTopbar } from "./BosTopbar";
import { WorkflowDrawer, type RunEvent } from "./WorkflowDrawer";

export interface SchedulePageProps {
  venture: string | null;
  lastEvent: RuntimeEvent | null;
  liveNonce: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const two = (n: number) => String(n).padStart(2, "0");
const CHIP: Record<SlotState, string> = { done: "chip ok", failed: "chip bad", missed: "chip bad", "no record": "chip", upcoming: "chip", paused: "chip warn", "not today": "chip" };

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
  const slots = useMemo(() => (scoped ? watchSlots(scoped, nowMs) : []), [scoped, nowMs]);
  const open = openId && scoped ? scoped.find((c) => c.id === openId) ?? null : null;
  const onChanged = useCallback(() => setRetryNonce((n) => n + 1), []);

  // The now line sits before the first slot still ahead of today's UTC clock (the mockup's rule).
  const hNow = (nowMs % DAY_MS) / HOUR_MS;
  const at = slots.findIndex((s) => s.hour > hNow);
  const nowText = `${two(Math.floor(hNow))}:${two(Math.floor((hNow % 1) * 60))}`;
  const nowLine = (
    <div className="nowline" key="now" role="separator" aria-label={`Now ${nowText}`}><span>{`now ${nowText}`}</span><i /></div>
  );
  const rowEls = slots.map((s) => (
    <div className="tl-row" key={`${s.cadence.id}-${s.hour}`}>
      <time>{`${two(s.hour)}:00`}</time>
      <button className="row-btn" type="button" onClick={() => setOpenId(s.cadence.id)}>
        <span className="ava" aria-hidden="true">{stationInitials(s.cadence.agent)}</span>
        <span><b>{s.title}</b><span className="sub" style={{ display: "block" }}>{stationName(s.cadence.agent)}</span></span>
        <span className={CHIP[s.state]}>{s.state}</span>
      </button>
    </div>
  ));
  const timeline = at < 0 ? [...rowEls, nowLine] : [...rowEls.slice(0, at), nowLine, ...rowEls.slice(at)];

  return (
    <section className="page" aria-labelledby="h-schedule">
      <BosTopbar
        eyebrow={`Automation · ${venture ?? "All ventures"}`}
        title="Schedule"
        tagline="today's watch, hour by hour"
        headingId="h-schedule"
        clock
        chips={<span className="chip" title="Times are UTC, the clock the cadences run on">Today's watch</span>}
      />
      {error ? (
        <div className="empty-note"><span className="script">Not reachable.</span><br />{"The runtime did not answer. "}<button type="button" className="linkish" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button></div>
      ) : scoped === null ? (
        <div className="empty-note" role="status">Reading the watch…</div>
      ) : slots.length === 0 ? (
        <div className="empty-note"><span className="script">Nothing scheduled.</span><br />No station has a timed cadence in this venture.</div>
      ) : (
        <div className="card"><div className="tl">{timeline}</div></div>
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
    </section>
  );
}

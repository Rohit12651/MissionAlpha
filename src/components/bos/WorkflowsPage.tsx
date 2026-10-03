// B4 — the Workflows page (nav id `workflows`). The swarm's standing cadences as a live
// table: what runs, which station owns it, on what schedule, when it last ran and whether
// it is healthy. Row click opens the WorkflowDrawer (Run-now / Pause).
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so none of it — the page, the
// drawer, the confirm gate, its icons — is in the main index chunk (hard 194,560 B gz
// ceiling). The cadence client lives entirely behind this boundary.
//
// EVERY ROW IS REAL OR AN ADMITTED GAP: rows come from GET /runtime/cadence; a fetch
// failure renders a faint mono note + Retry (the vault/PolicyEditor pattern), never a
// fabricated table.
//
// LIVE: consumes the app-wide SSE subscription through `lastEvent`. A `workflow.run`
// frame updates the matching row's last-run/status in place (no refetch flash) and is
// reconciled by an authoritative re-read; `liveNonce` (bumped on every resync) triggers
// that read. NO innerHTML anywhere.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTick } from "../../lib/ticker";
import { agoLabel } from "../../lib/storiesClient";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import {
  cadenceLabel,
  cadenceRow,
  listCadences,
  type Cadence,
} from "../../lib/cadenceClient";
import { BosTopbar } from "./BosTopbar";
import { WorkflowDrawer, type RunEvent } from "./WorkflowDrawer";

export interface WorkflowsPageProps {
  /** The venture scope from the sidebar switcher; null = all ventures. */
  venture: string | null;
  /** Newest catalog frame from the app-wide SSE subscription. */
  lastEvent: RuntimeEvent | null;
  /** Bumped on every SSE resync — triggers the authoritative re-read. */
  liveNonce: number;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (n: number) => String(n).padStart(2, "0");

/** The mockup's cadence words: "Daily · 02:00"; a weekly row names its day from next_run.
 *  All times on this page are UTC, the clock the cadence hour is defined on. */
function cadenceText(c: Cadence): string {
  const h = c.hour === null || c.hour === undefined ? "" : `${two(c.hour)}:00`;
  if (c.expr === "weekly" && c.next_run !== null) return `${DAY[new Date(c.next_run).getUTCDay()]}${h ? ` · ${h}` : ""}`;
  const base = cadenceLabel(c);
  return base.charAt(0) + base.slice(1).toLowerCase();
}

/** The mockup's Next column: paused, an hour slot, or "in N min" when it is close. */
function nextText(c: Cadence, now: number): string {
  if (!c.enabled) return "paused";
  if (c.next_run === null) return "on demand";
  const d = c.next_run - now;
  if (d <= 0) return "due now";
  if (d < 3_600_000) return `in ${Math.max(1, Math.round(d / 60_000))} min`;
  const at = new Date(c.next_run);
  return `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
}

export function WorkflowsPage({ venture, lastEvent, liveNonce }: WorkflowsPageProps) {
  const nowMs = useTick();
  const [rows, setRows] = useState<Cadence[] | null>(null);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  // Per-cadence recent runs, built from the live workflow.run tail (newest first).
  const [history, setHistory] = useState<Record<string, RunEvent[]>>({});

  // ── authoritative read (mount · SSE resync · Retry · post-write) ───────────
  useEffect(() => {
    let live = true;
    setError(false);
    listCadences()
      .then((r) => { if (live) setRows(r.cadences ?? []); })
      .catch(() => { if (live) { setRows(null); setError(true); } });
    return () => { live = false; };
  }, [liveNonce, retryNonce]);

  // ── live tail: a workflow.run updates the row in place + records history ────
  const lastEventRef = useRef<RuntimeEvent | null>(null);
  useEffect(() => {
    if (!lastEvent || lastEvent === lastEventRef.current) return;
    lastEventRef.current = lastEvent;
    if (lastEvent.name !== "workflow.run") return;
    const id = typeof lastEvent.data.id === "string" ? lastEvent.data.id : "";
    const status = typeof lastEvent.data.status === "string" ? lastEvent.data.status : "dispatched";
    if (!id) return;
    const at = Date.now();
    setHistory((h) => ({ ...h, [id]: [{ at, status }, ...(h[id] ?? [])].slice(0, 20) }));
    setRows((prev) => (prev === null ? prev : prev.map((c) => (c.id === id ? { ...c, last_run: at, last_status: status } : c))));
    // then reconcile authoritative next_run/last_run
    setRetryNonce((n) => n + 1);
  }, [lastEvent]);

  const scoped = useMemo(
    () => (rows === null ? null : venture ? rows.filter((c) => c.venture === venture) : rows),
    [rows, venture],
  );
  const activeCount = scoped ? scoped.filter((c) => c.enabled).length : 0;
  const open = openId && scoped ? scoped.find((c) => c.id === openId) ?? null : null;

  const onChanged = useCallback(() => setRetryNonce((n) => n + 1), []);

  // Phase G (ADR G-2): the mockup's Workflows page — one `table.tbl` of cadences; a row
  // opens the workflow drawer.
  return (
    <section className="page" aria-labelledby="h-workflows">
      <BosTopbar
        eyebrow={`Automation · ${venture ?? "All ventures"}`}
        title="Workflows"
        tagline="the standing cadences"
        headingId="h-workflows"
        clock
        chips={<span className="chip" data-app-only="active-count">{scoped === null ? "—" : `${activeCount} active`}</span>}
      />
      {error ? (
        <div className="empty-note"><span className="script">Not reachable.</span><br />{"The runtime did not answer. "}<button type="button" className="linkish" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button></div>
      ) : scoped === null ? (
        <div className="empty-note" role="status">Reading the cadences…</div>
      ) : scoped.length === 0 ? (
        <div className="empty-note"><span className="script">Nothing scheduled.</span><br />The stations have no standing cadence in this venture yet.</div>
      ) : (
        <div className="card table-wrap">
          <table className="tbl">
            <caption className="sr">Standing cadences</caption>
            <thead><tr><th scope="col">Workflow</th><th scope="col">Cadence</th><th scope="col">Owner</th><th scope="col">Last run</th><th scope="col">Next</th><th scope="col">State</th></tr></thead>
            <tbody>
              {scoped.map((c) => {
                const vm = cadenceRow(c, nowMs);
                const openRow = () => setOpenId(c.id);
                return (
                  <tr key={c.id} className="click" tabIndex={0} aria-label={`${vm.name}, ${vm.station}, ${vm.cadence}`} onClick={openRow}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRow(); } }}>
                    <td><b>{vm.name}</b></td>
                    <td>{cadenceText(c)}</td>
                    <td>{vm.station}</td>
                    <td title={vm.status.label}><span className={c.last_run === null ? "dot muted" : c.last_status === "error" ? "dot bad" : "dot ok"} style={{ display: "inline-block", marginRight: 6 }} />{c.last_run !== null && <span className="sr-only">{c.last_status === "error" ? "failed, " : `${c.last_status ?? "ran"}, `}</span>}{c.last_run === null ? "never" : agoLabel(c.last_run)}</td>
                    <td>{nextText(c, nowMs)}</td>
                    {/* The mockup's state is the schedule's own (active / paused); how the last
                        run went is the dot beside "Last run". */}
                    <td><span className={c.enabled ? "chip ok" : "chip warn"}>{c.enabled ? "active" : "paused"}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <WorkflowDrawer cadence={open} now={nowMs} history={history[open.id] ?? []} onClose={() => setOpenId(null)} onChanged={onChanged} />}
    </section>
  );
}

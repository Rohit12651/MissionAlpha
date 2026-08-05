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
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import {
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
  const scopeLabel = (venture ?? "all ventures").toUpperCase();
  const open = openId && scoped ? scoped.find((c) => c.id === openId) ?? null : null;

  const onChanged = useCallback(() => setRetryNonce((n) => n + 1), []);

  return (
    <div className="bos-deck bos-wf">
      <BosTopbar
        eyebrow={`AUTOMATION · ${scopeLabel}`}
        title="Workflows"
        chips={
          <span className="helm-chip" data-tone={activeCount > 0 ? "green" : "muted"}>
            ● {scoped === null ? "—" : `${activeCount} active`}
          </span>
        }
      />

      {error ? (
        <p className="bos-wf-note helm-mono">
          workflows unavailable — runtime not reachable{" "}
          <button type="button" className="bos-vault-retry" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button>
        </p>
      ) : scoped === null ? (
        <p className="bos-wf-note helm-mono">reading…</p>
      ) : scoped.length === 0 ? (
        <p className="bos-wf-note helm-mono">no cadences in this venture — the stations have nothing scheduled here yet</p>
      ) : (
        <div className="bos-wf-table" role="table" aria-label="Workflow cadences">
          <div className="bos-wf-row bos-wf-row--head" role="row">
            <span role="columnheader" className="helm-mono">WORKFLOW</span>
            <span role="columnheader" className="helm-mono">STATION</span>
            <span role="columnheader" className="helm-mono">CADENCE</span>
            <span role="columnheader" className="helm-mono">LAST RUN</span>
            <span role="columnheader" className="helm-mono">STATUS</span>
          </div>
          {scoped.map((c) => {
            const vm = cadenceRow(c, nowMs);
            return (
              <button
                key={c.id}
                type="button"
                role="row"
                className="bos-wf-row bos-wf-row--data"
                onClick={() => setOpenId(c.id)}
                aria-label={`${vm.name} — ${vm.station}, ${vm.cadence}`}
              >
                <span role="cell" className="bos-wf-cell-name">{vm.name}</span>
                <span role="cell" className="bos-wf-cell-station helm-mono">{vm.station}</span>
                <span role="cell" className="bos-wf-cell-cadence helm-mono">{vm.cadence}</span>
                <span role="cell" className="bos-wf-cell-last helm-mono">{vm.lastRun}</span>
                <span role="cell" className="bos-wf-cell-status">
                  <span className="helm-chip" data-tone={vm.status.tone}>● {vm.status.label}</span>
                </span>
              </button>
            );
          })}
        </div>
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

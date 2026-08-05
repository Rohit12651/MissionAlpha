// B5 — the Command Center's ventures panel. One row per venture (name · records ·
// pending); clicking a row sets the app-wide scope, so choosing here re-scopes every
// open BOS surface (the whole point of the phase). Presentational — the container hands
// it the roster and the setter.
//
// HONESTY: `records` is the venture's live vault size; `pending` is the CROSS-VENTURE
// pending-delivery count (deliveries have no venture column in v1), so it is the same on
// every row. The column header says so rather than implying a per-venture split. The
// empty state names the single venture instead of pretending there is a list.

import { venturesEmptyState, type VentureKpi } from "../../lib/kpiClient";

export interface VenturesPanelProps {
  ventures: readonly VentureKpi[];
  /** The current scope, or null for "All ventures" (the reset row). */
  current: string | null;
  /** Choose a scope — null clears back to all ventures. */
  onChoose: (venture: string | null) => void;
}

export function VenturesPanel({ ventures, current, onChoose }: VenturesPanelProps) {
  const empty = venturesEmptyState(ventures);
  return (
    <section className="bos-center-panel" aria-labelledby="bos-center-ventures-title">
      <header className="bos-center-panel-head">
        <h2 id="bos-center-ventures-title" className="bos-center-panel-title">Ventures</h2>
        <span className="bos-center-panel-sub helm-mono">records · pending (all ventures)</span>
      </header>

      {empty ? (
        <p className="bos-center-empty helm-mono">{empty}</p>
      ) : (
        <div className="bos-center-vlist" role="list">
          {/* All-ventures reset row — the honest "no filter" scope. */}
          <button
            type="button"
            role="listitem"
            className="bos-center-vrow"
            data-current={current === null ? "true" : undefined}
            aria-current={current === null ? "true" : undefined}
            onClick={() => onChoose(null)}
          >
            <span className="bos-center-vname">All ventures</span>
            <span className="bos-center-vmeta helm-mono">no filter</span>
          </button>
          {ventures.map((v) => (
            <button
              key={v.id}
              type="button"
              role="listitem"
              className="bos-center-vrow"
              data-current={current === v.id ? "true" : undefined}
              aria-current={current === v.id ? "true" : undefined}
              onClick={() => onChoose(v.id)}
              title={`Scope every surface to ${v.name || v.id}`}
            >
              <span className="bos-center-vname">{v.name || v.id}</span>
              <span className="bos-center-vmeta helm-mono">
                <span className="bos-center-vrecords">{v.records}</span>
                <span aria-hidden className="bos-center-vdot">·</span>
                <span className="bos-center-vpending">{v.pending}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

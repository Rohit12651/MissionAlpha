// B5 — the ventures list. Phase G (ADR G-2, D-7): the mockup's Ventures card, one
// `.row-btn` per venture: a glow (amber while anything waits), the name, "N active · M
// need you", and "scope →". Choosing a row re-scopes the whole app (ventureScope); the
// sidebar switcher is where the scope is cleared, as in the mockup.
//
// "N active" has no per-venture source (jobs carry no venture column, v1) → "—", a
// logged Phase G gap. "M need you" is the venture's pending count from /runtime/bos/kpis.

import type { VentureKpi } from "../../lib/kpiClient";

export interface VenturesPanelProps {
  /** null while loading; the error flag wins over it. */
  ventures: readonly VentureKpi[] | null;
  error: boolean;
  /** The current scope, or null for every venture. */
  current: string | null;
  onChoose: (venture: string) => void;
  onRetry: () => void;
}

export function VenturesPanel({ ventures, error, current, onChoose, onRetry }: VenturesPanelProps) {
  const shown = (ventures ?? []).filter((v) => !current || v.id === current);
  return (
    <div className="card">
      <div className="card-h"><h2>Ventures</h2><span className="sub">scoped by the switcher</span></div>
      <ul className="list">
        {error ? (
          <li className="empty-note">
            <span className="script">Not reachable.</span><br />
            {"The runtime did not answer. "}<button type="button" className="linkish" onClick={onRetry}>Retry</button>
          </li>
        ) : ventures === null ? (
          <li className="empty-note">Reading the ventures…</li>
        ) : shown.length === 0 ? (
          <li className="empty-note"><span className="script">No ventures yet.</span><br />The vault creates one with its first record.</li>
        ) : (
          shown.map((v) => (
            <li key={v.id}>
              <button className="row-btn" type="button" onClick={() => onChoose(v.id)} title={`Scope every surface to ${v.name || v.id}`}>
                <span className={`glow${v.pending > 0 ? " amber" : ""}`} aria-hidden="true" />
                <span>
                  <b>{v.name || v.id}</b>
                  <span className="sub" style={{ display: "block" }}>{`— active · ${v.pending} need you`}</span>
                </span>
                <span className="sub">scope →</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

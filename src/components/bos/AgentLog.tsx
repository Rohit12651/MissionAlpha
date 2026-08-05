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
import { PILL_LABEL, PILL_TONE, type LogRow } from "../../lib/briefClient";

export interface AgentLogProps {
  /** Newest-first rows, or null while the first read is in flight. */
  rows: LogRow[] | null;
  error: boolean;
  onRetry: () => void;
  /** Deep-link a needs-review row into the Inbox with that delivery selected. */
  onOpenDelivery: (deliveryId: string) => void;
}

export function AgentLog({ rows, error, onRetry, onOpenDelivery }: AgentLogProps) {
  // The LEAF subscribes to the shared 1s tick (ticker.tsx) so the ages count live
  // without re-rendering the console input beside it — the same rule LiveFeed follows.
  const nowMs = useTick();

  return (
    <section className="bos-brief-log" aria-labelledby="bos-brief-log-title">
      <div className="bos-brief-log-head">
        <h3 id="bos-brief-log-title" className="bos-brief-h3">Agent log</h3>
        <span className="helm-chip">Last 24h</span>
      </div>

      {error ? (
        <p className="bos-vault-note helm-mono">
          could not read the log{" "}
          <button type="button" className="bos-vault-retry" onClick={onRetry}>Retry</button>
        </p>
      ) : rows === null ? (
        <p className="bos-vault-note helm-mono">reading…</p>
      ) : rows.length === 0 ? (
        <p className="bos-vault-note helm-mono">Quiet watch — nothing logged yet.</p>
      ) : (
        <ul className="bos-brief-rows">
          {rows.map((r) => (
            <li key={r.key} className="bos-brief-row">
              <span className="bos-brief-agent helm-mono">{r.agent}</span>
              <span className="bos-brief-row-main">
                <span className="bos-brief-row-title">{r.title}</span>
                <span className="bos-brief-row-meta helm-mono">
                  {r.kind}
                  {r.venture ? ` · ${r.venture}` : ""}
                </span>
              </span>
              {r.pill === "needs-review" && r.deliveryId ? (
                <button
                  type="button"
                  className="helm-chip bos-brief-pill-cta"
                  data-tone={PILL_TONE[r.pill]}
                  onClick={() => onOpenDelivery(r.deliveryId as string)}
                  title="Open this delivery in the Inbox"
                >
                  {PILL_LABEL[r.pill]} →
                </button>
              ) : (
                <span className="helm-chip" data-tone={PILL_TONE[r.pill]}>{PILL_LABEL[r.pill]}</span>
              )}
              <span className="bos-brief-row-age helm-mono">{formatRelative(r.ts, nowMs)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

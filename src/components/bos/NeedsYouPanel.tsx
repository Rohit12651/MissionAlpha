// B5 — the Command Center's "needs you" panel: the top pending deliveries, so the
// cross-venture home surfaces what is waiting on a decision without leaving for the
// Inbox. Clicking a row deep-links into the Inbox with that delivery selected (the B3
// initialSelectedId plumb). Presentational — the container fetches, this renders.
//
// HONESTY: the rows are the REAL pending deliveries (inboxClient list), not a fixture.
// An empty list says "all clear" rather than inventing work; a fetch failure shows a
// retry, never a fabricated queue.

import { avatarFor, sourceLabel, type Delivery } from "../../lib/inboxClient";

export interface NeedsYouPanelProps {
  /** Top pending deliveries (already limited by the container). */
  deliveries: readonly Delivery[];
  error: boolean;
  /** Deep-link into the Inbox with this delivery selected (B3 initialSelectedId). */
  onOpen: (id: string) => void;
  onRetry: () => void;
}

export function NeedsYouPanel({ deliveries, error, onOpen, onRetry }: NeedsYouPanelProps) {
  return (
    <section className="bos-center-panel" aria-labelledby="bos-center-needs-title">
      <header className="bos-center-panel-head">
        <h2 id="bos-center-needs-title" className="bos-center-panel-title">Needs you</h2>
        <span className="bos-center-panel-sub helm-mono">pending decisions</span>
      </header>

      {error ? (
        <div className="bos-center-needs-error">
          <p className="bos-center-empty helm-mono">inbox unavailable — runtime not reachable</p>
          <button type="button" className="bos-center-retry helm-mono" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : deliveries.length === 0 ? (
        <p className="bos-center-empty helm-mono">Nothing needs you — all clear.</p>
      ) : (
        <div className="bos-center-needs" role="list">
          {deliveries.map((d) => (
            <button
              key={d.id}
              type="button"
              role="listitem"
              className="bos-center-needs-row"
              onClick={() => onOpen(d.id)}
              title={`Open “${d.title}” in the Inbox`}
            >
              <span className="bos-center-needs-avatar helm-mono" aria-hidden>{avatarFor(d.agentId)}</span>
              <span className="bos-center-needs-body">
                <span className="bos-center-needs-title">{d.title}</span>
                <span className="bos-center-needs-meta helm-mono">
                  {d.agentId} · {sourceLabel(d.source)}
                </span>
              </span>
              <span className="bos-center-needs-cue" aria-hidden>→</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

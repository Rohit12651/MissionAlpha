// B5 — the top of the REAL pending queue. Phase G (ADR G-2, D-7): the mockup's Needs-you
// card — an avatar, the title, "<kind> · <station>", and the SLA countdown — deep-linking
// into the Inbox with the item selected.

import { useEffect, useState } from "react";
import type { Delivery } from "../../lib/inboxClient";
import { inboxKindOf, slaText } from "../../lib/inboxTally";
import { stationById, stationInitials } from "../../lib/stationMeta";

export interface NeedsYouPanelProps {
  /** Top pending deliveries (already limited by the container). */
  deliveries: readonly Delivery[];
  /** Every pending item — the "N waiting" count, not just the ones listed. */
  waiting: number;
  error: boolean;
  onOpen: (id: string) => void;
  onRetry: () => void;
}

function useSecond(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function NeedsYouPanel({ deliveries, waiting, error, onOpen, onRetry }: NeedsYouPanelProps) {
  const now = useSecond(deliveries.some((d) => d.slaDeadline));
  return (
    <div className="card">
      <div className="card-h"><h2>Needs you</h2><span className="sub">{`${waiting} waiting`}</span></div>
      <ul className="list">
        {error ? (
          <li className="empty-note">
            <span className="script">Not reachable.</span><br />
            {"The Inbox did not answer. "}<button type="button" className="linkish" onClick={onRetry}>Retry</button>
          </li>
        ) : deliveries.length === 0 ? (
          <li className="empty-note"><span className="script">All clear.</span><br />Nothing waits for you.</li>
        ) : (
          deliveries.map((d) => {
            const sla = d.slaDeadline ? slaText(d.slaDeadline, now) : null;
            return (
              <li key={d.id}>
                <button className="row-btn" type="button" onClick={() => onOpen(d.id)}>
                  <span className="ava" aria-hidden="true">{stationInitials(d.agentId)}</span>
                  <span>
                    <b>{d.title}</b>
                    <span className="sub" style={{ display: "block" }}>{`${inboxKindOf(d.kind)} · ${stationById(d.agentId)?.name ?? d.agentId}`}</span>
                  </span>
                  {sla && <span className="sla">{sla}</span>}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

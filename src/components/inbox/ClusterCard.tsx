// Collapsed failure cluster (Phase 2, excellence program).
//
// WHY THIS EXISTS — measured on the live runtime: the queue strip reads
// `tech-lead · 27 fail`, `sr-backend · 23 fail`, `sr-frontend · 19 fail`, ... (97 total)
// and the Inbox rendered them as ~20 near-identical cards. One root cause, twenty human
// decisions. This card is ONE decision for the whole signature.
//
// DELIBERATELY NOT a DeliveryCard variant: it decides N deliveries at once, so it must
// look different from a card that decides exactly one. It reuses the same `helm-card`
// shell and chip vocabulary so it still reads as part of the same list.
import { useState } from "react";
import type { Delivery } from "../../lib/inboxClient";
import { stationInitials } from "../../lib/stationMeta";
import { DeliveryCard } from "./DeliveryCard";

export function ClusterCard({
  agentId,
  reason,
  size,
  members,
  busy,
  selectedId,
  onSelect,
  onDismissAll,
}: {
  agentId: string;
  reason: string;
  size: number;
  members: readonly Delivery[];
  busy: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDismissAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Phase G: APP-ONLY grouping (the mockup lists a failure cluster as one row), drawn as the
  // mockup's list row: an 18px spacer where a checkbox would sit, then a `.dcard`.
  return (
    <li data-app-only="failure-cluster" style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: 8, alignItems: "start" }}>
      <span style={{ display: "block", width: 18 }} />
      <div className="dcard" style={{ cursor: "default" }}>
        <span className="l1">
          <span className="ava" aria-hidden="true">{stationInitials(agentId)}</span>
          <span className="chip">cluster</span>
          <b>{`${agentId} is stuck · ${reason}`}</b>
          {/* The number is the whole point: it names how much noise this one row absorbs. */}
          <span className="chip bad" aria-label={`${size} identical failures`}>{`×${size}`}</span>
        </span>
        <span className="l2">
          <span className="chip warn">repeated failure</span>
          <span>{`${size} identical failures · one decision`}</span>
        </span>
        <span className="row">
          <button type="button" className="btn btn-outline" disabled={busy} onClick={onDismissAll}>{busy ? "Dismissing…" : `Dismiss all ${size}`}</button>
          <button type="button" className="btn btn-ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Hide" : `Show ${size}`}</button>
        </span>
        {/* Expanded: the real individual deliveries, each still independently decidable.
            Collapsing is a VIEW, never a loss of access to the underlying records. */}
        {open && (
          <ul className="list" style={{ borderTop: "1px solid var(--hair)", paddingTop: 8 }}>
            {members.map((m) => <DeliveryCard key={m.id} delivery={m} selected={m.id === selectedId} onSelect={onSelect} />)}
          </ul>
        )}
      </div>
    </li>
  );
}

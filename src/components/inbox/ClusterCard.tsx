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
import { avatarFor } from "../../lib/inboxClient";
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

  return (
    <div className="helm-card mb-2.5" data-cluster="true">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="helm-avatar" aria-hidden>{avatarFor(agentId)}</span>

        <span className="helm-display min-w-0 flex-1 text-[13.5px] leading-snug">
          {agentId} is stuck — {reason}
        </span>

        {/* The number is the whole point: it names how much noise this one row absorbs. */}
        <span className="helm-chip ml-auto" data-tone="red" aria-label={`${size} identical failures`}>
          ×{size}
        </span>
      </div>

      <div className="mt-[7px] flex flex-wrap items-center gap-2.5">
        <span className="helm-chip" data-tone="amber">repeated failure</span>
        <span className="helm-note text-[11.5px]">
          {size} identical failures · one decision
        </span>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="helm-btn"
          data-variant="reject"
          disabled={busy}
          onClick={onDismissAll}
        >
          {busy ? "Dismissing…" : `Dismiss all ${size}`}
        </button>
        <button
          type="button"
          className="helm-btn"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide" : `Show ${size}`}
        </button>
      </div>

      {/* Expanded: the real individual deliveries, each still independently decidable.
          Collapsing is a VIEW, never a loss of access to the underlying records. */}
      {open && (
        <div className="mt-2.5 border-t pt-2.5" style={{ borderColor: "var(--helm-line)" }}>
          {members.map((m) => (
            <DeliveryCard
              key={m.id}
              delivery={m}
              selected={m.id === selectedId}
              onSelect={onSelect}
              animate={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}

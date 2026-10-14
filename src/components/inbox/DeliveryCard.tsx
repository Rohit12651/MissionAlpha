import { decidedLabel, isPending, isReadOnly, sourceLabel, type Delivery } from "../../lib/inboxClient";
import { inboxKindOf, isBulkSelectable } from "../../lib/inboxTally";
import { stationById, stationInitials } from "../../lib/stationMeta";
import { trustChip, injectionChip } from "../../lib/externalTrust";
import { RiskChip } from "./RiskChip";
import { SlaTimer, HOT_MS } from "./SlaTimer";

/*
  One Delivery row. Phase G (ADR G-2): the mockup's Inbox list item — a checkbox (or an
  18px spacer when the row cannot be bulk-approved), then a `.dcard` button: avatar, kind
  chip, title and the SLA countdown; then the risk chip, the diffstat and "<ref> · <station>".
  The card is a <button> with aria-pressed, so selection is never colour-only. The app's
  source / injection / trust / branch / decided markers are kept (app-only), in the same
  `.chip` vocabulary.
*/
export function DeliveryCard({ delivery: d, selected, onSelect, bulkSelected = false, onBulkToggle }: {
  delivery: Delivery;
  selected: boolean;
  onSelect: (id: string) => void;
  bulkSelected?: boolean;
  /** Phase 3 — multi-select. Undefined = this row is not bulk-selectable. */
  onBulkToggle?: (id: string, shift: boolean) => void;
}) {
  const pending = isPending(d);
  const files = d.diffstat.files;
  const ref = d.storyId ?? d.jobId ?? null;
  const station = stationById(d.agentId)?.name ?? d.agentId;
  const trust = trustChip(d.externalMeta?.trust);
  const inject = injectionChip(d.externalMeta?.injectFlags);
  const selectable = onBulkToggle && isBulkSelectable(d);
  return (
    <li style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: 8, alignItems: "start" }}>
      {selectable ? (
        <input
          type="checkbox"
          aria-label={`Select ${d.title}`}
          checked={bulkSelected}
          onChange={() => {}}
          onClick={(e) => onBulkToggle(d.id, e.shiftKey)}
          style={{ marginTop: 16, width: 18, height: 18, accentColor: "var(--brand)" }}
        />
      ) : (
        <span style={{ display: "block", width: 18 }} />
      )}
      <button className="dcard" type="button" aria-pressed={selected} onClick={() => onSelect(d.id)}>
        <span className="l1">
          <span className="ava" aria-hidden="true">{stationInitials(d.agentId)}</span>
          <span className="chip">{inboxKindOf(d.kind)}</span>
          <b>{d.title}</b>
          {pending ? <SlaTimer deadline={d.slaDeadline} hotUnderMs={HOT_MS} /> : <span className={d.status === "rejected" ? "chip bad" : "chip ok"} data-app-only="decided">{decidedLabel(d.status)}</span>}
        </span>
        <span className="l2">
          <RiskChip band={d.risk.band} />
          {files > 0 && (
            <span className="mono">{`${files} files `}<span className="add">{`+${d.diffstat.additions}`}</span>{" "}<span className="del">{`−${d.diffstat.deletions}`}</span></span>
          )}
          {d.source !== "swarm" && <span className="chip" data-app-only="source">{`${sourceLabel(d.source)}${isReadOnly(d) ? " · read-only" : ""}`}</span>}
          {inject && <span className={`chip ${inject.tone === "red" ? "bad" : "warn"}`} title={inject.title} data-app-only="injection">{inject.label}</span>}
          {trust && <span className={trust.tone === "red" ? "chip bad" : trust.tone === "amber" ? "chip warn" : "chip"} title={trust.title} data-app-only="trust">{trust.label}</span>}
          <span>{ref ? `${ref} · ${station}` : station}</span>
          {d.branch && <span className="mono" title={d.branch} data-app-only="branch">{d.branch}</span>}
        </span>
      </button>
    </li>
  );
}

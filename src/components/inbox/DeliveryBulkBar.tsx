/*
  Phase 3 — bulk decision. Phase G (ADR G-2): the mockup's `.bulkbar` — "N selected",
  Approve selected, Clear, and the rule in words: high-risk items are never offered for a
  bulk approve (isBulkSelectable), they need a typed APPLY in the review pane. Always
  shown, as the mockup shows it ("0 selected", Approve disabled); a refused batch shows
  the runtime's reason inline, never a silent no-op.
*/
export function DeliveryBulkBar({ count, busy, error, onApprove, onReject, onClear }: {
  count: number;
  busy: boolean;
  /** Server refusal text. */
  error?: string | null;
  onApprove: () => void;
  /** APP-ONLY: the mockup offers approve only; the app keeps bulk reject. */
  onReject: () => void;
  onClear: () => void;
}) {
  return (
    <div className="bulkbar" role="region" aria-label="Bulk decision">
      <b>{`${count} selected`}</b>
      <button className="btn btn-primary" type="button" disabled={busy} aria-busy={busy || undefined} onClick={onApprove}>
        {busy ? "Approving…" : "Approve selected"}
      </button>
      <button className="btn btn-ghost" type="button" disabled={busy || count === 0} data-app-only="bulk-reject" onClick={onReject}>Reject selected</button>
      <button className="btn btn-ghost" type="button" disabled={busy} onClick={onClear}>Clear</button>
      <span style={{ fontSize: ".8125rem", opacity: 0.85 }}>High-risk items are skipped: they need a typed APPLY.</span>
      {error && <span role="alert" style={{ fontSize: ".8125rem", flexBasis: "100%" }}>{error}</span>}
    </div>
  );
}

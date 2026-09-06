// Bulk decision bar (Phase 3, excellence program).
//
// Appears only when a selection exists. Mirrors the shape of the shipped BulkActionBar
// (used by the agent board) so the two read as the same product, but talks to
// /inbox/bulk-decide.
//
// SECURITY — the high-risk path is deliberately awkward. The single-delivery review pane
// makes a human type a confirm phrase before approving high-risk work; bulk must not
// become the way around that. So: when the selection contains ANY high-risk delivery,
// Approve is disabled until the operator ticks an explicit confirmation, and the server
// independently refuses the batch without `confirmHighRisk` (belt AND braces — the
// client control is convenience, the server gate is the actual protection).
export function DeliveryBulkBar({
  count,
  highRiskCount,
  confirmHighRisk,
  busy,
  error,
  onConfirmHighRiskChange,
  onApprove,
  onReject,
  onClear,
}: {
  count: number;
  highRiskCount: number;
  confirmHighRisk: boolean;
  busy: boolean;
  /** Server refusal text. Shown inline — a refused batch must never look like a no-op. */
  error?: string | null;
  onConfirmHighRiskChange: (v: boolean) => void;
  onApprove: () => void;
  onReject: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;
  const approveBlocked = highRiskCount > 0 && !confirmHighRisk;

  return (
    <div className="helm-card mb-2.5" data-bulkbar="true" role="region" aria-label="Bulk decision">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="helm-display text-[13px]">
          {count} selected
        </span>

        {highRiskCount > 0 && (
          <span className="helm-chip" data-tone="red">
            {highRiskCount} high risk
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="helm-btn"
            data-variant="approve"
            disabled={busy || approveBlocked}
            title={approveBlocked ? "Confirm high-risk approval first" : undefined}
            onClick={onApprove}
          >
            {busy ? "Working…" : `Approve ${count}`}
          </button>
          <button type="button" className="helm-btn" data-variant="reject" disabled={busy} onClick={onReject}>
            Reject {count}
          </button>
          <button type="button" className="helm-btn" data-variant="quiet" disabled={busy} onClick={onClear}>
            Clear
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="helm-note mt-2.5 text-[12px]" style={{ color: "var(--helm-red)" }}>
          {error}
        </p>
      )}

      {highRiskCount > 0 && (
        <label className="mt-2.5 flex items-start gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={confirmHighRisk}
            onChange={(e) => onConfirmHighRiskChange(e.target.checked)}
            aria-label="Confirm high-risk bulk approval"
          />
          <span className="helm-note">
            I understand {highRiskCount} of these {highRiskCount === 1 ? "is" : "are"} high risk.
            Approving in bulk skips the per-delivery review; the runtime refuses this batch
            without an explicit confirmation.
          </span>
        </label>
      )}
    </div>
  );
}

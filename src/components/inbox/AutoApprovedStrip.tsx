import { useCallback, useEffect, useState } from "react";
import { listInbox, type Delivery } from "../../lib/inboxClient";
import { RiskChip } from "./RiskChip";

/*
  P6 / ADR-053 — the auto-approved strip.

  Collapsed by default: a one-line "N auto-approved under policy — audited" summary, so
  auto-applied work is present in the Inbox (the spec's requirement) without pushing
  pending decisions down the list. Expanding fetches the auto_approved rows and shows,
  per delivery, the band + the risk reasons + who applied it (`policy`) — the audit
  trail the operator needs to trust the automation.

  When the count is zero it says so plainly and never fabricates an "auto-approved
  today" number.
*/
export function AutoApprovedStrip({ count, refreshNonce }: { count: number; refreshNonce?: number }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    listInbox({ status: "auto_approved", limit: 50 })
      .then((r) => setRows(r.deliveries ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  // Fetch when opened, and re-fetch on a parent nonce bump (a new auto-apply arrived).
  useEffect(() => { if (open) load(); }, [open, load, refreshNonce]);

  if (count <= 0) {
    return <div className="helm-dashed mt-2.5">Auto-approve is off. Every delivery waits for your decision.</div>;
  }

  return (
    <div className="helm-dashed mt-2.5">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden style={{ color: "var(--helm-green)" }}>✓</span>
        <b style={{ color: "var(--helm-green)" }}>{count} auto-approved</b>
        <span style={{ color: "var(--helm-paper-dim)" }}>under policy — audited</span>
        <span className="helm-mono ml-auto text-[11px]" style={{ color: "var(--helm-paper-faint)" }}>
          {open ? "hide" : "show"}
        </span>
      </button>

      {open && (
        <ul className="mt-2 flex list-none flex-col gap-1.5" aria-label="Auto-approved deliveries">
          {loading && !rows ? (
            <li className="helm-note" role="status">Reading the audit trail…</li>
          ) : rows && rows.length ? (
            rows.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                <RiskChip band={d.risk.band} />
                <span className="helm-display">{d.title}</span>
                <span className="helm-mono text-[11px]" style={{ color: "var(--helm-paper-faint)" }}>
                  {d.agentId} · by {d.decidedBy ?? "policy"}
                </span>
                {d.risk.reasons.length > 0 && (
                  <span className="helm-mono text-[11px]" style={{ color: "var(--helm-paper-dim)" }}>
                    {d.risk.reasons.join(", ")}
                  </span>
                )}
              </li>
            ))
          ) : (
            <li className="helm-note">No auto-approved deliveries in the retention window.</li>
          )}
        </ul>
      )}
    </div>
  );
}

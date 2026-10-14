import { useCallback, useEffect, useState } from "react";
import { listInbox, type Delivery } from "../../lib/inboxClient";
import { stationById } from "../../lib/stationMeta";

/*
  P6 / ADR-053 — the auto-approved list. Phase G (ADR G-2): the mockup's collapsed
  "Auto-approved" <details> card, rows as `.feed-row`. Opening it reads the auto_approved
  rows: who applied each (`policy`) and why the band allowed it — the audit trail the
  operator needs to trust the automation. The count is the runtime's real tally (D-7: the
  mockup says "today"; the runtime counts the retention window, so the sub says neither).
  At zero it says plainly that every delivery waits for a human.
*/
const two = (n: number) => String(n).padStart(2, "0");
const hhmm = (iso: string | null) => { if (!iso) return ""; const d = new Date(iso); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

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
  useEffect(() => { if (open && count > 0) load(); }, [open, count, load, refreshNonce]);
  return (
    <details className="card" style={{ marginTop: 24 }} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="card-h" style={{ cursor: "pointer", listStyle: "none", margin: 0 }}>
        <h2>Auto-approved</h2>
        <span className="sub">{count > 0 ? `${count} under policy · audited` : "auto-approve is off · every delivery waits for you"}</span>
      </summary>
      <ul className="list" style={{ marginTop: 12 }} aria-label="Auto-approved deliveries">
        {count <= 0 ? (
          <li className="empty-note">Nothing is applied without you.</li>
        ) : loading && !rows ? (
          <li className="empty-note" role="status">Reading the audit trail…</li>
        ) : rows && rows.length ? (
          rows.map((d) => (
            <li key={d.id} className="feed-row" title={d.risk.reasons.join(", ") || undefined}>
              <span className="dot ok" />
              <span>{d.title} <span className="sub">{`· ${stationById(d.agentId)?.name ?? d.agentId} · by ${d.decidedBy ?? "policy"}`}</span></span>
              <time dateTime={d.decidedAt ?? undefined}>{hhmm(d.decidedAt)}</time>
            </li>
          ))
        ) : (
          <li className="empty-note">No auto-approved deliveries in the retention window.</li>
        )}
      </ul>
    </details>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  INSUFFICIENT_DATA,
  LEDGER_WINDOWS,
  durationLabel,
  getAgentLedger,
  rateLabel,
  rateTone,
  sortLedger,
  spendCell,
  getSpend,
  type AgentLedger as Ledger,
  type SpendSummary,
  type LedgerSort,
  type LedgerWindow,
} from "../../lib/ledgerClient";

/*
  PHASE 6 — the per-agent performance ledger, on the Agents deck.

  WHAT IT ANSWERS: which agents to trust, retune, or retire. Every number is computed by
  the runtime from rows that already exist in SQLite (agent-ledger.mjs) — no new writes,
  no schema change, nothing inferred.

  THE HONESTY RULE IS THE FEATURE, and it is enforced three times over:
    1. the runtime returns `approvalRate: null` below 5 decisions;
    2. `rateLabel()` refuses a percentage for any non-finite or out-of-range value;
    3. unrated rows SINK when sorting by rate, in both directions — ranking a no-data
       agent next to a genuinely failing one is the same lie told with position.
  An unrated agent reads "insufficient data" and is styled muted, because an absence of
  evidence is not a warning.

  NO SPARKLINE. The plan sketched one. There is no per-day history in the payload, and the
  only way to draw a trend from a single aggregate is to invent the points — which this
  program forbids outright. Recorded as a known gap with the shape of the real fix
  (a bucketed endpoint), not quietly dropped.
*/

export interface AgentLedgerPanelProps {
  /** Bumped when a decision lands, so the table re-reads without a refresh. */
  refreshNonce: number;
}

const COLUMNS: { key: LedgerSort | null; label: string; title: string }[] = [
  { key: null, label: "Agent", title: "The agent that produced the work" },
  { key: "delivered", label: "Delivered", title: "Deliveries minted in this window" },
  { key: "approvalRate", label: "Approved", title: "Approved ÷ decided. Needs 5 decisions before a rate is shown" },
  { key: "failures", label: "Failures", title: "Agent-stuck rows. Never counted as a code decision" },
  { key: "medianDecisionMs", label: "Median wait", title: "Median time from delivery to decision" },
  // Phase 7. Not sortable: on a subscription plan every cell reads "included", so a sort
  // control here would be an affordance that does nothing most of the time.
  { key: null, label: "Spend", title: "Real cost for API-key accounts. A subscription plan has no per-turn price" },
];

export function AgentLedgerPanel({ refreshNonce }: AgentLedgerPanelProps) {
  const [window, setWindow] = useState<LedgerWindow>("7d");
  const [data, setData] = useState<Ledger | null>(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<LedgerSort>("delivered");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  // Phase 7 — spend rides alongside, from its own gated route. A failure here leaves the
  // column blank rather than blocking the ledger: the two are independent truths.
  const [spend, setSpend] = useState<SpendSummary | null>(null);

  useEffect(() => {
    let live = true;
    setError(false);
    getAgentLedger(window)
      .then((d) => {
        if (!live) return;
        // An `error` body is a real refusal (a malformed window), not data. Showing the
        // previous window's numbers under a new label would be worse than showing none.
        if (d.error) { setData(null); setError(true); } else setData(d);
      })
      .catch(() => { if (live) { setData(null); setError(true); } });
    return () => { live = false; };
  }, [window, refreshNonce]);

  useEffect(() => {
    let live = true;
    getSpend(window)
      .then((d) => { if (live) setSpend(d.error ? null : d); })
      .catch(() => { if (live) setSpend(null); });
    return () => { live = false; };
  }, [window, refreshNonce]);

  const rows = useMemo(() => sortLedger(data?.agents ?? [], sort, dir), [data, sort, dir]);

  const toggleSort = useCallback((key: LedgerSort) => {
    setSort((prev) => {
      if (prev === key) { setDir((d) => (d === "desc" ? "asc" : "desc")); return prev; }
      setDir("desc");
      return key;
    });
  }, []);

  return (
    <section className="bos-ledger" aria-label="Agent ledger">
      <header className="bos-ledger-head">
        <h2 className="bos-ledger-title">Agent ledger</h2>
        <label className="sr-only" htmlFor="ledger-window">Ledger window</label>
        <select
          id="ledger-window"
          className="helm-input bos-ledger-window"
          value={window}
          onChange={(e) => setWindow(e.target.value as LedgerWindow)}
        >
          {LEDGER_WINDOWS.map((w) => (
            <option key={w} value={w}>{w === "24h" ? "last 24h" : `last ${w.replace("d", " days")}`}</option>
          ))}
        </select>
      </header>

      {error ? (
        <p className="bos-ledger-empty helm-mono">ledger unavailable — runtime not reachable</p>
      ) : data === null ? (
        <p className="bos-ledger-empty helm-mono">reading the ledger…</p>
      ) : rows.length === 0 ? (
        <p className="bos-ledger-empty helm-mono">No deliveries in this window.</p>
      ) : (
        <div className="bos-ledger-scroll">
          <table className="bos-ledger-table">
            <caption className="sr-only">
              {`Per-agent delivery outcomes for the ${window} window. An agent with fewer than ${data.minDecisionsForRate} decisions shows "${INSUFFICIENT_DATA}" instead of an approval rate.`}
            </caption>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.label}
                    scope="col"
                    title={c.title}
                    aria-sort={c.key && sort === c.key ? (dir === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {c.key ? (
                      <button type="button" className="bos-ledger-sort" onClick={() => toggleSort(c.key as LedgerSort)}>
                        {c.label}
                        <span aria-hidden="true">{sort === c.key ? (dir === "asc" ? " ↑" : " ↓") : ""}</span>
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.agentId}>
                  <th scope="row" className="bos-ledger-agent helm-mono">{r.agentId}</th>
                  <td>{r.delivered}</td>
                  <td>
                    <span className="bos-ledger-rate" data-tone={rateTone(r)}>{rateLabel(r)}</span>
                    {r.rated ? (
                      <span className="bos-ledger-sub">{` ${r.approved + r.autoApproved}/${r.decisions}`}</span>
                    ) : (
                      <span className="bos-ledger-sub">{` ${r.decisions} decided`}</span>
                    )}
                  </td>
                  <td>{r.failures}</td>
                  <td>{durationLabel(r.medianDecisionMs)}</td>
                  <td className="bos-ledger-spend">
                    {spendCell(spend?.agents.find((a) => a.agentId === r.agentId), spend?.activeMetered ?? false)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && rows.length > 0 ? (
        <p className="bos-ledger-foot">
          {`An agent needs ${data.minDecisionsForRate} decisions before a rate is shown. Auto-approved counts as approved; agent-stuck rows do not count as decisions.`}
          {spend?.activeMetered
            ? " Spend is the provider's own reported cost; turns it did not price are excluded."
            : " This account is a flat-rate subscription, so turns have no per-turn price."}
          {/* The caveat is NOT optional when the batch is mixed: a total that silently
              omits unpriced turns is a false statement about the period. */}
          {spend?.mixed ? ` ${spend.unpricedTurns} metered turn(s) arrived with no cost figure and are not in any total.` : ""}
        </p>
      ) : null}
    </section>
  );
}

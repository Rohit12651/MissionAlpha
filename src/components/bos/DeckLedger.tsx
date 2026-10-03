// Phase G (ADR G-2) — the Agents page's ledger: the approved mockup's `table.tbl` — one row
// per station: Agent, Tier, Model, Mode, Watch, Heartbeat, Spend today — sortable by
// name, model, heartbeat and spend, a row opening the station.
//
// D-7, every cell a real field: tier from state.json (in the mockup's tier words), mode from
// the station-perm store, watch from stationBadge(), heartbeat from heartbeatAt, spend from
// GET /runtime/spend (24h; "—" when unmetered or unknown, never $0.00), model from the
// operator's per-agent choice (loadAgentModel).
//
// APP-ONLY, kept: the Phase 6 delivery ledger (delivered, approval rate, failures, median
// decision time, 7-day window) rides along as extra columns marked data-app-only.

import { useEffect, useMemo, useState } from "react";
import type { AgentState, AgentTier } from "../../data/types";
import { BADGE_LABEL, stationBadge, stationById, stationInitials } from "../../lib/stationMeta";
import { durationLabel, getAgentLedger, getSpend, rateLabel, type AgentLedgerRow, type SpendSummary } from "../../lib/ledgerClient";
import { agoLabel } from "../../lib/storiesClient";
import { useStationPerm } from "../station/permStore";
import { PERM_WORD } from "./StationCard";
import { loadAgentModel } from "../../lib/agentModel";
import { tierLabel } from "../../lib/modelTiers";

type Sort = "name" | "model" | "beat" | "spend";
const TIER: Record<AgentTier, string> = { supreme: "captain", principal: "principal", senior: "senior", support: "worker" };
const nameOf = (a: AgentState) => stationById(a.id)?.name ?? a.id;
const beatOf = (a: AgentState) => (a.heartbeatAt ? Date.parse(a.heartbeatAt) : Number.NaN);

function Row({ agent, usd, ledger, onOpen }: { agent: AgentState; usd: number | null; ledger: AgentLedgerRow | undefined; onOpen: (id: string) => void }) {
  const perm = useStationPerm(agent.id);
  const open = () => onOpen(agent.id);
  return (
    <tr className="click" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}>
      <td><span className="row" style={{ gap: 8 }}><span className="ava" aria-hidden="true">{stationInitials(agent.id)}</span><b>{nameOf(agent)}</b></span></td>
      <td>{TIER[agent.tier] ?? agent.tier}</td>
      <td className="mono">{tierLabel(loadAgentModel(agent.id))}</td>
      <td>{perm ? PERM_WORD[perm.effective] ?? perm.effective : "—"}</td>
      <td><span className="chip">{BADGE_LABEL[stationBadge(agent)]}</span></td>
      <td>{agoLabel(beatOf(agent))}</td>
      <td className="num">{usd === null ? "—" : `$${usd.toFixed(2)}`}</td>
      <td data-app-only="ledger">{ledger?.delivered ?? "—"}</td>
      <td data-app-only="ledger">{ledger ? rateLabel(ledger) : "—"}</td>
      <td data-app-only="ledger">{ledger?.failures ?? "—"}</td>
      <td data-app-only="ledger">{ledger ? durationLabel(ledger.medianDecisionMs) : "—"}</td>
    </tr>
  );
}

export function DeckLedger({ agents, refreshNonce, onOpen }: { agents: readonly AgentState[]; refreshNonce: number; onOpen: (id: string) => void }) {
  const [sort, setSort] = useState<Sort>("name");
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [ledger, setLedger] = useState<AgentLedgerRow[]>([]);
  useEffect(() => {
    let live = true;
    getSpend("24h").then((d) => { if (live) setSpend(d.error ? null : d); }).catch(() => { if (live) setSpend(null); });
    getAgentLedger("7d").then((d) => { if (live) setLedger(d.error ? [] : d.agents); }).catch(() => { if (live) setLedger([]); });
    return () => { live = false; };
  }, [refreshNonce]);

  const usdOf = (id: string): number | null => (spend?.activeMetered ? spend.agents.find((a) => a.agentId === id)?.usd ?? null : null);
  const rows = useMemo(() => [...agents].sort((a, b) => {
    if (sort === "beat") return (beatOf(b) || 0) - (beatOf(a) || 0);
    if (sort === "spend") return (usdOf(b.id) ?? -1) - (usdOf(a.id) ?? -1);
    if (sort === "model") return tierLabel(loadAgentModel(a.id)).localeCompare(tierLabel(loadAgentModel(b.id))) || nameOf(a).localeCompare(nameOf(b));
    return nameOf(a).localeCompare(nameOf(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [agents, sort, spend]);

  const th = (key: Sort | null, label: string) => (
    <th scope="col" aria-sort={key ? (key === sort ? (key === "name" || key === "model" ? "ascending" : "descending") : "none") : undefined}>
      {key ? <button type="button" onClick={() => setSort(key)}>{label}</button> : label}
    </th>
  );
  return (
    <div className="card table-wrap">
      <table className="tbl">
        <caption className="sr">Every agent, its model, mode and spend today</caption>
        <thead>
          <tr>
            {th("name", "Agent")}{th(null, "Tier")}{th("model", "Model")}{th(null, "Mode")}{th(null, "Watch")}{th("beat", "Heartbeat")}{th("spend", "Spend today")}
            <th scope="col" data-app-only="ledger" title="Deliveries in the last 7 days">Delivered</th>
            <th scope="col" data-app-only="ledger" title="Approved share of decided deliveries, 7 days">Approval</th>
            <th scope="col" data-app-only="ledger">Failures</th>
            <th scope="col" data-app-only="ledger" title="Median time to a decision, 7 days">Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => <Row key={a.id} agent={a} usd={usdOf(a.id)} ledger={ledger.find((l) => l.agentId === a.id)} onOpen={onOpen} />)}
        </tbody>
      </table>
    </div>
  );
}

// S0 — one SE seat on the Command deck. Phase G (ADR G-2): the mockup's `.station` card —
// an icon well and the watch chip, "Station 0N · <role>", the name, the seat's blurb, then
// "<model> · <permission mode> · <heartbeat age>".
//
// Everything on the card is READ: the watch badge from stationBadge(), the mode from the
// station-perm store, the model from the operator's per-agent choice (loadAgentModel, the
// tier sent with that agent's next run), the age from heartbeatAt. A stale agent carries
// the mockup's "stuck" chip.

import { memo } from "react";
import type { AgentState } from "../../data/types";
import { BADGE_LABEL, stationBadge, type StationBadgeId, type StationDef } from "../../lib/stationMeta";
import { useStationPerm } from "../station/permStore";
import { agoLabel } from "../../lib/storiesClient";
import { loadAgentModel } from "../../lib/agentModel";
import { tierLabel } from "../../lib/modelTiers";

const CHIP: Record<StationBadgeId, string> = { on: "chip ok", standby: "chip warn", off: "chip" };
const DOT: Record<StationBadgeId, string> = { on: "dot ok live", standby: "dot warn", off: "dot muted" };
/** The mockup's permission words. */
export const PERM_WORD: Record<string, string> = { default: "Ask", acceptEdits: "Accept edits", bypassPermissions: "Bypass" };

/** The mockup's well icon, chosen by the seat's role. */
export function stationIcon(role: string): string {
  if (role === "Build") return "tools";
  if (role === "Testing" || role === "Code review") return "audit";
  if (role === "Monitor") return "center";
  if (role.startsWith("Release")) return "brief";
  if (role === "Orchestration") return "deck";
  return "stories";
}

export interface StationCardProps {
  agent: AgentState;
  /** The seeded seat this card is, or null for a swarm agent. */
  station: StationDef | null;
  /** Position in deck order — drives "Station 0N". */
  index: number;
  onOpen: (agent: AgentState, station: StationDef | null) => void;
}

export const StationCard = memo(function StationCard({ agent, station, index, onOpen }: StationCardProps) {
  const badge = stationBadge(agent);
  const perm = useStationPerm(agent.id);
  const name = station?.name ?? agent.id;
  const role = station?.role ?? agent.role ?? "agent";
  const beat = agent.heartbeatAt ? Date.parse(agent.heartbeatAt) : Number.NaN;
  return (
    <button type="button" className={badge === "on" ? "station on" : "station"} onClick={() => onOpen(agent, station)} title={agent.task ?? undefined}>
      <span className="row" style={{ justifyContent: "space-between", width: "100%" }}>
        <span className="well"><svg aria-hidden="true"><use href={`#i-${stationIcon(role)}`} /></svg></span>
        <span className={CHIP[badge]}><span className={DOT[badge]} />{BADGE_LABEL[badge]}</span>
      </span>
      <span className="sub">{`Station ${String(index + 1).padStart(2, "0")} · ${role}`}</span>
      <h3>{name}</h3>
      <p>{station?.blurb ?? agent.task ?? role}</p>
      <span className="meta" style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: ".6875rem", color: "var(--ink-3)" }}>
        <span className="mono">{tierLabel(loadAgentModel(agent.id))}</span>·<span>{perm ? PERM_WORD[perm.effective] ?? perm.effective : "—"}</span>·<span>{agoLabel(beat)}</span>
        {agent.stale && <span className="chip warn">stuck</span>}
      </span>
    </button>
  );
});

// S0 — one SE seat on the Command deck.
//
// Everything on this card is READ from the live state feed: the badge comes from the
// shipped column vocabulary via stationBadge(), and the note is the agent's own task
// line when it has one. Where there is no truth to show, the card says the honest
// thing (the seat's standing brief) rather than inventing activity.

import { memo } from "react";
import { Bot, ClipboardList, Code2, Compass, FileText, GitPullRequest, Radar, Rocket, ShieldCheck, Layers, type LucideIcon } from "lucide-react";
import type { AgentState } from "../../data/types";
import { BADGE_LABEL, BADGE_TONE, stationBadge, stationOrdinal, type StationDef } from "../../lib/stationMeta";

/** Seat id → its icon. A swarm agent (no station def) falls back to the generic bot. */
const STATION_ICON: Record<string, LucideIcon> = {
  "tech-lead": Compass,
  "pm-analyst": ClipboardList,
  "architect": Layers,
  "sr-backend": Code2,
  "sr-frontend": Code2,
  "reviewer": GitPullRequest,
  "qa": ShieldCheck,
  "devops": Rocket,
  "sre": Radar,
  "docs-writer": FileText,
};

export interface StationCardProps {
  agent: AgentState;
  /** The seeded seat this card is, or null for a swarm agent. */
  station: StationDef | null;
  /** Position in deck order — drives the STATION 0N eyebrow. */
  index: number;
  onOpen: (agent: AgentState, station: StationDef | null) => void;
}

export const StationCard = memo(function StationCard({ agent, station, index, onOpen }: StationCardProps) {
  const badge = stationBadge(agent);
  const Icon = STATION_ICON[agent.id] ?? Bot;
  const name = station?.name ?? agent.id;
  const role = station?.role ?? agent.role ?? "agent";
  // The agent's own last activity line when the feed carries one; otherwise the
  // seat's standing brief. Never a fabricated status sentence.
  const note = agent.task ?? station?.blurb ?? role;

  return (
    <button
      type="button"
      className="bos-deck-station"
      onClick={() => onOpen(agent, station)}
      aria-label={`${name} — ${role} — ${BADGE_LABEL[badge]}`}
    >
      <span className="bos-deck-station-head">
        <span className="bos-deck-well" aria-hidden>
          <Icon size={17} />
        </span>
        <span className="helm-chip" data-tone={BADGE_TONE[badge]}>
          {BADGE_LABEL[badge]}
        </span>
      </span>
      <span className="bos-deck-station-ord helm-mono">{stationOrdinal(index)}</span>
      <span className="bos-deck-station-name">{name}</span>
      <span className="bos-deck-station-role helm-mono">{role}</span>
      <span className="bos-deck-station-note">{note}</span>
    </button>
  );
});

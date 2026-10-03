// Phase G (ADR G-2) — the Missions page: the approved mockup's `data-page="missions"`.
// A roster card, the board (State: stations by watch; Pipeline: jobs by status, as the
// mockup draws it) and the Tech Lead chat card, in the mockup's `.missions` grid (200px ·
// board · 400px; the chat drops under the board below 1280px, everything stacks below 760px).
//
// D-7: every card is a real station from state.json; the model is the operator's per-agent
// choice (loadAgentModel); the mockup's loop step is the agent's real task (or next step).

import { memo, type ReactNode } from "react";
import type { AgentState, AgentTier } from "../../data/types";
import type { BoardView } from "../ViewToggle";
import { BADGE_LABEL, deckOrder, stationBadge, stationById, stationInitials, type StationBadgeId } from "../../lib/stationMeta";
import { agoLabel } from "../../lib/storiesClient";
import { loadAgentModel } from "../../lib/agentModel";
import { tierLabel } from "../../lib/modelTiers";
import { BosTopbar } from "../bos/BosTopbar";
import { Kcol } from "../bos/Kcol";
import { JobColumns } from "../board/JobBoard";

const WATCH_DOT: Record<StationBadgeId, string> = { on: "ok", standby: "warn", off: "muted" };
const WATCH_COLS: readonly [StationBadgeId, string][] = [["on", "On watch"], ["standby", "Standing by"], ["off", "Off watch"]];
/** The mockup's tier vocabulary over the runtime's tiers. */
const TIER: Record<AgentTier, string> = { supreme: "captain", principal: "principal", senior: "senior", support: "worker" };

const nameOf = (a: AgentState) => stationById(a.id)?.name ?? a.id;
const beatMs = (a: AgentState) => (a.heartbeatAt ? Date.parse(a.heartbeatAt) : Number.NaN);

const StationCard = memo(function StationCard({ agent, onOpen }: { agent: AgentState; onOpen?: (id: string) => void }) {
  const tier = TIER[agent.tier] ?? agent.tier;
  return (
    <button className="kcard" type="button" disabled={!onOpen} onClick={() => onOpen?.(agent.id)}>
      <span className="meta"><span className="chip"><span className={`dot t-${tier}`} />{tier}</span><span className="mono">{tierLabel(loadAgentModel(agent.id))}</span></span>
      <h3>{nameOf(agent)}</h3>
      <span className="meta">{`${agent.task ?? agent.next ?? "standing by"} · ${agoLabel(beatMs(agent))}`}</span>
    </button>
  );
});

export interface MissionsPageProps {
  agents: AgentState[];
  view: BoardView;
  onView: (v: BoardView) => void;
  /** Undefined while replaying: a reconstructed past is not inspectable. */
  onOpenAgent?: (id: string) => void;
  onAddAgents: () => void;
  venture: string | null;
  jobNonce: number;
  /** The Tech Lead chat card (RightPanel). */
  chat: ReactNode;
}

export function MissionsPage({ agents, view, onView, onOpenAgent, onAddAgents, venture, jobNonce, chat }: MissionsPageProps) {
  const ordered = deckOrder(agents);
  const onWatch = ordered.filter((a) => stationBadge(a) === "on").length;
  return (
    <section className="page" aria-labelledby="h-missions">
      <BosTopbar
        eyebrow={`Missions · ${venture ?? "All ventures"}`}
        title="Missions"
        tagline="talk to the tech lead, watch the seats"
        headingId="h-missions"
        clock
        chips={
          <div className="seg" aria-label="Board view">
            {(["state", "pipeline"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => onView(v)}>{v === "state" ? "State" : "Pipeline"}</button>
            ))}
          </div>
        }
      />
      <div className="missions">
        <div className="card roster">
          <div className="card-h"><span className="sub">Roster</span><span className="sub">{`${onWatch}/${ordered.length} on watch`}</span></div>
          <div>
            {ordered.map((a) => {
              const badge = stationBadge(a);
              return (
                <button key={a.id} className="r-row" type="button" disabled={!onOpenAgent} onClick={() => onOpenAgent?.(a.id)}>
                  <span className="ava" aria-hidden="true">{stationInitials(a.id)}</span>
                  <span><b>{nameOf(a)}</b><small>{stationById(a.id)?.role ?? a.role}</small></span>
                  <span className={`dot ${WATCH_DOT[badge]}${badge === "on" ? " live" : ""}`} title={BADGE_LABEL[badge]} />
                </button>
              );
            })}
            {/* APP-ONLY: hire stations through the Agent Factory. */}
            <button type="button" className="pill" data-app-only="add-agents" style={{ marginTop: 8 }} onClick={onAddAgents}>Add agents</button>
          </div>
        </div>
        <div className="kb-scroll">
          {view === "state" ? (
            <div className="kb">
              {WATCH_COLS.map(([k, label]) => {
                const col = ordered.filter((a) => stationBadge(a) === k);
                return (
                  <Kcol key={k} label={label} count={col.length}>
                    {col.map((a) => <StationCard key={a.id} agent={a} onOpen={onOpenAgent} />)}
                  </Kcol>
                );
              })}
            </div>
          ) : (
            <JobColumns liveNonce={jobNonce} hideBlocked />
          )}
        </div>
        {chat}
      </div>
    </section>
  );
}

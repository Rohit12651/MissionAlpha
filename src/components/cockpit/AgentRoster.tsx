// Agent roster (mission-control redesign) — a compact, calm STATUS list of the
// real swarm agents (ids straight from state.json — never renamed). Click/Enter
// opens the read-only inspect drawer. Not chats. Reference: Linear/Intercom left rail.

import { memo } from "react";
import type { AgentState } from "../../data/types";
import { agentAccent, formatAge, liveAgeSec, tok } from "../../lib/agentMeta";
import { useTick } from "../../lib/ticker";
import { loadAgentModel } from "../../lib/agentModel";
import { tierLabel } from "../../lib/modelTiers";

function initials(id: string): string {
  const parts = id.split(/[-_\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return id.slice(0, 2).toUpperCase();
}

const Row = memo(function Row({ agent, selected, onSelect }: { agent: AgentState; selected: boolean; onSelect: (id: string) => void }) {
  const now = useTick();
  const accent = tok(agentAccent(agent));
  const age = formatAge(liveAgeSec(agent, now));
  const dotPulse = !agent.dead && !agent.stale && agent.column === "in_progress";
  return (
    <button
      type="button"
      onClick={() => onSelect(agent.id)}
      aria-label={`Inspect ${agent.id}`}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-panel-2/60 focus-visible:ring-2"
      style={{ backgroundColor: selected ? "color-mix(in oklch, var(--c-accent-cyan) 12%, transparent)" : "transparent", opacity: agent.dead ? 0.5 : 1 }}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold"
        style={{ color: accent, backgroundColor: `color-mix(in oklch, ${accent} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${accent} 30%, transparent)` }}
      >
        {initials(agent.id)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium leading-tight">{agent.id}</span>
        <span className="flex items-center gap-1.5 text-[10px] leading-tight text-muted">
          <span className="truncate">{agent.role || "agent"}</span>
          <span className="shrink-0 rounded font-mono text-[8px] uppercase tracking-wide"
            style={{ padding: "0 4px", color: tok("accent-cyan"), backgroundColor: `color-mix(in oklch, ${tok("accent-cyan")} 12%, transparent)` }}
            title="Model (set in the agent's drawer)">
            {tierLabel(loadAgentModel(agent.id))}
          </span>
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: accent, boxShadow: dotPulse ? `0 0 6px 1px ${accent}` : "none" }}
          aria-hidden
        />
        <span className="font-mono text-[9px] tabular-nums text-muted">{age}</span>
      </span>
    </button>
  );
});

export const AgentRoster = memo(function AgentRoster({
  agents,
  selectedId,
  onSelect,
}: {
  agents: AgentState[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <nav aria-label="Agents" className="flex h-full flex-col gap-0.5 overflow-y-auto p-2">
      <div className="px-2 pb-1.5 pt-1 text-[9px] font-medium uppercase tracking-[0.08em] text-muted">
        {agents.length} agent{agents.length === 1 ? "" : "s"}
      </div>
      {agents.length === 0 ? (
        <p className="px-2 py-4 text-[11px] text-muted">No agents yet.</p>
      ) : (
        agents.map((a) => <Row key={a.id} agent={a} selected={a.id === selectedId} onSelect={onSelect} />)
      )}
    </nav>
  );
});

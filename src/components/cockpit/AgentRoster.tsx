// Agent roster (mission-control redesign) — a compact, calm STATUS list of the
// real swarm agents (ids straight from state.json — never renamed). Click/Enter
// opens the read-only inspect drawer. Not chats. Reference: Linear/Intercom left rail.

import { memo, useState } from "react";
import { Plus, Trash2, Square } from "lucide-react";
import type { AgentState } from "../../data/types";
import { agentAccent, formatAge, liveAgeSec, tok } from "../../lib/agentMeta";
import { useTick } from "../../lib/ticker";
import { loadAgentModel } from "../../lib/agentModel";
import { tierLabel } from "../../lib/modelTiers";
import { removableKind } from "../../lib/agentActions";
import { runtimeUrl } from "../../lib/runtimeBase";
import { runtimeToken } from "../../lib/runtimeToken";

// Stop a running agent — kills its claude -p child (POST /runtime/:id/stop, auth-gated).
// The CEO card maps to the "boss" chat id (the cockpit chats boss, aliased onto the ceo card).
async function stopAgent(id: string): Promise<void> {
  const target = id === "ceo" ? "boss" : id;
  try {
    const token = await runtimeToken();
    await fetch(runtimeUrl(`/runtime/${encodeURIComponent(target)}/stop`), {
      method: "POST",
      headers: { "x-runtime-token": token },
    });
  } catch {
    /* child may already be done */
  }
}

function initials(id: string): string {
  const parts = id.split(/[-_\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return id.slice(0, 2).toUpperCase();
}

const Row = memo(function Row({ agent, selected, onSelect }: { agent: AgentState; selected: boolean; onSelect: (id: string) => void }) {
  const now = useTick();
  const [stopping, setStopping] = useState(false);
  const accent = tok(agentAccent(agent));
  const age = formatAge(liveAgeSec(agent, now));
  const live = !agent.dead && agent.column === "in_progress";
  const dotPulse = !agent.dead && !agent.stale && agent.column === "in_progress";
  const canRemove = removableKind(agent) !== "none";

  async function onStop(e: React.MouseEvent) {
    e.stopPropagation();
    if (stopping) return;
    setStopping(true);
    await stopAgent(agent.id);
    // poll flips the card out of in_progress; reset the local flag shortly after.
    window.setTimeout(() => setStopping(false), 1500);
  }

  // Removal is F3-gated in the agent drawer (single confirm path, one audit story).
  // The roster button is a shortcut that opens the drawer on this agent.
  function onManage(e: React.MouseEvent) {
    e.stopPropagation();
    onSelect(agent.id);
  }

  return (
    <div className="group relative">
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
      {/* Stop — always visible while the agent is live (urgent control). */}
      {live && (
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          aria-label={`Stop ${agent.id}`}
          title="Stop (interrupt)"
          className="absolute top-1.5 inline-flex items-center justify-center rounded p-1 text-white outline-none transition-transform focus-visible:ring-2 active:scale-95 disabled:opacity-50"
          style={{ right: canRemove ? "28px" : "6px", backgroundColor: tok("stale-red") }}
        >
          <Square size={10} fill="currentColor" aria-hidden />
        </button>
      )}
      {/* Remove — on hover, for imported/factory agents only (never ceo/built-ins).
          Opens the drawer, where the removal is confirmed through the F3 PermissionGate. */}
      {canRemove && (
        <button
          type="button"
          onClick={onManage}
          aria-label={`Manage ${agent.id} — remove from the board`}
          title="Manage / remove"
          className="absolute right-1.5 top-1.5 hidden rounded p-1 outline-none transition-colors duration-150 hover:bg-panel-2 focus-visible:ring-2 group-hover:block motion-reduce:transition-none"
          style={{ color: tok("stale-red") }}
        >
          <Trash2 size={12} aria-hidden />
        </button>
      )}
    </div>
  );
});

export const AgentRoster = memo(function AgentRoster({
  agents,
  selectedId,
  onSelect,
  onAddAgents,
}: {
  agents: AgentState[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** F5 — opens the Agent Factory, the single home for putting an agent on the board. */
  onAddAgents?: () => void;
}) {
  return (
    <nav aria-label="Agents" className="flex h-full flex-col gap-0.5 overflow-y-auto p-2">
      <div className="flex items-center px-2 pb-1.5 pt-1">
        <span className="text-[9px] font-medium uppercase tracking-[0.08em] text-muted">
          {agents.length} agent{agents.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={onAddAgents}
          disabled={!onAddAgents}
          aria-label="Add agents — opens the Agent Factory"
          title="Add agents (opens the Agent Factory)"
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide outline-none transition-colors duration-150 hover:bg-panel-2 focus-visible:ring-2 disabled:cursor-default disabled:opacity-40 motion-reduce:transition-none"
          style={{ color: tok("accent-cyan") }}
        >
          <Plus size={11} aria-hidden /> Add
        </button>
      </div>
      {agents.length === 0 ? (
        <p className="px-2 py-4 text-[11px] text-muted">No agents yet.</p>
      ) : (
        agents.map((a) => <Row key={a.id} agent={a} selected={a.id === selectedId} onSelect={onSelect} />)
      )}
    </nav>
  );
});

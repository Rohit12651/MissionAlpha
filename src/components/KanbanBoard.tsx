import { memo, useMemo } from "react";
import { LayoutGroup } from "framer-motion";
import type { AgentState } from "../data/types";
import {
  COLUMN_ORDER,
  COLUMN_LABEL,
  COLUMN_ACCENT,
  PIPELINE_ORDER,
  PIPELINE_LABEL,
} from "../lib/agentMeta";
import { KanbanColumn } from "./KanbanColumn";
import type { BoardView } from "./ViewToggle";

// Pipeline stages borrow an accent from a representative column tone.
const STAGE_ACCENT: Record<string, string> = {
  strategy: "ceo-gold",
  "design-arch": "accent-cyan",
  build: "accent-cyan",
  qa: "blocked-amber",
  review: "accent-cyan",
  deploy: "done-green",
  memory: "muted",
};

/**
 * The board. Same agent set, two groupings:
 *  - state    → COLUMN_ORDER (idle → … → offline)
 *  - pipeline → PIPELINE_ORDER (strategy → … → memory)
 * A shared LayoutGroup means a card animates (glides) to its new column the
 * instant its state/stage changes between polls — the signature live moment.
 */
export const KanbanBoard = memo(function KanbanBoard({
  agents,
  view,
  onSelect,
}: {
  agents: AgentState[];
  view: BoardView;
  onSelect?: (id: string) => void;
}) {
  const columns = useMemo(() => {
    if (view === "state") {
      return COLUMN_ORDER.map((col) => ({
        key: col,
        label: COLUMN_LABEL[col],
        accent: COLUMN_ACCENT[col],
        agents: agents.filter((a) => a.column === col),
      }));
    }
    return PIPELINE_ORDER.map((stage) => ({
      key: stage,
      label: PIPELINE_LABEL[stage],
      accent: STAGE_ACCENT[stage] ?? "muted",
      agents: agents.filter((a) => a.pipelineStage === stage),
    }));
  }, [agents, view]);

  return (
    <LayoutGroup>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((c) => (
          <KanbanColumn
            key={c.key}
            label={c.label}
            accent={c.accent}
            agents={c.agents}
            onSelect={onSelect}
          />
        ))}
      </div>
    </LayoutGroup>
  );
});

import { memo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { AgentState } from "../data/types";
import { tok } from "../lib/agentMeta";
import { AgentCard } from "./AgentCard";

/**
 * One board column. Header shows label + live count with an accent underglow.
 * Cards animate in/out via AnimatePresence; cross-column glide is handled by
 * the shared layoutId on each AgentCard.
 */
export const KanbanColumn = memo(function KanbanColumn({
  label,
  accent,
  agents,
  onSelect,
}: {
  label: string;
  accent: string; // token name
  agents: AgentState[];
  onSelect?: (id: string) => void;
}) {
  const c = tok(accent);
  return (
    <section className="flex min-w-[230px] flex-1 flex-col">
      <header className="mb-3 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: c, boxShadow: `0 0 8px ${c}` }}
            aria-hidden
          />
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-text/90">
            {label}
          </h2>
        </div>
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[11px] tabular-nums"
          style={{
            color: c,
            backgroundColor: `color-mix(in oklch, ${c} 12%, transparent)`,
          }}
        >
          {agents.length}
        </span>
      </header>

      <div
        className="flex min-h-[120px] flex-1 flex-col gap-2.5 rounded-panel border border-border/60 p-2.5"
        style={{
          background: `linear-gradient(180deg, color-mix(in oklch, ${c} 4%, transparent), transparent 40%)`,
        }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {agents.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="grid flex-1 place-items-center py-6 text-[11px] text-muted/60"
            >
              —
            </motion.div>
          ) : (
            agents.map((a) => <AgentCard key={a.id} agent={a} onSelect={onSelect} />)
          )}
        </AnimatePresence>
      </div>
    </section>
  );
});

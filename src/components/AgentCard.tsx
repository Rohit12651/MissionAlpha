import { memo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Link2, FileCode2 } from "lucide-react";
import type { AgentState } from "../data/types";
import {
  agentAccent,
  formatAge,
  liveAgeSec,
  tok,
  TIER_ACCENT,
  TIER_LABEL,
} from "../lib/agentMeta";
import { useTick } from "../lib/ticker";
import { TtlRing } from "./TtlRing";
import { StateBadge } from "./StateBadge";

// Emil-rules motion: ease-out enter from scale .96, GPU transform/opacity only,
// ≤300ms; spring on layout glide between columns; reduced-motion → instant.
const EASE = [0.22, 1, 0.36, 1] as const;

// memo'd: parent columns re-render on each 2s poll, but a card only needs to
// re-render when its own agent object changes or the 1s tick fires (subscribed
// here at the leaf via useTick — keeps the live age counting without re-rendering
// the whole board or the globe).
export const AgentCard = memo(function AgentCard({
  agent,
  onSelect,
}: {
  agent: AgentState;
  onSelect?: (id: string) => void;
}) {
  const reduce = useReducedMotion();
  const nowMs = useTick();
  const age = liveAgeSec(agent, nowMs);
  const accent = agentAccent(agent);
  const accentVar = tok(accent);
  const overdue = !agent.dead && age !== null && age > agent.ttlSec;
  const active = !agent.dead && !agent.stale && agent.column === "in_progress";
  const tierAccent = TIER_ACCENT[agent.tier];

  // Active = breathing cyan glow. Stale = breathing red. Else static hairline.
  const glow =
    active || agent.stale
      ? {
          boxShadow: [
            `0 0 0 1px color-mix(in oklch, ${accentVar} 35%, transparent), 0 0 18px -6px ${accentVar}`,
            `0 0 0 1px color-mix(in oklch, ${accentVar} 55%, transparent), 0 0 30px -4px ${accentVar}`,
            `0 0 0 1px color-mix(in oklch, ${accentVar} 35%, transparent), 0 0 18px -6px ${accentVar}`,
          ],
        }
      : { boxShadow: `0 0 0 1px ${tok("border")}` };

  return (
    <motion.article
      layout
      layoutId={agent.id}
      initial={reduce ? false : { opacity: 0, scale: 0.96, y: 6 }}
      animate={{
        opacity: 1,
        scale: 1,
        y: 0,
        ...(reduce ? {} : glow),
      }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -6 }}
      transition={{
        layout: { type: "spring", stiffness: 380, damping: 34 },
        opacity: { duration: 0.22, ease: EASE },
        scale: { duration: 0.22, ease: EASE },
        boxShadow: { duration: 2.4, repeat: Infinity, ease: "easeInOut" },
      }}
      id={`agent-${agent.id}`}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={onSelect ? `Open details for ${agent.id}` : undefined}
      onClick={onSelect ? () => onSelect(agent.id) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(agent.id);
              }
            }
          : undefined
      }
      className="group relative cursor-pointer overflow-hidden rounded-[14px] bg-panel/80 backdrop-blur-sm outline-none transition-colors hover:bg-panel-2/70 focus-visible:ring-2 focus-visible:ring-accent-cyan data-[focus=true]:ring-2 data-[focus=true]:ring-ceo-gold"
      style={{ opacity: agent.dead ? 0.55 : 1, scrollMarginTop: "6rem" }}
    >
      {/* tier accent rail */}
      <span
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: tok(tierAccent), opacity: agent.dead ? 0.4 : 0.9 }}
        aria-hidden
      />

      <div className="flex items-start gap-3 px-4 py-3 pl-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-mono text-[13px] font-semibold">{agent.id}</h3>
            <span
              className="shrink-0 font-mono text-[9px] tracking-widest"
              style={{ color: tok(tierAccent), opacity: 0.7 }}
            >
              {TIER_LABEL[agent.tier]}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted">{agent.role}</p>

          <div className="mt-2.5">
            <StateBadge state={agent.state} accent={accent} />
          </div>

          {agent.task && (
            <p className="mt-2 line-clamp-2 text-[12px] leading-snug text-text/90">
              {agent.task}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
            {agent.blockedBy && (
              <span
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5"
                style={{
                  color: tok("blocked-amber"),
                  backgroundColor: `color-mix(in oklch, ${tok("blocked-amber")} 12%, transparent)`,
                }}
              >
                <Link2 size={11} /> blocked by {agent.blockedBy}
              </span>
            )}
            {agent.file && (
              <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                <FileCode2 size={11} className="shrink-0" />
                <span className="truncate">{agent.file}</span>
              </span>
            )}
          </div>
        </div>

        {/* TTL ring + live age */}
        <div className="flex shrink-0 flex-col items-center gap-1">
          <TtlRing ageSec={age} ttlSec={agent.ttlSec} accent={accent} overdue={overdue}>
            <span
              className="font-mono text-[10px] tabular-nums"
              style={{ color: overdue ? tok("stale-red") : tok("muted") }}
            >
              {formatAge(age)}
            </span>
          </TtlRing>
          {overdue && (
            <span className="font-mono text-[8px] uppercase tracking-wide text-stale-red">
              overdue
            </span>
          )}
        </div>
      </div>
    </motion.article>
  );
});

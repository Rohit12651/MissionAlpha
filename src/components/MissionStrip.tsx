import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, Activity, CheckCircle2, Hand } from "lucide-react";
import type { AgentState, Heartbeat, SchedulerHealth } from "../data/types";
import { tok } from "../lib/agentMeta";
import { compactAge } from "../lib/formatRelative";
import { useTick } from "../lib/ticker";
import { HeartbeatRibbon } from "./HeartbeatRibbon";

// Mission Strip — Phase 3 Option B status spine. One calm glass band under the
// header answering "does this need ME, is the swarm alive, is it pulsing" in a
// 2s glance. Three zones L→R: NEEDS-YOU pill · liveness cluster · pulse ribbon.
// Emil motion: single-channel boxShadow breathing on demand/stale, ≤300ms enter,
// GPU transform/opacity only, reduced-motion → static glow snapshot.

const EASE = [0.22, 1, 0.36, 1] as const;
const AWAITING = "AWAITING_USER_DECISION";

// ── Zone A: NEEDS-YOU ──────────────────────────────────────────────────────
function NeedsYou({
  pending,
  onFocusAgent,
  reduce,
}: {
  pending: AgentState[];
  onFocusAgent: (id: string) => void;
  reduce: boolean | null;
}) {
  const gold = tok("ceo-gold");

  if (pending.length === 0) {
    // Calm all-clear micro-state — subtle, never loud.
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-panel/60 px-3 py-1.5 text-xs text-muted">
        <CheckCircle2 size={13} className="text-done-green" aria-hidden />
        <span>all clear</span>
      </span>
    );
  }

  const names = pending.map((a) => a.id).join(", ");
  const lead = pending[0];
  const label =
    pending.length === 1
      ? lead.task ?? lead.role
      : `${pending.length} agents awaiting your call`;

  // A5: tiny "Next:" preview — surface the lead pending agent's intended next step
  // before the operator even opens the drawer. Single line, truncated, calm.
  const nextPreview = lead.next ?? null;

  return (
    <div className="flex flex-col items-start gap-1">
    <motion.button
      type="button"
      onClick={() => onFocusAgent(lead.id)}
      initial={reduce ? false : { opacity: 0, scale: 0.97 }}
      animate={
        reduce
          ? { opacity: 1 }
          : {
              opacity: 1,
              scale: 1,
              boxShadow: [
                `0 0 0 1px color-mix(in oklch, ${gold} 45%, transparent), 0 0 16px -4px ${gold}`,
                `0 0 0 1px color-mix(in oklch, ${gold} 70%, transparent), 0 0 28px -2px ${gold}`,
                `0 0 0 1px color-mix(in oklch, ${gold} 45%, transparent), 0 0 16px -4px ${gold}`,
              ],
            }
      }
      transition={{
        opacity: { duration: 0.24, ease: EASE },
        scale: { duration: 0.24, ease: EASE },
        boxShadow: { duration: 2.6, repeat: Infinity, ease: "easeInOut" },
      }}
      style={{
        backgroundColor: `color-mix(in oklch, ${gold} 12%, transparent)`,
        boxShadow: reduce
          ? `0 0 0 1px color-mix(in oklch, ${gold} 55%, transparent), 0 0 20px -4px ${gold}`
          : undefined,
      }}
      className="group inline-flex items-center gap-2.5 rounded-full px-3.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ceo-gold"
      aria-label={`Needs you: ${names}. ${label}`}
      title={`${names} — ${label}`}
    >
      <Hand size={14} style={{ color: gold }} aria-hidden />
      <span
        className="font-mono text-[11px] font-semibold uppercase tracking-widest"
        style={{ color: gold }}
      >
        Needs You
      </span>
      <span className="hidden h-3 w-px bg-border sm:inline-block" aria-hidden />
      <span className="hidden max-w-[15rem] truncate text-xs text-text/90 sm:inline">
        <span className="font-mono text-[11px]" style={{ color: gold }}>
          {names}
        </span>
        <span className="mx-1.5 text-muted">·</span>
        {label}
      </span>
    </motion.button>
    {nextPreview && (
      <span className="ml-1 inline-flex max-w-[18rem] items-center gap-1 truncate text-[10px] text-muted">
        <span className="font-mono uppercase tracking-wide text-muted/80">Next</span>
        <span className="text-muted/60" aria-hidden>·</span>
        <span className="truncate text-text/70">{nextPreview}</span>
      </span>
    )}
    </div>
  );
}

// ── Zone B: liveness cluster ───────────────────────────────────────────────
function Liveness({
  scheduler,
  reduce,
}: {
  scheduler: SchedulerHealth;
  reduce: boolean | null;
}) {
  // Live age of the last tick — subscribe to the shared 1s ticker at this leaf
  // so the "ticked Ns ago" counts up without re-rendering the whole strip/globe.
  const nowMs = useTick();
  const running = scheduler.running;
  const hasStale = scheduler.staleCount > 0;
  // Redundant encoding (Bloomberg a11y): the dot is green only when alive AND
  // no stale agents; otherwise it goes red/amber + carries a glyph + text.
  const dotToken = !running ? "stale-red" : hasStale ? "blocked-amber" : "done-green";
  const dotVar = tok(dotToken);
  const statusText = !running ? "scheduler offline" : hasStale ? "degraded" : "live";

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs"
      role="status"
      aria-live="polite"
      aria-label={`Swarm ${statusText}, ${scheduler.activeCount} active${
        hasStale ? `, ${scheduler.staleCount} stale` : ""
      }`}
    >
      {/* scheduler dot + status + last tick age */}
      <span className="inline-flex items-center gap-2">
        <motion.span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: dotVar }}
          animate={
            reduce
              ? { boxShadow: `0 0 8px 1px ${dotVar}` }
              : {
                  boxShadow: [
                    `0 0 6px 0px ${dotVar}`,
                    `0 0 12px 2px ${dotVar}`,
                    `0 0 6px 0px ${dotVar}`,
                  ],
                }
          }
          transition={
            reduce
              ? undefined
              : { duration: running && !hasStale ? 2.4 : 1.2, repeat: Infinity, ease: "easeInOut" }
          }
          aria-hidden
        />
        <span className="font-medium" style={{ color: dotVar }}>
          {statusText}
        </span>
        <span className="text-muted">
          · ticked{" "}
          <span className="font-mono tabular-nums">{compactAge(scheduler.lastTick, nowMs)}</span> ago
        </span>
      </span>

      {/* active count */}
      <span className="inline-flex items-center gap-1.5 text-muted">
        <Activity size={13} className="text-accent-cyan" aria-hidden />
        <span className="font-mono tabular-nums text-text">{scheduler.activeCount}</span> active
      </span>

      {/* stale count — only shown (and loud) when > 0; redundant color+glyph+text */}
      {hasStale && (
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5"
          style={{
            color: tok("stale-red"),
            backgroundColor: `color-mix(in oklch, ${tok("stale-red")} 12%, transparent)`,
          }}
        >
          <AlertTriangle size={13} aria-hidden />
          <span className="font-mono tabular-nums">{scheduler.staleCount}</span> stale
        </span>
      )}
    </div>
  );
}

// ── Strip ──────────────────────────────────────────────────────────────────
export function MissionStrip({
  agents,
  scheduler,
  heartbeats,
  onFocusAgent,
}: {
  agents: AgentState[];
  scheduler: SchedulerHealth;
  heartbeats: Heartbeat[];
  onFocusAgent: (id: string) => void;
}) {
  const reduce = useReducedMotion();
  const pending = useMemo(
    () => agents.filter((a) => a.state === AWAITING),
    [agents],
  );

  return (
    <motion.section
      aria-label="Mission status spine"
      initial={reduce ? false : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, ease: EASE }}
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-panel border border-border bg-panel/60 px-4 py-3 backdrop-blur-md sm:px-5"
    >
      <div aria-live="polite">
        <NeedsYou pending={pending} onFocusAgent={onFocusAgent} reduce={reduce} />
      </div>

      <Liveness scheduler={scheduler} reduce={reduce} />

      <div className="ml-auto flex items-center gap-2">
        <span className="hidden font-mono text-[10px] uppercase tracking-widest text-muted sm:inline">
          pulse
        </span>
        <HeartbeatRibbon heartbeats={heartbeats} />
      </div>
    </motion.section>
  );
}

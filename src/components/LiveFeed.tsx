import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Radio } from "lucide-react";
import type { AgentState, FeedEvent } from "../data/types";
import { tok, TIER_ACCENT } from "../lib/agentMeta";
import { formatRelative } from "../lib/formatRelative";
import { useTick } from "../lib/ticker";

// LiveFeed — Phase 3 "collapsed-calm" activity dock (Linear-restrained family).
// DEFAULT collapsed: last 3 events as quiet typographic rows. EXPANDED: full
// scrollable list (capped), newest-first, new rows slide+fade in from top.
// Emil motion: ease-out enter, ≤300ms, transform/opacity only, reduced-motion
// → instant. No firehose — the only thing that *demands* lives in MissionStrip.

const EASE = [0.22, 1, 0.36, 1] as const;
const CAP = 60;
const COLLAPSED_N = 3;

/** Color an endpoint chip by the agent's tier; muted for system/ALL/unknown. */
function endpointToken(id: string, tierById: Map<string, AgentState["tier"]>): string {
  const t = tierById.get(id);
  return t ? tok(TIER_ACCENT[t]) : tok("muted");
}

function Chip({ id, color }: { id: string; color: string }) {
  return (
    <span
      className="inline-flex max-w-[8rem] items-center truncate rounded px-1.5 py-0.5 font-mono text-[10px]"
      style={{
        color,
        backgroundColor: `color-mix(in oklch, ${color} 12%, transparent)`,
      }}
    >
      {id}
    </span>
  );
}

function FeedRow({
  ev,
  nowMs,
  tierById,
  reduce,
}: {
  ev: FeedEvent;
  nowMs: number;
  tierById: Map<string, AgentState["tier"]>;
  reduce: boolean | null;
}) {
  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
      transition={{ duration: 0.24, ease: EASE }}
      className="flex items-start gap-3 border-b border-border/60 px-4 py-2.5 last:border-b-0"
    >
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
        <Chip id={ev.from} color={endpointToken(ev.from, tierById)} />
        <span className="text-muted" aria-hidden>
          →
        </span>
        <Chip id={ev.to} color={endpointToken(ev.to, tierById)} />
      </div>

      <div className="min-w-0 flex-1">
        <span className="font-mono text-[11px] font-medium text-accent-cyan">{ev.topic}</span>
        {ev.body && (
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-text/80">{ev.body}</p>
        )}
      </div>

      <span className="shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-muted">
        {formatRelative(ev.ts, nowMs)}
      </span>
    </motion.li>
  );
}

export function LiveFeed({
  feed,
  agents,
}: {
  feed: FeedEvent[];
  agents: AgentState[];
}) {
  const reduce = useReducedMotion();
  const nowMs = useTick();
  const [expanded, setExpanded] = useState(false);

  const tierById = useMemo(() => {
    const m = new Map<string, AgentState["tier"]>();
    for (const a of agents) m.set(a.id, a.tier);
    return m;
  }, [agents]);

  // Newest-first, valid timestamps, capped.
  const ordered = useMemo(() => {
    return [...feed]
      .filter((e) => !Number.isNaN(Date.parse(e.ts)))
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .slice(0, CAP);
  }, [feed]);

  const visible = expanded ? ordered : ordered.slice(0, COLLAPSED_N);

  return (
    <section
      aria-label="Activity feed"
      className="overflow-hidden rounded-panel border border-border bg-panel/60 backdrop-blur-md"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Radio size={14} className="text-accent-cyan" aria-hidden />
          <h2 className="text-sm font-medium">Activity</h2>
          <span
            className="rounded-full bg-panel-2 px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted"
            role="status"
            aria-live="polite"
            aria-label={`${ordered.length} events`}
          >
            {ordered.length}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-panel/70 px-2.5 py-1 text-xs text-muted outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-accent-cyan"
        >
          {expanded ? "Collapse" : `Show all ${ordered.length}`}
          <motion.span
            animate={reduce ? undefined : { rotate: expanded ? 180 : 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            aria-hidden
            className="inline-flex"
          >
            <ChevronDown size={14} />
          </motion.span>
        </button>
      </header>

      <ul
        className={
          expanded
            ? "max-h-[22rem] overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-cyan"
            : "overflow-hidden"
        }
        // When expanded the list scrolls; make it keyboard-focusable so it can be
        // scrolled with arrow keys without a pointer.
        tabIndex={expanded ? 0 : undefined}
        aria-label={expanded ? "Activity events, scrollable" : undefined}
      >
        <AnimatePresence initial={false}>
          {visible.map((ev) => (
            <FeedRow
              key={`${ev.ts}-${ev.from}-${ev.to}-${ev.topic}`}
              ev={ev}
              nowMs={nowMs}
              tierById={tierById}
              reduce={reduce}
            />
          ))}
        </AnimatePresence>
        {ordered.length === 0 && (
          <li className="px-4 py-6 text-center text-xs text-muted">no activity yet</li>
        )}
      </ul>
    </section>
  );
}

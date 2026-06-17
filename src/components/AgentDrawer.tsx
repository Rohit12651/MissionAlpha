import { useEffect, useId, useMemo, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X, AlertTriangle, Link2, Inbox, Radio, HeartPulse } from "lucide-react";
import type { AgentState, FeedEvent, Heartbeat, CommandRequest, CommandResult } from "../data/types";
import {
  agentAccent,
  formatAge,
  liveAgeSec,
  stateLabel,
  tok,
  TIER_ACCENT,
  TIER_LABEL,
} from "../lib/agentMeta";
import { formatRelative } from "../lib/formatRelative";
import { buildBlockedChain, lastEventFor } from "../lib/blockedChain";
import { useTick } from "../lib/ticker";
import { StateBadge } from "./StateBadge";
import { TtlRing } from "./TtlRing";
import { AgentAction } from "./AgentAction";
import { AgentManage } from "./factory/AgentManage";

// A1 — Agent Drill-Down Drawer + A2 Why-Stuck. Right-side slide-in, spring/ease-out,
// reduced-motion → instant. a11y: role=dialog, aria-modal, focus trap, Esc, focus
// restore to the triggering card. All color via OKLCH tokens — no inline hex.

const EASE = [0.22, 1, 0.36, 1] as const;
const HB_CAP = 30;
const CONV_CAP = 40;

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border/60 px-5 py-4">
      <h3 className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-muted">
        <span className="text-accent-cyan" aria-hidden>
          {icon}
        </span>
        {title}
        {count !== undefined && (
          <span className="ml-auto font-mono text-[10px] tabular-nums text-muted/70">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}

// ── A2: blocked-chain / why-stuck ──────────────────────────────────────────
function WhyStuck({
  agent,
  agents,
  feed,
  heartbeats,
  nowMs,
}: {
  agent: AgentState;
  agents: AgentState[];
  feed: FeedEvent[];
  heartbeats: Heartbeat[];
  nowMs: number;
}) {
  const { chain, cycle, root } = useMemo(
    () => buildBlockedChain(agent.id, agents),
    [agent.id, agents],
  );

  if (!agent.blockedBy && !agent.stale) {
    return (
      <Section icon={<HeartPulse size={13} />} title="Status">
        <p className="text-[12px] text-muted">Not blocked — running normally.</p>
      </Section>
    );
  }

  const gold = tok("ceo-gold");
  const red = tok("stale-red");

  return (
    <Section icon={<AlertTriangle size={13} />} title="Why stuck">
      {agent.blockedBy && root && (
        <p
          className="mb-3 rounded-md px-3 py-2 text-[12px] font-medium"
          style={{
            color: red,
            backgroundColor: `color-mix(in oklch, ${red} 12%, transparent)`,
            border: `1px solid color-mix(in oklch, ${red} 28%, transparent)`,
          }}
        >
          Root cause: <span className="font-mono">{root.id}</span> is {stateLabel(root.state)}
        </p>
      )}

      {cycle && (
        <p
          className="mb-3 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px]"
          style={{ color: tok("blocked-amber"), backgroundColor: `color-mix(in oklch, ${tok("blocked-amber")} 14%, transparent)` }}
        >
          <AlertTriangle size={12} aria-hidden /> circular block detected
        </p>
      )}

      {agent.blockedBy && chain.length > 1 && (
        <ol className="relative mb-1 flex flex-col gap-1.5">
          {chain.map((node, i) => {
            const isRoot = i === chain.length - 1;
            const last = lastEventFor(node.id, feed, heartbeats);
            const ts = last.lastSync?.ts ?? last.lastHeartbeat?.ts;
            return (
              <li
                key={node.id}
                className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5"
                style={
                  isRoot
                    ? { backgroundColor: `color-mix(in oklch, ${gold} 10%, transparent)`, border: `1px solid color-mix(in oklch, ${gold} 26%, transparent)` }
                    : { backgroundColor: `color-mix(in oklch, ${tok("panel-2")} 60%, transparent)` }
                }
              >
                {i > 0 && (
                  <Link2 size={11} className="shrink-0 text-muted" aria-label="blocked by" />
                )}
                <span className="font-mono text-[12px]" style={isRoot ? { color: gold } : undefined}>
                  {node.id}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <StateBadge state={node.state} accent={agentAccent(node)} />
                  <span className="font-mono text-[10px] tabular-nums text-muted">
                    {ts ? formatRelative(ts, nowMs) : "—"}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {agent.stale && !agent.blockedBy && (
        <StaleDetail agent={agent} feed={feed} heartbeats={heartbeats} nowMs={nowMs} />
      )}
    </Section>
  );
}

function StaleDetail({
  agent,
  feed,
  heartbeats,
  nowMs,
}: {
  agent: AgentState;
  feed: FeedEvent[];
  heartbeats: Heartbeat[];
  nowMs: number;
}) {
  const last = lastEventFor(agent.id, feed, heartbeats);
  const age = liveAgeSec(agent, nowMs);
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <p style={{ color: tok("stale-red") }}>
        Stale — no heartbeat for{" "}
        <span className="font-mono tabular-nums">{formatAge(age)}</span> (ttl{" "}
        <span className="font-mono tabular-nums">{agent.ttlSec}s</span>)
      </p>
      {last.lastHeartbeat && (
        <p className="text-muted">
          Last heartbeat: <span className="font-mono">{stateLabel(last.lastHeartbeat.state)}</span>{" "}
          · {formatRelative(last.lastHeartbeat.ts, nowMs)}
        </p>
      )}
      {last.lastSync && (
        <p className="text-muted">
          Last message: <span className="text-text/80">{last.lastSync.body}</span>{" "}
          <span className="font-mono text-[10px]">· {formatRelative(last.lastSync.ts, nowMs)}</span>
        </p>
      )}
    </div>
  );
}

// ── Conversation / inbox row ───────────────────────────────────────────────
function MessageRow({ ev, nowMs }: { ev: FeedEvent; nowMs: number }) {
  return (
    <li className="border-b border-border/50 py-2.5 last:border-b-0">
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-muted">{ev.from}</span>
        <span className="text-muted" aria-hidden>→</span>
        <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-muted">{ev.to}</span>
        <span className="font-mono text-accent-cyan">{ev.topic}</span>
        <span className="ml-auto font-mono tabular-nums text-muted">{formatRelative(ev.ts, nowMs)}</span>
      </div>
      {ev.body && <p className="mt-1 text-[12px] leading-snug text-text/85">{ev.body}</p>}
    </li>
  );
}

// ── Drawer ─────────────────────────────────────────────────────────────────
export function AgentDrawer({
  agent,
  agents,
  feed,
  heartbeats,
  onClose,
  onCommand,
}: {
  agent: AgentState | null;
  agents: AgentState[];
  feed: FeedEvent[];
  heartbeats: Heartbeat[];
  onClose: () => void;
  /** WRITE arrow — passed to the action panel so the operator can ACT. */
  onCommand?: (cmd: CommandRequest) => Promise<CommandResult>;
}) {
  const reduce = useReducedMotion();
  const nowMs = useTick();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const open = agent !== null;

  // BUG 2/3 fix: App passes a fresh `onClose` closure every poll (~2s). If that
  // identity lives in the focus-effect deps, the effect re-runs every tick and
  // re-focuses the close button — stealing focus mid-chat (BUG 2) and scrolling
  // the drawer back to the top (BUG 3). Stash it in a ref so the keydown handler
  // can call the latest onClose without making it an effect dependency.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Esc to close + focus trap + restore focus to the triggering element on close.
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;

    // Focus the panel's close button (first focusable) on open. preventScroll so
    // opening the drawer never yanks the scroll position.
    const focusables = panel?.querySelectorAll<HTMLElement>(FOCUSABLE);
    focusables?.[0]?.focus({ preventScroll: true });

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Restore focus to the card/pill that opened the drawer.
      trigger?.focus?.();
    };
    // Re-run only on the open transition (per agent id), not on every poll.
    // onClose is read via onCloseRef so it must NOT be a dep — see BUG 2/3 above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent?.id]);

  return (
    <AnimatePresence>
      {agent && (
        <div className="fixed inset-0 z-50" aria-hidden={false}>
          {/* backdrop */}
          <motion.div
            className="absolute inset-0 bg-bg/60 backdrop-blur-sm"
            initial={reduce ? { opacity: 1 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            onClick={onClose}
            aria-hidden
          />

          {/* panel */}
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={reduce ? { x: 0, opacity: 1 } : { x: "100%" }}
            animate={reduce ? { x: 0, opacity: 1 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : { x: "100%" }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 380, damping: 40, mass: 0.9 }
            }
            className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col overflow-y-auto border-l border-border bg-panel/95 backdrop-blur-xl shadow-2xl"
          >
            <DrawerHeader agent={agent} nowMs={nowMs} titleId={titleId} onClose={onClose} />

            {/* A5 — operator action: the first thing you can DO on drill-in. */}
            <AgentAction agent={agent} agents={agents} onCommand={onCommand} />

            {/* Item 4 — manage created agents (skills + delete). Self-hides for
                built-ins (not in the factory registry), so always safe to render. */}
            <AgentManage agentId={agent.id} />

            <WhyStuck
              agent={agent}
              agents={agents}
              feed={feed}
              heartbeats={heartbeats}
              nowMs={nowMs}
            />

            <HeartbeatTimeline agentId={agent.id} heartbeats={heartbeats} nowMs={nowMs} />

            <Conversations agentId={agent.id} feed={feed} nowMs={nowMs} />

            <Section icon={<Inbox size={13} />} title="Inbox" count={agent.inbox.length}>
              {agent.inbox.length === 0 ? (
                <p className="text-[12px] text-muted">inbox empty</p>
              ) : (
                <ul className="flex flex-col">
                  {[...agent.inbox]
                    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
                    .map((ev, i) => (
                      <MessageRow key={`${ev.ts}-${i}`} ev={ev} nowMs={nowMs} />
                    ))}
                </ul>
              )}
            </Section>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function DrawerHeader({
  agent,
  nowMs,
  titleId,
  onClose,
}: {
  agent: AgentState;
  nowMs: number;
  titleId: string;
  onClose: () => void;
}) {
  const accent = agentAccent(agent);
  const age = liveAgeSec(agent, nowMs);
  const overdue = !agent.dead && age !== null && age > agent.ttlSec;
  const tierAccent = TIER_ACCENT[agent.tier];
  return (
    <header className="flex items-start gap-3 px-5 pb-4 pt-5">
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="truncate font-mono text-lg font-semibold">
          {agent.id}
        </h2>
        <div className="mt-0.5 flex items-center gap-2 text-[11px]">
          <span className="font-mono tracking-widest" style={{ color: tok(tierAccent), opacity: 0.8 }}>
            {TIER_LABEL[agent.tier]}
          </span>
          <span className="text-muted">·</span>
          <span className="truncate text-muted">{agent.role}</span>
        </div>
        <div className="mt-2.5">
          <StateBadge state={agent.state} accent={accent} />
        </div>
      </div>

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
          <span className="font-mono text-[8px] uppercase tracking-wide text-stale-red">overdue</span>
        )}
      </div>

      <button
        type="button"
        onClick={onClose}
        aria-label="Close agent detail"
        className="rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent-cyan"
      >
        <X size={18} />
      </button>
    </header>
  );
}

function HeartbeatTimeline({
  agentId,
  heartbeats,
  nowMs,
}: {
  agentId: string;
  heartbeats: Heartbeat[];
  nowMs: number;
}) {
  const rows = useMemo(
    () =>
      heartbeats
        .filter((h) => h.agent === agentId && !Number.isNaN(Date.parse(h.ts)))
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
        .slice(0, HB_CAP),
    [agentId, heartbeats],
  );
  return (
    <Section icon={<HeartPulse size={13} />} title="Heartbeat timeline" count={rows.length}>
      {rows.length === 0 ? (
        <p className="text-[12px] text-muted">no heartbeats recorded</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((h, i) => (
            <li key={`${h.ts}-${i}`} className="flex items-center gap-3 font-mono text-[11px]">
              <span className="w-16 shrink-0 tabular-nums text-muted">{formatRelative(h.ts, nowMs)}</span>
              <span className="h-1 w-1 shrink-0 rounded-full bg-accent-cyan" aria-hidden />
              <span className="truncate text-text/80">{stateLabel(h.state)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Conversations({
  agentId,
  feed,
  nowMs,
}: {
  agentId: string;
  feed: FeedEvent[];
  nowMs: number;
}) {
  const rows = useMemo(
    () =>
      feed
        .filter((e) => (e.from === agentId || e.to === agentId) && !Number.isNaN(Date.parse(e.ts)))
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
        .slice(0, CONV_CAP),
    [agentId, feed],
  );
  return (
    <Section icon={<Radio size={13} />} title="Conversations" count={rows.length}>
      {rows.length === 0 ? (
        <p className="text-[12px] text-muted">no messages involving this agent</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((ev, i) => (
            <MessageRow key={`${ev.ts}-${i}`} ev={ev} nowMs={nowMs} />
          ))}
        </ul>
      )}
    </Section>
  );
}

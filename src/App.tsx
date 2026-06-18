import { useMemo, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Menu, PanelRight } from "lucide-react";
import { useAgentState } from "./data/useAgentState";
import { useTick } from "./lib/ticker";
import type { Counts, DashboardState } from "./data/types";
import { KanbanBoard } from "./components/KanbanBoard";
import { ViewToggle, type BoardView } from "./components/ViewToggle";
import { MissionStrip } from "./components/MissionStrip";
import { LiveFeed } from "./components/LiveFeed";
import { PulseGlobe } from "./components/PulseGlobe";
import { ThemeToggle } from "./components/ThemeToggle";
import { AgentDrawer } from "./components/AgentDrawer";
import { TimeScrubber } from "./components/TimeScrubber";
import { BulkActionBar } from "./components/BulkActionBar";
import { ControlPlanePanel } from "./components/ControlPlanePanel";
import { SessionsBrowser } from "./components/SessionsBrowser";
import { AgentFactory } from "./components/factory/AgentFactory";
import { ThreadRail, type ThreadInfo } from "./components/workspace/ThreadRail";
import { ChatPane, type Msg } from "./components/workspace/ChatPane";
import { TeamPanel } from "./components/workspace/TeamPanel";
import { tok } from "./lib/agentMeta";
import { reconstructAt, countsFrom } from "./lib/replay";

// Chat-first shell (ADR-023): chat is the PRIMARY center column; the board is a
// secondary, collapsible "Team" panel. Left = thread switcher (Boss/CEO + agents).
// All prior board features (Cycle1/2 control plane, dispatch loop, F2b, sessions,
// factory, replay) live UNCHANGED inside the Team panel.

const STALE_SNAPSHOT_MS = 15_000;

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const STAT_TILES: ReadonlyArray<{ key: keyof Counts; label: string; tone: string }> = [
  { key: "total", label: "Total", tone: "text-text" },
  { key: "active", label: "Active", tone: "text-accent-cyan" },
  { key: "inProgress", label: "In Progress", tone: "text-accent-cyan" },
  { key: "blocked", label: "Blocked", tone: "text-blocked-amber" },
  { key: "stale", label: "Stale", tone: "text-stale-red" },
  { key: "offline", label: "Offline", tone: "text-muted" },
];

function FreshnessClock({ generatedAt }: { generatedAt: string }) {
  const now = useTick();
  const t = Date.parse(generatedAt);
  const ageMs = Number.isNaN(t) ? 0 : now - t;
  if (ageMs > STALE_SNAPSHOT_MS) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-xs text-stale-red" role="status">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-stale-red" aria-hidden />
        reconnecting…
      </span>
    );
  }
  return <span className="font-mono text-xs text-muted">updated {formatClock(generatedAt)}</span>;
}

function BoardHeader({ state }: { state: DashboardState }) {
  const live = state.scheduler.running;
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold tracking-tight">Command Tower</h2>
      </div>
      <div className="flex items-center gap-3">
        <FreshnessClock generatedAt={state.generatedAt} />
        <span className="flex items-center gap-2 rounded-full border border-border bg-panel px-2.5 py-1 text-[11px]" role="status">
          <span
            className={`inline-block h-2 w-2 rounded-full ${live ? "bg-done-green" : "bg-stale-red"}`}
            style={{ boxShadow: live ? "0 0 8px 1px var(--c-done-green)" : "0 0 8px 1px var(--c-stale-red)" }}
            aria-hidden
          />
          <span className="text-muted">{live ? "online" : "offline"} · {state.scheduler.cadenceSec}s</span>
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}

function StatTiles({ counts }: { counts: Counts }) {
  return (
    <section aria-label="Swarm counts" className="grid grid-cols-3 gap-2.5">
      {STAT_TILES.map((tile) => (
        <div key={tile.key} className="rounded-panel border border-border bg-panel/80 px-3 py-3 backdrop-blur-sm">
          <motion.div
            key={counts[tile.key]}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className={`font-mono text-xl font-semibold tabular-nums ${tile.tone}`}
          >
            {counts[tile.key]}
          </motion.div>
          <div className="mt-1 text-[10px] uppercase tracking-wide text-muted">{tile.label}</div>
        </div>
      ))}
    </section>
  );
}

function LoadingShell() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-muted">
        <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-accent-cyan" aria-hidden />
        <span className="font-mono text-sm">connecting to swarm…</span>
      </div>
    </div>
  );
}

// Persisted layout helpers.
const lsGet = (k: string, fallback: string): string => {
  try {
    return localStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

export default function App() {
  const { state, error, sendCommand, getAudit, getCommandStatus, listSessions } = useAgentState();

  // ── chat-first shell state ──────────────────────────────────────────────
  const [activeThread, setActiveThread] = useState<string>(() => lsGet("ma.activeThread", "boss"));
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => lsGet("ma.rail.collapsed", "0") === "1");
  const [railOpenMobile, setRailOpenMobile] = useState(false);
  const [teamOpen, setTeamOpen] = useState<boolean>(() => {
    const v = lsGet("ma.team.open", "");
    if (v === "1") return true;
    if (v === "0") return false;
    return typeof window !== "undefined" && window.innerWidth >= 1024; // default open on desktop
  });
  const [threadMsgs, setThreadMsgs] = useState<Record<string, Msg[]>>({});

  const selectThread = useCallback((id: string) => {
    setActiveThread(id);
    lsSet("ma.activeThread", id);
    setRailOpenMobile(false);
  }, []);
  const toggleRail = useCallback(() => {
    setRailCollapsed((c) => {
      lsSet("ma.rail.collapsed", c ? "0" : "1");
      return !c;
    });
  }, []);
  const toggleTeam = useCallback(() => {
    setTeamOpen((o) => {
      lsSet("ma.team.open", o ? "0" : "1");
      return !o;
    });
  }, []);

  const setActiveMsgs = useCallback(
    (updater: (prev: Msg[]) => Msg[]) => {
      setThreadMsgs((all) => ({ ...all, [activeThread]: updater(all[activeThread] ?? []) }));
    },
    [activeThread],
  );

  // ── board / replay state ──────────────────────────────────────────────────
  const [view, setView] = useState<BoardView>("state");
  const [replayMs, setReplayMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const replaying = replayMs !== null;
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = useMemo(
    () => state?.agents.find((a) => a.id === selectedAgentId) ?? null,
    [state?.agents, selectedAgentId],
  );

  const viewAgents = useMemo(
    () =>
      state == null
        ? []
        : replayMs == null
          ? state.agents
          : reconstructAt(replayMs, state.agents, state.heartbeats),
    [state, replayMs],
  );
  const viewFeed = useMemo(() => {
    if (state == null) return [];
    if (replayMs == null) return state.feed;
    return state.feed.filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isNaN(t) || t <= replayMs;
    });
  }, [state, replayMs]);
  const viewCounts = useMemo<Counts | null>(
    () => (state == null ? null : replayMs == null ? state.counts : countsFrom(viewAgents)),
    [state, replayMs, viewAgents],
  );

  const enterReplay = (ms: number) => {
    setReplayMs(ms);
    setSelectedAgentId(null);
  };
  const goLive = () => {
    setReplayMs(null);
    setPlaying(false);
  };
  const globeNowMs = useMemo(
    () => (state ? Date.parse(state.generatedAt) || Date.now() : Date.now()),
    [state?.generatedAt],
  );
  const openAgent = (id: string) => setSelectedAgentId(id);
  const allOffline = !!state && state.agents.length > 0 && state.agents.every((a) => a.dead);

  // ── thread list (Boss pinned + per-agent) ──────────────────────────────────
  const threads = useMemo<ThreadInfo[]>(() => {
    const list: ThreadInfo[] = [{ id: "boss", title: "Boss Console", accent: "ceo-gold", pinned: true }];
    for (const a of state?.agents ?? []) {
      list.push({ id: a.id, title: a.id, accent: a.factory ? "factory-violet" : "accent-cyan" });
    }
    return list;
  }, [state?.agents]);

  const activeInfo = threads.find((t) => t.id === activeThread) ?? threads[0];
  const isBoss = activeInfo.id === "boss";
  const subtitle = isBoss
    ? "you (BOSS) → CEO · supreme over swarm"
    : `agent · ${state?.agents.find((a) => a.id === activeInfo.id)?.role ?? activeInfo.id}`;

  const headerExtra = (
    <>
      <button
        type="button"
        onClick={() => setRailOpenMobile(true)}
        aria-label="Open threads"
        className="rounded-md p-1.5 outline-none transition-colors focus-visible:ring-2 lg:hidden"
        style={{ color: tok("muted") }}
      >
        <Menu size={18} aria-hidden />
      </button>
      <button
        type="button"
        onClick={toggleTeam}
        aria-pressed={teamOpen}
        aria-controls="team-panel"
        aria-label="Toggle Team panel"
        className="rounded-md p-1.5 outline-none transition-colors focus-visible:ring-2"
        style={{ color: teamOpen ? tok("text") : tok("muted"), backgroundColor: teamOpen ? tok("panel-2") : "transparent" }}
      >
        <PanelRight size={18} aria-hidden />
      </button>
    </>
  );

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden" style={{ backgroundColor: tok("bg") }}>
      {/* desktop rail */}
      <div className="hidden lg:block">
        <ThreadRail threads={threads} activeId={activeThread} onSelect={selectThread} collapsed={railCollapsed} onToggleCollapsed={toggleRail} />
      </div>

      {/* mobile rail overlay */}
      {railOpenMobile && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Threads">
          <div className="absolute inset-0" style={{ backgroundColor: `color-mix(in oklch, ${tok("bg")} 70%, transparent)` }} onClick={() => setRailOpenMobile(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0">
            <ThreadRail threads={threads} activeId={activeThread} onSelect={selectThread} collapsed={false} onToggleCollapsed={() => setRailOpenMobile(false)} />
          </div>
        </div>
      )}

      {/* center chat — PRIMARY */}
      <div className="flex min-w-0 flex-1">
        <ChatPane
          threadId={activeInfo.id}
          title={activeInfo.title}
          subtitle={subtitle}
          accent={activeInfo.accent}
          isBoss={isBoss}
          messages={threadMsgs[activeInfo.id] ?? []}
          setMessages={setActiveMsgs}
          onCommand={sendCommand}
          headerExtra={headerExtra}
        />
      </div>

      {/* secondary Team panel — the board, demoted */}
      <TeamPanel open={teamOpen} onClose={toggleTeam}>
        {error && (
          <div role="alert" className="mb-4 rounded-panel border border-stale-red bg-panel px-4 py-3 text-sm text-stale-red">
            {error}
          </div>
        )}
        {state ? (
          <div className="flex flex-col gap-5">
            <BoardHeader state={state} />

            <PulseGlobe agents={state.agents} feed={state.feed} scheduler={state.scheduler} nowMs={globeNowMs} />
            <p className="sr-only" role="status" aria-live="polite">
              {`Live swarm constellation: ${state.counts.active} active, ${state.counts.blocked} blocked, ${state.counts.stale} stale, ${state.counts.offline} offline of ${state.counts.total} agents.`}
            </p>

            <TimeScrubber
              heartbeats={state.heartbeats}
              feed={state.feed}
              replayMs={replayMs}
              playing={playing}
              onScrub={enterReplay}
              onLive={goLive}
              onTogglePlay={() => setPlaying((p) => !p)}
            />

            {replaying && (
              <div role="status" aria-live="polite" className="rounded-panel border border-ceo-gold bg-panel/70 px-4 py-2.5 text-sm" style={{ boxShadow: "0 0 16px -6px var(--c-ceo-gold)" }}>
                <span className="font-mono text-xs font-semibold uppercase tracking-widest text-ceo-gold">Replay Mode</span>
                <span className="ml-2 text-muted">Viewing the swarm as it was. Press <span className="font-mono text-text">LIVE</span> to return.</span>
              </div>
            )}
            {!replaying && !state.scheduler.running && (
              <div role="alert" className="rounded-panel border border-stale-red bg-panel/70 px-4 py-2.5 text-sm text-stale-red">
                Scheduler offline — data may be stale.
              </div>
            )}
            {!replaying && allOffline && state.scheduler.running && (
              <div role="status" className="rounded-panel border border-border bg-panel/70 px-4 py-2.5 text-sm text-muted">
                All agents are currently offline. Waiting for the next wake cycle.
              </div>
            )}

            <MissionStrip agents={viewAgents} scheduler={state.scheduler} heartbeats={state.heartbeats} onFocusAgent={openAgent} />
            <StatTiles counts={viewCounts ?? state.counts} />

            {!replaying && <BulkActionBar agents={viewAgents} onCommand={sendCommand} />}
            {!replaying && <ControlPlanePanel getAudit={getAudit} getCommandStatus={getCommandStatus} />}
            {!replaying && <SessionsBrowser listSessions={listSessions} />}
            {!replaying && <AgentFactory />}

            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted">{view === "state" ? "By lifecycle state" : "By pipeline stage"}</h3>
              <ViewToggle view={view} onChange={setView} />
            </div>

            <KanbanBoard agents={viewAgents} view={view} onSelect={replaying ? undefined : openAgent} />
            <LiveFeed feed={viewFeed} agents={viewAgents} />

            <footer className="pt-1 text-center font-mono text-[11px] text-muted">
              {replaying ? "REPLAY" : "live poll @2s"} · {viewAgents.length} agents · {(viewCounts ?? state.counts).active} active
            </footer>
          </div>
        ) : (
          <LoadingShell />
        )}
      </TeamPanel>

      {/* agent drilldown drawer (from board card clicks) — overlay at root */}
      {state && (
        <AgentDrawer
          agent={selectedAgent}
          agents={state.agents}
          feed={state.feed}
          heartbeats={state.heartbeats}
          onClose={() => setSelectedAgentId(null)}
          onCommand={sendCommand}
        />
      )}
    </div>
  );
}

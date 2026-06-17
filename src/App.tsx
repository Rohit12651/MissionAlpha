import { useMemo, useState } from "react";
import { motion } from "framer-motion";
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
import { BossConsole } from "./components/BossConsole";
import { reconstructAt, countsFrom } from "./lib/replay";

// Phase 5 — final polish + a11y + perf harden. The board shows STATE; the strip
// shows DEMAND-ON-ME + LIVENESS + PULSE; the globe is a decorative hero band.
// Perf: the 1s clock no longer lives here (App is now stable across ticks) — it
// is provided via <TickProvider> and consumed only by the leaf components that
// display a live-counting age, so the globe + static chrome never re-render at 1Hz.

// If the snapshot is older than this, the poll has likely stalled (server down /
// scheduler stopped) — surface a calm "reconnecting" hint.
const STALE_SNAPSHOT_MS = 15_000;

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const STAT_TILES: ReadonlyArray<{ key: keyof Counts; label: string; tone: string }> = [
  { key: "total", label: "Total", tone: "text-text" },
  { key: "active", label: "Active", tone: "text-accent-cyan" },
  { key: "inProgress", label: "In Progress", tone: "text-accent-cyan" },
  { key: "blocked", label: "Blocked", tone: "text-blocked-amber" },
  { key: "stale", label: "Stale", tone: "text-stale-red" },
  { key: "offline", label: "Offline", tone: "text-muted" },
];

/** "updated 12:01:33" that also flips to a reconnecting hint when the poll stalls. */
function FreshnessClock({ generatedAt }: { generatedAt: string }) {
  const now = useTick();
  const t = Date.parse(generatedAt);
  const ageMs = Number.isNaN(t) ? 0 : now - t;
  const stale = ageMs > STALE_SNAPSHOT_MS;

  if (stale) {
    return (
      <span
        className="inline-flex items-center gap-1.5 font-mono text-xs text-stale-red"
        role="status"
      >
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-stale-red" aria-hidden />
        reconnecting…
      </span>
    );
  }
  return (
    <span className="font-mono text-xs text-muted">updated {formatClock(generatedAt)}</span>
  );
}

function Header({ state }: { state: DashboardState }) {
  const live = state.scheduler.running;
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Agent Command Tower
        </h1>
        <span className="hidden text-sm text-muted sm:inline">MissionAlpha</span>
      </div>
      <div className="flex items-center gap-4">
        <FreshnessClock generatedAt={state.generatedAt} />
        <span
          className="flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs"
          role="status"
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              live ? "bg-done-green" : "bg-stale-red"
            }`}
            style={{
              boxShadow: live
                ? "0 0 8px 1px var(--c-done-green)"
                : "0 0 8px 1px var(--c-stale-red)",
            }}
            aria-hidden
          />
          <span className="text-muted">
            scheduler {live ? "online" : "offline"} · {state.scheduler.cadenceSec}s
          </span>
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}

function StatTiles({ counts }: { counts: Counts }) {
  return (
    <section aria-label="Swarm counts" className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {STAT_TILES.map((tile) => (
        <div
          key={tile.key}
          className="rounded-panel border border-border bg-panel/80 px-4 py-4 backdrop-blur-sm"
        >
          <motion.div
            key={counts[tile.key]}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className={`font-mono text-2xl font-semibold tabular-nums sm:text-3xl ${tile.tone}`}
          >
            {counts[tile.key]}
          </motion.div>
          <div className="mt-1 text-[10px] uppercase tracking-wide text-muted sm:text-xs">
            {tile.label}
          </div>
        </div>
      ))}
    </section>
  );
}

function LoadingShell() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-muted">
        <span
          className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-accent-cyan"
          aria-hidden
        />
        <span className="font-mono text-sm">connecting to swarm…</span>
      </div>
    </div>
  );
}

export default function App() {
  const { state, error, sendCommand, getAudit, getCommandStatus, listSessions } =
    useAgentState();
  // Boss Console docked on the LEFT (like Claude's chat pane). Open by default.
  const [bossOpen, setBossOpen] = useState(true);
  const [view, setView] = useState<BoardView>("state");
  // A3 replay: null = LIVE; a number = a pinned past moment (epoch ms). While
  // replaying, the 2s poll keeps updating state.heartbeats (so the scrubber's
  // endMs/markers grow) but the rendered board stays pinned at replayMs.
  const [replayMs, setReplayMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const replaying = replayMs !== null;

  // A1 drill-down: the agent whose drawer is open. Resolved live from current
  // state so the drawer updates as the swarm moves while it's open.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = useMemo(
    () => state?.agents.find((a) => a.id === selectedAgentId) ?? null,
    [state?.agents, selectedAgentId],
  );

  // The board/strip/counts render this set: live agents, or the swarm rebuilt
  // as it was at replayMs. Same shape → the kanban's shared layoutId makes cards
  // GLIDE between columns as you scrub. The feed is filtered to events ≤ replayMs.
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
    setSelectedAgentId(null); // drawer runs off live data; close it on scrub
  };
  const goLive = () => {
    setReplayMs(null);
    setPlaying(false);
  };

  // The globe only needs a "now" for recomputing recent-talk edges; it animates
  // off its own RAF clock. Feed it the poll's generatedAt epoch (changes ~every
  // 2s) rather than the 1s tick, so the 3D scene never re-renders at 1Hz.
  const globeNowMs = useMemo(
    () => (state ? Date.parse(state.generatedAt) || Date.now() : Date.now()),
    [state?.generatedAt],
  );

  // A1: NEEDS-YOU pill + card clicks both OPEN THE DRILL-DOWN DRAWER for that
  // agent — going from "I see it" → "I understand it" without leaving the screen.
  const openAgent = (id: string) => setSelectedAgentId(id);

  const allOffline =
    !!state && state.agents.length > 0 && state.agents.every((a) => a.dead);

  return (
    <div
      className="mx-auto flex min-h-full max-w-[1500px] flex-col gap-6 px-4 py-7 transition-[padding] duration-200 sm:px-6 lg:px-8"
      style={bossOpen ? { paddingLeft: "404px" } : undefined}
    >
      {/* Boss Console — global chat docked LEFT (BOSS → CEO), like Claude's pane. */}
      <BossConsole open={bossOpen} onOpenChange={setBossOpen} onCommand={sendCommand} />

      {error && (
        <div
          role="alert"
          className="rounded-panel border border-stale-red bg-panel px-4 py-3 text-sm text-stale-red"
        >
          {error}
        </div>
      )}

      {state ? (
        <>
          <PulseGlobe
            agents={state.agents}
            feed={state.feed}
            scheduler={state.scheduler}
            nowMs={globeNowMs}
          />

          {/* Text alternative for the decorative globe — read by screen readers. */}
          <p className="sr-only" role="status" aria-live="polite">
            {`Live swarm constellation: ${state.counts.active} active, ${state.counts.blocked} blocked, ${state.counts.stale} stale, ${state.counts.offline} offline of ${state.counts.total} agents.`}
          </p>

          <Header state={state} />

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
            <div
              role="status"
              aria-live="polite"
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-panel border border-ceo-gold bg-panel/70 px-4 py-2.5 text-sm"
              style={{ boxShadow: "0 0 16px -6px var(--c-ceo-gold)" }}
            >
              <span className="font-mono text-xs font-semibold uppercase tracking-widest text-ceo-gold">
                Replay Mode
              </span>
              <span className="text-muted">
                Viewing the swarm as it was — columns reconstructed from heartbeat
                history. Task / blocker / TTL shown are current-frame approximations.
                Press <span className="font-mono text-text">LIVE</span> to return to now.
              </span>
            </div>
          )}

          {!replaying && !state.scheduler.running && (
            <div
              role="alert"
              className="rounded-panel border border-stale-red bg-panel/70 px-4 py-2.5 text-sm text-stale-red"
            >
              Scheduler offline — data may be stale.
            </div>
          )}
          {!replaying && allOffline && state.scheduler.running && (
            <div
              role="status"
              className="rounded-panel border border-border bg-panel/70 px-4 py-2.5 text-sm text-muted"
            >
              All agents are currently offline. Waiting for the next wake cycle.
            </div>
          )}

          <main className="flex flex-col gap-6">
            <MissionStrip
              agents={viewAgents}
              scheduler={state.scheduler}
              heartbeats={state.heartbeats}
              onFocusAgent={openAgent}
            />
            <StatTiles counts={viewCounts ?? state.counts} />

            {/* F6 bulk actions + F3 permission gate — live control plane (Cycle 1).
                Hidden in replay (acting on a past snapshot makes no sense). */}
            {!replaying && <BulkActionBar agents={viewAgents} onCommand={sendCommand} />}

            {/* F5 audit-log viewer + F7 command feedback — read-only control plane. */}
            {!replaying && (
              <ControlPlanePanel getAudit={getAudit} getCommandStatus={getCommandStatus} />
            )}

            {/* F4 session history — recall + summarize past swarm sessions. */}
            {!replaying && <SessionsBrowser listSessions={listSessions} />}

            {/* Agent Factory — BOSS spawns AI-authored agents w/ real-posting skills. */}
            {!replaying && <AgentFactory builtinIds={state.agents.map((a) => a.id)} />}

            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted">
                {view === "state" ? "By lifecycle state" : "By pipeline stage"}
              </h2>
              <ViewToggle view={view} onChange={setView} />
            </div>

            <KanbanBoard
              agents={viewAgents}
              view={view}
              onSelect={replaying ? undefined : openAgent}
            />

            <LiveFeed feed={viewFeed} agents={viewAgents} />
          </main>

          <AgentDrawer
            agent={selectedAgent}
            agents={state.agents}
            feed={state.feed}
            heartbeats={state.heartbeats}
            onClose={() => setSelectedAgentId(null)}
            onCommand={sendCommand}
          />

          <footer className="pt-1 text-center font-mono text-[11px] text-muted">
            {replaying ? "REPLAY" : "Phase 5 · live poll @2s"} · {viewAgents.length} agents ·{" "}
            {(viewCounts ?? state.counts).active} active
          </footer>
        </>
      ) : (
        <LoadingShell />
      )}
    </div>
  );
}

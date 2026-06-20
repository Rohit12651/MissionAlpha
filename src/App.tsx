import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Settings as SettingsIcon, Command, ScrollText, Wrench, History, Users, LayoutDashboard, MessageSquare, PanelRightOpen } from "lucide-react";
import { useAgentState } from "./data/useAgentState";
import type { Counts } from "./data/types";
import type { Msg } from "./components/workspace/ChatPane";
import { AgentRoster } from "./components/cockpit/AgentRoster";
import { RightPanel } from "./components/cockpit/RightPanel";
import { UtilityDrawer, type UtilityTab } from "./components/cockpit/UtilityDrawer";
import { KanbanBoard } from "./components/KanbanBoard";
import { ViewToggle, type BoardView } from "./components/ViewToggle";
import { PulseGlobe } from "./components/PulseGlobe";
import { ThemeToggle } from "./components/ThemeToggle";
import { AgentDrawer } from "./components/AgentDrawer";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { Onboarding, hasOnboarded } from "./components/onboarding/Onboarding";
import type { PaletteCommand } from "./lib/paletteCommands";
import { MODEL_TIERS, saveTier } from "./lib/modelTiers";
import { runtimeToken } from "./lib/runtimeToken";
import { tok } from "./lib/agentMeta";
import { reconstructAt, countsFrom } from "./lib/replay";

// Mission-control shell (ADR-048 rev2): clean 3-zone cockpit — agent roster (left,
// status only) · kanban board (center, primary) · Chat|Feed panel (right). Globe is
// a faint ambient backdrop; Audit/Tools/Replay live in a top-nav slide-over. Agent
// ids come straight from state.json and are never renamed. Runtime behavior unchanged.

const BOSS_ID = "boss";

function migrateOffLegacyShell() {
  try {
    for (const k of ["ma.forkedThreads", "ma.activeThread", "ma.rail.collapsed", "ma.team.open", "ma.tower.view"]) {
      localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}

const COUNT_PILLS: ReadonlyArray<{ key: keyof Counts; label: string; tone: string }> = [
  { key: "active", label: "active", tone: "done-green" },
  { key: "blocked", label: "blocked", tone: "blocked-amber" },
  { key: "stale", label: "stale", tone: "stale-red" },
  { key: "offline", label: "offline", tone: "muted" },
];

function CountPills({ counts }: { counts: Counts }) {
  return (
    <span className="hidden items-center gap-1.5 sm:flex" role="status" aria-live="polite"
      aria-label={`${counts.active} active, ${counts.blocked} blocked, ${counts.stale} stale, ${counts.offline} offline of ${counts.total} agents`}>
      {COUNT_PILLS.map((p) => {
        const c = tok(p.tone);
        return (
          <span key={p.key} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] tabular-nums"
            style={{ color: c, backgroundColor: `color-mix(in oklch, ${c} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${c} 26%, transparent)` }}>
            <motion.span key={counts[p.key]} initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="font-semibold">{counts[p.key]}</motion.span>
            <span className="opacity-80">{p.label}</span>
          </span>
        );
      })}
    </span>
  );
}

function NavButton({ label, onClick, icon: Icon, active }: { label: string; onClick: () => void; icon: typeof ScrollText; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2"
      style={{ color: active ? tok("text") : tok("muted"), backgroundColor: active ? tok("panel-2") : "transparent" }}>
      <Icon size={16} aria-hidden />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

function LoadingShell() {
  return (
    <div className="flex flex-1 items-center justify-center" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-muted">
        <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-accent-cyan" aria-hidden />
        <span className="font-mono text-sm">connecting to swarm…</span>
      </div>
    </div>
  );
}

type MobilePane = "agents" | "board" | "chat";

export default function App() {
  const { state, error, sendCommand, getAudit, getCommandStatus, listSessions } = useAgentState();

  // Boss command thread (the ONE chat).
  const [bossMsgs, setBossMsgs] = useState<Msg[]>([]);
  const setMessages = useCallback((updater: (prev: Msg[]) => Msg[]) => setBossMsgs((prev) => updater(prev)), []);
  useEffect(() => {
    migrateOffLegacyShell();
    let cancelled = false;
    (async () => {
      try {
        const token = await runtimeToken();
        const res = await fetch(`/runtime/${BOSS_ID}/thread`, { cache: "no-store", headers: { "x-runtime-token": token } });
        const msgs = res.ok ? (((await res.json()) as { messages?: Msg[] }).messages ?? []) : [];
        if (!cancelled) setBossMsgs(msgs);
      } catch { /* empty */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Board + replay.
  const [kanbanMode, setKanbanMode] = useState<BoardView>("state");
  const [replayMs, setReplayMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const replaying = replayMs !== null;
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = useMemo(() => state?.agents.find((a) => a.id === selectedAgentId) ?? null, [state?.agents, selectedAgentId]);

  const viewAgents = useMemo(
    () => (state == null ? [] : replayMs == null ? state.agents : reconstructAt(replayMs, state.agents, state.heartbeats)),
    [state, replayMs],
  );
  const viewFeed = useMemo(() => {
    if (state == null) return [];
    if (replayMs == null) return state.feed;
    return state.feed.filter((e) => { const t = Date.parse(e.ts); return Number.isNaN(t) || t <= replayMs; });
  }, [state, replayMs]);
  const viewCounts = useMemo<Counts | null>(
    () => (state == null ? null : replayMs == null ? state.counts : countsFrom(viewAgents)),
    [state, replayMs, viewAgents],
  );

  const enterReplay = useCallback((ms: number) => { setReplayMs(ms); setSelectedAgentId(null); }, []);
  const goLive = useCallback(() => { setReplayMs(null); setPlaying(false); }, []);
  const globeNowMs = useMemo(() => (state ? Date.parse(state.generatedAt) || Date.now() : Date.now()), [state?.generatedAt]);

  const [mobilePane, setMobilePane] = useState<MobilePane>("board");
  const openAgent = useCallback((id: string) => { setSelectedAgentId(id); }, []);

  // Overlays.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(() => !hasOnboarded());
  const [utilOpen, setUtilOpen] = useState(false);
  const [utilTab, setUtilTab] = useState<UtilityTab>("audit");
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  const [tierReloadKey, setTierReloadKey] = useState(0);

  // Resizable + collapsible chat dock (desktop only; mobile keeps the pane tabs).
  // Width persists; clamped so it can never push content off-screen.
  const CHAT_MIN = 320, CHAT_MAX = 720, CHAT_DEFAULT = 380;
  const [isLg, setIsLg] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width:1024px)").matches);
  const [chatW, setChatW] = useState<number>(() => {
    const n = Number(localStorage.getItem("ma.chat.w"));
    return Number.isFinite(n) && n >= CHAT_MIN && n <= CHAT_MAX ? n : CHAT_DEFAULT;
  });
  const [chatCollapsed, setChatCollapsed] = useState<boolean>(() => localStorage.getItem("ma.chat.collapsed") === "1");
  const draggingRef = useRef(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width:1024px)");
    const on = () => setIsLg(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => { try { localStorage.setItem("ma.chat.w", String(chatW)); } catch { /* ignore */ } }, [chatW]);
  useEffect(() => { try { localStorage.setItem("ma.chat.collapsed", chatCollapsed ? "1" : "0"); } catch { /* ignore */ } }, [chatCollapsed]);
  const startChatResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      // panel hugs the right edge → width = distance from pointer to viewport right.
      setChatW(Math.min(CHAT_MAX, Math.max(CHAT_MIN, window.innerWidth - ev.clientX)));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const openUtil = useCallback((t: UtilityTab) => { setUtilTab(t); setUtilOpen(true); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dispatchGoal = useCallback((text: string) => {
    setPrefill((p) => ({ text, nonce: p.nonce + 1 }));
    setMobilePane("chat");
  }, []);

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = [
      { id: "dispatch", title: "Dispatch a goal", group: "Goal", keywords: "task run create command", run: () => dispatchGoal("") },
      { id: "open-audit", title: "Open Audit", group: "View", keywords: "log history", run: () => openUtil("audit") },
      { id: "open-tools", title: "Open Tools", group: "View", keywords: "connectors exec factory sessions", run: () => openUtil("tools") },
      { id: "open-replay", title: "Open Replay", group: "View", keywords: "time scrubber history", run: () => openUtil("replay") },
      { id: "open-settings", title: "Open Settings", group: "Settings", keywords: "theme accent tier policy", run: () => setSettingsOpen(true) },
      { id: "open-tour", title: "Replay onboarding tour", group: "Settings", keywords: "help welcome guide", run: () => setOnboardingOpen(true) },
    ];
    for (const t of MODEL_TIERS) {
      cmds.push({ id: `model-${t.key}`, title: `Switch model: ${t.label}`, group: "Model", hint: t.hint, keywords: `tier ${t.hint}`,
        run: () => { saveTier(BOSS_ID, t.key); setTierReloadKey((k) => k + 1); } });
    }
    for (const a of state?.agents ?? []) {
      cmds.push({ id: `inspect-${a.id}`, title: `Inspect ${a.id}`, group: "Agents", keywords: `${a.id} ${a.role}`, run: () => openAgent(a.id) });
    }
    return cmds;
  }, [state?.agents, dispatchGoal, openUtil, openAgent]);

  const counts = viewCounts ?? state?.counts ?? null;
  const needYou = counts ? counts.blocked + counts.stale : 0;
  const reassurance = counts == null ? "" : needYou === 0 ? "All agents working · nothing needs you" : `${needYou} need${needYou === 1 ? "s" : ""} you`;

  return (
    <div className="relative flex h-[100dvh] w-full flex-col overflow-hidden" style={{ backgroundColor: tok("bg") }}>
      {/* faint ambient globe backdrop */}
      {state && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-0 flex items-center justify-center overflow-hidden" style={{ opacity: 0.1 }}>
          <div className="w-[min(78vh,78vw)]"><PulseGlobe agents={state.agents} feed={state.feed} scheduler={state.scheduler} nowMs={globeNowMs} /></div>
        </div>
      )}

      {/* top bar */}
      <header className="relative z-10 flex items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: tok(needYou ? "blocked-amber" : "done-green"), boxShadow: `0 0 8px 1px ${tok(needYou ? "blocked-amber" : "done-green")}` }} aria-hidden />
          <span className="text-sm font-semibold tracking-tight">MissionAlpha</span>
        </span>
        {counts && <span className="hidden text-[12px] text-muted lg:inline">{reassurance}</span>}
        {counts && <span className="ml-1"><CountPills counts={counts} /></span>}

        <div className="ml-auto flex items-center gap-1">
          <NavButton label="Audit" icon={ScrollText} onClick={() => openUtil("audit")} active={utilOpen && utilTab === "audit"} />
          <NavButton label="Tools" icon={Wrench} onClick={() => openUtil("tools")} active={utilOpen && utilTab === "tools"} />
          <NavButton label="Replay" icon={History} onClick={() => openUtil("replay")} active={utilOpen && utilTab === "replay"} />
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Command palette (⌘K)" title="Command palette (⌘K)" className="rounded-md p-1.5 outline-none transition-colors focus-visible:ring-2" style={{ color: tok("muted") }}><Command size={18} aria-hidden /></button>
          <button type="button" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings" className="rounded-md p-1.5 outline-none transition-colors focus-visible:ring-2" style={{ color: tok("muted") }}><SettingsIcon size={18} aria-hidden /></button>
          <ThemeToggle />
        </div>
      </header>

      {/* mobile pane toggle */}
      <div className="relative z-10 flex gap-1 border-b border-border px-3 py-1.5 lg:hidden" role="tablist" aria-label="Pane">
        {([["agents", "Agents", Users], ["board", "Board", LayoutDashboard], ["chat", "Chat", MessageSquare]] as const).map(([id, label, Icon]) => (
          <button key={id} role="tab" aria-selected={mobilePane === id} onClick={() => setMobilePane(id)}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] outline-none focus-visible:ring-2"
            style={{ color: mobilePane === id ? tok("text") : tok("muted"), backgroundColor: mobilePane === id ? tok("panel-2") : "transparent" }}>
            <Icon size={15} aria-hidden /> {label}
          </button>
        ))}
      </div>

      {error && <div role="alert" className="relative z-10 border-b border-stale-red bg-panel px-4 py-2 text-sm text-stale-red">{error}</div>}

      {/* 3-zone body */}
      <div className="relative z-10 flex min-h-0 flex-1">
        {/* roster */}
        <aside className={`w-[180px] shrink-0 border-r border-border ${mobilePane === "agents" ? "block w-full" : "hidden"} lg:block lg:w-[180px]`}>
          {state ? <AgentRoster agents={state.agents} selectedId={selectedAgentId} onSelect={openAgent} /> : <LoadingShell />}
        </aside>

        {/* board (primary) */}
        <main className={`min-w-0 flex-1 flex-col ${mobilePane === "board" ? "flex" : "hidden"} lg:flex`}>
          {state ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
                <h2 className="text-sm font-medium">Squad missions</h2>
                <ViewToggle view={kanbanMode} onChange={setKanbanMode} />
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4" style={{ overscrollBehavior: "contain" }}>
                <KanbanBoard agents={viewAgents} view={kanbanMode} onSelect={replaying ? undefined : openAgent} />
              </div>
            </>
          ) : <LoadingShell />}
        </main>

        {/* drag handle — desktop, expanded only */}
        {isLg && !chatCollapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat panel"
            onPointerDown={startChatResize}
            onDoubleClick={() => setChatW(CHAT_DEFAULT)}
            title="Drag to resize · double-click to reset"
            className="group hidden shrink-0 cursor-col-resize touch-none lg:block"
            style={{ width: 7, marginInline: -3, zIndex: 20 }}
          >
            <div className="mx-auto h-full w-px opacity-50 transition-opacity group-hover:opacity-100" style={{ backgroundColor: tok("accent-cyan") }} />
          </div>
        )}

        {/* right panel — Chat | Feed (resizable + collapsible on desktop) */}
        {isLg && chatCollapsed ? (
          <button
            type="button"
            onClick={() => setChatCollapsed(false)}
            aria-label="Open chat panel"
            title="Open chat panel"
            className="hidden w-9 shrink-0 items-center justify-center border-l border-border outline-none transition-colors hover:bg-panel-2 focus-visible:ring-2 lg:flex"
            style={{ color: tok("muted") }}
          >
            <PanelRightOpen size={18} aria-hidden />
          </button>
        ) : (
          <div
            className={`min-w-0 shrink-0 overflow-hidden ${mobilePane === "chat" ? "flex w-full" : "hidden"} lg:flex`}
            style={isLg ? { width: chatW } : undefined}
          >
            {state && (
              <RightPanel
                bossId={BOSS_ID}
                messages={bossMsgs}
                setMessages={setMessages}
                onCommand={sendCommand}
                prefill={prefill}
                tierReloadKey={tierReloadKey}
                feed={viewFeed}
                agents={viewAgents}
                onCollapse={isLg ? () => setChatCollapsed(true) : undefined}
              />
            )}
          </div>
        )}
      </div>

      {/* overlays */}
      {state && (
        <AgentDrawer agent={selectedAgent} agents={state.agents} feed={state.feed} heartbeats={state.heartbeats} onClose={() => setSelectedAgentId(null)} onCommand={sendCommand} />
      )}
      {state && (
        <UtilityDrawer
          open={utilOpen} tab={utilTab} onTab={setUtilTab} onClose={() => setUtilOpen(false)}
          state={state} viewAgents={viewAgents} replayMs={replayMs} playing={playing}
          onScrub={enterReplay} onLive={goLive} onTogglePlay={() => setPlaying((p) => !p)}
          sendCommand={sendCommand} getAudit={getAudit} getCommandStatus={getCommandStatus} listSessions={listSessions}
          feedForReplay={state.feed}
        />
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={paletteCommands} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Onboarding open={onboardingOpen} onClose={() => setOnboardingOpen(false)} onTryGoal={(goal) => dispatchGoal(goal)} />
    </div>
  );
}

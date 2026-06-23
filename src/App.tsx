import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { Users, LayoutDashboard, MessageSquare, PanelRightOpen } from "lucide-react";
import { useAgentState } from "./data/useAgentState";
import type { Counts } from "./data/types";
import { ChatPane, type Msg } from "./components/workspace/ChatPane";
import { AgentRoster } from "./components/cockpit/AgentRoster";
import { RightPanel } from "./components/cockpit/RightPanel";
import { UtilityDrawer, type UtilityTab } from "./components/cockpit/UtilityDrawer";
import { KanbanBoard } from "./components/KanbanBoard";
import { ViewToggle, type BoardView } from "./components/ViewToggle";
import { PulseGlobe } from "./components/PulseGlobe";
import { AgentDrawer } from "./components/AgentDrawer";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { Onboarding, hasOnboarded } from "./components/onboarding/Onboarding";
import { TitleBar } from "./components/shell/TitleBar";
import { StatusStrip } from "./components/shell/StatusStrip";
import { PreflightGate } from "./components/PreflightGate";
import { SwarmHero } from "./components/hero/SwarmHero";
import type { PaletteCommand } from "./lib/paletteCommands";
import { MODEL_TIERS, saveTier } from "./lib/modelTiers";
import { runtimeToken } from "./lib/runtimeToken";
import { runtimeUrl, type PreflightResult } from "./lib/runtimeBase";
import { tok, TIER_ACCENT, TIER_LABEL } from "./lib/agentMeta";
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

  // Host-dependency preflight pushed from the electron bridge (claude/docker/auth).
  // Undefined in dev/vite (bridge absent) → gate + status strip degrade gracefully.
  // Optional-chained so it NEVER crashes when window.missionAlpha is missing.
  const [preflight, setPreflight] = useState<PreflightResult | undefined>(undefined);
  useEffect(() => {
    window.missionAlpha?.onPreflight?.((result) => setPreflight(result));
  }, []);

  // Boss command thread (the ONE chat).
  const [bossMsgs, setBossMsgs] = useState<Msg[]>([]);
  const setMessages = useCallback((updater: (prev: Msg[]) => Msg[]) => setBossMsgs((prev) => updater(prev)), []);
  useEffect(() => {
    migrateOffLegacyShell();
    let cancelled = false;
    (async () => {
      try {
        const token = await runtimeToken();
        const res = await fetch(runtimeUrl(`/runtime/${BOSS_ID}/thread`), { cache: "no-store", headers: { "x-runtime-token": token } });
        const msgs = res.ok ? (((await res.json()) as { messages?: Msg[] }).messages ?? []) : [];
        if (!cancelled) setBossMsgs(msgs);
      } catch { /* empty */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // SwarmHero inline panel: which agent is open + a lazy per-agent message store (reuses ChatPane;
  // no second chat engine). Each opened agent's history is fetched on demand, same path as the Boss.
  const [heroAgentId, setHeroAgentId] = useState<string | null>(null);
  const [agentMsgs, setAgentMsgs] = useState<Record<string, Msg[]>>({});
  const setAgentMessages = useCallback(
    (id: string) => (updater: (prev: Msg[]) => Msg[]) =>
      setAgentMsgs((m) => ({ ...m, [id]: updater(m[id] ?? []) })),
    [],
  );
  useEffect(() => {
    if (!heroAgentId) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await runtimeToken();
        const res = await fetch(runtimeUrl(`/runtime/${encodeURIComponent(heroAgentId)}/thread`), {
          cache: "no-store", headers: { "x-runtime-token": token },
        });
        const msgs = res.ok ? (((await res.json()) as { messages?: Msg[] }).messages ?? []) : [];
        if (!cancelled) setAgentMsgs((m) => ({ ...m, [heroAgentId]: msgs }));
      } catch { /* empty */ }
    })();
    return () => { cancelled = true; };
  }, [heroAgentId]);

  // The hero panel's chat slot: the EXISTING ChatPane for an agent thread (isBoss=false). All
  // send/apply still routes through sendCommand + the ChatPane permission gates — no new path.
  const renderHeroChat = useCallback(
    (id: string) => {
      const a = state?.agents.find((x) => x.id === id);
      return (
        <ChatPane
          threadId={id}
          title={id}
          subtitle={a ? `${a.role} · ${TIER_LABEL[a.tier]}` : id}
          accent={a ? TIER_ACCENT[a.tier] : "accent-cyan"}
          isBoss={false}
          messages={agentMsgs[id] ?? []}
          setMessages={setAgentMessages(id)}
          onCommand={sendCommand}
        />
      );
    },
    [state?.agents, agentMsgs, setAgentMessages, sendCommand],
  );

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
  const [heroOpen, setHeroOpen] = useState(false);
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
  // Holds the teardown for an in-flight chat-divider drag so an unmount mid-drag
  // can remove the window listeners and restore document.body.style.userSelect.
  const chatDragCleanupRef = useRef<(() => void) | null>(null);
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
      chatDragCleanupRef.current = null;
    };
    chatDragCleanupRef.current = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);
  // On unmount, tear down any drag still in progress (listeners + userSelect).
  useEffect(() => () => { chatDragCleanupRef.current?.(); }, []);

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

      {/* frameless title bar — drags the window + houses the topbar content */}
      <TitleBar
        counts={counts}
        reassurance={reassurance}
        needYou={needYou}
        activeUtil={utilOpen ? utilTab : null}
        onOpenUtil={openUtil}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHero={() => setHeroOpen(true)}
      />

      {/* preflight gate — blocking setup screen / docker banner / cockpit */}
      <PreflightGate preflight={preflight}>
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
      </PreflightGate>

      {/* bottom status strip — runtime up? · Docker? · quota */}
      <StatusStrip preflight={preflight} />

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
      {state && (
        <SwarmHero
          open={heroOpen}
          agents={state.agents}
          feed={state.feed}
          onClose={() => { setHeroOpen(false); setHeroAgentId(null); }}
          openAgentId={heroAgentId}
          onSelectAgent={setHeroAgentId}
          renderChat={renderHeroChat}
        />
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={paletteCommands} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Onboarding open={onboardingOpen} onClose={() => setOnboardingOpen(false)} onTryGoal={(goal) => dispatchGoal(goal)} />
    </div>
  );
}

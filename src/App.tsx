import type { SelfGradeFrame } from "./lib/selfGrade.ts";
import { useMemo, useState, useCallback, useEffect, useRef, lazy, Suspense, type ReactNode } from "react";
import { Users, LayoutDashboard, MessageSquare, PanelRightOpen, GripVertical, Maximize2, X } from "lucide-react";
import { useAgentState } from "./data/useAgentState";
import type { Counts } from "./data/types";
import { ChatPane, type Msg } from "./components/workspace/ChatPane";
import { AgentRoster } from "./components/cockpit/AgentRoster";
import { RightPanel } from "./components/cockpit/RightPanel";
import { UtilityDrawer, type UtilityTab } from "./components/cockpit/UtilityDrawer";
import { KanbanBoard } from "./components/KanbanBoard";
import { ViewToggle, ShellToggle, type BoardView, type ShellView } from "./components/ViewToggle";
import { AgentDrawer } from "./components/AgentDrawer";
import { CommandPalette } from "./components/CommandPalette";
import { SkillPalette } from "./components/skills/SkillPalette";
import { loadCatalog, type MissionSkill } from "./lib/skillsCatalog";
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
import { clampDockPos } from "./lib/swarmGraph";
import { tok, TIER_ACCENT, TIER_LABEL } from "./lib/agentMeta";
import { reconstructAt, countsFrom } from "./lib/replay";
import { useRuntimeEvents, applyBadge, applyUsageTick, type RuntimeEvent, type UsageByKey } from "./lib/useRuntimeEvents";
import { isQueueEvent } from "./lib/queueModel";
import { applyActivity, type ActivityRow, fallbackSeq } from "./lib/activityStream";

/** Phase 5 — the activity rail's open/closed state survives a reload. */
const ACTIVITY_OPEN_KEY = "ma.activity.open.v1";
import { listInbox, type InboxCounts } from "./lib/inboxClient";
// B2 — only the PURE helpers + the stats fetcher are imported here. VaultPage (the
// graph, the viewer, the markdown parser) stays behind React.lazy so the main index
// never carries the vault UI.
import { getVaultStats, ventureOptions, type VentureRef } from "./lib/vaultClient";
// B5 — the app-wide venture scope. One module store read through useVenture(); the
// sidebar switcher and the Command Center's ventures panel write it, every BOS surface
// re-renders scoped (src/lib/ventureScope.ts).
import { useVenture } from "./lib/ventureScope";
import { emitDeliveryNotification, emitSlaNotification, syncTitleBadge } from "./lib/deliveryNotify";
// CC-Primitives P5 — the shared per-station perm store. ONE line in the SSE reducer
// below keeps the card chip and the drawer toggle reconciled; no Context provider.
import { applyPermFrame } from "./components/station/permStore";
import { AuthProvider, useAuth } from "./lib/useAuth";
// MUNDER-ADOPTION A2 — the breaker ladder's client model (shared with StatusStrip).
import { BREAKER_ORDER, type BreakerLevel, type BreakerSummary } from "./lib/breakerModel";
// MUNDER-ADOPTION A3 — transcript ground-truth totals shape (UsageOverview footer).
import type { TranscriptTotals } from "./components/workspace/UsageMeter";
import { LoginGate } from "./components/auth/LoginGate";
import { BosSidebar } from "./components/bos/BosSidebar";
import { BOS_NAV, type BosNavEntry, type BosPage } from "./components/bos/bosNav";

// P3 feature flag (program plan §5.1). ON by default; VITE_INBOX=0 restores the
// pre-P3 cockpit EXACTLY — no toggle, no skin attribute, no SSE subscription, and
// the Inbox chunk is never fetched (it is a lazy import below).
const INBOX_ENABLED =
  import.meta.env.VITE_INBOX !== "0" && import.meta.env.VITE_INBOX !== "false";

// B0 — Business-OS shell flag. Nested under INBOX_ENABLED on purpose: the sidebar's
// primary destination IS the P3 Inbox, so with the Inbox off there is nothing to
// navigate to. VITE_BOS=0 restores the shipped P3 shell EXACTLY — the ShellToggle
// returns to the title bar, the sidebar never mounts, and the layout wrapper element
// does not exist in the tree at all (see BosFrame below).
const BOS_ENABLED =
  INBOX_ENABLED && import.meta.env.VITE_BOS !== "0" && import.meta.env.VITE_BOS !== "false";

// Stable empty roster so the memoised sidebar does not re-render on every poll tick
// during the pre-load window where `state` is still null.
const NO_AGENTS = [] as const;
// B2 — same reason: a stable empty roster so the memoised sidebar does not re-render
// while the vault stats are still in flight.
const NO_VENTURES = [] as const;

const InboxPanel = lazy(() =>
  import("./components/inbox").then((m) => ({ default: m.InboxPanel })),
);

// B1 — the Command deck is its OWN chunk. B0 left 1.7KB of gzip headroom on the main
// index; a lazy import keeps the deck (and its modal + icons) out of it entirely, so
// the deck is downloaded the first time the BOSS actually opens it.
const CommandDeck = lazy(() =>
  import("./components/bos/CommandDeck").then((m) => ({ default: m.CommandDeck })),
);

// B5 — the Command Center is its OWN chunk too: the page, the four StatTiles, the
// ventures + needs-you panels, and the kpiClient all ride here, NOT the main index
// (which sits under a hard gzip ceiling). Downloaded the first time the BOSS opens it.
const CommandCenter = lazy(() =>
  import("./components/bos/CommandCenter").then((m) => ({ default: m.CommandCenter })),
);

// B2 — the Knowledge Vault is its OWN chunk too. It pulls the graph, the record viewer
// and the markdown line parser; none of that belongs in the main index, which sits
// under a hard gzip ceiling. Downloaded the first time the BOSS opens the vault.
const VaultPage = lazy(() =>
  import("./components/bos/VaultPage").then((m) => ({ default: m.VaultPage })),
);

// B3 — the CEO brief is its OWN chunk too. It pulls the Captain console, the dial and
// the agent log; none of that belongs in the main index, which sits under a hard gzip
// ceiling. Downloaded the first time the BOSS opens the brief.
const BriefPage = lazy(() =>
  import("./components/bos/BriefPage").then((m) => ({ default: m.BriefPage })),
);

// B4 — Automation is its OWN pair of chunks. Each pulls the cadence client, the drawer
// and the reused confirm gate; none of that belongs in the main index, which sits under
// a hard gzip ceiling. Downloaded the first time the BOSS opens Workflows / Schedule.
const WorkflowsPage = lazy(() =>
  import("./components/bos/WorkflowsPage").then((m) => ({ default: m.WorkflowsPage })),
);
const SchedulePage = lazy(() =>
  import("./components/bos/SchedulePage").then((m) => ({ default: m.SchedulePage })),
);

// S0 (story pipeline) — B6's Pipeline/Content surfaces are DELETED, not merely unwired:
// their pages, drawers and client libs are gone from the tree, so there is no lazy
// chunk to declare here.
// B7 — the artifact registry + the read-only roadmap, both their own chunks (thin bundle).
const OutputsPage = lazy(() =>
  import("./components/bos/OutputsPage").then((m) => ({ default: m.OutputsPage })),
);
// Multi-Provider Credentials — the Accounts page is its OWN chunk: the add-account
// form, the Framer-Motion list and the accounts client stay out of the main index.
const AccountsPage = lazy(() =>
  import("./components/bos/AccountsPage").then((m) => ({ default: m.AccountsPage })),
);
const RoadmapPage = lazy(() =>
  import("./components/bos/RoadmapPage").then((m) => ({ default: m.RoadmapPage })),
);

// S6 (story pipeline) — the Stories board + detail are their OWN chunk. It pulls the stories
// client, the spine tracker, the Build panel and the inline gate actions; none of that belongs
// in the main index, which sits under a hard gzip ceiling. Downloaded the first time the BOSS
// opens Stories.
const StoriesPage = lazy(() =>
  import("./components/bos/StoriesPage").then((m) => ({ default: m.StoriesPage })),
);

// The ambient globe is a faint (0.1-opacity) decorative backdrop. It pulls in three.js
// (~226KB gz). Lazy + idle-gated so that heavy chunk is NEVER fetched on the initial
// paint — it streams in after first paint when the browser is idle. Behavior is
// unchanged (the globe still renders); it just no longer competes with first paint.
const PulseGlobe = lazy(() =>
  import("./components/PulseGlobe").then((m) => ({ default: m.PulseGlobe })),
);

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

/**
 * B0 — the BOS layout frame. Flag ON: the shell body becomes a flex row — the
 * sidebar rail first, then the EXISTING content in its own `min-w-0` column, so
 * nothing inside had to move. Flag OFF: this renders its children and nothing
 * else, so the shipped tree is unchanged — the wrapper element is not merely
 * hidden, it is never created.
 */
function BosFrame({ enabled, sidebar, children }: { enabled: boolean; sidebar: ReactNode; children: ReactNode }) {
  if (!enabled) return <>{children}</>;
  return (
    <div className="relative z-10 flex min-h-0 flex-1">
      {sidebar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

type MobilePane = "agents" | "board" | "chat";

// P9 — second seat. When auth is active (≥2 accounts) and there is no valid session,
// the whole app is replaced by the LoginGate; while /auth/me is in flight we show the
// existing LoadingShell to avoid a flash. Solo (0/1 account) never gates → the app
// renders exactly as it always has. The provider wraps everything so InboxPanel's
// role/assignment reads the same context.
export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

function AuthGate() {
  const { loading, authActive, user } = useAuth();
  if (authActive && !user) return loading ? <LoadingShell /> : <LoginGate />;
  return <AppInner />;
}

function AppInner() {
  const { state, error, sendCommand, getAudit, getCommandStatus, listSessions } = useAgentState();

  // Host-dependency preflight pushed from the electron bridge (claude/docker/auth).
  // Undefined in dev/vite (bridge absent) → gate + status strip degrade gracefully.
  // Optional-chained so it NEVER crashes when window.missionAlpha is missing.
  const [preflight, setPreflight] = useState<PreflightResult | undefined>(undefined);
  useEffect(() => {
    window.missionAlpha?.onPreflight?.((result) => setPreflight(result));
  }, []);

  // Defer the ambient 3D globe until the browser is idle after first paint, so its
  // three.js chunk never competes with the initial render. Falls back to a short timer
  // where requestIdleCallback is absent (Safari). One-shot.
  const [globeReady, setGlobeReady] = useState(false);
  useEffect(() => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof ric === "function") {
      const id = ric(() => setGlobeReady(true), { timeout: 1500 });
      const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      return () => { if (typeof cic === "function") cic(id); };
    }
    const t = setTimeout(() => setGlobeReady(true), 200);
    return () => clearTimeout(t);
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
  // P2-3 movable/dismissible mini dock: persisted position + dismissed flag.
  const DOCK_W = 240, DOCK_H = 190;
  const [dockDismissed, setDockDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem("ma.dockDismissed") === "1"; } catch { return false; }
  });
  const [dockPos, setDockPos] = useState<{ x: number; y: number }>(() => {
    try { const s = localStorage.getItem("ma.dockPos"); if (s) return JSON.parse(s) as { x: number; y: number }; } catch { /* ignore */ }
    const vpH = typeof window !== "undefined" ? window.innerHeight : 900;
    return { x: 16, y: vpH - DOCK_H - 80 };
  });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  useEffect(() => { try { localStorage.setItem("ma.dockPos", JSON.stringify(dockPos)); } catch { /* ignore */ } }, [dockPos]);
  useEffect(() => { try { localStorage.setItem("ma.dockDismissed", dockDismissed ? "1" : "0"); } catch { /* ignore */ } }, [dockDismissed]);
  const onDockDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { dx: e.clientX - dockPos.x, dy: e.clientY - dockPos.y };
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      setDockPos(clampDockPos(ev.clientX - dragRef.current.dx, ev.clientY - dragRef.current.dy, DOCK_W, DOCK_H, window.innerWidth, window.innerHeight, 8));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = ""; document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none"; document.body.style.cursor = "grabbing";
  }, [dockPos.x, dockPos.y]);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on state?.generatedAt only; depending on `state` would recompute on every poll tick.
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
  // F5 — bumping this opens the Agent Factory (inside the Tools utility drawer) on Create.
  const [factoryOpenSignal, setFactoryOpenSignal] = useState(0);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  const [skillsOpen, setSkillsOpen] = useState(false);
  // The ~3,100-entry catalog is a lazily-loaded chunk (see lib/skillsCatalog) — it is
  // fetched the first time the palette opens, never on first paint.
  const [skills, setSkills] = useState<readonly MissionSkill[]>([]);
  const [tierReloadKey, setTierReloadKey] = useState(0);

  // Fetch the catalog chunk the first time the palette is opened; cached thereafter.
  useEffect(() => {
    if (!skillsOpen || skills.length) return;
    let live = true;
    void loadCatalog().then((c) => { if (live) setSkills(c.MISSION_SKILLS); });
    return () => { live = false; };
  }, [skillsOpen, skills.length]);

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
  // F5 — the roster's "+ Add" no longer opens a picker itself; it routes to the Factory,
  // which is the single home for putting an agent on the board.
  const openFactory = useCallback(() => {
    setUtilTab("tools");
    setUtilOpen(true);
    setFactoryOpenSignal((n) => n + 1);
  }, []);

  const skillsOpenRef = useRef(skillsOpen);
  useEffect(() => { skillsOpenRef.current = skillsOpen; }, [skillsOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); setPaletteOpen((o) => !o); }
      // "/" opens the Skills palette — only when not typing into a field.
      else if (e.key === "/" && !skillsOpenRef.current) {
        const t = e.target as HTMLElement | null;
        const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        if (!typing) { e.preventDefault(); setSkillsOpen(true); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dispatchGoal = useCallback((text: string) => {
    setPrefill((p) => ({ text, nonce: p.nonce + 1 }));
    setMobilePane("chat");
  }, []);

  // Pick a skill from the palette → drop its prompt into the composer (existing gated prefill flow).
  const pickSkillIntoComposer = useCallback((s: MissionSkill) => {
    setPrefill((p) => ({ text: s.prompt, nonce: p.nonce + 1 }));
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
      { id: "open-skills", title: "Skills palette", group: "Open", hint: "/", keywords: "skill catalog library prompt", run: () => setSkillsOpen(true) },
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

  // ── P3: the ONE SSE subscription (ADR-052) ────────────────────────────────
  // Lives here, not inside InboxPanel, so switching to the Board never tears the
  // stream down — the badge has to keep counting while the Inbox is off-screen.
  // The existing 2s state.json poll (useAgentState) is untouched and is NOT gated
  // on this: when the bus is down the board stays live and the Inbox shows a banner.
  const [shellView, setShellView] = useState<ShellView>(INBOX_ENABLED ? "inbox" : "board");
  // B1 — which BOS page owns the main slot, or null when a shellView does. Exactly one
  // of the two renders, so there is still exactly one <main id="ma-main"> in the tree.
  const [bosPage, setBosPage] = useState<BosPage | null>(null);
  // Leaving a BOS page is the same act as choosing a view — the toggle below lg is the
  // only nav a narrow window has, so it must be able to get out of the deck.
  const goShellView = useCallback((v: ShellView) => { setBosPage(null); setShellView(v); }, []);
  // B3 — the CEO brief's needs-review deep-link: leave the brief, land on the Inbox with
  // that delivery already selected. `initialSelectedId` on InboxPanel is ADDITIVE and
  // optional, so every other path into the Inbox behaves exactly as it did before.
  const [inboxSelectId, setInboxSelectId] = useState<string | null>(null);
  const openDelivery = useCallback((id: string) => {
    setInboxSelectId(id);
    setBosPage(null);
    setShellView("inbox");
  }, []);
  // B5 — the venture scope is now a SINGLE app-wide source (src/lib/ventureScope.ts).
  // B2 held it in local state and threaded it to the Vault page + the deck's records
  // read ("app-wide scoping lands in B5"); B5 promotes it to a module store read through
  // useVenture(), so the sidebar switcher AND the Command Center's ventures panel write
  // ONE value and every open BOS surface re-renders scoped. `chooseVenture` keeps its
  // name — it is the store's setter, wired unchanged into the sidebar + palette.
  const { venture, setVenture: chooseVenture } = useVenture();
  // The venture roster for the switcher, read once per resync (not on a timer).
  const [ventures, setVentures] = useState<readonly VentureRef[]>(NO_VENTURES);
  // Bumped on every `vault.written` frame — the Vault page re-reads authoritative
  // state instead of polling, so a record another station wrote appears with no refresh.
  const [vaultNonce, setVaultNonce] = useState(0);
  // Phase 5 — the activity feed's bounded ring buffer (500 rows, newest first). It fills
  // from the SSE subscription below whether or not the panel is open, so opening the rail
  // shows history rather than an empty box.
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  // Identity for frames that arrive without a bus sequence. Counts DOWN so it can never
  // collide with a real (positive, monotonic) sequence and defeat replay dedupe.
  const [activityOpen, setActivityOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(ACTIVITY_OPEN_KEY) !== "0"; } catch { return true; }
  });
  const toggleActivity = useCallback(() => {
    setActivityOpen((v) => {
      const next = !v;
      try { localStorage.setItem(ACTIVITY_OPEN_KEY, next ? "1" : "0"); } catch { /* storage blocked */ }
      return next;
    });
  }, []);
  // CC-Primitives P6 — bumped on every `memory.changed` frame, mirroring vaultNonce
  // above: the Vault's station memory panel re-reads rather than polling or trying to
  // reconstruct the new text from the (identity-only) frame.
  const [memoryNonce, setMemoryNonce] = useState(0);
  // B4 — bumped on every `workflow.run` frame so the Workflows/Schedule pages re-read
  // authoritative next_run/last_run (a fired slot advances the schedule) without polling.
  const [workflowNonce, setWorkflowNonce] = useState(0);
  // S6 — bumped on every `story.changed` frame so the Stories board + open detail re-read
  // authoritative story/stage/build state (the frame is identity-only {id, stage}) without polling.
  const [storyNonce, setStoryNonce] = useState(0);
  // 12.2 — the Job board's own nonce (see the job.changed branch below).
  const [jobNonce, setJobNonce] = useState(0);
  const [pendingDeliveries, setPendingDeliveries] = useState(0);
  const [lastEvent, setLastEvent] = useState<RuntimeEvent | null>(null);
  const [resyncNonce, setResyncNonce] = useState(0);
  // D7 — monotonic count of queue-moving frames (see onRuntimeEvent).
  const [queueNonce, setQueueNonce] = useState(0);
  // Phase 1 / R4 — bumped on every `doctor.status` frame; the Command Center re-reads.
  const [doctorNonce, setDoctorNonce] = useState(0);
  // Phase 3 / R9 — the grade is re-READ on this nonce; the FRAME is kept for its delta.
  const [selfGradeNonce, setSelfGradeNonce] = useState(0);
  const [selfGradeFrame, setSelfGradeFrame] = useState<SelfGradeFrame | null>(null);
  // P8 (ADR-030) — live usage from the bus (usage.tick), keyed thread×tier. Feeds the
  // UsageOverview panel. Tokens + context% only — never $.
  const [usageByThread, setUsageByThread] = useState<UsageByKey>({});
  const notifiedRef = useRef<Set<string>>(new Set());
  const slaNotifiedRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef(0);
  // MUNDER-ADOPTION A2 — the breaker ladder, folded from `breaker.state` frames. The
  // frame is the WHOLE truth the strip needs (agentId + level), so unlike the nonce
  // patterns above there is no re-read: the map accumulates levels and the chip renders
  // the worst + how many agents are degraded. In-memory like the runtime's own ladder —
  // a reload starts all-healthy until the next change frame (the gated GET has the rest).
  const breakerMapRef = useRef<Map<string, BreakerLevel>>(new Map());
  const [breakerSummary, setBreakerSummary] = useState<BreakerSummary | null>(null);
  // MUNDER-ADOPTION A3 — transcript ground-truth totals (usage.transcript frames).
  // Aggregate-only, kept as-is: the frame IS the summary; detail stays behind the GET.
  const [transcriptTotals, setTranscriptTotals] = useState<TranscriptTotals | null>(null);
  useEffect(() => { pendingRef.current = pendingDeliveries; }, [pendingDeliveries]);

  const onRuntimeEvent = useCallback((e: RuntimeEvent) => {
    setLastEvent(e);
    // D7 — `lastEvent` is a single VALUE slot, and SSE hands us several frames in one
    // chunk. React batches the assignments, so a burst of `task.queued` + `task.started`
    // + `usage.tick` leaves `lastEvent` holding only the tick and the queue strip never
    // learns anything happened — measured live as "0 running" beside a claimed task, with
    // two authoritative re-reads in twenty minutes. A counter bumped through an UPDATER
    // survives the same batching, which is exactly why applyBadge below never lost a
    // delivery. The strip re-reads authoritative state off this, so no frame is load-
    // bearing on its own.
    if (isQueueEvent(e.name)) setQueueNonce((n) => n + 1);
    setPendingDeliveries((p) => applyBadge(p, e));
    // Phase 5 — the activity feed. Folded HERE, in the app's single SSE subscription,
    // rather than in the panel: a second EventSource would double the runtime's fan-out
    // for a read-only surface, and the feed must keep filling while the panel is closed.
    // `seq` is the bus sequence and is what makes a reconnect replay idempotent. A frame
    // without one gets a DETERMINISTIC id derived from its own content (fallbackSeq) —
    // the previous decrementing counter handed the same redelivered frame a different id
    // each time, so the dedupe never matched and a reconnect could render it twice.
    setActivity((rows) => applyActivity(rows, e, typeof e.seq === "number" ? e.seq : fallbackSeq(e), Date.now()));
    if (e.name === "usage.tick") setUsageByThread((m) => applyUsageTick(m, e));
    // MUNDER-ADOPTION A3 — the transcript ledger moved. Change-only frames; kept whole.
    if (e.name === "usage.transcript") {
      const d = e.data as { sessions?: number; inputTokens?: number; outputTokens?: number; source?: string };
      setTranscriptTotals({
        sessions: Number(d?.sessions) || 0,
        inputTokens: Number(d?.inputTokens) || 0,
        outputTokens: Number(d?.outputTokens) || 0,
        source: typeof d?.source === "string" ? d.source : "none",
      });
    }
    // B2 — a record landed somewhere in the vault. The frame is identity-only, so the
    // page re-READS rather than trying to reconstruct a record from the payload.
    if (e.name === "vault.written") setVaultNonce((n) => n + 1);
    // MUNDER-ADOPTION A4 — a lane was condensed (records evicted into the rolling
    // summary). Same re-read contract as vault.written: the page refetches.
    if (e.name === "vault.condensed") setVaultNonce((n) => n + 1);
    // CC-Primitives P6 — a station's memory changed. Identity-only frame; the panel
    // re-READS rather than trying to reconstruct memory text from the payload.
    if (e.name === "memory.changed") setMemoryNonce((n) => n + 1);
    if (e.name === "workflow.run") setWorkflowNonce((n) => n + 1);
    // Phase 1 / R4 — a doctor verdict CHANGED. The frame is {status, fails, warns} and
    // deliberately carries no checks: a health report enumerates this install's weaknesses
    // and the bus is a broadcast. So it is a signal to re-READ the token-gated route — the
    // same shape as `memory.changed` above, for the same reason.
    if (e.name === "doctor.status") setDoctorNonce((n) => n + 1);
    // Phase 3 / R9 — the self-grade moved. Unlike every other identity-only frame here,
    // this one is KEPT rather than only counted: `delta`/`appeared`/`cleared` come from the
    // runtime's own diffGrades and exist NOWHERE else — the route has no notion of "since
    // when". Re-deriving the arrow client-side could disagree with the server about why the
    // number moved, which is the one thing this tile must not do.
    if (e.name === "selfgrade.changed") {
      const d = e.data as { delta?: number; appeared?: string[]; cleared?: string[] };
      setSelfGradeFrame({
        delta: Number(d?.delta) || 0,
        appeared: Array.isArray(d?.appeared) ? d.appeared : [],
        cleared: Array.isArray(d?.cleared) ? d.cleared : [],
      });
      setSelfGradeNonce((n) => n + 1);
    }
    // S6 — a story was created or changed stage. Identity-only frame ({id, stage}); the board
    // and any open detail re-READ authoritative state rather than reconstructing from the frame.
    if (e.name === "story.changed") setStoryNonce((n) => n + 1);
    // 12.2 — the Job board. Separate from storyNonce so a story frame does not re-read the
    // job board and vice versa. `job.changed` fires on create, on a status move and (since
    // 12.2) on every task move, which is what makes a card's CONTENTS live and not just
    // its column.
    if (e.name === "job.changed") setJobNonce((n) => n + 1);
    // P5 — a station's interactive permission override moved. Identity + mode only;
    // the store reconciles the card chip and the drawer toggle from the same frame.
    if (e.name === "station.perm.changed") applyPermFrame(e.data);
    // MUNDER-ADOPTION A2 — an agent's runaway-ladder level changed. Change-only frames;
    // the map is the strip's whole data source (see breakerMapRef above).
    if (e.name === "breaker.state") {
      const d = e.data as { agentId?: string; level?: string };
      if (d?.agentId && typeof d.level === "string" && BREAKER_ORDER[d.level as BreakerLevel] !== undefined) {
        breakerMapRef.current.set(d.agentId, d.level as BreakerLevel);
        let worst: BreakerLevel = "healthy";
        let degraded = 0;
        for (const l of breakerMapRef.current.values()) {
          if (BREAKER_ORDER[l] > 0) degraded += 1;
          if (BREAKER_ORDER[l] > BREAKER_ORDER[worst]) worst = l;
        }
        setBreakerSummary({ worst, degraded });
      }
    }
    if (e.name === "delivery.created") {
      emitDeliveryNotification(e.data, pendingRef.current + 1, notifiedRef.current);
    }
    // P6 (§5.10) — the ONE permitted re-notification: a delivery reached its SLA
    // half-life and is still undecided. Deduped on its own seen-set (replay-safe).
    if (e.name === "delivery.sla_halflife") {
      emitSlaNotification(e.data, slaNotifiedRef.current);
    }
  }, []);
  const onResync = useCallback(() => setResyncNonce((n) => n + 1), []);

  const { connected: liveConnected, retryAt, reconnectNow } = useRuntimeEvents({
    enabled: INBOX_ENABLED,
    onEvent: onRuntimeEvent,
    onResync,
  });

  // Authoritative badge baseline. The SSE deltas are exact between reads; this
  // corrects for anything that happened before the tab existed, and re-corrects on
  // every reconnect (an events_log prune can outlive a long disconnect).
  const applyCounts = useCallback((c: InboxCounts) => {
    setPendingDeliveries(Number(c.pending) || 0);
  }, []);
  useEffect(() => {
    if (!INBOX_ENABLED) return;
    let live = true;
    listInbox({ limit: 1 })
      .then((r) => { if (live && r.counts) applyCounts(r.counts); })
      .catch(() => { /* the strip degrades to the SSE delta; no crash path */ });
    return () => { live = false; };
  }, [resyncNonce, applyCounts]);

  // B2 — the venture roster behind the sidebar switcher. Read on mount, on every SSE
  // resync, and whenever a record is written (a new venture can only appear that way).
  // A failure leaves the roster empty, which renders "All ventures" alone — never a
  // fabricated list.
  useEffect(() => {
    if (!BOS_ENABLED) return;
    let live = true;
    getVaultStats()
      .then((s) => { if (live) setVentures(ventureOptions(s)); })
      .catch(() => { if (live) setVentures(NO_VENTURES); });
    return () => { live = false; };
  }, [resyncNonce, vaultNonce]);

  // Web badge (tab title). Electron gets the real dock badge over the bridge.
  useEffect(() => { if (INBOX_ENABLED) syncTitleBadge(pendingDeliveries); }, [pendingDeliveries]);

  // The Helm skin is an ADDITIVE attribute, separate from data-theme, applied only
  // while the Inbox is on screen. Removing it restores the cockpit exactly.
  // B0: with the BOS shell on, the sidebar is helm-styled on BOTH views, so the
  // attribute stays put across the Inbox ⇄ Board switch.
  useEffect(() => {
    if (!INBOX_ENABLED) return;
    const el = document.documentElement;
    if (BOS_ENABLED || shellView === "inbox") el.setAttribute("data-skin", "helm");
    else el.removeAttribute("data-skin");
    return () => el.removeAttribute("data-skin");
  }, [shellView]);

  // B0 — the ONE dispatch for every sidebar / palette BOS entry. Each arm calls a
  // setter that already ships; nothing here creates a new surface, which is why an
  // entry can never point at a page that does not exist.
  const onBosNav = useCallback((e: BosNavEntry) => {
    // B1 — a page entry takes the main slot; every entry that flips shellView gives it
    // back. `settings` is deliberately absent from that list: it is an overlay, so the
    // page underneath must survive it.
    if (e.kind === "page") { setBosPage(e.page); return; }
    if (e.kind === "view") { goShellView(e.view); return; }
    switch (e.action) {
      case "settings": setSettingsOpen(true); break;
      case "factory": goShellView("board"); openFactory(); break;
      case "chat": goShellView("board"); if (!isLg) setMobilePane("chat"); break;
      // SessionsBrowser lives inside the utility drawer; "replay" is the exact
      // UtilityTab id (UtilityDrawer.tsx:23 — "audit" | "tools" | "replay").
      case "sessions": goShellView("board"); setUtilOpen(true); setUtilTab("tools"); break; // SessionsBrowser lives in the tools tab (UtilityDrawer:113); replay scrubber is its sibling tab
    }
  }, [isLg, openFactory, goShellView]);

  // BOS palette entries ride the SAME dispatch as the sidebar. Flag off, this
  // returns the shipped list by reference — the palette cannot show them.
  const bosPaletteCommands = useMemo<PaletteCommand[]>(() => {
    if (!BOS_ENABLED) return paletteCommands;
    return [
      ...paletteCommands,
      ...BOS_NAV.map((e) => ({
        id: `bos-${e.id}`,
        title: e.kind === "view" ? `Go to ${e.label}` : `Open ${e.label}`,
        group: "Business OS",
        keywords: `bos sidebar ${e.id} ${e.label}`,
        run: () => onBosNav(e),
      })),
    ];
  }, [paletteCommands, onBosNav]);

  const counts = viewCounts ?? state?.counts ?? null;
  const needYou = counts ? counts.blocked + counts.stale : 0;
  const reassurance = counts == null ? "" : needYou === 0 ? "All agents working · nothing needs you" : `${needYou} need${needYou === 1 ? "s" : ""} you`;

  return (
    <div className="relative flex h-[100dvh] w-full flex-col overflow-hidden" style={{ backgroundColor: tok("bg") }}>
      {/* Skip link (WCAG 2.4.1 bypass-blocks) — first focusable element; hidden until
          keyboard focus, then jumps past the title-bar controls to #ma-main. */}
      <a href="#ma-main" className="ma-skip-link">
        Skip to main content
      </a>
      {/* faint ambient globe backdrop — idle-deferred so three.js stays off first paint */}
      {state && globeReady && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-0 flex items-center justify-center overflow-hidden" style={{ opacity: 0.1 }}>
          <div className="w-[min(78vh,78vw)]">
            <Suspense fallback={null}>
              <PulseGlobe agents={state.agents} feed={state.feed} scheduler={state.scheduler} nowMs={globeNowMs} />
            </Suspense>
          </div>
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
        onOpenSkills={() => setSkillsOpen(true)}
        pendingDeliveries={INBOX_ENABLED ? pendingDeliveries : 0}
        shellToggle={
          // B0 — the sidebar owns surface switching when BOS is on, so the title-bar
          // toggle stands down rather than offering a second control for one job.
          // EXCEPT below lg: the sidebar is CSS-hidden there, so the toggle must
          // return or a narrow window has no Inbox↔Board nav at all (verify-lane catch).
          INBOX_ENABLED && (!BOS_ENABLED || !isLg) ? (
            <ShellToggle view={shellView} onChange={goShellView} pending={pendingDeliveries} />
          ) : undefined
        }
      />

      {/* preflight gate — blocking setup screen / docker banner / cockpit */}
      <PreflightGate preflight={preflight} onOpenAccounts={() => setBosPage("accounts")}>
      {/* B0 — sidebar + shell body. The rail is a <nav>, never a <main>, so exactly
          one <main id="ma-main"> still renders per view and the skip link keeps its
          single target. It also sits AFTER the skip link in DOM order. */}
      <BosFrame
        enabled={BOS_ENABLED}
        sidebar={
          <BosSidebar
            shellView={shellView}
            bosPage={bosPage}
            pending={pendingDeliveries}
            agents={state?.agents ?? NO_AGENTS}
            onNav={onBosNav}
            onAgent={openAgent}
            venture={venture}
            ventures={ventures}
            onVenture={chooseVenture}
          />
        }
      >
      {/* B5 — the Command Center is the cross-venture home; it takes the main slot first.
          Exactly one <main id="ma-main"> still renders, so the skip link keeps its one
          target. venture scope comes from useVenture() inside the page (app-wide). */}
      {BOS_ENABLED && bosPage === "center" ? (
        <Suspense
          fallback={
            <div className="relative z-10 flex flex-1 items-center justify-center text-muted" role="status" aria-live="polite">
              <span className="font-mono text-sm">opening the command center…</span>
            </div>
          }
        >
          <main id="ma-main" aria-label="Command center" className="relative z-10 flex min-h-0 flex-1">
            <CommandCenter
              pending={pendingDeliveries}
              vaultNonce={vaultNonce}
              workflowNonce={workflowNonce}
              resyncNonce={resyncNonce}
              doctorNonce={doctorNonce}
              selfGradeNonce={selfGradeNonce}
              selfGradeFrame={selfGradeFrame}
              onOpenDelivery={openDelivery}
              onOpenAccounts={() => setBosPage("accounts")}
              activity={activity}
              activityConnected={liveConnected}
              activityOpen={activityOpen}
              onToggleActivity={toggleActivity}
            />
          </main>
        </Suspense>
      ) : BOS_ENABLED && bosPage === "stories" ? (
        <Suspense
          fallback={
            <div className="relative z-10 flex flex-1 items-center justify-center text-muted" role="status" aria-live="polite">
              <span className="font-mono text-sm">opening the pipeline…</span>
            </div>
          }
        >
          <main id="ma-main" aria-label="Stories" className="relative z-10 flex min-h-0 flex-1">
            <StoriesPage
              venture={venture}
              liveNonce={storyNonce + resyncNonce}
              jobNonce={jobNonce + resyncNonce}
            />
          </main>
        </Suspense>
      ) : BOS_ENABLED && bosPage === "deck" ? (
        <Suspense
          fallback={
            <div className="relative z-10 flex flex-1 items-center justify-center text-muted" role="status" aria-live="polite">
              <span className="font-mono text-sm">opening the deck…</span>
            </div>
          }
        >
          <main id="ma-main" aria-label="Command deck" className="relative z-10 flex min-h-0 flex-1">
            <CommandDeck
              agents={state?.agents ?? NO_AGENTS}
              pending={pendingDeliveries}
              venture={venture}
              vaultNonce={vaultNonce}
              onOpenFactory={openFactory}
              onAgent={openAgent}
              onOpenBrief={() => setBosPage("brief")}
            />
          </main>
        </Suspense>
      ) : BOS_ENABLED && bosPage === "brief" ? (
        <Suspense
          fallback={
            <div className="relative z-10 flex flex-1 items-center justify-center text-muted" role="status" aria-live="polite">
              <span className="font-mono text-sm">opening the brief…</span>
            </div>
          }
        >
          <main id="ma-main" aria-label="Daily brief" className="relative z-10 flex min-h-0 flex-1">
            <BriefPage
              venture={venture}
              lastEvent={lastEvent}
              liveNonce={resyncNonce}
              onOpenDelivery={openDelivery}
            />
          </main>
        </Suspense>
      ) : BOS_ENABLED && bosPage === "vault" ? (
        <Suspense
          fallback={
            <div className="relative z-10 flex flex-1 items-center justify-center text-muted" role="status" aria-live="polite">
              <span className="font-mono text-sm">opening the log…</span>
            </div>
          }
        >
          <main id="ma-main" aria-label="Knowledge vault" className="relative z-10 flex min-h-0 flex-1">
            <VaultPage
              venture={venture}
              liveNonce={vaultNonce + resyncNonce}
              memoryLiveNonce={memoryNonce + resyncNonce}
            />
          </main>
        </Suspense>
      ) : BOS_ENABLED && bosPage === "workflows" ? (
        <Suspense
          fallback={
            <div className="relative z-10 flex flex-1 items-center justify-center text-muted" role="status" aria-live="polite">
              <span className="font-mono text-sm">opening workflows…</span>
            </div>
          }
        >
          <main id="ma-main" aria-label="Workflows" className="relative z-10 flex min-h-0 flex-1">
            <WorkflowsPage venture={venture} lastEvent={lastEvent} liveNonce={workflowNonce + resyncNonce} />
          </main>
        </Suspense>
      ) : BOS_ENABLED && bosPage === "schedule" ? (
        <Suspense
          fallback={
            <div className="relative z-10 flex flex-1 items-center justify-center text-muted" role="status" aria-live="polite">
              <span className="font-mono text-sm">opening the schedule…</span>
            </div>
          }
        >
          <main id="ma-main" aria-label="Schedule" className="relative z-10 flex min-h-0 flex-1">
            <SchedulePage venture={venture} lastEvent={lastEvent} liveNonce={workflowNonce + resyncNonce} />
          </main>
        </Suspense>
      ) : BOS_ENABLED && bosPage === "outputs" ? (
        <Suspense
          fallback={
            <div className="relative z-10 flex flex-1 items-center justify-center text-muted" role="status" aria-live="polite">
              <span className="font-mono text-sm">opening outputs…</span>
            </div>
          }
        >
          <main id="ma-main" aria-label="Outputs" className="relative z-10 flex min-h-0 flex-1">
            <OutputsPage venture={venture} lastEvent={lastEvent} liveNonce={resyncNonce} />
          </main>
        </Suspense>
      ) : BOS_ENABLED && bosPage === "accounts" ? (
        <Suspense
          fallback={
            <div className="relative z-10 flex flex-1 items-center justify-center text-muted" role="status" aria-live="polite">
              <span className="font-mono text-sm">opening accounts…</span>
            </div>
          }
        >
          <main id="ma-main" aria-label="Accounts" className="relative z-10 flex min-h-0 flex-1">
            <AccountsPage />
          </main>
        </Suspense>
      ) : BOS_ENABLED && bosPage === "roadmap" ? (
        <Suspense
          fallback={
            <div className="relative z-10 flex flex-1 items-center justify-center text-muted" role="status" aria-live="polite">
              <span className="font-mono text-sm">opening roadmap…</span>
            </div>
          }
        >
          <main id="ma-main" aria-label="Roadmap" className="relative z-10 flex min-h-0 flex-1">
            <RoadmapPage />
          </main>
        </Suspense>
      ) : INBOX_ENABLED && shellView === "inbox" ? (
        <Suspense
          fallback={
            <div className="relative z-10 flex flex-1 items-center justify-center text-muted" role="status" aria-live="polite">
              <span className="font-mono text-sm">opening the inbox…</span>
            </div>
          }
        >
          <main id="ma-main" aria-label="Inbox" className="relative z-10 flex min-h-0 flex-1">
            <InboxPanel
              lastEvent={lastEvent}
              resyncNonce={resyncNonce}
              queueNonce={queueNonce}
              connected={liveConnected}
              retryAt={retryAt}
              onReconnectNow={reconnectNow}
              onCounts={applyCounts}
              initialSelectedId={inboxSelectId ?? undefined}
            />
          </main>
        </Suspense>
      ) : (
      <>
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
          {state ? <AgentRoster agents={state.agents} selectedId={selectedAgentId} onSelect={openAgent} onAddAgents={openFactory} /> : <LoadingShell />}
        </aside>

        {/* board (primary) */}
        <main id="ma-main" aria-label="Squad missions" className={`min-w-0 flex-1 flex-col ${mobilePane === "board" ? "flex" : "hidden"} lg:flex`}>
          {state ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
                <h2 className="text-sm font-medium">Squad missions</h2>
                <ViewToggle view={kanbanMode} onChange={setKanbanMode} />
              </div>
              {/* 2026-09-07 — the roster moved to Settings. It showed the RULE (reference data
                  that changes about once a day) above a board the operator watches constantly,
                  and it was mounted here AND on the Job board. The BREACH now reaches the
                  operator through the queue strip, which is what was actually missing. */}
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
      </>
      )}
      </BosFrame>
      </PreflightGate>

      {/* bottom status strip — runtime up? · Docker? · quota · (P3) inbox + bus */}
      <StatusStrip
        preflight={preflight}
        pendingDeliveries={INBOX_ENABLED ? pendingDeliveries : undefined}
        liveConnected={INBOX_ENABLED ? liveConnected : undefined}
        breaker={INBOX_ENABLED ? (breakerSummary ?? undefined) : undefined}
      />

      {/* overlays */}
      {state && (
        <AgentDrawer agent={selectedAgent} agents={state.agents} feed={state.feed} heartbeats={state.heartbeats} onClose={() => setSelectedAgentId(null)} onCommand={sendCommand} lastEvent={lastEvent} />
      )}
      {state && (
        <UtilityDrawer
          open={utilOpen} tab={utilTab} onTab={setUtilTab} onClose={() => setUtilOpen(false)}
          state={state} viewAgents={viewAgents} replayMs={replayMs} playing={playing}
          onScrub={enterReplay} onLive={goLive} onTogglePlay={() => setPlaying((p) => !p)}
          sendCommand={sendCommand} getAudit={getAudit} getCommandStatus={getCommandStatus} listSessions={listSessions}
          feedForReplay={state.feed}
          factoryOpenSignal={factoryOpenSignal}
          usageTicks={Object.values(usageByThread)}
          transcriptTotals={transcriptTotals}
        />
      )}
      {state && (
        <SwarmHero
          open={heroOpen}
          agents={state.agents}
          feed={state.feed}
          onClose={() => { setHeroOpen(false); setHeroAgentId(null); setDockDismissed(false); }}
          openAgentId={heroAgentId}
          onSelectAgent={setHeroAgentId}
          renderChat={renderHeroChat}
          onCommand={sendCommand}
        />
      )}
      {/* P2-3: movable + dismissible mini live-ops dock (when the full hero is closed). */}
      {state && !heroOpen && !dockDismissed && (
        <div
          className="fixed z-30 hidden flex-col overflow-hidden rounded-xl border shadow-xl lg:flex"
          style={{ left: dockPos.x, top: dockPos.y, width: DOCK_W, height: DOCK_H, backgroundColor: "#0a0b14", borderColor: "rgba(255,255,255,0.18)" }}
          role="group" aria-label="Live ops dock"
        >
          <div onPointerDown={onDockDragStart} className="flex items-center gap-1.5 border-b px-2 py-1.5"
            style={{ borderColor: "rgba(255,255,255,0.08)", cursor: "grab", touchAction: "none" }}>
            <GripVertical size={13} aria-hidden style={{ color: "#6b7280" }} />
            <span className="flex-1 select-none text-[10px]" style={{ color: "#9aa0ad" }}>live ops</span>
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setHeroOpen(true)}
              aria-label="Expand to full swarm view" title="Expand"
              className="rounded p-1 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2" style={{ color: "#9aa0ad" }}>
              <Maximize2 size={13} aria-hidden />
            </button>
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setDockDismissed(true)}
              aria-label="Close live ops dock" title="Close"
              className="rounded p-1 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2" style={{ color: "#d39a9a" }}>
              <X size={14} aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <SwarmHero
              variant="dock"
              open
              agents={state.agents}
              feed={state.feed}
              onClose={() => {}}
              onSelectAgent={(id) => { if (id) { setHeroAgentId(id); setHeroOpen(true); } }}
            />
          </div>
        </div>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={bosPaletteCommands} />
      <SkillPalette open={skillsOpen} onClose={() => setSkillsOpen(false)} skills={skills} onPick={pickSkillIntoComposer} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Onboarding open={onboardingOpen} onClose={() => setOnboardingOpen(false)} onTryGoal={(goal) => dispatchGoal(goal)} />
    </div>
  );
}

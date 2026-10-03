import type { SelfGradeFrame } from "./lib/selfGrade.ts";
import { useMemo, useState, useCallback, useEffect, useRef, lazy, Suspense, type ReactNode } from "react";
import { useAgentState } from "./data/useAgentState";
import type { Counts } from "./data/types";
import { ChatPane, type Msg } from "./components/workspace/ChatPane";
import { RightPanel } from "./components/cockpit/RightPanel";
import { MissionsPage } from "./components/missions/MissionsPage";
import { UtilityDrawer, type UtilityTab } from "./components/cockpit/UtilityDrawer";
import type { BoardView, ShellView } from "./components/ViewToggle";
import { AgentDrawer } from "./components/AgentDrawer";
import { CommandPalette } from "./components/CommandPalette";
import { SkillPalette } from "./components/skills/SkillPalette";
import { loadCatalog, type MissionSkill } from "./lib/skillsCatalog";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { TitleBar } from "./components/shell/TitleBar";
import { StatusStrip } from "./components/shell/StatusStrip";
import { PreflightGate } from "./components/PreflightGate";
import { SwarmHero } from "./components/hero/SwarmHero";
import { DockSwarm } from "./components/hero/DockSwarm";
import { firstRunView, readFlag, withTimeout, writeFlag } from "./lib/firstRun";

/** How long the first-run check waits on the runtime before showing the landing. */
const FIRST_RUN_TIMEOUT_MS = 5000;
import { getAccounts } from "./lib/accounts";
import { getWorkspace } from "./lib/workspaceClient";
import type { PaletteCommand } from "./lib/paletteCommands";
import { MODEL_TIERS, saveTier } from "./lib/modelTiers";
import { runtimeToken } from "./lib/runtimeToken";
import { runtimeUrl, type PreflightResult } from "./lib/runtimeBase";
import { clampDockPos } from "./lib/swarmGraph";
import { TIER_ACCENT, TIER_LABEL } from "./lib/agentMeta";
import { reconstructAt, countsFrom } from "./lib/replay";
import { useRuntimeEvents, applyBadge, applyUsageTick, type RuntimeEvent, type UsageByKey } from "./lib/useRuntimeEvents";
import { isQueueEvent } from "./lib/queueModel";
import { applyActivity, type ActivityRow, fallbackSeq } from "./lib/activityStream";

/** Phase 5 — the activity rail's open/closed state survives a reload. */
const ACTIVITY_OPEN_KEY = "ma.activity.open.v1";
import { listInbox, type InboxCounts } from "./lib/inboxClient";
import { tallyPending } from "./lib/inboxTally";
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
import { BosSidebar, BosMobileTabs } from "./components/bos/BosSidebar";
import { SketchSprite } from "./components/shell/SketchSprite";
import { BOS_NAV, type BosNavEntry, type BosPage } from "./components/bos/bosNav";

// P3 feature flag (program plan §5.1). ON by default; VITE_INBOX=0 restores the
// pre-P3 cockpit EXACTLY — no toggle, no skin attribute, no SSE subscription, and
// the Inbox chunk is never fetched (it is a lazy import below).
const INBOX_ENABLED =
  import.meta.env.VITE_INBOX !== "0" && import.meta.env.VITE_INBOX !== "false";

// B0 — Business-OS shell flag. Nested under INBOX_ENABLED on purpose: the sidebar's
// primary destination IS the P3 Inbox, so with the Inbox off there is nothing to
// navigate to. VITE_BOS=0 unmounts the sidebar and the layout wrapper element does not
// exist in the tree at all (see BosFrame below). Phase G removed the P3 title-bar
// ShellToggle, so with the flag off there is no control to reach the Board surface.
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
// First-run surfaces: an onboarded user never opens either, so neither ships in the main chunk.
const Landing = lazy(() => import("./components/landing/Landing").then((m) => ({ default: m.Landing })));
const Setup = lazy(() => import("./components/onboarding/Setup").then((m) => ({ default: m.Setup })));
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

// ADR-LS5: the ambient PulseGlobe is not mounted — the mockup defines no globe and a
// WebGL backdrop changes every frame. The component stays in src/components/PulseGlobe.tsx.


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
// Phase G (ADR G-2): the mockup's `.body` grid — rail + `.content`, mobile tabs first.
function BosFrame({ enabled, sidebar, tabs, children }: { enabled: boolean; sidebar: ReactNode; tabs: ReactNode; children: ReactNode }) {
  if (!enabled) return <>{children}</>;
  return (
    <div className="body">
      {sidebar}
      <div className="content">{tabs}{children}</div>
    </div>
  );
}


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
  const DOCK_W = 220, DOCK_H = 170;
  const [dockDismissed, setDockDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem("ma.dockDismissed") === "1"; } catch { return false; }
  });
  // null = never dragged: the mockup's `.dock` CSS places it (bottom-left). Phase G.
  const [dockPos, setDockPos] = useState<{ x: number; y: number } | null>(() => {
    try { const s = localStorage.getItem("ma.dockPos"); if (s) return JSON.parse(s) as { x: number; y: number }; } catch { /* ignore */ }
    return null;
  });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  useEffect(() => { if (dockPos) try { localStorage.setItem("ma.dockPos", JSON.stringify(dockPos)); } catch { /* ignore */ } }, [dockPos]);
  // A stored position is from another window size: clamp it on load and on every resize,
  // or a dock dragged in a wide window is stranded off-screen in a narrow one.
  useEffect(() => {
    const fit = () => setDockPos((p) => {
      if (!p) return p;
      const c = clampDockPos(p.x, p.y, DOCK_W, DOCK_H, window.innerWidth, window.innerHeight, 8);
      return c.x === p.x && c.y === p.y ? p : c;
    });
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  useEffect(() => { try { localStorage.setItem("ma.dockDismissed", dockDismissed ? "1" : "0"); } catch { /* ignore */ } }, [dockDismissed]);
  const onDockDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const at = (e.currentTarget as HTMLElement).closest(".dock")?.getBoundingClientRect();
    if (!at) return;
    dragRef.current = { dx: e.clientX - at.left, dy: e.clientY - at.top };
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
  }, []);
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
  const openAgent = useCallback((id: string) => { setSelectedAgentId(id); }, []);

  // Overlays.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [heroOpen, setHeroOpen] = useState(false);
  // Landing + Setup (spec §5.1, ADR-LS1): flag → cockpit at once; otherwise wait for the
  // runtime's accounts + workspace (the upgrade path) before choosing, so nothing flashes.
  const [view, setView] = useState<"loading" | "landing" | "cockpit">(() => (readFlag() === "1" ? "cockpit" : "loading"));
  const [setupOpen, setSetupOpen] = useState(false);
  // Every open is a fresh Setup (its key), so a reopen never shows a previous run's facts.
  const [setupRun, setSetupRun] = useState(0);
  // Setup's return-focus target, taken at the first open only: a reopen from inside Setup
  // (⌘K Replay while it is open) keeps pointing at what the user was on before.
  const setupReturn = useRef<Element | null>(null);
  const openSetup = useCallback(() => {
    if (!document.activeElement?.closest(".ob")) setupReturn.current = document.activeElement;
    setSetupRun((n) => n + 1);
    setSetupOpen(true);
  }, []);
  // "Start a job" (the mockup's showView("app")): the cockpit, with Setup over it until onboarded.
  const startJob = useCallback(() => { setView("cockpit"); if (readFlag() !== "1") openSetup(); }, [openSetup]);
  // The mockup's toast (#toast): one status line, shown for 2.6s.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (view !== "loading") return;
    let live = true;
    // A runtime that accepts the connection but never answers must not hold the app on a blank
    // screen: after 5s the check counts as unanswered (→ landing).
    const timeout = <T,>(p: Promise<T>) => withTimeout(p, FIRST_RUN_TIMEOUT_MS);
    void Promise.allSettled([timeout(getAccounts()), timeout(getWorkspace())]).then(([a, w]) => {
      if (!live) return;
      const next = firstRunView({ flag: readFlag(), accounts: a.status === "fulfilled" ? a.value : null, workspace: w.status === "fulfilled" ? w.value : null });
      if (next === "cockpit") writeFlag();
      setView(next);
    });
    return () => { live = false; };
  }, [view]);
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
  }, []);

  // Pick a skill from the palette → drop its prompt into the composer (existing gated prefill flow).
  const pickSkillIntoComposer = useCallback((s: MissionSkill) => {
    setPrefill((p) => ({ text: s.prompt, nonce: p.nonce + 1 }));
  }, []);

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = [
      { id: "dispatch", title: "Dispatch a goal", group: "Goal", keywords: "task run create command", run: () => dispatchGoal("") },
      { id: "open-audit", title: "Open Audit", group: "View", keywords: "log history", run: () => openUtil("audit") },
      { id: "open-tools", title: "Open Tools", group: "View", keywords: "connectors exec factory sessions", run: () => openUtil("tools") },
      { id: "open-replay", title: "Open Replay", group: "View", keywords: "time scrubber history", run: () => openUtil("replay") },
      { id: "open-settings", title: "Open Settings", group: "Settings", keywords: "theme accent tier policy", run: () => setSettingsOpen(true) },
      // ADR-LS4: the old cockpit tour is gone; this reopens Setup at step 1.
      { id: "open-tour", title: "Replay onboarding tour", group: "Settings", keywords: "help setup guide", run: () => { setView("cockpit"); openSetup(); } },
      { id: "open-welcome", title: "Show the welcome page", group: "Settings", keywords: "landing welcome home", run: () => { setSetupOpen(false); setView("landing"); } },
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
  }, [state?.agents, dispatchGoal, openUtil, openAgent, openSetup]);

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
  // D-7: false until the first authoritative read lands; until then a count is "—", never 0.
  const [pendingKnown, setPendingKnown] = useState(false);
  // D-7 — the code-shaped subset of pending inbox items ("N deliveries await you").
  const [pendingCodeDeliveries, setPendingCodeDeliveries] = useState(0);
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
    setPendingKnown(true);
  }, []);
  useEffect(() => {
    if (!INBOX_ENABLED) return;
    let live = true;
    listInbox({ status: "pending", limit: 200 })
      .then((r) => {
        if (!live) return;
        if (r.counts) applyCounts(r.counts);
        // ponytail: counts deliveries among the first 200 pending items (the runtime's list
        // cap); page through /inbox if a real queue ever exceeds it.
        setPendingCodeDeliveries(tallyPending(r.deliveries ?? []).deliveries);
      })
      .catch(() => { /* the strip degrades to the SSE delta; no crash path */ });
    return () => { live = false; };
  }, [resyncNonce, applyCounts, pendingDeliveries]);

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
      // The chat is always on the Missions page now (the mockup has no pane tabs): bring it in.
      case "chat": goShellView("board"); requestAnimationFrame(() => document.getElementById(`chat-in-${BOSS_ID}`)?.focus()); break;
      // SessionsBrowser lives inside the utility drawer; "replay" is the exact
      // UtilityTab id (UtilityDrawer.tsx:23 — "audit" | "tools" | "replay").
      case "sessions": goShellView("board"); setUtilOpen(true); setUtilTab("tools"); break; // SessionsBrowser lives in the tools tab (UtilityDrawer:113); replay scrubber is its sibling tab
    }
  }, [openFactory, goShellView]);

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

  if (view === "loading") {
    return <div className="sk" style={{ background: "var(--paper)", minHeight: "100vh" }} role="status" aria-label="Opening MissionAlpha" />;
  }
  if (view === "landing") {
    return (
      // The shell paints its own paper; the landing must too (index.css repaints <body>).
      <div className="sk" style={{ background: "var(--paper)", minHeight: "100vh" }}>
        <SketchSprite />
        <Suspense fallback={null}><Landing onStart={startJob} events={activity} /></Suspense>
      </div>
    );
  }

  return (
    // isolation: a stacking context for the shell, kept from when an ambient globe painted
    // at z-index -1 under its surfaces (ADR-LS5 unmounted it); harmless, so unchanged.
    <div className="shell sk" style={{ isolation: "isolate" }}>
      {/* The mockup's SVG symbol sprite: every <use href="#i-…"> resolves here. */}
      <SketchSprite />
      {/* Skip link (WCAG 2.4.1 bypass-blocks) — first focusable element; hidden until
          keyboard focus, then jumps past the title-bar controls to #ma-main. */}
      <a href="#ma-main" className="ma-skip-link">
        Skip to main content
      </a>

      {/* frameless title bar — drags the window + houses the topbar content */}
      <TitleBar
        counts={counts}
        deliveries={INBOX_ENABLED ? (pendingKnown ? pendingCodeDeliveries : null) : 0}
        needYou={INBOX_ENABLED ? (pendingKnown ? pendingDeliveries : null) : 0}
        activeUtil={utilOpen ? utilTab : null}
        onOpenUtil={openUtil}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHero={() => setHeroOpen(true)}
        onOpenSkills={() => setSkillsOpen(true)}
        onOpenInbox={() => { const e = BOS_NAV.find((n) => n.id === "inbox"); if (e) onBosNav(e); }}
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
        tabs={<BosMobileTabs bosPage={bosPage} shellView={shellView} onNav={onBosNav} />}
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
          <main id="ma-main" aria-label="Command center">
            <CommandCenter
              pending={pendingDeliveries}
              pendingKnown={pendingKnown}
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
          <main id="ma-main" aria-label="Stories">
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
          <main id="ma-main" aria-label="Agents">
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
          <main id="ma-main" aria-label="Daily brief">
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
          <main id="ma-main" aria-label="Knowledge vault">
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
          <main id="ma-main" aria-label="Workflows">
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
          <main id="ma-main" aria-label="Schedule">
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
          <main id="ma-main" aria-label="Outputs">
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
          <main id="ma-main" aria-label="Accounts">
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
          <main id="ma-main" aria-label="Roadmap">
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
          <main id="ma-main" aria-label="Inbox">
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
        // Phase G (ADR G-2): the mockup's Missions page — roster, board, Tech Lead chat.
        <main id="ma-main" aria-label="Missions">
          {error && <div role="alert" className="alert" style={{ margin: 16 }}><span className="dot bad" style={{ marginTop: 7 }} /><div>{error}</div></div>}
          {state ? (
            <MissionsPage
              agents={viewAgents}
              view={kanbanMode}
              onView={setKanbanMode}
              onOpenAgent={replaying ? undefined : openAgent}
              onAddAgents={openFactory}
              venture={venture}
              jobNonce={jobNonce + resyncNonce}
              chat={
                <RightPanel
                  bossId={BOSS_ID}
                  messages={bossMsgs}
                  setMessages={setMessages}
                  onCommand={sendCommand}
                  prefill={prefill}
                  tierReloadKey={tierReloadKey}
                  feed={viewFeed}
                  agents={viewAgents}
                />
              }
            />
          ) : <LoadingShell />}
        </main>
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
      {/* P2-3: movable + dismissible mini live-ops dock (when the full hero is closed).
          Phase G: the mockup's `.dock` frame; its CSS places it until the BOSS drags it.
          The inner swarm renderer is replaced in G11 with the mockup's 2D canvas. */}
      {state && !heroOpen && !dockDismissed && (
        <div className="dock" role="region" aria-label="Live ops"
          style={dockPos ? { left: dockPos.x, top: dockPos.y, right: "auto", bottom: "auto" } : undefined}>
          <div className="dock-h" onPointerDown={onDockDragStart}>
            <span>Live ops · drag me</span>
            <span>
              <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setHeroOpen(true)} aria-label="Open the full swarm">⤢</button>{" "}
              <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setDockDismissed(true)} aria-label="Hide live ops">×</button>
            </span>
          </div>
          <DockSwarm agents={state.agents} lastEvent={activity[0] ? { seq: activity[0].seq, agentId: activity[0].agentId } : null} />
        </div>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={bosPaletteCommands} />
      <SkillPalette open={skillsOpen} onClose={() => setSkillsOpen(false)} skills={skills} onPick={pickSkillIntoComposer} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {/* Mounted from its first open on (setupRun > 0) and kept, so a close can restore focus. */}
      {setupRun > 0 && (
        <Suspense fallback={null}>
          <Setup key={setupRun} open={setupOpen} onClose={() => setSetupOpen(false)} stations={state ? state.agents.length : null} returnFocus={setupReturn}
            onDone={() => { writeFlag(); setSetupOpen(false); setBosPage("center"); setToast("Your team is ready · start a job from Missions"); }} />
        </Suspense>
      )}
      <div className={toast ? "toast on" : "toast"} role="status" aria-live="polite">{toast ?? ""}</div>
    </div>
  );
}

# Ops-Cockpit Redesign — PLAN (post-S6 UX fix)

**Slug:** `ops-cockpit-redesign`
**Author:** principal-ux-design + architect (drafted with `sp-writing-plans`)
**Status:** PLAN — AWAITING_USER_GO
**Date:** 2026-06-19
**ADR:** introduces `ADR-048-ops-cockpit-shell.md` (next free number — 042–044 desktop, 045–047 enterprise are deferred)
**Scope class:** FRONTEND SHELL ONLY. No runtime/engine/sandbox/broker/MCP change. No new backend route. All S1→S3.5 behavior + the S6 verification stay valid.

---

## 1. Why (the BOSS's four complaints, one root cause)
The chat-first shell (ADR-023) demoted the board too far:
1. "Command Tower" buried in a right drawer → agent status not visible; feels like "time pass," not real-time.
2. Every agent rendered as a **separate chat thread** stacked on the left rail → looks like you must babysit N chats.
3. **FORK** spawns rail rows that look like "new agents."
4. **No way to delete** forked rows.

Root cause: the **thread rail = agent roster** mental model is wrong for an ops tool. Fix = make it a **control room**: one command line in, live status board out.

## 2. Goal / Non-goals
**Goal:** A single **Boss command** chat (you type here → CEO dispatches) beside a **primary, always-visible Command Tower** (live agent status + its existing views). Agents are **status cards you inspect (read-only)**, not chat windows. No per-agent chats, no fork.

**Non-goals:** No backend change. No new agent capability. Don't delete any Command Tower view (kanban/globe/feed/replay/audit) — relocate them. Don't touch the tool-loop/approval/sandbox UI behavior (ExecConsole stays, just rehomed). Keep settings/palette/onboarding/usage-meter from S4.

## 3. Target layout
```
┌───────────────────────────────────────────────────────────────┐
│ MissionAlpha   [3 active][1 blocked][2 idle]      ⌘K   ⚙  ◐    │  top bar (counts always-on)
├──────────────────────┬────────────────────────────────────────┤
│  BOSS COMMAND        │  COMMAND TOWER (primary)                 │
│  (the one chat)      │  Cards │ Kanban │ Globe │ Feed │ Replay │ │  view switcher
│                      │  │ Audit │ Tools                         │
│  ▸ goal in           │  ───────────────────────────────────────│
│  ▸ CEO dispatches    │  (selected view fills the panel)         │
│  ▸ model picker      │  Cards = live agent status grid          │
│  ▸ usage meter       │  click a card → read-only drawer         │
│  [ type goal… ][↑]   │                                          │
└──────────────────────┴────────────────────────────────────────┘
   ~38% width             ~62% width
mobile (≤768): tabs — [Command] [Tower] — full-width, one at a time
```

## 4. Design contract (principal-ux-design — consumed by senior-web-1/2)
- **Tokens:** OKLCH only via `tok()` (existing `--c-*`). Reuse `accent-cyan` (primary), status colors `done-green`/`blocked-amber`/`stale-red`/`muted`, `ceo-gold` for Boss. No new hex. Respect the S4 accent override + theme.
- **`impeccable` craft:** status-first hierarchy; counts read in <1s; card = name · state dot · current task (1 line, truncated) · age. Calm by default (idle agents recede, active breathe).
- **`hallmark` anti-slop:** the two columns must feel like one tool, not a template; real density (cards 2–3 per row, not giant empty boxes); no fake chrome.
- **`emil-design-eng` motion:** card state change = 160–200ms ease-out; active pulse synced to scheduler cadence (existing `ticker`); view-switch crossfade ≤200ms; **all gated by `prefers-reduced-motion` + the S4 reduce-motion override**.
- **a11y:** view switcher = `role="tablist"`/`tab`/`tabpanel`, arrow-key nav; cards keyboard-focusable (`button`, Enter/Space → drawer); counts in an `aria-live="polite"` region; 320–768 responsive (hard floor 320).
- **gstack design-review** pass before merge.

## 5. Component changes

### NEW
- `src/components/cockpit/CommandTower.tsx` — the primary right panel. Owns the **view switcher** (`Cards | Kanban | Globe | Feed | Replay | Audit | Tools`) + renders the selected view. Pure presentational shell; receives `state`, `replay` props, `onSelectAgent`.
- `src/components/cockpit/AgentStatusGrid.tsx` — the **Cards** view: responsive grid of agent status cards (name, state dot, task, age, focus-ring). Card click → `onSelectAgent(id)` → existing `AgentDrawer` (read-only). Reuses `agentMeta`/`ticker`/`StateBadge`.
- `src/lib/cockpitView.ts` (pure, unit-tested) — view-id type + the tab list + a tiny `nextView`/`prevView` for arrow-key nav. Testable with `node --test` (no new dep).

### MODIFY
- `src/App.tsx` — replace the `ThreadRail | ChatPane | TeamPanel` three-way with **two-pane: `ChatPane` (Boss, fixed) + `CommandTower`**. Drop `activeThread` switching (Boss is the only chat). Keep palette/settings/onboarding mounts. Counts move to the top bar (always-on). `selectedAgentId` + `AgentDrawer` stay (now driven by card clicks in `AgentStatusGrid`).
- `src/components/workspace/ChatPane.tsx` — hard-wire to the Boss thread; **remove the FORK button + `onFork`**; keep model picker, usage meter, prefill, dispatch. Keep `tierReloadKey` (palette still switches model).
- `src/components/CommandPalette` command list (in `App.tsx`) — drop "Fork current thread"; "jump to thread/agent" becomes **"inspect agent <id>"** → opens the drawer (not a chat). Keep new-chat=Boss focus, dispatch, open settings/connectors, switch model, view-switch (`Show Kanban/Globe/Audit…`).
- View hosts move **into** CommandTower (no logic change): `KanbanBoard`, `PulseGlobe`, `LiveFeed`, `TimeScrubber`+replay banner, `AuditTrailPanel`, and under **Tools**: `ConnectorPanel`, `ExecConsole`, `AgentFactory`, `ControlPlanePanel`, `SessionsBrowser`, `BulkActionBar`. `MissionStrip`/`StatTiles` fold into the top bar counts.

### REMOVE / RETIRE
- `ThreadRail` usage in the shell (component file kept but unmounted; per-agent + fork threads gone from the rail).
- FORK affordance + `forkedThreads` state + `ma.forkedThreads` localStorage. **One-time migration:** on mount, `localStorage.removeItem("ma.forkedThreads")` (+ legacy `ma.activeThread`) so existing forks vanish cleanly.
- `TeamPanel` drawer wrapper (its children are now CommandTower views). Component file kept until confirmed unused.

### PRESERVED (untouched)
- All `agent-runtime/*` (engine, sandbox, broker, MCP, usage, audit, threads, server routes). The `/runtime/:id/fork` endpoint stays server-side (just no UI button) — no backend edit.
- S4: settings store/panel, palette core, onboarding, audit read model, CI, the 160 runtime + 17 frontend tests.

## 6. State / data changes (frontend only)
- App shell state shrinks: remove `activeThread`, `forkedThreads`, `railCollapsed`, `railOpenMobile`, `teamOpen`. Add `towerView` (persisted `ma.tower.view`, default `cards`) + keep `selectedAgentId`, `replayMs`, `playing`, `prefill`, `tierReloadKey`, settings/palette/onboarding flags.
- Boss thread id constant = `"boss"`. Chat history/persistence/usage for Boss unchanged (same `/runtime/boss/*`).
- No change to `state.json` shape, `DataSource`, `useAgentState`, or any client→runtime contract.

## 7. Phases (TDD where logic exists; verify each before next)
- **P0 — ADR + contract.** `architect` writes `ADR-048-ops-cockpit-shell.md` (this plan ratified). `principal-ux-design` finalizes the §4 contract. Exit: approved.
- **P1 — pure lib + tests (TDD).** `cockpitView.ts` + `src/lib/__tests__/cockpitView.test.ts` (tab list, next/prev wrap, default). `node --test` green.
- **P2 — CommandTower + AgentStatusGrid.** Build the panel + status grid; mount existing views inside; view switcher (tablist + arrow keys). `senior-web-1`.
- **P3 — App shell rewire.** Two-pane layout; top-bar counts (`aria-live`); drop rail/fork/team state; fork-cleanup migration; rewire palette commands; card-click → drawer. `senior-web-2`.
- **P4 — ChatPane trim.** Remove FORK/onFork; Boss-only; keep model/usage/prefill. `senior-web-2`.
- **P5 — polish.** `impeccable polish` + `emil-design-eng` motion + `hallmark` self-critique; responsive 320–768; reduced-motion.
- **P6 — verify.** `tsc` + `vite build` clean; 17 frontend + new cockpitView tests green; **full 160 runtime suite re-run green** (must stay green — proves no backend touched); `gstack design-review`; `webapp-testing`/playwright pass on the new shell (or honest BOSS visual acceptance, app left running).

## 8. Tests
- New: `cockpitView.test.ts` (pure nav). Update any App-level assumptions.
- Re-run: full frontend unit (17 → +cockpitView) + the 160 runtime regression (unchanged, must stay green).
- Manual/playwright: top-bar counts update; card click → drawer; view switcher keyboard-navigable; no rail, no fork; old forks cleared on first load; settings/palette/onboarding intact; responsive at 320/375/768.

## 9. a11y / motion / responsive (hard requirements)
- Tablist semantics + roving tabindex; cards are buttons; counts `aria-live`; drawer keeps its focus-trap.
- Motion ≤200ms ease-out, reduced-motion + S4 override honored; active-pulse via existing `ticker` (no 1Hz full-tree re-render).
- 320px floor: two-pane collapses to `[Command][Tower]` tabs; cards 1-col.

## 10. Risks + mitigations
- **R1 feature loss** moving Command Tower views → mitigate: views are mounted unchanged inside CommandTower; P6 checklist confirms each reachable.
- **R2 stale "dead" board** (scheduler not running) → add a top-bar hint "scheduler offline — run scheduler-ctl.sh start" (reuses existing offline banner logic) so it reads as ops-state, not a bug.
- **R3 regression to S1→S4** → backend untouched + 160 suite re-run is the gate.
- **R4 motion/contrast slips** → impeccable/emil/gstack review gate.

## 11. Governance gates (per roadmap)
`architect` ADR-048 → `principal-ux-design` contract → build (TDD, senior-web-1/2) → `senior-security-engineer` (confirm: shell-only, no new write/exec path, fork endpoint unused-but-safe, no regression) → `senior-qa` TESTS_GREEN incl. 160 regression → `senior-code-reviewer` clear → `memory-updater` persists. **No commit/push until BOSS tests (rule 1).**

## 12. Acceptance (BOSS will test)
- Open app → **one Boss chat** left, **Command Tower** right, **counts visible up top**.
- Type a goal in Boss → CEO dispatches → **agent cards go active live** on the right.
- **No per-agent chat windows. No FORK. Old forks gone.**
- Click an agent card → read-only inspect drawer.
- Switch Tower views (Cards/Kanban/Globe/Feed/Replay/Audit/Tools) by click + keyboard.
- Settings/theme/palette/onboarding/usage-meter still work; full regression green.

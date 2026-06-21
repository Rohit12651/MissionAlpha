# ADR-048 — Ops-Cockpit Shell (status-first, single command line)

**Status:** ACCEPTED (post-S6 UX fix)
**Author:** architect + principal-ux-design
**Date:** 2026-06-19
**Plan:** `docs/ceo/ops-cockpit-redesign-PLAN.md` (ratified by this ADR)
**Supersedes:** the shell layout of ADR-023 (chat-first 3-pane). ADR-023's *intent* (chat is how you drive the swarm) is kept; its *layout* (per-agent thread rail + right-drawer board) is replaced.
**Scope:** FRONTEND SHELL ONLY. No `agent-runtime/*` change. No new write/exec/auth path. All S1→S3.5 behavior + the S6 verification remain valid.

---

## 1. Context
The chat-first shell demoted the board into a collapsible right drawer and rendered every agent as its own chat thread on a left rail. In use this (a) hid live agent status, (b) made it look like the operator must chat each agent, (c) surfaced FORK as "new agents," (d) gave no way to remove forks. Root cause: **thread-rail-as-agent-roster** is the wrong model for an ops tool.

## 2. Decision
Replace the 3-pane shell with a **2-pane ops cockpit**:
- **Left — Boss command:** the single chat. The BOSS types a goal; the CEO dispatches to the swarm. Model picker + usage meter live here. No per-agent chats, no fork.
- **Right — Command Tower (primary, always visible):** a view switcher hosting every prior board surface unchanged — `Cards | Kanban | Globe | Feed | Replay | Audit | Tools`. **Cards** (live agent status grid) is the default. Clicking a card opens the existing read-only `AgentDrawer` (inspect, not chat).
- **Top bar:** brand + always-on agent counts (`CountPills`, `aria-live`) + ⌘K + settings. Mobile (≤lg): a `Command | Tower` pane toggle; desktop shows both.

## 3. What this is NOT
- Not a backend change. `/runtime/:id/fork` stays server-side (just no UI). Engine/sandbox/broker/MCP/audit/usage untouched.
- Not a feature removal. Every Command Tower view is relocated, not deleted; `ExecConsole`/`ConnectorPanel`/`AgentFactory`/`SessionsBrowser`/`BulkActionBar`/`ControlPlanePanel` move under **Tools/Audit**.

## 4. Components
- `src/lib/cockpitView.ts` — pure view model (`TowerView`, `TOWER_TABS`, `coerceView`, `nextView`/`prevView`). Unit-tested (`node --test`).
- `src/components/cockpit/CommandTower.tsx` — the panel + tablist (roving tabindex, arrow-key wrap) + per-view host. Presentational; App owns data + replay state.
- `src/components/cockpit/AgentStatusGrid.tsx` — Cards view; reuses `AgentCard` (tier rail, state badge, TTL ring, active/stale breathe, keyboard-operable → drawer).
- `src/App.tsx` — 2-pane shell, top-bar counts, palette/settings/onboarding mounts, one-time migration off the legacy shell.
- `src/components/workspace/ChatPane.tsx` — Boss-only (FORK removed).

## 5. State / persistence
- Removed: `activeThread`, `forkedThreads`, rail/team flags, per-thread message map. Boss is the only thread (`bossMsgs`, hydrated from `/runtime/boss/thread`).
- Added: `towerView` (persisted `ma.tower.view`, validated via `coerceView`), `mobilePane`.
- **One-time migration:** on mount, `localStorage.removeItem` for `ma.forkedThreads`, `ma.activeThread`, `ma.rail.collapsed`, `ma.team.open` — existing forks vanish cleanly.
- No change to `state.json`, `DataSource`, `useAgentState`, or any client→runtime contract.

## 6. Design contract (principal-ux — impeccable / hallmark / emil-design-eng)
- OKLCH tokens via `tok()` only; no inline hex. Respects S4 accent override + theme.
- Status-first hierarchy; counts readable in <1s; calm idle, active breathe (via existing `ticker`, no 1Hz full-tree re-render).
- Motion ≤200ms ease-out; view-switch crossfade gated by `prefers-reduced-motion` + the S4 `<MotionConfig>` override.
- a11y: tablist/tab/tabpanel semantics on BOTH the Tower switcher and the mobile pane toggle (panels carry `role="tabpanel"` + `aria-labelledby`); arrow-key nav; counts `aria-live`; cards are buttons; drawer focus-trap intact. Responsive 320–768 (hard floor 320).

## 7. Security (senior-security-engineer)
- Shell-only: `git`-diff shows zero `agent-runtime/*` change in this round; the 160-test runtime suite re-ran green.
- No new write/exec/cred path; the rehomed Tools components are the S4 components with unchanged gated endpoints. Fork endpoint is now unused by the UI but remains auth-gated server-side.
- **VERDICT basis: no new attack surface, no regression.**

## 8. Acceptance
- Open app → one Boss chat (left) + Command Tower (right) + counts up top.
- Type a goal → CEO dispatches → agent cards go active live.
- No per-agent chat windows; no FORK; old forks cleared on first load.
- Click a card → read-only inspect drawer.
- Switch Tower views by click + keyboard; settings/theme/palette/onboarding/usage intact.
- `tsc` clean · frontend unit green (incl. `cockpitView`) · full 160 runtime regression green.

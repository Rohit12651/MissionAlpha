# ADR-023 — Chat-First Shell (chat = primary; board demoted to a secondary "Team" panel)

- **Status:** ACCEPTED
- **Date:** 2026-06-17
- **Slug:** `chat-first-shell`
- **Plan:** `docs/ceo/workspace-plan.md` (Phase 1 / Phase 2 UX / Phase 4 persistence / Phase 5 UI)
- **Deciders:** architect, principal-ux-design, senior-web-1, senior-web-2, senior-backend-2, ceo
- **Related:** ADR-022 (per-thread model tier), boss-console-plan.md, cycle1/cycle2 scopes

## Context

Today the layout is INVERTED from what BOSS wants (workspace-plan GAP 2):

- `BossConsole.tsx` is a **left dock** (App reserves 404px left padding, collapse → reopen rail top-left).
- The **board is the center** — `App.tsx` stacks kanban + heartbeat feed + globe + `ControlPlanePanel` (Cycle 1) + `SessionsBrowser` (Cycle 2) + `AgentFactory`. Per-agent chat (`AgentChat.tsx`) lives inside an agent drawer.
- Chat threads are **in-memory only** — `threads = new Map()` in `server.mjs`; resets on restart.

BOSS decision (locked #2, NO NEGOTIATION):
> Chat = center/main panel (Claude-Code-style). Board → secondary "team status" side/tab view.

Hard constraint (Phase 0 + Non-goals): keep ALL existing features working — Cycle 1/2 control plane, dispatch→autonomous loop, F2b sandbox/broker, per-agent chat. Board is **demoted, never deleted**.

## Decision

**Invert the shell.** Chat becomes the primary center column; the board becomes a secondary, collapsible right-side "Team" panel (a tab on mobile). Add a multi-thread conversation model with disk persistence and per-thread model tier (ADR-022).

### 1. Layout inversion

```
Desktop (≥1024px):
[ ThreadRail ~264px ] [ ChatPane (PRIMARY, center, 1fr) ] [ TeamPanel ~420px collapsible ]
```

- **ChatPane = center, primary.** Streaming thread + composer + model-tier header. Same SSE machinery from `AgentChat`/`BossConsole`, *promoted* to center.
- **ThreadRail = left.** Boss/CEO pinned + one thread per agent (built-in + factory). Active highlight. Replaces the old left dock.
- **TeamPanel = right, secondary, collapsible.** Hosts the board EXACTLY as-is (kanban / feed / globe / ControlPlane / BulkAction / Sessions / Factory). Demoted, never deleted.

### 2. Component decomposition

| Component | Role | Reuse |
|---|---|---|
| `WorkspaceShell` (NEW) | 3-column grid; layout state; responsive | replaces stacking layout in `App.tsx` |
| `ThreadRail` (NEW) | thread list + switcher + New; Boss/CEO pinned | feeds off registry + thread index |
| `ChatPane` (NEW) | center chat host: header (title + picker) + thread + composer | wraps existing SSE logic |
| `ModelTierPicker` (NEW) | Opus/Sonnet/Haiku dropdown w/ hints; per-thread; persists | sends `model` per ADR-022 |
| `TeamPanel` (NEW) | collapsible right panel; mounts board untouched | board verbatim |
| `BossConsole` | demoted; its content becomes the Boss/CEO thread; dispatch-parse + `PermissionGate` PRESERVED | keep `parseDispatch` + F3 |
| board components | mounted inside `TeamPanel`, UNTOUCHED | zero behavior change |

Critical: dispatch→autonomous loop PRESERVED. The Boss/CEO thread still parses ```dispatch, renders "CEO proposes N dispatches", routes through `PermissionGate` (F3) → `/api/command` + `/runtime/:id/run`. We move *where* chat lives, not *how* dispatch works.

### 3. Layout state + persistence

**A. Layout/UI state (client, localStorage)** — `{ teamPanelOpen, activeThreadId, railCollapsed, model.<threadId> }`. Per-browser; non-sensitive.

**B. Conversation persistence (server, disk)** — Phase 4, senior-backend-2:
- Promote in-memory `threads` Map to disk: `agent-runtime/threads/<threadId>.json`, **gitignored**.
- `threadId` matches the route regex (`^[a-z0-9_-]{1,64}$`); reuse `safeId()` for the filename → no path traversal.
- Record: `{ id, tier, messages:[{role,content}], updatedAt }`.
- **Load on startup** (alongside `factory.loadRegistry()`); **persist on each turn's `done`** (trimmed last-N, N≈40). Byte cap per file.
- Per-turn transcript-replay model UNCHANGED; persistence just means the thread survives restart.

Security (Phase 6): thread store writes ONLY under `agent-runtime/threads/` via `safeId(threadId)` filenames — no caller-controlled path segments, gitignored, never seeded into a sandbox, content already egress-scrubbed. No new auth surface.

### 4. Responsive

- **≥1024px:** 3 columns.
- **768–1023px:** rail collapses to icon rail; Team panel closed (sheet on demand).
- **<768px:** chat full-screen; rail = left sheet (hamburger); board = bottom-sheet "Team" tab. Touch targets ≥44px; `env(safe-area-inset-bottom)`; `100dvh`.

### 5. Motion + a11y (emil-design-eng + impeccable)

- Team panel collapse: `transform: translateX` + width, ease-out ≤300ms (exit faster).
- Thread switch: cross-fade; never animate streaming text.
- Model switch: subtle chip transition.
- `prefers-reduced-motion`: instant show/hide + instant swap.
- a11y: rail = `navigation`, center = `main` (only one), Team = `complementary`; `aria-current` active thread; `aria-expanded` on Team toggle; focus → composer on thread switch; streaming `aria-live=polite`; errors `role=alert`; OKLCH tokens only.

## Non-goals (explicit)

- No board deletion (every board feature works inside TeamPanel).
- No non-Claude providers (inherited from ADR-022).
- No agent-factory rework (re-parented unchanged).
- No backend chat-protocol change (SSE shape, gates, inflight cap, scrub unchanged; add `tier` to meta + disk persistence).
- No auto-apply / no auto-dispatch (operator gates every dispatch + apply).

## Consequences

**Positive** — all-in-one cockpit, chat-center + live team status, no tab switching; history survives restart; per-thread tier + named threads; reuses ALL proven machinery (low regression risk if board untouched).

**Negative / accepted** — `App.tsx` reflow is the biggest single change (Phase 7 regression re-verifies Cycle1/2, F2b, dispatch loop, Boss console, per-agent chat); disk I/O per turn (bounded); BossConsole demotion changes a familiar surface; mobile is a genuinely different layout (covered by 320–768 floor).

## Rollback

- Layout: `WorkspaceShell` behind a client flag; off → fall back to left-dock + center-board. Same backend → frontend-only rollback.
- Persistence: additive; delete `agent-runtime/threads/` + revert hydration → in-memory behavior, no data-contract change, no repo trace (gitignored).

## S2 ratification (2026-06-18)

- **Status:** ACCEPTED — shell stands, unchanged. No reflow, no layout change.

The chat-first shell shipped and holds: `ThreadRail` (left), `ChatPane` (center primary, `src/components/workspace/ChatPane.tsx`), `TeamPanel` (right, board verbatim). Threads persist to `agent-runtime/threads/<id>.json` via `persistThread` (~L170) + hydrate via `loadThreads` (~L151). The per-thread model tier (ADR-022) is live through `ModelTierPicker` in the `ChatPane` header (~L283). Dispatch→autonomous loop preserved.

**S2 adds two things ON TOP of this shell — both additive, NO reflow:**

1. **Usage meter (ADR-030).** A compact USAGE readout in the `ChatPane` sticky header (~L264, near `ModelTierPicker` at ~L283), modeled on Claude Code `/context`: real token counts (in/out, cache) + a context-window % bar + which tier ran. It fits in the existing `headerExtra` slot or beside the picker — no grid change. It is a USAGE meter, **never a cost meter; no `$` ever appears** (BOSS-locked; subscription = flat-rate). The `ChatPane` SSE loop (~L190) gains one branch for a new `event: usage` frame — the existing `event:`/`data:` parser already accepts arbitrary event names, so this is one `else if` next to the `meta`/`token`/`error` branches.

2. **Thread fork/resume (ADR-031).** `ThreadRail` gains resume (select a persisted server thread → hydrate its messages into `App.tsx` `threadMsgs` at `src/App.tsx` L146, which today starts empty — see ADR-031) and a fork action (branch the current thread at the latest/chosen message into a new thread). These wire into the EXISTING `ThreadRail` list + `threadMsgs` record; no new column, no shell restructure.

**Unchanged:** SSE shape extends additively (new `usage` event; `meta`/`token`/`done`/`error` untouched). Gates, inflight cap, scrub, disk-persistence model, and the responsive/a11y/motion contract all stand. sr-security posture from §3 (thread store writes only under `threads/` via `threadSafeId`, gitignored) is reused and extended — never relaxed — by ADR-031.

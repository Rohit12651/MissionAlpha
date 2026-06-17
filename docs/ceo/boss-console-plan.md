# Plan — Global Boss Console (USER above CEO)

**Slug:** `boss-console`
**Author:** CEO agent + architect
**Status:** PLAN — `AWAITING_USER_DECISION`
**Date:** 2026-06-14
**Mode:** caveman (bus) · normal prose (this memo)

## Concept

Hierarchy: **USER (BOSS / Rohit) → CEO → architect → principals → seniors → QA → reviewer**.
Today chat is per-agent (buried in each agent's drawer). BOSS needs a **global, always-present
console** at the TOP of the app to command the swarm through the CEO (the supreme agent per
`ceo.md`). BOSS speaks → CEO interprets → CEO answers + dispatches downstream via the existing
command/sync bus. One pane, from the same app.

Reuses what's already built: `agent-runtime` (streaming) + `AgentChat` pattern + command channel
(F3 gate, /api/command) + sync bus. Net-new = a BOSS→CEO elevated channel + a global UI dock + a
CEO dispatch bridge.

## Roles in this build (who does what)

| Agent | Job |
|---|---|
| **CEO** | gate scope; own the BOSS↔CEO conversation contract; define dispatch authority |
| **architect** | ADR: boss-session design, dispatch bridge, transport reuse |
| **principal-ux-design** | global console UX (dock, gold/CEO identity, thread, a11y) |
| **senior-backend-1** | runtime: BOSS→CEO session + elevated system prompt |
| **senior-backend-2** | dispatch bridge: CEO reply → command channel + sync bus |
| **senior-web-1** | global console panel + wiring in App |
| **senior-security-engineer** | BOSS elevation guard, injection guard, dispatch gate (F3) |
| **senior-qa** | flows + adversarial tests |
| **memory-updater** | persist decisions |

---

## STEP-BY-STEP PLAN

### Step 0 — CEO gate (scope + non-goals)
- BOSS Console = top-level chat; BOSS is identity ABOVE ceo.
- Non-goals: not a replacement for per-agent drawer chat (keep both); not a new auth system
  (single operator = BOSS for now); no autonomous spend without gate.
- Exit: USER GO → architect ADR.

### Step 1 — architect ADR (`docs/adr/ADR-017-boss-console.md`)
Decide + document:
- **Channel:** new runtime route `POST /runtime/boss/chat` → a dedicated **CEO session** (not a
  generic agent). System prompt = CEO persona (Bezos/Musk/Solomon/Fink) + "you report to BOSS
  (Rohit), supreme over the 16-agent swarm; caveman on bus, persuasive prose to BOSS."
- **Dispatch bridge:** how CEO turns a BOSS directive into action. Two-tier:
  1. CEO **proposes** dispatch in its reply (structured block, e.g. ```dispatch\ntask senior-web-1 "build X"\n```).
  2. UI surfaces proposed dispatches as **F3-gated buttons** → BOSS confirms → fires real
     `/api/command` (ack/respawn/task) + `agent-sync.sh` to the bus. CEO never auto-fires
     destructive ops; BOSS confirms. (Bezos "disagree & commit" — BOSS decides.)
- **Transport:** reuse SSE (same as AgentChat). Boss thread persists (ties to F4 history later).
- **Identity:** request envelope `issuedBy:"BOSS"` (elevated above "operator").

### Step 2 — principal-ux-design (global console UX)
- **Placement:** persistent top-level dock — a BOSS button in the header (crown/gold) → opens a
  slide-over/console panel pinned right or bottom, ABOVE the board (z-top). Distinct CEO-gold
  identity so it reads as "command from the top."
- Thread view (BOSS ↔ CEO), streaming cursor, dispatch-proposal cards w/ Confirm/Deny (F3 style).
- a11y (focus, aria-live), reduced-motion, mobile, OKLCH tokens. No inline hex.

### Step 3 — senior-backend-1 (runtime: BOSS→CEO session)
- Add `/runtime/boss/chat` to `agent-runtime/server.mjs`: dedicated session id `boss`, CEO system
  prompt, streams reply. Dual-mode (live Claude / mock) like existing.
- Conversation persists per boss thread (in-memory now; F4-backed later).

### Step 4 — senior-backend-2 (dispatch bridge)
- Parse CEO reply for a ```dispatch``` block → structured directives list.
- Expose them to UI (in the SSE stream as a `dispatch` event, or parsed client-side).
- On BOSS confirm → call existing `/api/command` (type ack/respawn/task) and/or write
  `agent-sync.sh` BOSS→agent. Audit every dispatch (F5). NO auto-fire.

### Step 5 — senior-web-1 (UI build + wiring)
- `src/components/BossConsole.tsx` — global console (header button + slide-over), streaming chat,
  dispatch-proposal cards wired to F3 PermissionGate + sendCommand.
- Mount in `App.tsx` at top level (outside the board, always available, live-only).

### Step 6 — senior-security-engineer (guards)
- BOSS elevation: only the app's operator = BOSS (no remote until auth/Phase 6).
- Injection guard: CEO output that proposes dispatch is DATA → always F3-gated, never auto-exec.
- Dispatch allow-list: only {ack, respawn, task} via command channel (no shell from CEO).
- Audit every BOSS directive + every fired dispatch.

### Step 7 — senior-qa (tests)
- Flow: BOSS msg → CEO streams reply → proposes dispatch → BOSS confirms → command fires → agent
  reacts on bus → shows in feed.
- Adversarial: CEO proposes a destructive dispatch → must NOT fire without confirm; injection in
  CEO reply can't bypass gate; deny path fires nothing.
- Regression: per-agent drawer chat + Cycle 1 controls unbroken.

### Step 8 — memory-updater
- Persist boss-console decision + dispatch-bridge pattern to `memory/SESSION_MEMORY.md` + MCP.

---

## Dependency order
```
Step0 CEO gate
  → Step1 architect ADR  [blocks all]
  → Step2 ux  ∥  Step3 runtime boss→CEO
  → Step4 dispatch bridge
  → Step5 UI wiring
  → Step6 security  →  Step7 QA  →  Step8 memory
```

## Acceptance (DONE when)
- [ ] Global BOSS console reachable from app top-level (header button → console), always-present.
- [ ] BOSS messages CEO; CEO reply streams live (mock now, real Claude w/ credits).
- [ ] CEO can PROPOSE dispatches to agents; BOSS confirms via F3 gate; confirmed → real command
      fires on the bus + audited (F5). Nothing auto-fires.
- [ ] BOSS identity (`issuedBy:"BOSS"`) above operator; per-agent drawer chat still works.
- [ ] Security: dispatch allow-listed + gated + audited; injection can't bypass.

## Non-goals
- Remote/multi-user BOSS (needs auth — Phase 6).
- CEO autonomous spend / auto-fire destructive ops (always BOSS-gated).
- Replacing per-agent chat (both coexist).

## Reuse map (low new surface)
- Streaming = existing `agent-runtime` + SSE.
- Chat UI = extend `AgentChat` pattern → `BossConsole`.
- Dispatch = existing `/api/command` + `agent-sync.sh` + F3 `PermissionGate`.
- Audit = existing F5 AUDIT.log + ControlPlanePanel.

**ASK USER:** GO on Boss Console? Sequence vs F2 (agent tools)? CEO rec: Boss Console is cheaper +
higher daily value (you command the swarm from the top) — do it before F2.

# Plan — Unified Workspace (chat-first, multi-tier Claude, all-in-one)

**Slug:** `workspace`
**Author:** CEO + architect
**Status:** PLAN — AWAITING_USER_DECISION
**Date:** 2026-06-17
**Mode:** caveman (bus + doc)

## BOSS decisions (locked, NO NEGOTIATION)
1. Models = **Claude tiers only**: Opus (claude-opus-4-8) / Sonnet (claude-sonnet-4-6) / Haiku
   (claude-haiku-4-5). Subscription (cli `--model`). No GPT/Gemini.
2. **Chat = center/main panel** (Claude-Code-style). Board → secondary "team status" side/tab view.

## Goal
MissionAlpha = ALL-IN-ONE. One screen: chat (like Claude Code) as the PRIMARY surface, pick model
tier per chat, give tasks, and see the agent team's live progress/status — no tab switching.

## What already exists (reuse)
- Real Claude chat in-app via subscription (BossConsole + per-agent AgentChat) — `agent-runtime`
  cli backend (`claude -p`).
- Team status: board (kanban/heartbeat/feed/globe), dispatch, autonomous loop.
- Auth token, host/origin gates, F2b sandbox+broker.
- GAP 1: only one model (no per-chat tier picker).
- GAP 2: chat is a side dock, board is center → INVERTED from the desired layout.

## What's NEW (this plan)
1. **Model-tier picker** — per-chat dropdown (Opus/Sonnet/Haiku); runtime passes `--model` to cli.
2. **Chat-first reflow** — App becomes a chat-centric shell: chat center (primary), board a
   collapsible secondary panel/tab ("Team"). Conversation history persists.

---

## AGENT ROSTER — who does what (NO NEGOTIATION)
| Agent | Owns |
|---|---|
| ceo | gate, scope |
| architect | ADR-022 model-tier plumbing + ADR-023 chat-first shell layout |
| principal-ux-design | UX contract: chat-center layout, model picker, board-as-secondary (design tokens) |
| senior-web-1 | App reflow → chat-first shell; primary chat panel; layout state |
| senior-web-2 | model-tier picker UI; board→secondary "Team" panel/tab; conversation list |
| senior-backend-1 | model param on /chat + /run (cli `--model` allowlisted); model registry |
| senior-backend-2 | conversation persistence (per-thread, survives restart) |
| senior-security-engineer | model-param injection guard (allowlist tiers, no arbitrary flags) — HARD gate |
| senior-qa | e2e + adversarial |
| memory-updater | persist decisions |

### Design skills (mandatory, P2 + P4)
`impeccable` (craft+audit) · `emil-design-eng` (motion: panel transitions, model-switch, board
collapse) · `hallmark`/`taste-skill` (anti-slop, chat-app structure like Claude/Linear) ·
`gstack design-review` (critique) · `ui-designer`+`frontend-developer` agents. OKLCH tokens, a11y,
reduced-motion, mobile 320–768.

---

## PHASES

### PHASE 0 — CEO gate
- Owner: ceo. Non-goals: no non-Claude providers; no agent-factory work (separate plan); keep all
  existing controls (Cycle1/2, F2b, loop) working in the new layout.
- Exit: BOSS GO.

### PHASE 1 — architect: ADRs (BLOCKS)
- `ADR-022-model-tiers.md`: model registry `{ opus: "claude-opus-4-8", sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5" }`. /chat + /run accept optional `{model: "opus|sonnet|haiku"}` →
  runtime maps to id → `claude -p --model <id>`. Default = sonnet (speed/cost). API backend uses
  the same map for the SDK model field. STRICT allowlist (no raw passthrough).
- `ADR-023-chat-first-shell.md`: layout reflow. App shell = primary chat column (center, like Claude
  Code), board moves to a secondary, collapsible right panel / "Team" tab. Conversation model:
  multiple threads (Boss/CEO + per-agent), a thread switcher, persisted. Keep board + dispatch + loop
  fully functional inside the new shell.
- Exit: ADRs approved; model allowlist signed off by sr-security.

### PHASE 2 — principal-ux + design skills: UX contract
- impeccable shape + gstack design-review + emil motion. Design:
  1. **Chat-first shell** — center chat (message thread, streaming, model picker in header, input
     bar), left = thread/agent switcher (Boss/CEO + agents), right = collapsible "Team" board.
  2. **Model picker** — clean dropdown (Opus/Sonnet/Haiku) w/ tier hints (smartest / balanced /
     fastest), per-thread, persists.
  3. **Team panel** — the existing board (kanban/feed/globe/control-plane) as a secondary, toggle-able
     view; not lost, just demoted.
  4. **Responsive** — mobile = chat full-screen, board behind a tab.
- Reference feel: Claude Code / Linear / Raycast — calm, dense, fast. Anti-slop (hallmark).
- Exit: design approved (gstack + impeccable audit).

### PHASE 3 — senior-backend-1: model-tier plumbing
- Runtime: model registry + allowlist. /chat + /run + /factory/author (if present) accept `{model}`;
  map tier→id; cli spawn adds `--model <id>`; reject unknown tier (400). Health reports tiers.
- VALIDATE: model must be one of the 3 tier keys; never interpolate raw input into spawn args.
- Exit: curl /chat {model:"haiku"} → faster reply; {model:"opus"} → opus; bad tier → 400.

### PHASE 4 — senior-backend-2: conversation persistence
- Persist threads (Boss + per-agent) to disk (e.g. agent-runtime/threads/<id>.json, gitignored) so
  history survives restart. Load on startup. Cap size.
- Exit: chat, restart runtime, history still there.

### PHASE 5 — senior-web-1 + senior-web-2: chat-first UI build (design skills applied)
- web-1: reflow `src/App.tsx` → chat-first shell (chat center primary). Keep board mounted in the
  secondary panel (no feature loss). Layout state (chat/team toggle), persisted.
- web-2: model-tier picker (chat header), thread switcher, board-as-secondary "Team" panel/tab.
  Wire model param into AgentChat/BossConsole fetches.
- Apply emil motion (panel slide/collapse, model-switch, streaming), impeccable polish, gstack review.
- Exit: chat is the center; pick model per chat; board reachable as Team panel; all old features work.

### PHASE 6 — senior-security-engineer: model-param + layout review
- model param: confirm strict allowlist, no flag-injection into `claude` argv (e.g. model="--dangerously…").
- Confirm no regression in auth token / host gates / sandbox / loop with new layout.
- Exit: sign-off.

### PHASE 7 — senior-qa: e2e + adversarial
- e2e: open app → chat center → switch Opus/Sonnet/Haiku → reply uses right tier → give task →
  agent runs → Team panel shows progress → review/apply. Restart → history persists.
- Adversarial: model="--inject", unknown tier, huge thread → all handled.
- Regression: Cycle1/2, F2b, dispatch loop, Boss console, per-agent chat — all work in new shell.
- Exit: TESTS_GREEN + tsc + lint + sr-security sign-off.

### PHASE 8 — memory-updater + CEO retro
- Persist layout + model-tier decisions. Retro: which tier used most, chat-first adoption.

---

## Dependency order
```
P0 ceo → P1 architect ADRs → P2 ux/design → P3 model plumbing ∥ P4 persistence
  → P5 UI reflow → P6 security → P7 QA → P8 memory
```

## Acceptance (DONE when)
- [ ] Chat is the PRIMARY center panel (Claude-Code-style); board is a secondary, toggle-able "Team" view.
- [ ] Per-chat model picker: Opus / Sonnet / Haiku; runtime honors it via `--model` (allowlisted).
- [ ] Conversation history persists across restart.
- [ ] All existing features (board, dispatch, autonomous loop, F2b, control plane) work in the new shell.
- [ ] Modern UI (impeccable/emil/gstack-reviewed), a11y, responsive.
- [ ] tsc + lint + TESTS_GREEN + sr-security sign-off. No model-param injection.

## Non-goals
- Non-Claude providers (GPT/Gemini) — explicitly OUT.
- Agent-factory (separate plan: `agent-factory-plan.md`).
- Removing the board — it stays, just secondary.

## CEO note
Small-but-high-impact: model-tier = trivial plumbing (`--model` allowlisted); the real work is the
**chat-first reflow** done WELL (design skills mandatory) so it feels like Claude Code, not a
dashboard with a chat bolted on. Board demoted, never deleted. This makes MissionAlpha the
all-in-one cockpit you described.

**ASK BOSS:** GO? Default model tier = Sonnet (balanced) ok?

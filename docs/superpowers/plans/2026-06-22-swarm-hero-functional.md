# SwarmHero — Functional Live Ops View (Feature Spec)

> **STATUS: FEATURE SPEC + SEQUENCING — NOT directly line-executable.** Each feature (H1–H3)
> below is a scoped spec whose FIRST task is to produce its own executable RED→GREEN sub-plan
> (real code + exact commands) via `sp-writing-plans`, then execute it with
> `sp-subagent-driven-development`. Do NOT hand a subagent an `Hx` bullet and expect runnable
> code — expand it into a sub-plan first.

**Goal:** Turn the `SwarmHero` from a decorative publicity animation into a **functional live ops
view**: hover a node to read an agent, click a node to open that agent's existing inspect+chat
drawer, packets fly the REAL comms paths (from→to) from live feed, and node visuals encode live
status (working / blocked / stale / idle). It must STILL look good enough to screen-record for
publicity (the original ask is preserved — this is additive).

**Architecture:** `SwarmHero` already renders a force-directed glow graph from live `agents` +
`feed` (wired in the live-state work — `/api/state.json` now reflects the running runtime). This
feature adds (a) pointer hit-testing inside the canvas effect (node positions + parallax offset
`ox/oy` are in scope there), surfacing a hovered node to React state for a tooltip; (b) a new
`onSelectAgent(id)` prop the cockpit wires to its EXISTING `openAgent(id)` + `AgentDrawer`
(inspect + chat + command) — **no new chat/inspect UI is built**; (c) packet spawning driven by
new `feed` events instead of random edges; (d) node draw keyed off live `column`/`stale`. No
backend change — the runtime already serves live state.

**Tech Stack:** React + TypeScript, Canvas 2D, Vite, Electron (packaged), `node --test` (logic), Playwright/webapp-testing (visual/interaction).

---

## Skill + Agent map (CLAUDE.md — MANDATORY, fire per phase)

Every feature: **task-0 = `sp-writing-plans`** (write the executable RED→GREEN sub-plan), then
**`sp-subagent-driven-development`** to execute, **`sp-test-driven-development`** for each code step,
**`sp-verification-before-completion`** before claiming done. Per-feature specialists on top:

| Phase | Skills (fire first, in order) | Agents (build / verify) | Why |
|---|---|---|---|
| **H1** status visuals + real-comms packets | `sp-writing-plans` → `emil-design-eng` (motion: packet easing, pulse, red-ring states) → `impeccable` (`craft`/`polish` the status encoding) → `hallmark` (anti-slop visual check) → `sp-test-driven-development` → `sp-verification-before-completion` | `principal-ux-design` (OWNS the hero visual contract + tokens), `react-specialist` (canvas/render impl), `react-reviewer` (hook/render correctness), `performance-engineer` (rAF + shadowBlur budget) | encode live status without breaking the publicity look; keep 60fps |
| **H2** hover tooltip (hit-test) | `sp-writing-plans` → `emil-design-eng` (tooltip enter/exit ≤200ms ease-out, instant on adjacent) → `impeccable` (`typeset`/`layout` the tooltip card) → `kw-design-accessibility-review` → `sp-test-driven-development` → `sp-verification-before-completion` | `react-specialist` (hit-test + pointer events), `a11y-architect` (keyboard reachability of the inspect affordance), `ui-ux-tester` (hover QA) | precise hit-test under parallax; readable, accessible tooltip |
| **H3** click → inspect+chat (wire to AgentDrawer) | `sp-writing-plans` → `claude-code-guide` (n/a) … `frontend-design` (overlay→drawer handoff) → `emil-design-eng` (hero close + drawer open transition) → `sp-test-driven-development` → `webapp-testing` (click-through flow) → `sp-verification-before-completion` | `react-specialist` (prop wiring App↔hero), `react-reviewer`, `ui-ux-tester` + `webapp-testing` (verify click→drawer→chat), `security-reviewer` (BLOCKING — confirm clicks open chat only; all existing permission/apply gates intact, no new action surface) | reuse the EXISTING AgentDrawer; no new action path bypasses gates |

**Rule:** never free-code a phase — fire `sp-writing-plans` first to expand it into RED/GREEN steps,
then the agents above. Commit per GREEN. **H3 gates on `security-reviewer` before commit** (it adds a
new user-action entry point into agent chat/commands).

UI/UX skills are MANDATORY per CLAUDE.md for any frontend/design work: `hallmark` (anti-slop
structural check) → `impeccable` (craft/critique/polish/typeset/layout) → `frontend-design` →
`emil-design-eng` (motion/interaction) → `kw-design-accessibility-review` + `a11y-architect` (WCAG 2.2).

---

## Hard constraints (verified — breaking these = wrong)

- **Reuse, don't rebuild.** Click → `App.openAgent(id)` (`App.tsx:110` = `setSelectedAgentId`) +
  close hero → the EXISTING `AgentDrawer` (`App.tsx:318`, props `agent/agents/feed/heartbeats/
  onClose/onCommand`) opens with inspect + chat + command. Do NOT build a second chat/inspect UI.
- **Hit-test must account for parallax.** Node coords are drawn at `(x+? , y+?)` after
  `ctx.translate(ox, oy)` inside the effect (`SwarmHero.tsx` draw loop). Cursor→node mapping MUST
  subtract `ox/oy`. The pointer/click listeners therefore live INSIDE the canvas `useEffect`
  (where `nodes`, `ox`, `oy` are in scope); surface the hovered node id + screen position to React
  state for the tooltip; call `onSelectAgent(id)` on click.
- **Packets = real comms.** Replace random packet spawning with feed-driven: track the last-seen
  feed `ts`; on each new `FeedEvent`, spawn a packet from the `from` node → `to` node (skip if
  either id isn't a node). Keep a small idle trickle ONLY if feed is empty (so it's never dead on
  a quiet swarm). Artifact/agent node lookup via the existing `byKey`/`agentIdx` maps.
- **Status visuals from live data.** `agents` already carry live `column` + `stale` (from
  `buildLiveState`). Node draw: `in_progress` → bright pulse; `blocked` → red ring
  (`--c-stale-red` equivalent `#e24b4a`); `stale` → dim + desaturate; `idle` → faint. Keep the
  fixed dark publicity palette (no pink).
- **Read-only + gated.** The hero adds NO new action surface beyond opening chat. Sending a
  message / applying changes still flows through the existing `ChatPane` + permission gates. A
  click never mutates anything directly.
- **Crisp, not blurry.** Keep the solid per-frame clear (no trail smear — locked in the last fix).
- **Perf.** Canvas stays ≤ the current node/edge/packet budget; hit-test is O(nodes) per pointer
  event (fine ≤ ~50 nodes). No React re-render per frame — tooltip state updates only on
  hovered-node CHANGE (throttle), never every frame.
- **Reduced motion + a11y.** Honor `prefers-reduced-motion` (settle static, no packet stream).
  The graph is decorative, so provide a keyboard path to the same data (the cockpit roster/board
  already give keyboard inspect; document that the hero is a visual alternative, not the only path).
- **Self-contained + reusable.** `SwarmHero` stays a standalone component (publicity reuse on a
  future landing page) — `onSelectAgent` is OPTIONAL; when omitted (landing page), nodes are
  display-only (hover tooltip still works, click is a no-op).

---

## Verified code anchors (2026-06-22)

- `src/components/hero/SwarmHero.tsx` — props `{ open, agents, feed=[], onClose }`; canvas effect
  builds `nodes[]` + `agentIdx` Map + `byKey` Map; draws under `ctx.translate(ox, oy)`; pointer
  parallax `ox/oy` eased in the loop; solid clear per frame; fixed dark palette `KCOL`.
- `src/App.tsx:88` `selectedAgentId` state · `:89` `selectedAgent` memo · `:110` `openAgent(id)` ·
  `:318` `<AgentDrawer agent={selectedAgent} agents feed heartbeats onClose onCommand={sendCommand}/>` ·
  `:329` `<SwarmHero open={heroOpen} agents={state.agents} feed={state.feed} onClose=…/>`.
- `src/components/AgentDrawer.tsx:211` `AgentDrawer({ agent, agents, feed, heartbeats, onClose, onCommand })`.
- `FeedEvent` shape: `{ ts, from, to, topic, ref, body }` (`types.ts:59`). Live feed now synthesized
  by `buildLiveState` (`agent-runtime/live-state.mjs`).
- `AgentState` carries `column` (`idle|in_progress|blocked|review|done`) + `stale` (`types.ts:25`).

---

## H1 — Live status visuals + real-comms packets

**Goal:** Node appearance encodes live status; packets fly real feed paths.

**Sub-plan must cover (files: `SwarmHero.tsx` draw loop + a new `agent-runtime`-free pure helper
`src/lib/swarmGraph.ts` for packet/status mapping so it's unit-testable; test `src/lib/__tests__/swarmGraph.test.ts`):**
- Pure `statusStyle(agent)` → `{ ring: "red"|null, pulse: boolean, dim: boolean }` from `column`/`stale`. RED→GREEN unit tests.
- Pure `packetsFromFeed(prevTs, feed, hasNode)` → `{ newTs, spawns: [{from,to}] }` (only events newer than `prevTs`, both endpoints present). RED→GREEN unit tests.
- Wire into the draw loop: status-driven node render (red ring / pulse / dim), feed-driven packet spawn (replace random), idle trickle only when feed empty.
- `emil-design-eng`: packet ease, pulse rate, red-ring weight; `impeccable polish`; `hallmark` anti-slop pass.
- `performance-engineer`: confirm 60fps with packets + shadowBlur at ~45 nodes.

**Exit Gate:** working agents pulse, blocked show a red ring, stale dim, idle faint; a real feed
event produces a packet along its from→to path; unit tests green; 60fps; publicity look intact.

---

## H2 — Hover tooltip (parallax-correct hit-test)

**Goal:** Hover any node → tooltip card with `id · role · tier · status · current task`.

**Sub-plan must cover (files: `SwarmHero.tsx` — pointer hit-test in the effect + a tooltip overlay;
pure `src/lib/swarmGraph.ts` `hitTest(nodes, px, py, ox, oy)` → node id|null; test added):**
- `hitTest` pure fn (cursor minus parallax vs node radius) — RED→GREEN unit tests (hit inside r, miss outside, parallax offset respected).
- `pointermove` listener (inside effect) → compute hovered id → `setHovered({id, sx, sy})` ONLY on change (no per-frame setState).
- Tooltip = absolutely-positioned card (pointer-events:none) reading the agent from `agents` by id; `emil-design-eng` enter/exit ≤200ms ease-out; `impeccable typeset/layout`; `kw-design-accessibility-review` (contrast, not the only data path).
- Cursor `pointer` over a node (hint clickability).

**Exit Gate:** hovering a node shows the correct agent's tooltip at the cursor, accurate under
parallax + drift; leaving hides it; no frame drops from setState; tests green.

---

## H3 — Click node → open agent inspect + chat (wire to AgentDrawer)

**Goal:** Click a node → that agent's existing inspect+chat drawer opens.

**⚠️ security-sensitive (new user-action entry point) → `security-reviewer` BLOCKING before commit.**

**Sub-plan must cover (files: `SwarmHero.tsx` add optional `onSelectAgent?(id)` prop + click
handler in the effect; `App.tsx` pass `onSelectAgent={(id)=>{ setHeroOpen(false); openAgent(id); }}`):**
- `SwarmHero` gains optional `onSelectAgent?: (id: string) => void`. Click handler (in effect) →
  `hitTest` → if node + `onSelectAgent` → call it. When prop omitted (landing page) → no-op.
- `App.tsx`: wire `onSelectAgent` to close the hero + `openAgent(id)` → existing `AgentDrawer`
  opens with inspect + chat + `onCommand`. No new chat code.
- `emil-design-eng`: hero-close → drawer-open transition (no jarring jump; drawer is origin-aware).
- `webapp-testing` + `ui-ux-tester`: click a node in the running app → drawer opens for THAT agent
  → chat is usable. Verify in dev AND packaged.
- `security-reviewer`: confirm a node click opens chat ONLY; sending/apply still gated by the
  existing permission broker; no new path mutates state or bypasses `onCommand` gates; `onSelectAgent`
  can't be invoked with an attacker-controlled id (id comes from the rendered roster nodes).

**Exit Gate:** clicking a node opens the correct agent's drawer (inspect + chat), in dev AND the
packaged app; existing gates intact; security-reviewer clean.

---

## SEQUENCE
```
H1 (status + real packets) → H2 (hover tooltip) → H3 (click → inspect+chat)
```
H1/H2 are pure-visual + read-only (low risk, no gate impact). H3 adds the action entry point →
built last + security-gated. Each is independently shippable.

---

## Global Exit Gate (feature complete)
- [ ] Node visuals reflect live status (pulse/red-ring/dim/faint) — H1.
- [ ] Packets trace real feed from→to paths; idle trickle only when feed empty — H1.
- [ ] Hover → correct tooltip, parallax-accurate — H2.
- [ ] Click → correct agent's existing inspect+chat drawer (dev + packaged) — H3.
- [ ] Standalone reuse intact: `onSelectAgent` omitted → display-only hero (publicity) still works.
- [ ] Publicity look preserved (dark, glow, no pink, crisp, screen-recordable).
- [ ] `prefers-reduced-motion` honored; a11y reviewed.
- [ ] `cd agent-runtime && npm test` green; `npm run typecheck` 0; `npm run build` 0; pure-helper unit tests green.
- [ ] `security-reviewer` PASS on H3 (no new ungated action surface).
- [ ] Commits per GREEN; not pushed.

## Self-review (against the ask)
- "click a node → open that agent's chat/inspect" → H3 (reuses AgentDrawer). ✔
- "packets reflect real comms" → H1 feed-driven packets. ✔
- "doubles as a live ops view" → H1 status visuals + H2 hover + H3 click. ✔
- Required CLAUDE.md skills + agents named per phase (sp-* pipeline + hallmark/impeccable/
  frontend-design/emil-design-eng/kw-design-accessibility-review + principal-ux-design/react-*/
  a11y-architect/ui-ux-tester/webapp-testing/performance-engineer/security-reviewer). ✔
- Reuse-not-rebuild + gates-intact + parallax hit-test + publicity-preserved constraints stated. ✔
- Anchors verified (openAgent, AgentDrawer, SwarmHero props, FeedEvent, AgentState.column). ✔
```
```

# PRD — SwarmHero: Functional Live Ops View

> Authored via `kw-product-management-write-spec`. This is a PRODUCT SPEC (the "what" + "why" +
> acceptance criteria). The executable RED→GREEN build plan is produced per feature at build time
> via `sp-writing-plans` (task-0 of each requirement group) — see **Build: Skill + Agent Map**.

| | |
|---|---|
| **Status** | Draft — ready for build |
| **Owner** | Rohit (boss) · design owner: `principal-ux-design` |
| **Surface** | `src/components/hero/SwarmHero.tsx` (MissionAlpha cockpit, Electron desktop) |
| **Date** | 2026-06-22 |
| **Related** | Live-state wiring (`/api/state.json`, `agent-runtime/live-state.mjs`) — DONE; F4 desktop app — DONE |

---

## Problem Statement

The SwarmHero (the full-screen glowing agent graph behind the "Swarm" button) is currently
**decorative only** — a publicity animation. It reads live data but you cannot act on it: no way to
identify an agent, open its chat, or see real traffic. Operators who open it get a pretty picture,
then must leave it and go back to the roster/board to actually do anything. The visual real estate
(a full-screen, attention-grabbing view) delivers zero operational value, and the "live" framing is
misleading because nothing in it is interactive.

**Who/when:** the operator (boss), every time they open the Swarm view expecting to *use* it.
**Cost of not solving:** wasted prime UI; a "live ops view" that isn't; the swarm's real activity
(comms, blockers, who's working) stays invisible at a glance.

---

## Goals

1. **Glanceable status** — within 2 seconds of opening, the operator can tell which agents are
   working, blocked, stale, or idle, without reading text. (Measure: status legible from node
   visuals alone in usability check.)
2. **One-click to act** — clicking any agent node opens that agent's inline inspect + chat panel
   (hero stays open) in ≤1 interaction. (Measure: click→panel success rate = 100% in QA.)
3. **Real traffic visible** — packets represent actual agent-to-agent comms (feed events), not
   random motion. (Measure: every spawned packet maps to a real `FeedEvent` from→to.)
4. **Publicity preserved** — the view stays screen-record-worthy (dark, glow, no pink, crisp). The
   ops upgrade is additive, not a downgrade of the promo asset. (Measure: side-by-side with the
   current promo frame — visual parity or better.)
5. **Zero new risk** — adds no ungated action surface; clicking only opens chat, all existing
   permission/apply gates remain the only path to mutation. (Measure: `security-reviewer` PASS.)

---

## Non-Goals

1. **No new CHAT implementation** — the inline panel (P0-4) is allowed (boss-approved v2), but it
   must **embed the EXISTING `ChatPane`** for chat/send/apply. Writing a second chat engine, message
   store, or gate is out of scope (duplication, drift). New code = panel chrome + comms list only.
2. **No drag/edit of the graph** — nodes are not repositionable or editable by the operator; it's a
   read+inspect view, not a graph editor. (Low value, high complexity.)
3. **No new agent actions from the hero** — no "dispatch", "kill", "approve" buttons on nodes in
   v1. Actions stay in the gated chat/drawer flow. (Keeps the security surface unchanged.)
4. **No historical/timeline scrubbing in the hero** — replay lives in the cockpit's Replay drawer;
   the hero shows live-now only. (Separate initiative.)
5. **No backend/runtime changes** — `/api/state.json` already serves live state with `feed`. This
   feature is renderer-only. (Already shipped; don't re-open it.)

---

## User Stories

**Operator (boss) — primary persona**
1. As the operator, I want each agent node to *look* different by status, so I can spot blocked or
   stalled agents instantly without reading.
2. As the operator, I want to hover a node and see its id, role, status, and current task, so I can
   identify an agent before acting.
3. As the operator, I want to click a node and land in that agent's chat/inspect, so I can act on
   what I see without hunting in the roster.
4. As the operator, I want packets to show *real* messages flying between agents, so the view tells
   me what the swarm is actually doing right now.
5. As the operator, I want the Swarm view to stay visually impressive, so I can still screen-record
   it for the landing page / promo.

**Marketer / future-landing-page (secondary persona)**
6. As a marketer, I want to embed the same SwarmHero on a landing page with clicks disabled, so it
   plays as a hero animation without exposing internal navigation. (Standalone reuse: `onSelectAgent`
   omitted → display-only.)

**Edge cases**
7. As the operator on a *quiet* swarm (no comms), I want a subtle idle packet trickle, so the view
   isn't dead-still.
8. As an operator with `prefers-reduced-motion`, I want a calm static frame (no packet stream), so
   the view doesn't cause motion discomfort.

---

## Requirements

### Must-Have (P0)

**P0-1 — Status-driven node visuals**
Node appearance encodes live `column` + `stale` from the agent data already supplied to the hero.
- Acceptance (Given/When/Then):
  - Given an agent with `column: "in_progress"`, When the hero renders, Then its node shows a
    bright pulse.
  - Given an agent with `column: "blocked"`, Then its node shows a red ring (`#e24b4a`).
  - Given an agent with `stale: true`, Then its node renders dim/desaturated.
  - Given an agent with `column: "idle"` and no heartbeat, Then its node renders faint.
  - Given the fixed dark publicity palette, Then no pink is introduced and the glow is preserved.
- **Fire (CLAUDE.md):** `sp-writing-plans` → `emil-design-eng` → `impeccable` → `hallmark` → `sp-test-driven-development` → `sp-verification-before-completion`. **Agents:** `principal-ux-design` (visual contract), `react-specialist` (impl), `react-reviewer`, `performance-engineer` (60fps).

**P0-2 — Packets reflect real comms**
Packets spawn from live `feed` events (`from → to`), replacing random spawning.
- Acceptance:
  - Given a new `FeedEvent {from, to}` where both ids are nodes, When it arrives, Then exactly one
    packet travels the from→to edge.
  - Given a feed event whose `from` or `to` is not a rendered node, Then no packet is spawned (no crash).
  - Given an empty/quiet feed, Then a subtle idle trickle plays (view never dead-still).
  - Given the same feed (no new events), Then no duplicate packets are spawned (last-seen `ts` respected).
- **Fire (CLAUDE.md):** `sp-writing-plans` → `emil-design-eng` (packet ease) → `impeccable` → `sp-test-driven-development` → `sp-verification-before-completion`. **Agents:** `react-specialist` (impl), `react-reviewer`, `performance-engineer`. (Grouped with P0-1 — same phase.)

**P0-3 — Hover tooltip (parallax-correct hit-test)**
Hovering a node shows a tooltip with `id · role · tier · status · current task`.
- Acceptance:
  - Given the cursor is within a node's radius (after subtracting parallax offset), When hovering,
    Then a tooltip for THAT agent appears at the cursor.
  - Given the graph is drifting / parallax-shifted, Then the hit-test still resolves the correct node.
  - Given the cursor leaves all nodes, Then the tooltip hides.
  - Given hovering, Then the cursor becomes a pointer (clickability hint).
  - Performance: tooltip React state updates only on hovered-node CHANGE (never per animation frame).
- **Fire (CLAUDE.md):** `sp-writing-plans` → `emil-design-eng` (tooltip enter/exit) → `impeccable` (`typeset`/`layout`) → `kw-design-accessibility-review` → `sp-test-driven-development` → `sp-verification-before-completion`. **Agents:** `react-specialist` (hit-test), `a11y-architect` (WCAG 2.2), `ui-ux-tester`.

**P0-4 — Click node → INLINE real-time inspect + chat panel (v2, boss-approved)**
Clicking a node opens an inline right-side panel **inside the hero** (the hero stays open — it
"doubles as a live ops view"), matching the approved reference mockup
(`docs/mockups/swarm-hero-functional-ref.html`). The panel **embeds the EXISTING chat component
(`ChatPane`) — no new chat code is written**; it adds only the panel chrome (header + recent-comms
list) around it.

Panel layout (per the reference mockup):
- **Header:** avatar initials (e.g. `SW`) + agent id (mono) + `role · tier · <live status>`.
- **RECENT COMMS:** live list of that agent's feed events (`→ to · topic · "body"` / `← from · …`),
  newest first, **updated in real time** from the polled `/api/state.json` feed (filtered to this
  agent's from/to).
- **Chat composer:** the existing `ChatPane` for that agent (Message …, send), fully gated as today.
- Right-edge panel ~300px; the graph keeps animating in the remaining space.

- Acceptance (Given/When/Then):
  - Given a node, When clicked, Then the inline panel opens **for that exact agent id** with the
    hero still visible behind it; clicking another node swaps the panel to that agent.
  - Given the panel is open, Then RECENT COMMS reflects that agent's live feed and **updates without
    reopening** as new events arrive (real-time).
  - Given the embedded chat, Then it is the SAME `ChatPane` used in the cockpit — NO duplicate chat
    implementation; sending / applying still routes through the existing permission gates.
  - Given the panel open, Then the clicked node shows a white selection ring (P1-1 folded into P0).
  - Given a close affordance (✕ / Esc-once), When used, Then the panel closes and the hero returns
    to full-screen graph (Esc-again closes the hero).
  - Verified in BOTH dev and the packaged Electron build.
  - Negative: a click on empty canvas closes the panel (or does nothing if already closed).
- **Fire (CLAUDE.md):** `sp-writing-plans` → `frontend-design` (overlay↔panel) → `emil-design-eng` (panel open/close motion) → `impeccable` (`polish`) → `sp-test-driven-development` → `webapp-testing` (click-through, dev + packaged) → `sp-verification-before-completion`. **Agents:** `react-specialist` (App↔hero wiring), `react-reviewer`, `ui-ux-tester` + `webapp-testing`, **`security-reviewer` (BLOCKING before commit)**.

**P0-5 — Standalone reuse preserved**
- Acceptance:
  - Given `SwarmHero` is mounted WITHOUT `onSelectAgent` (landing page), When a node is clicked,
    Then nothing happens (display-only) and hover tooltips still work.

### Nice-to-Have (P1)

**P1-1 — Selected-node highlight — ✅ DONE (shipped in P0-4).** The open agent's node already gets a
white selection ring. No further work; listed for completeness.

**P1-2 — Comms label on packet**
A packet (which represents a real `FeedEvent`) carries a small label of its `topic`, so the operator
can read WHAT is flowing, not just that something is.
- Acceptance (Given/When/Then):
  - Given a packet spawned from a feed event with a `topic`, When it is in flight, Then a small
    mono label (the topic, ≤16 chars) renders next to it, fading in/out with the packet.
  - Given the cursor is near a packet, Then that packet's label is emphasized (brighter/larger);
    far packets stay subtle so the view doesn't clutter.
  - Given many simultaneous packets, Then at most ~6 labels render at once (nearest-to-cursor or
    most-recent), capped to protect readability + 60fps.
  - Given `prefers-reduced-motion` (no packet stream), Then no labels (n/a). No regression to P0-2.
- **Fire (CLAUDE.md):** `sp-writing-plans` → `emil-design-eng` (label fade with the packet) →
  `impeccable` (`typeset` the micro-label) → `sp-test-driven-development` → `sp-verification-before-completion`.
  **Agents:** `react-specialist` (canvas label render), `react-reviewer`, `performance-engineer`
  (label-cap + fps), `ui-ux-tester`.

**P1-3 — Filter / dim by tier (interactive legend)**
The bottom legend chips (CEO / principal / senior / support) become clickable filters: click a tier
to focus it (others dim), so the operator can isolate a layer of the swarm.
- Acceptance (Given/When/Then):
  - Given the legend, When a tier chip is clicked, Then nodes/edges/packets of OTHER tiers dim
    (lower opacity, no glow), the focused tier stays full, and the chip shows an active state.
  - Given multiple chips clicked, Then the focus set is their union (all active tiers stay lit).
  - Given an active chip is clicked again, Then it leaves the focus set; with NO chips active, all
    nodes show full (default).
  - Given the dim transition, Then it eases ≤200ms (no hard flicker), honoring `prefers-reduced-motion`
    (instant, no animation).
  - Given keyboard, Then each legend chip is a real focusable button (Tab + Enter/Space toggles),
    with a visible focus ring + `aria-pressed`.
- **Fire (CLAUDE.md):** `sp-writing-plans` → `impeccable` (chip interaction states) →
  `emil-design-eng` (dim ease) → `kw-design-accessibility-review` → `sp-test-driven-development` →
  `sp-verification-before-completion`. **Agents:** `react-specialist` (legend buttons + focus-set
  state → canvas dim), `a11y-architect` (WCAG 2.2 keyboard/focus/aria), `ui-ux-tester`.

> **P1 scope note:** P1-1 is already done (P0-4). P1 = **P1-2 + P1-3** only. Both are pure-visual /
> read-only enhancements — NO new action surface, so **no `security-reviewer` gate** is required
> (unlike P0-4). Build order: **P1-2 → P1-3**. Each is independently shippable.

### Future Considerations (P2)

**P2-1 — In-hero actions** — node context actions (re-dispatch, ack) — would require routing through
the gate; design nodes/handlers so this can be added later without restructuring.
**P2-2 — Edge weighting by comms volume** — thicker/brighter links between chattier agents.
**P2-3 — Mini live-ops dock** — a non-fullscreen embedded version on the cockpit home.

---

## Success Metrics

**Leading (days)**
- Click-through: % of Swarm-view opens that result in ≥1 node click → target **≥40%** within 2 weeks
  (proves it's used as ops, not just watched).
- Time-to-identify a blocked agent (usability test) → target **< 3s**.
- Packet→feed fidelity → **100%** of packets map to a real feed event (instrumented assertion).

**Lagging (weeks)**
- Operator reliance: Swarm view becomes a regular entry point to agent chat (qualitative + click
  attribution) vs. roster/board.
- Promo usage: the same component ships on the landing page (reuse with clicks disabled) — binary.

**Measurement method:** lightweight click logging in dev/QA + manual usability check; packet
fidelity via a unit assertion in `packetsFromFeed`.

---

## Build: Skill + Agent Map (CLAUDE.md — MANDATORY, fire per phase)

Every feature group: **task-0 = `sp-writing-plans`** (executable RED→GREEN sub-plan), then
**`sp-subagent-driven-development`** to execute, **`sp-test-driven-development`** per code step,
**`sp-verification-before-completion`** before "done". Specialists per phase:

| Group | UI/UX skills (fire in order) | Agents (build / verify) |
|---|---|---|
| **P0-1 + P0-2** (visuals + packets) | `sp-writing-plans` → `emil-design-eng` (packet ease, pulse, red-ring) → `impeccable` (`craft`/`polish`) → `hallmark` (anti-slop) → `sp-test-driven-development` → `sp-verification-before-completion` | `principal-ux-design` (visual contract owner), `react-specialist` (canvas impl), `react-reviewer`, `performance-engineer` (rAF + shadowBlur 60fps) |
| **P0-3** (hover tooltip) | `sp-writing-plans` → `emil-design-eng` (tooltip enter/exit ≤200ms ease-out) → `impeccable` (`typeset`/`layout`) → `kw-design-accessibility-review` → TDD → verification | `react-specialist` (hit-test + pointer), `a11y-architect` (WCAG 2.2), `ui-ux-tester` |
| **P0-4** (click → chat) | `sp-writing-plans` → `frontend-design` (overlay→drawer handoff) → `emil-design-eng` (close/open transition) → TDD → `webapp-testing` (click-through, dev + packaged) → verification | `react-specialist` (App↔hero wiring), `react-reviewer`, `ui-ux-tester` + `webapp-testing`, **`security-reviewer` (BLOCKING before commit)** |

Rule: **never free-code a phase** — `sp-writing-plans` first, then the agents above. Commit per
GREEN. **P0-4 gates on `security-reviewer`** (new user-action entry point).

---

## Real-Time Behavior (how "live" actually works)

The hero already receives `agents` + `feed` from `App`, which polls the LIVE `/api/state.json`
(`LocalPollAdapter`, ~2s cadence) — the same source the cockpit board uses. So "real-time" =
**re-render off the live props each poll**, no new data plane:

- **Node status** — recomputed from `agents[].column`/`stale` every poll → pulse/red-ring/dim flips
  live as agents start/finish/block.
- **Packets** — `packetsFromFeed(prevTs, feed)` fires on each NEW `FeedEvent` between polls →
  packets appear as real comms happen.
- **Inline panel RECENT COMMS** — derived live from `feed` filtered to the open agent (`from===id ||
  to===id`), so the list grows in place while the panel stays open (no reopen).
- **Inline panel status** — the header status string reads the open agent's current `column` from
  the latest `agents` prop → updates live.
- **Embedded `ChatPane`** — already streams the agent's turn live (SSE) via the existing path.

Reference mockup (boss-approved layout): `docs/mockups/swarm-hero-functional-ref.html` — left:
hover tooltip; right: the inline real-time inspect+chat panel (header · RECENT COMMS · composer).

> Constraint: real-time updates must NOT thrash React — derive panel data with `useMemo` keyed on
> `(openId, feed)`; the canvas keeps its own rAF loop and reads node status from a ref synced on
> prop change, so the animation never triggers per-frame React renders.

---

## Verified Code Anchors (2026-06-22)

- `src/components/hero/SwarmHero.tsx` — props `{ open, agents, feed=[], onClose }`; canvas effect
  builds `nodes[]` + `agentIdx` + `byKey`; draws under `ctx.translate(ox, oy)` (parallax); solid
  per-frame clear; fixed dark `KCOL` palette.
- `src/App.tsx:88` `selectedAgentId` · `:89` `selectedAgent` memo · `:110` `openAgent(id)` ·
  `:318` `<AgentDrawer agent={selectedAgent} agents feed heartbeats onClose onCommand={sendCommand}/>` ·
  `:329` `<SwarmHero open agents feed onClose/>`.
- `src/components/AgentDrawer.tsx:211` `AgentDrawer({ agent, agents, feed, heartbeats, onClose, onCommand })`.
- `FeedEvent` `{ ts, from, to, topic, ref, body }` (`types.ts:59`); `AgentState.column` ∈
  `idle|in_progress|blocked|review|done`, `AgentState.stale` (`types.ts:25`).
- New pure helpers to add (unit-tested, no React): `src/lib/swarmGraph.ts` →
  `statusStyle(agent)`, `packetsFromFeed(prevTs, feed, hasNode)`, `hitTest(nodes, px, py, ox, oy)`.

---

## Open Questions

- ~~**[design — non-blocking]** Selection ring (P1-1) timing.~~ **RESOLVED — shipped in P0-4.**
- **[design — non-blocking]** Idle-trickle rate when feed is quiet — how subtle? (`emil-design-eng`
  to tune; default ~1 packet / 0.6s.)
- **[a11y — non-blocking]** Is the cockpit roster/board a sufficient keyboard-equivalent path, or
  does the hero need keyboard node focus in v1? (Default: rely on roster/board; document it.)
- ~~**[product — blocking]** v1 (close→cockpit drawer) vs v2 (inline panel).~~ **RESOLVED
  2026-06-22 — boss chose v2: inline real-time inspect+chat panel inside the hero** (reference
  mockup `docs/mockups/swarm-hero-functional-ref.html`). P0-4 updated accordingly.

---

## Timeline Considerations

- No hard deadline. Build order P0-1 → P0-2 → P0-3 → P0-4 (visual/read-only first, action-entry
  last + security-gated). Each P0 is independently shippable.
- Dependency: none new — live `/api/state.json` + `AgentDrawer` already exist.
- Phasing: P0 = the functional ops view (this spec). P1 = polish (selection ring, packet labels,
  tier filter). P2 = in-hero gated actions / embedded dock (separate spec).

---

## Self-Review (spec quality)
- Goals are outcomes + measurable (status legibility, click-through, packet fidelity, publicity
  parity, security PASS). ✔
- Non-goals prevent scope creep (no new chat UI, no graph editing, no new actions, no backend). ✔
- Every P0 has Given/When/Then acceptance, incl. negative + edge (quiet feed, reduced motion,
  standalone reuse). ✔
- Required CLAUDE.md skills + agents named per phase. ✔
- One genuinely-blocking open question surfaced (v1 vs v2 click behavior). ✔

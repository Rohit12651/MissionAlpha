# Build Directive — SwarmHero P2 (Future Considerations)

> Paste-ready build prompt for a NEW session/tab. Detailed plan + the EXACT CLAUDE.md skills and
> agents to fire per phase. P0 + P1 are DONE and committed; build ONLY P2 here.

**Repo:** `/Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha` · **Branch:** `feat/multimodal-input`
**Surface:** `src/components/hero/SwarmHero.tsx` (+ `src/App.tsx`, `src/lib/swarmGraph.ts`)

## READ FIRST (do not skip)
- Spec: `docs/superpowers/plans/2026-06-22-swarm-hero-functional.md` → "Future Considerations (P2)".
- Progress to date: `docs/superpowers/SWARM_HERO_PROGRESS.md`.
- Reference layout: `docs/mockups/swarm-hero-p2-ref.html` (P2-annotated — built 2026-06-23) and the
  P0/P1 sibling `docs/mockups/swarm-hero-functional-ref.html`.
- Shipped P0/P1 sub-plans (patterns to mirror): `docs/superpowers/plans/2026-06-2{2,3}-swarm-hero-*.md`.

## SCOPE — P2 = P2-1 + P2-2 + P2-3
All build on the existing functional hero. Build order: **P2-2 → P2-3 → P2-1** (lowest risk →
highest; P2-1 introduces the first mutation surface and is the security-gated finale).

- **P2-2 — Edge weighting by comms volume** (read-only, pure-visual): links between chattier agents
  render thicker/brighter, so collaboration intensity is glanceable.
- **P2-3 — Mini live-ops dock** (read-only): a non-fullscreen embedded SwarmHero on the cockpit home;
  click-to-expand to the full hero. Reuses the SwarmHero component via a `variant` prop.
- **P2-1 — In-hero gated node actions** (MUTATION — security-gated): the inline panel gains `Ack` and
  `Re-dispatch` actions for the open agent, routed through the EXISTING `sendCommand` +
  `PermissionGate` path. NO new command types, NO new backend.

---

## MANDATORY PROCESS (every phase, in this order)
1. **`sp-writing-plans`** — task-0: expand the P2 item into an executable RED→GREEN sub-plan (real
   code + exact commands). Save to `docs/superpowers/plans/`. The directive is a SPEC, not line-runnable.
2. **`sp-subagent-driven-development`** — execute task-by-task; delegate heavy edits to subagents.
3. **`sp-test-driven-development`** — every code step RED → GREEN → commit. Pure helpers first.
4. **The per-phase UI/UX skills + agents named in each item's "Fire (CLAUDE.md)" line below.**
5. **`sp-verification-before-completion`** — before claiming any phase done.

NEVER free-code a phase. `sp-writing-plans` first, then the agents.

## HARD CONSTRAINTS (carried from P0/P1 — breaking these = wrong)
- **Pure helpers stay unit-testable** in `src/lib/swarmGraph.ts` with tests in
  `src/lib/__tests__/swarmGraph.test.ts` (RED→GREEN). Do not bury new logic only in the canvas closure.
- **Reuse existing data/paths:** edges/feed/`agents` already in scope; commands go through the
  EXISTING `sendCommand` (`useAgentState`) + `PermissionGate` + `getCommandStatus` — the SAME path
  `ChatPane`/`AgentDrawer` use. `CommandType` stays `"ack" | "respawn" | "task"` (no new verbs).
- **Real-time + perf:** keep the canvas rAF loop; new state must NOT cause per-frame React renders
  (React state → ref synced on change; canvas reads the ref). Hold 60fps (`performance-engineer`).
- **Crisp** (solid per-frame clear, no trail blur), **dark publicity palette, NO pink**, honor
  `prefers-reduced-motion`.
- **No regression to P0/P1:** status visuals, real-comms packets + labels, hover tooltip, inline
  inspect+chat panel + selection ring, tier filter must all still work. P2 is additive.
- **P2-1 is the ONLY mutation surface** → `security-reviewer` is a BLOCKING gate before its commit.
  P2-2 and P2-3 are read-only → no security gate (unless P2-3 surfaces P2-1 actions in the dock).

## PROCESS / GIT
- Commit per GREEN, conventional messages, end with the Co-Authored-By trailer. Do NOT push or open a
  PR unless asked. Stage ONLY files you change; do not touch unrelated work (`SESSION_MEMORY.md`,
  `Untitled.png`, `missionalpha-cockpit.html`, `live-state-wiring.md`).
- Verify each phase: `cd agent-runtime && npm test` unaffected (297 pass); `npm run typecheck`
  (exit 0); `npm run build` (exit 0); pure-helper unit tests green; interaction in the running app
  (dev AND packaged Electron) via `webapp-testing` — for P2-1, verify the gate actually blocks/asks.
- After each phase: report acceptance with proof, then continue.

---

## P2-2 — Edge weighting by comms volume

**Acceptance (Given/When/Then):**
- Given a feed with N messages between agents A and B, When the graph renders, Then the A↔B link is
  thicker AND brighter in proportion to N (normalized across all edges).
- Given two agents with no comms but a structural link (e.g. agent→CEO), Then the link renders at a
  baseline minimum weight (never invisible).
- Given the busiest pair, Then its weight is capped (no runaway thickness) and stays crisp at 60fps.
- Given `prefers-reduced-motion`, Then weights are static (no pulsing), still proportional.
- Given the tier filter active (P1-3), Then dimmed edges keep their relative weight but at dim alpha.

**Design:**
- Pure helper `edgeWeights(feed, hasNode)` → `Map<string, number>` keyed `"from|to"` (order-normalized)
  of NORMALIZED weights in `[0,1]`: count comms per unordered agent pair, divide by the max count.
  Unit-test: counting, order-independence (A|B == B|A), normalization, empty feed → empty map,
  non-node pairs ignored.
- Canvas: when drawing each edge, look up its weight (0 if none), compute
  `lineWidth = 0.8 + weight * 2.4` and fold `0.4 + 0.6*weight` into the edge alpha. Build a
  `weightsRef` synced on `[feed]` (no per-frame React render). Multiply by the P1-3 `max(a.dim,b.dim)`.

**Files:** `src/lib/swarmGraph.ts` (+ test), `src/components/hero/SwarmHero.tsx`.

**Fire (CLAUDE.md):** `sp-writing-plans` → `emil-design-eng` (weight→width/brightness easing curve) →
`impeccable` (`polish` link hierarchy) → `sp-test-driven-development` → `sp-verification-before-completion`.
**Agents:** `react-specialist` (canvas edge render + `weightsRef`), `react-reviewer`,
`performance-engineer` (per-frame cost of N edges + 60fps).

---

## P2-3 — Mini live-ops dock

**Acceptance (Given/When/Then):**
- Given the cockpit home, When it renders, Then a non-fullscreen SwarmHero dock (e.g. a card/corner
  panel) shows the live graph (status visuals + real packets) at reduced scale.
- Given the dock, When a node is clicked OR an "expand" affordance is used, Then the full-screen
  SwarmHero opens (optionally pre-selecting the clicked agent).
- Given the dock, Then it is display-first: it must NOT steal focus, NOT autoplay loud motion, and
  honor `prefers-reduced-motion` (static settle).
- Given the same `SwarmHero` component, Then the dock reuses it via a `variant`/size prop — NO fork,
  NO second canvas engine.
- Given keyboard, Then the expand affordance is a real focusable button (Tab + Enter/Space, focus ring).

**Design:**
- Add an optional `variant?: "full" | "dock"` (default `"full"`) + optional `className`/size props to
  `SwarmHero`. In `"dock"`: no fixed-inset overlay, smaller canvas, legend/tooltip/panel suppressed or
  minimized, lighter motion. The rAF loop, helpers, and status/packet rendering are shared.
- `App` mounts a docked `SwarmHero` on the cockpit home with an expand handler that opens the
  existing full hero (`setHeroOpen(true)`, optional `setHeroAgentId(id)`).
- No mutation → no security gate. Keep it cheap (consider pausing the dock rAF when offscreen).

**Files:** `src/components/hero/SwarmHero.tsx` (variant prop), `src/App.tsx` (mount + expand),
possibly a thin `src/components/hero/SwarmDock.tsx` wrapper.

**Fire (CLAUDE.md):** `sp-writing-plans` → `frontend-design` (dock vs full-overlay composition) →
`impeccable` (`craft` the dock card) → `emil-design-eng` (open/expand transition) →
`kw-design-accessibility-review` → `sp-test-driven-development` → `webapp-testing` (dev + packaged) →
`sp-verification-before-completion`. **Agents:** `react-specialist` (variant + App mount),
`react-reviewer`, `principal-ux-design` (dock-in-cockpit visual contract), `a11y-architect`
(expand button + focus), `ui-ux-tester`.

---

## P2-1 — In-hero gated node actions (SECURITY-GATED)

**Acceptance (Given/When/Then):**
- Given the inline panel for an agent, Then it shows `Ack` and `Re-dispatch` actions in the header/footer.
- Given `Ack` is clicked, When confirmed via the EXISTING `PermissionGate`, Then a `{type:"ack",
  target:<agentId>}` `CommandRequest` is sent through `sendCommand` (the same path the cockpit uses);
  the agent's `acknowledged` state flips on the next poll.
- Given `Re-dispatch` is clicked, When confirmed, Then a `{type:"respawn", target:<agentId>}` command
  is sent the same way; `respawnRequested` flips live.
- Given the action is in flight, Then UI shows pending/disabled until `getCommandStatus` resolves
  (no double-send); failures surface a non-leaking error.
- Given NO confirmation (gate dismissed), Then NO command is sent.
- Given `onSelectAgent`/command props are omitted (landing-page reuse), Then actions are hidden
  (display-only) — never a dangling action.
- Verified in BOTH dev and packaged Electron.

**Design (REUSE — no new path):**
- The hero panel ALREADY embeds `ChatPane` and App owns `sendCommand`. Add an `onCommand` prop to the
  hero panel (App passes `sendCommand`) and render the SAME gated action affordance pattern used by
  the cockpit's agent action panel — i.e. an action button that opens `PermissionGate`, and only
  on confirm calls `sendCommand({type, target})`. NO new `CommandType`, NO new endpoint.
- Pending/disabled state derived from `getCommandStatus` (already wired in App). Use a small pure
  helper if any decision logic emerges (e.g. `canDispatch(agent)` → not already-pending), unit-tested.
- Keep actions OUT of the canvas; they live in the React panel chrome (no per-frame concern).

**Files:** `src/components/hero/SwarmHero.tsx` (panel actions), `src/App.tsx` (pass `onCommand`/status),
`src/lib/swarmGraph.ts` (+ test) only if a pure decision helper is added.

**Fire (CLAUDE.md):** `sp-writing-plans` → `frontend-design` (action affordance in the panel) →
`emil-design-eng` (button press/confirm motion) → `impeccable` (`polish`) → `kw-design-accessibility-review`
→ `sp-test-driven-development` → `webapp-testing` (gate blocks + sends only on confirm, dev + packaged) →
`sp-verification-before-completion`. **Agents:** `react-specialist` (panel actions + gate wiring),
`react-reviewer`, `a11y-architect` (action buttons + gate focus/aria), `ui-ux-tester` + `webapp-testing`,
**`security-reviewer` (BLOCKING before the P2-1 commit)** — confirm: reuses the existing gate, no new
mutation/verb/endpoint, target id validated (`^[a-z0-9_-]{1,64}$`), no privilege beyond cockpit, no
secret/log leak.

---

## Verified anchors (2026-06-23)
- `SwarmHero` props: `{ open, agents, feed=[], onClose, openAgentId, onSelectAgent, renderChat }`.
- `src/lib/swarmGraph.ts` helpers: `statusStyle`, `packetsFromFeed`, `hitTest`, `recentComms`,
  `selectPacketLabels`, `focusDim` — extend here; tests in `__tests__/swarmGraph.test.ts` (61 green).
- Canvas build: `nodes` (with `kind`, `agentId`, `dim`), `edges: [number,number][]`, `agentIdx`,
  `byKey`; draws under `ctx.translate(ox, oy)`; solid per-frame clear; `KCOL` dark palette.
- Commands: `CommandType = "ack" | "respawn" | "task"` (`types.ts`); `CommandRequest {type, target,...}`;
  `App`: `sendCommand`, `getCommandStatus` from `useAgentState`; `AgentState.acknowledged` /
  `AgentState.respawnRequested` flip on poll; gating via `PermissionGate`.
- App wires SwarmHero: `openAgentId={heroAgentId} onSelectAgent={setHeroAgentId} renderChat={renderHeroChat}`.

## Verification (each phase)
1. `npm run test:unit` — new pure-helper tests green + existing 61 unaffected.
2. `cd agent-runtime && npm test` — still 297.
3. `npm run typecheck` + `npm run build` exit 0; `npm run electron:build` for the packaged check.
4. `webapp-testing` interaction in dev AND packaged; P2-1: prove the gate blocks and only sends on confirm.
5. Screenshot: P2-2 weighted edges; P2-3 the dock + expand; P2-1 the gate + action.

## Self-review (before "done")
- Every P2 acceptance line maps to a test or a verified interaction. ✔
- Pure logic (edgeWeights / any decision helper) unit-tested; canvas/React only renders. ✔
- No per-frame React render (refs); 60fps held. ✔
- P2-1 reuses the existing gated command path; `security-reviewer` PASS before commit. ✔
- No P0/P1 regression; dark/no-pink/reduced-motion preserved. ✔

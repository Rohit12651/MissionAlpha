# Agent Command Tower — Build Plan (Phased)

> Status: **PLAN ONLY — awaiting USER GO.** No dev until Rohit says go.
> Owner: CEO agent (strategic) → senior-web (impl) once approved.
> Decided: Option 2 (Vite app in repo, port 3004), architected with a swappable data seam for future Option 3 (live SSE/global). Dark + light toggle. State-view ↔ Pipeline-view toggle. 2D + 3D motion graphics.

---

## 0. North Star

A live, glanceable **command tower** for the 16-agent Waahyu swarm. Rohit opens one screen → instantly sees who's working, who's blocked, who's stale, what agents are saying to each other, and the heartbeat pulse of the whole org. Looks like Tesla/Apple/Claude — not a generic SaaS kanban. Always-on wall display grade.

First-principles (Tesla-CEO framing):
- **The expensive part is the craft + the data seam, not the backend.** Build those right; bolt the server on later.
- **No wasted motion.** Every UI component reads one typed `AgentState` model. Swap the data source (poll → SSE) without touching a single view.
- **Reversible by design.** Option 2 → Option 3 is a one-file adapter swap, not a rewrite.

---

## 1. Architecture (the seam that makes it global-ready)

```
agent-status/*.md  ──(scheduler tick, ~50s)──►  agent-status/state.json
                                                        │
                                          ┌─────────────┴──────────────┐
                                          │   DataSource interface     │   ◄── the seam
                                          ├────────────────────────────┤
                                          │ LocalPollAdapter  (v1 now) │  fetch state.json @2s
                                          │ LiveStreamAdapter (v2 later)│  SSE/WebSocket gateway
                                          └─────────────┬──────────────┘
                                                        │  useAgentState() hook
                                          ┌─────────────┴──────────────┐
                                          │     React UI (port 3004)    │
                                          │  CEO bar · Kanban · Feed ·  │
                                          │  Heartbeat · 3D pulse globe │
                                          └─────────────────────────────┘
```

**Data contract — `agent-status/state.json`** (scheduler emits each tick):
```json
{
  "generatedAt": "2026-06-02T06:02:01Z",
  "scheduler": { "running": true, "cadenceSec": 50, "lastTick": "...", "activeCount": 4, "staleCount": 0 },
  "agents": [
    { "id": "ceo", "role": "Chief Executive", "tier": "supreme",
      "state": "MONITORING", "task": "q3-quickcommerce-memo", "file": "docs/ceo/...",
      "blockedBy": null, "heartbeatAt": "...", "ageSec": 12, "ttlSec": 45, "stale": false,
      "pipelineStage": "strategy", "inboxCount": 1 }
    /* ...16 agents... */
  ],
  "feed": [ { "ts":"...", "from":"ceo", "to":"architect", "topic":"strategy-approved", "body":"..." } ],
  "heartbeats": [ { "ts":"...", "agent":"ceo", "state":"MONITORING" } ]
}
```

UI NEVER reads markdown. Only `state.json`. That single decoupling = global-ready.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | React 19 + Vite 5 + TypeScript | matches repo toolchain (apps/admin-dashboard) — zero new learning |
| Styling | Tailwind 3 + CSS vars (OKLCH tokens) | dark/light via `data-theme`, design tokens from `apps/shared` where useful |
| 2D motion | **Framer Motion** (`motion`) | spring cards, layout animations, enter/exit, drag-free reorder on state change |
| 3D motion | **Three.js + react-three-fiber + drei** | hero "pulse globe" / particle field reacting to swarm activity |
| Micro-motion | CSS + `emil-design-eng` rules | ≤300ms, ease-out enter, spring on activity, reduced-motion respected |
| Charts | recharts (already in repo) | heartbeat sparkline, throughput timeline |
| Icons | lucide-react (already in repo) | consistent line icons |
| Data poll | native `fetch` + `setInterval(2s)` behind adapter | zero deps, swap to SSE later |

New deps to add (v1): `framer-motion`, `three`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing` (bloom/glow). Optional: `maath` (particle math), `leva` (dev-only tuning). Everything else already in repo (React 19, Vite 5, Tailwind 3, recharts, lucide).

---

## 3. Aesthetic — Dark + Light toggle (Tesla ↔ Apple)

Driven by skills: `impeccable craft` + `soft-skill` (high-end-visual-design: expensive feel, whitespace, spring motion) + `emil-design-eng` (motion) + `hallmark` (anti-AI-slop, structural variety) + `theme-factory` (token system) + `frontend-design`.

**Dark (default — Tesla cinematic):**
- bg near-black `oklch(0.15 0.01 270)`, layered panels, subtle grain
- electric accents: active=cyan `oklch(0.8 0.15 200)`, blocked=amber, stale=red pulse, done=green
- glassmorphism cards, soft inner glow on active agents
- big whitespace, glanceable from across a room

**Light (Apple premium):**
- off-white `oklch(0.98 0.005 90)`, soft shadows, restrained color
- SF-style type scale, calm, daylight-readable
- same layout, lighter material

Toggle = `data-theme` attr flip + CSS var swap. Persist in localStorage. Smooth 300ms crossfade.

---

## 4. Motion Graphics Plan (2D + 3D) — NO NEGOTIATION, must look modern

Motion is the differentiator vs a static kanban. Governed by `emil-design-eng` + `impeccable animate`.

### 4.1 3D layer (hero — Three.js + react-three-fiber + drei)
- **Swarm Core / Pulse Globe** behind CEO bar: slowly-rotating 3D node constellation, one node per agent (16 nodes).
  - Node **brightness/size** = activity (IN_PROGRESS bright, IDLE dim, OFFLINE dark).
  - **Edges light up** + animate a traveling pulse when two agents talk (SYNC_LOG `FROM→TO` event).
  - **Stale node** flickers red; **CEO node** larger, gold, center.
  - Whole field **"breathes"** (subtle scale pulse) on each scheduler tick.
  - Background: slow drifting **particle field** / starfield (Tesla cinematic depth).
  - Tech: instanced points/lines (GPU-cheap), bloom post-processing (drei `EffectComposer` + `Bloom`), capped particle count, lazy-loaded, `prefers-reduced-motion` → static glowing snapshot.
- **Optional shader flourish:** subtle animated gradient mesh / noise shader backdrop (react-three `shaderMaterial`) for the "expensive" Tesla feel.

### 4.2 2D layer (Framer Motion)
- Cards **spring** into columns; **`layout` animation** glides a card to its new column when an agent changes state (the signature moment — watch work flow across the board live).
- **Activity ripple** + soft glow pulse on a card the instant its heartbeat updates.
- **Stale card:** slow red **breathing** glow (opacity+shadow loop).
- **TTL ring:** circular progress around avatar depleting toward next-expected-heartbeat, refills on beat.
- **Live feed:** messages **slide+fade** in from bottom, newest top, with a typing-dot shimmer on arrival.
- **Heartbeat timeline:** animated **sweep line** (recharts area + motion path draw), tick markers pulse.
- **CEO bar:** on `AWAITING_USER_DECISION` → soft **pulsing halo** + gentle shake-to-attention; capability-gap chip **bounces** once on new gap.
- **Number counters:** active/stale counts **count-up** animate (spring) on change.
- **Theme toggle:** 300ms crossfade + sun/moon **morph** icon.
- **Page enter:** staggered card cascade (50ms stagger, ease-out).

### 4.3 Micro-interaction rules (emil-design-eng — enforced)
- UI animations ≤300ms · card press 100–160ms · enter ease-out · on-screen movement ease-in-out · NEVER ease-in on UI.
- Start from `scale(0.96)+opacity:0`, never `scale(0)`.
- Only animate `transform` + `opacity` (GPU). No layout/paint thrash.
- `transform-origin` from trigger for popovers/drawers.
- `prefers-reduced-motion` → all motion → instant/crossfade fallback. Mandatory.

### 4.4 Optional asset-gen (if we want pre-rendered flourishes)
- `mcp__387fa149-...` (Adobe Express MCP) — generate hero gradient textures, glow sprites, vectorize agent role icons.
- `algorithmic-art` / `canvas-design` skills — generative backdrop textures (flow field, particle export) baked as static assets for perf.
- `slack-gif-creator` — (not core) animated status GIFs if ever needed.

---

## 5. Layout (both views, toggle)

```
┌─ CEO COMMAND BAR ─────────────────────────────────────────────┐
│ [CEO avatar] state · current initiative · ⚠ awaiting-you badge │  3D pulse globe behind
│ capability-gaps chip · scheduler health (green/red)            │
├───────────────────────────────────────────────────────────────┤
│  [ View: ◉ State  ○ Pipeline ]        [ ☀/🌙 theme ]           │
├─ KANBAN ──────────────────────────────────────────────────────┤
│  STATE VIEW: IDLE│IN_PROGRESS│BLOCKED│REVIEW│TESTS│DONE│OFFLINE │
│  PIPELINE VIEW: Strategy│Design+Arch│Build│QA│Review│Deploy│Mem │
│  cards: name · role · task · file · live-age · TTL ring · inbox │
├─ LIVE FEED ───────────────────────┬─ HEARTBEAT / THROUGHPUT ───┤
│  SYNC_LOG stream (who→who, topic)  │  pulse timeline + sparkline │
│  filter by agent                   │  scheduler tick markers     │
└────────────────────────────────────┴────────────────────────────┘
```

Card click → drawer: full status, INBOX messages, recent heartbeats, blocked-chain.

---

## 6. Phases (exit criteria each — no phase starts till prior green)

### Phase 0 — Scheduler emits JSON ✅ DONE
- `scripts/emit_state.py` (stdlib-only) parses BROADCAST + SYNC_LOG + HEARTBEAT + SCHEDULER → writes `agent-status/state.json` atomically. Wired into `agent-scheduler.sh` tick().
- Adds: role/tier/pipelineStage metadata per agent, state→column map, counts, feed, heartbeats, scheduler health, ageSec + stale flags.
- **Exit MET:** valid JSON, 16 agents, updates each tick, live-activity test passed (3 active agents → correct columns/blockedBy/feed), atomic tmp+rename. Schema matches §1.

### Phase 1 — Scaffold app + data seam ✅ DONE (senior-web-1)
- `apps/agent-dashboard/` Vite5+React19+TS(strict)+Tailwind3, port 3004.
- `DataSource` seam interface + `LocalPollAdapter` (poll `/api/state.json` @2s) + `useAgentState()` hook + typed model (types.ts matches live emitter incl. `dead`/`column`/`pipelineStage`).
- vite.config.ts `serveAgentState()` middleware serves state.json at `/api/state.json` (no file:// CORS).
- Deps installed clean (241 pkgs, no version relaxations): framer-motion, three, @react-three/fiber v9, drei v10, postprocessing v3, recharts, lucide.
- App.tsx = styled dark shell: header + live generatedAt clock + scheduler dot, 6 stat tiles, 16-agent list w/ age.
- **Exit MET (independently verified):** tsc clean exit 0, dev boots VITE 5.4.21, `/api/state.json` serves live (16 agents), index HTTP 200.

### Phase 2 — Kanban core (2D motion)
- State-view + Pipeline-view toggle. Agent cards. Framer layout animation on state change. Live-ticking age. TTL ring. Stale red-breathing.
- **Exit:** all 16 agents render in correct columns; card glides on state change; stale flashes; both views toggle.

### Phase 3 — CEO bar + live feed + heartbeat
- CEO command bar w/ awaiting-you halo + capability-gaps chip + scheduler health dot.
- SYNC_LOG feed (slide+fade, filter). Heartbeat timeline (recharts + motion sweep).
- **Exit:** feed streams new SYNC lines; CEO halo pulses on AWAITING_USER_DECISION; timeline live.

### Phase 4 — 3D pulse globe + theme system
- react-three-fiber node cluster, activity brightness, edge-light on talk, tick-breathe, reduced-motion fallback.
- Dark/light toggle, OKLCH tokens, localStorage persist, 300ms crossfade.
- **Exit:** globe reacts to live data; theme toggle smooth; reduced-motion static path works.

### Phase 5 — Polish + harden (skills pass)
- `impeccable audit` + `impeccable polish` + `hallmark audit` (P/H/E/S/R/V score).
- `emil-design-eng` motion review. `accessibility-tester` WCAG 2.2 AA. `webapp-testing` / playwright smoke at 3004.
- Empty/loading/error states. Mobile 375/768 responsive. Perf: 60fps, globe GPU-budgeted.
- **Exit:** a11y AA pass; 60fps; no AI-slop; screenshots dark+light both views.

### Phase 6 (FUTURE — your "go global" trigger, NOT now)
- Gateway (FastAPI/Node) + SSE push → `LiveStreamAdapter` (swap 1 file). Auth. Multi-swarm registry. Hosted on GCP Cloud Run. Shareable read-only links.
- **Exit:** remote browser sees live swarm w/o local files. (Separate GO.)

---

## 7. File tree (v1)

```
apps/agent-dashboard/
├── package.json            (port 3004)
├── vite.config.ts
├── tailwind.config.ts
├── index.html
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── data/
    │   ├── types.ts            (AgentState, FeedEvent, SchedulerHealth)
    │   ├── DataSource.ts       (interface — the seam)
    │   ├── LocalPollAdapter.ts (v1)
    │   └── useAgentState.ts    (hook)
    ├── theme/
    │   ├── tokens.css          (OKLCH dark+light vars)
    │   └── ThemeToggle.tsx
    ├── components/
    │   ├── CeoCommandBar.tsx
    │   ├── KanbanBoard.tsx
    │   ├── AgentCard.tsx
    │   ├── ViewToggle.tsx
    │   ├── LiveFeed.tsx
    │   ├── HeartbeatTimeline.tsx
    │   ├── PulseGlobe.tsx       (three / r3f)
    │   └── AgentDrawer.tsx
    └── lib/
        ├── time.ts             (live age ticking)
        └── stateMap.ts         (state→column, state→color, →pipelineStage)
```

---

## 8. Skills — full map from global CLAUDE.md (NO NEGOTIATION on design quality)

Design mandate locked: must look modern + attractive = Apple.com / Tesla.com / Claude-app grade. Every skill below fires automatically per CLAUDE.md trigger rules.

### 8.1 Design + frontend skills (PRIMARY — fire every UI phase)
| Skill | Source | Use |
|---|---|---|
| `impeccable` (craft/shape/audit/polish/bolder/quieter/distill/delight/clarify/colorize/typeset/layout/animate/adapt/optimize/live) | impeccable | PRIMARY design engine — overrides generic frontend-design. `craft` to build, `animate` for motion, `polish`+`audit` to finish |
| `hallmark` (+ `hallmark audit`) | hallmark | anti-AI-slop, structural variety, P/H/E/S/R/V self-score — so it's NOT a generic SaaS kanban |
| `soft-skill` (high-end-visual-design) | taste-skill | premium "expensive feel, whitespace, spring motion" = exact Apple/Tesla calm |
| `taste-skill` (design-taste-frontend) | taste-skill | anti-slop landing/dashboard base; dial DESIGN_VARIANCE high, MOTION_INTENSITY high |
| `emil-design-eng` | emil-design-eng | MOTION authority — easing, spring, ≤300ms, ease-out enter, transform-origin, reduced-motion, GPU-only props |
| `frontend-design` | anthropic | base React/component scaffolding (impeccable overrides for aesthetic) |
| `web-artifacts-builder` | anthropic | complex multi-component React+Tailwind build |
| `theme-factory` | anthropic | dark+light token system, OKLCH palette generation |
| `brand-guidelines` + `brandkit` | anthropic/taste | consistent identity across the board |
| `acs-artifacts-builder` | awesome-claude-skills | complex HTML artifact / shadcn+Tailwind components |
| `design-bridge` | voltagent | Figma → code token + handoff bridge (if we design in Figma MCP first) |

### 8.2 Specialist subagents (VoltAgent — fire via Agent tool)
| Subagent | Use |
|---|---|
| `react-specialist` | React 19 perf, hooks, state, memoization for live-polling board |
| `typescript-pro` | strict types, AgentState model, adapter generics |
| `frontend-developer` | component implementation |
| `ui-designer` | visual design system, component library |
| `ui-ux-tester` | interaction + flow testing |
| `accessibility-tester` | WCAG 2.2 AA — focus order, contrast, reduced-motion |
| `performance-engineer` | 60fps, Three.js GPU budget, bundle size |
| `websocket-engineer` | (Phase 6 only) SSE/WS gateway for global |

### 8.3 Quality + verification skills (Phase 5 gate)
| Skill | Use |
|---|---|
| `webapp-testing` (anthropic) | browser-verify the board at port 3004 BEFORE claiming done |
| `playwright` + `mcp__playwright__*` | E2E: theme toggle, view toggle, live update, card transitions |
| `ai-writing-auditor` | strip AI-slop from any UI copy/labels |
| `content-quality-editor` | final copy pass |
| `silent-failure-hunter` | no swallowed fetch/poll errors |
| gstack `design-review` | AI-slop check + design critique |
| gstack `design-shotgun` | if a section looks bland → explore variants |
| gstack `benchmark` | page speed / web vitals / bundle |

### 8.4 Superpowers pipeline (methodology — fire in order)
`sp-using-superpowers` → `sp-brainstorming` (visual directions) → `sp-writing-plans` (this doc) → `sp-executing-plans` → `sp-test-driven-development` (component tests) → `sp-verification-before-completion` (before each phase exit).

### 8.5 Knowledge-work skills (support)
`kw-design-design-system`, `kw-design-accessibility-review`, `kw-design-design-handoff`, `kw-design-ux-copy`, `kw-design-design-critique`.

### 8.6 Per-phase firing order
LOCKED 4-skill design stack (`impeccable` + `soft-skill` + `emil-design-eng` + `hallmark`) fires on EVERY UI phase (2–5). Magic MCP fires on every component build (1–4).
| Phase | Skills + MCP fired |
|---|---|
| 0 | (bash only — scheduler JSON) |
| 1 | sp-using-superpowers, frontend-design, web-artifacts-builder, react-specialist, typescript-pro, theme-factory (token scaffold). MCP: context7 |
| 2 | **magic** (inspiration→builder→refiner) + **impeccable craft + soft-skill + emil-design-eng + hallmark** + react-specialist, sp-test-driven-development |
| 3 | **magic** + **impeccable craft + soft-skill + emil-design-eng + hallmark** + frontend-design |
| 4 | **magic** + **impeccable animate + soft-skill + emil-design-eng + hallmark** + theme-factory, brand-guidelines, performance-engineer (3D budget). MCP: context7 (three/r3f) |
| 5 | **impeccable audit + polish + hallmark audit** + ai-writing-auditor, accessibility-tester, webapp-testing, playwright, gstack design-review + benchmark, sp-verification-before-completion |

MCP: `mcp__upstash-context7__*` for Framer Motion / Three.js / r3f / drei / Tailwind current docs BEFORE coding (fast-moving libs).

---

## 8.7 Component sourcing — 21st.dev Magic MCP (CHOSEN) + design-skill stack (LOCKED)

**Decision: Magic MCP is the component engine.** Installed user-scope, `claude mcp list` → `magic ✓ Connected`. Tools: `21st_magic_component_builder`, `21st_magic_component_inspiration`, `21st_magic_component_refiner`, `logo_search`. (CLAUDE.md updated with 21st-dev-magic section + auto-invoke rules.)

> **SESSION NOTE:** Magic MCP installed mid-session → its tools load only on NEXT session start. Restart Claude Code before Phase 1 build so `mcp__magic__*` tools are reachable (load via ToolSearch). Phase 0 (scheduler JSON) needs no MCP and can run regardless.

### Component pipeline (every UI component)
```
1. 21st_magic_component_inspiration   → pull proven modern patterns (cards, bento, glowing borders, particle bg)
2. 21st_magic_component_builder       → generate base component from description
3. impeccable craft + soft-skill      → elevate to Apple/Tesla premium (whitespace, OKLCH, material)
4. emil-design-eng                    → motion pass (spring, ease-out, ≤300ms, reduced-motion)
5. hallmark audit                     → anti-AI-slop, structural variety, P/H/E/S/R/V score
6. 21st_magic_component_refiner       → final refinement pass on the assembled component
7. wire to useAgentState() live data
8. logo_search                        → any brand/role iconography needed
```

### Design-skill stack — LOCKED (NO NEGOTIATION, per USER)
Every UI component passes ALL FOUR before it ships:
1. **`impeccable`** (craft → build, animate → motion, audit + polish → finish) — PRIMARY aesthetic engine
2. **`soft-skill`** (high-end-visual-design) — premium expensive feel, whitespace, spring
3. **`emil-design-eng`** — motion + easing + interaction craft
4. **`hallmark`** (+ `hallmark audit`) — anti-AI-slop, structural variety so it never reads as generic

Magic MCP generates the raw component → the four skills make it Apple/Tesla/Claude grade. Magic = speed, skills = taste. Both mandatory.

### Backup MCPs (available, supporting)
| MCP | Use |
|---|---|
| **Figma** (`use_figma`, `generate_figma_design`) | design-system + code-connect if we want Figma-truth source |
| **Adobe Express** (`mcp__387fa149...`) | hero gradient textures, glow sprites, vectorize role icons, `font_recommend` |
| **Vercel** | Phase 6 hosting |

## 9. Risks + mitigations

| Risk | Mitigation |
|---|---|
| `file://` CORS blocks fetch(state.json) | dev via vite proxy or symlink state.json into public/; or tiny `python3 -m http.server` |
| 3D globe tanks perf on weak GPU | instanced points, capped particle count, reduced-motion static fallback, lazy-load globe |
| state.json write race w/ read | scheduler writes atomically (tmp+rename); UI tolerates 1 stale poll |
| scope creep into Phase 6 early | hard gate — Phase 6 needs separate USER GO |
| theme/motion = AI-slop generic look | hallmark audit mandatory in Phase 5; structural variety enforced |

---

## 10. Estimate

| Phase | Rough effort |
|---|---|
| 0 scheduler JSON | XS |
| 1 scaffold+seam | S |
| 2 kanban 2D | M |
| 3 ceo+feed+heartbeat | M |
| 4 3D globe+theme | M |
| 5 polish+harden | S–M |

v1 = Phases 0–5. Phase 6 deferred to your global GO.

---

## DECISION GATE

Rohit: **GO** on Phases 0–5? Or adjust scope/aesthetic/motion first?
On GO → I start Phase 0 (scheduler JSON) → Phase 1 scaffold → build up phase-by-phase, each gated.

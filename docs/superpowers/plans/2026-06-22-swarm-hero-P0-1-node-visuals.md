# SwarmHero P0-1 — Status-Driven Node Visuals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **BOSS DIRECTIVE (overrides TDD default):** Do **NOT** run any `git commit` step until the boss
> explicitly approves. Each "Commit" step below is written for completeness but is **GATED** — stage
> only (`git add`), then pause. The boss commits.

**Goal:** Make each SwarmHero agent node *look* different by live status (in_progress / blocked /
stale / idle), so an operator can read the swarm's state in <2s without text — while preserving the
dark, glowing, no-pink publicity look.

**Architecture:** Add a pure, React-free helper `statusStyle(agent)` in `src/lib/swarmGraph.ts`
(unit-tested) that maps an agent's `column` + `stale` + `heartbeatAt` to numeric visual modifiers
(alpha / glow / pulse / ring / desaturate). Wire it into the existing canvas draw loop via a
`statusRef` (a `Map<agentId, StatusStyle>`) recomputed on the `agents` prop only — the rAF loop reads
the ref each frame, so status updates live each poll **without per-frame React renders**.

**Tech Stack:** React 18 + TypeScript, HTML5 Canvas 2D, Node test runner (`node --test`, native TS
strip on Node 25), Vite.

---

## Why a pure helper

The PRD ("Verified Code Anchors") mandates the visual contract live in a pure, unit-testable helper
(`statusStyle`) so the status→appearance mapping is provable without rendering a canvas. The canvas
wiring carries no logic worth unit-testing (it's draw calls) — it is verified by typecheck + build +
a visual screenshot. All behavioral assertions land on `statusStyle`.

## Visual contract (owned by `principal-ux-design`, tuned per `emil-design-eng`)

`StatusStyle` = `{ alpha, glow, pulse, ring, desaturate }`:

| field | meaning | applied in canvas |
|---|---|---|
| `alpha` | overall opacity multiplier (faint/dim) | `ctx.globalAlpha *= alpha` on node fill + glow |
| `glow` | shadowBlur multiplier vs base | `ctx.shadowBlur = r*2*glow` |
| `pulse` | radius pulse amplitude (0 = calm) | `r * (1 + pulse*sin(...))` |
| `ring` | stroke color or `null` | blocked → draw `#e24b4a` ring around node |
| `desaturate` | stale → blend toward muted | fill blends node color toward `#6b7280` |

Status → style mapping (precedence: `blocked` owns the ring; `stale` dims/desaturates on top):

| column | heartbeat | alpha | glow | pulse | ring | desaturate |
|---|---|---|---|---|---|---|
| `in_progress` | — | 1.0 | 1.4 | 0.18 | null | no |
| `blocked` | — | 1.0 | 1.2 | 0.10 | `#e24b4a` | no |
| `idle` | none (`null`) | 0.30 | 0.40 | 0 | null | no |
| `idle` | present | 0.70 | 0.90 | 0.04 | null | no |
| `review` / `done` | — | 0.85 | 1.0 | 0.05 | null | no |
| else (`awaiting_user`/`offline`/…) | — | 0.70 | 0.85 | 0.04 | null | no |

Then if `stale === true`: `alpha *= 0.5`, `glow *= 0.6`, `pulse = 0`, `desaturate = true`
(blocked keeps its red ring but the fill still dims — a blocked **and** stale agent reads as a dim
node with a red ring).

No pink anywhere. Glow preserved (shadowBlur retained, only scaled).

---

## File Structure

- **Create** `src/lib/swarmGraph.ts` — pure helpers for the swarm graph. P0-1 adds `statusStyle` +
  the `StatusStyle` type. (P0-2 will add `packetsFromFeed`; P0-3 will add `hitTest` — same file.)
- **Create** `src/lib/__tests__/swarmGraph.test.ts` — `node:test` unit tests for `statusStyle`.
- **Modify** `src/components/hero/SwarmHero.tsx` — import `statusStyle`, carry `agentId` on agent
  nodes, add `statusRef` synced on `agents`, apply the style in the node-draw loop.

---

### Task 1: Pure helper `statusStyle` + unit tests

**Files:**
- Create: `src/lib/swarmGraph.ts`
- Test: `src/lib/__tests__/swarmGraph.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/swarmGraph.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusStyle } from "../swarmGraph.ts";
import type { AgentState } from "../../data/types.ts";

// minimal agent factory — only the fields statusStyle reads
function ag(p: Partial<AgentState>): Pick<AgentState, "column" | "stale" | "heartbeatAt"> {
  return { column: "idle", stale: false, heartbeatAt: "2026-06-22T00:00:00.000Z", ...p };
}

test("in_progress → bright pulse, full alpha, strong glow, no ring", () => {
  const s = statusStyle(ag({ column: "in_progress" }));
  assert.equal(s.alpha, 1);
  assert.ok(s.glow >= 1.3, "glow boosted");
  assert.ok(s.pulse >= 0.15, "visible pulse");
  assert.equal(s.ring, null);
  assert.equal(s.desaturate, false);
});

test("blocked → red ring #e24b4a", () => {
  const s = statusStyle(ag({ column: "blocked" }));
  assert.equal(s.ring, "#e24b4a");
});

test("stale → dim + desaturated, pulse killed", () => {
  const base = statusStyle(ag({ column: "in_progress", stale: false }));
  const s = statusStyle(ag({ column: "in_progress", stale: true }));
  assert.ok(s.alpha < base.alpha, "dimmer than non-stale");
  assert.equal(s.pulse, 0, "no pulse when stale");
  assert.equal(s.desaturate, true);
});

test("idle with no heartbeat → faint", () => {
  const s = statusStyle(ag({ column: "idle", heartbeatAt: null }));
  assert.ok(s.alpha <= 0.35, "faint");
  assert.equal(s.ring, null);
});

test("idle with heartbeat is brighter than idle without", () => {
  const live = statusStyle(ag({ column: "idle", heartbeatAt: "2026-06-22T00:00:00.000Z" }));
  const cold = statusStyle(ag({ column: "idle", heartbeatAt: null }));
  assert.ok(live.alpha > cold.alpha);
});

test("blocked AND stale → keeps red ring but dims fill", () => {
  const s = statusStyle(ag({ column: "blocked", stale: true }));
  assert.equal(s.ring, "#e24b4a", "ring survives staleness");
  assert.ok(s.alpha < 1, "fill dimmed");
});

test("no status maps to a pink hue (ring is only red or null)", () => {
  for (const column of ["idle", "in_progress", "blocked", "review", "done", "awaiting_user", "offline"] as const) {
    const s = statusStyle(ag({ column }));
    assert.ok(s.ring === null || s.ring === "#e24b4a", `ring for ${column} is red-or-null`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npx --no-install node --test src/lib/__tests__/swarmGraph.test.ts`
(or `npm run test:unit`)
Expected: FAIL — `Cannot find module '../swarmGraph.ts'` / `statusStyle is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/swarmGraph.ts`:

```ts
// Pure, React-free helpers for the SwarmHero graph (unit-tested in __tests__/swarmGraph.test.ts).
// No DOM, no canvas, no React — just data → visual contract.
import type { AgentState } from "../data/types";

/** Visual modifiers a canvas applies to one agent node, derived from live status. */
export interface StatusStyle {
  /** overall opacity multiplier for the node fill + glow (1 = full). */
  alpha: number;
  /** shadowBlur multiplier vs the node's base glow (1 = normal). */
  glow: number;
  /** radius pulse amplitude (0 = calm, larger = more "alive"). */
  pulse: number;
  /** ring stroke color, or null for none. Blocked agents get "#e24b4a". */
  ring: string | null;
  /** stale agents render desaturated (canvas blends fill toward muted gray). */
  desaturate: boolean;
}

const BLOCKED_RING = "#e24b4a";

/**
 * Map an agent's live status to its node appearance. Pure: same input → same output.
 * Precedence: column sets the base; `blocked` owns the red ring; `stale` dims + desaturates on top.
 */
export function statusStyle(
  agent: Pick<AgentState, "column" | "stale" | "heartbeatAt">,
): StatusStyle {
  const blocked = agent.column === "blocked";
  let alpha: number;
  let glow: number;
  let pulse: number;

  switch (agent.column) {
    case "in_progress":
      alpha = 1; glow = 1.4; pulse = 0.18; break;
    case "blocked":
      alpha = 1; glow = 1.2; pulse = 0.10; break;
    case "idle":
      if (agent.heartbeatAt) { alpha = 0.7; glow = 0.9; pulse = 0.04; }
      else { alpha = 0.3; glow = 0.4; pulse = 0; }
      break;
    case "review":
    case "done":
      alpha = 0.85; glow = 1.0; pulse = 0.05; break;
    default: // awaiting_user, offline, any future column
      alpha = 0.7; glow = 0.85; pulse = 0.04; break;
  }

  let desaturate = false;
  if (agent.stale) {
    alpha *= 0.5;
    glow *= 0.6;
    pulse = 0;
    desaturate = true;
  }

  return { alpha, glow, pulse, ring: blocked ? BLOCKED_RING : null, desaturate };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run test:unit`
Expected: PASS — all `swarmGraph.test.ts` cases green; the pre-existing 4 lib test files still pass.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit (GATED — stage only, do NOT commit until boss approves)**

```bash
git add src/lib/swarmGraph.ts src/lib/__tests__/swarmGraph.test.ts
# git commit -m "feat(swarm): add statusStyle pure helper for status-driven node visuals"  # ← run ONLY after boss approval
```

---

### Task 2: Wire `statusStyle` into the SwarmHero canvas

**Files:**
- Modify: `src/components/hero/SwarmHero.tsx`

No new unit test (canvas draw = no testable logic; the logic is in `statusStyle`, already covered).
Verified by typecheck + build + visual screenshot.

- [ ] **Step 1: Import the helper and its type**

At top of `SwarmHero.tsx`, change the React import to add `useRef` (already imported) and add:

```ts
import { statusStyle, type StatusStyle } from "../../lib/swarmGraph";
```

- [ ] **Step 2: Carry `agentId` on agent nodes**

In the `N` type (around line 90) add an optional `agentId`:

```ts
type N = { id: string; kind: Kind; r: number; col: string; x: number; y: number; vx: number; vy: number; agentId?: string };
```

The `add(...)` helper pushes nodes without `agentId` (artifacts). After `const i = add(a.id, k, r);`
in the agent loop (around line 108), tag the node:

```ts
      const i = add(a.id, k, r);
      nodes[i].agentId = a.id;   // mark agent nodes so the draw loop can look up live status
      agentIdx.set(a.id, i);
```

- [ ] **Step 3: Add a `statusRef` synced on the `agents` prop (no per-frame React render)**

Inside the component body, next to `const cvRef = useRef...` add:

```ts
  const statusRef = useRef<Map<string, StatusStyle>>(new Map());
```

Add a light effect (place it after the existing keydown effect, before the canvas effect):

```ts
  // Sync live status into a ref the rAF loop reads each frame — status flips live on each
  // /api/state.json poll WITHOUT triggering a per-frame React render (PRD real-time guardrail).
  useEffect(() => {
    const m = new Map<string, StatusStyle>();
    for (const a of agents) m.set(a.id, statusStyle(a));
    statusRef.current = m;
  }, [agents]);
```

- [ ] **Step 4: Apply the style in the node-draw loop**

Replace the existing "nodes + bloom" block (lines ~285-294) with:

```ts
      // nodes + bloom — status-driven (P0-1): blocked ring, dim/faint/desaturated, brighter pulse.
      for (const a of nodes) {
        const st = a.agentId ? statusRef.current.get(a.agentId) : undefined;
        const alpha = st ? st.alpha : 1;
        const glowK = st ? st.glow : 1;
        const pulseAmp = st ? st.pulse : (a.kind === "ceo" ? 0.12 : 0.05);
        const speed = a.kind === "ceo" ? 2 : 1.4;
        const pulse = 1 + pulseAmp * Math.sin(t * speed + a.x);
        // desaturated (stale) agents blend their hue toward muted gray
        const fill = st && st.desaturate ? "#6b7280" : a.col;

        ctx.globalAlpha = alpha;
        ctx.shadowBlur = a.r * 2 * glowK;
        ctx.shadowColor = fill;
        ctx.fillStyle = fill;
        ctx.beginPath(); ctx.arc(a.x, a.y, a.r * pulse, 0, 6.2832); ctx.fill();
        ctx.shadowBlur = 0;

        // blocked ring
        if (st && st.ring) {
          ctx.globalAlpha = Math.min(1, alpha + 0.25);
          ctx.strokeStyle = st.ring;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(a.x, a.y, a.r * pulse + 3.5, 0, 6.2832); ctx.stroke();
        }

        // specular highlight
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "rgba(255,255,255,0.82)";
        ctx.beginPath(); ctx.arc(a.x - a.r * 0.3, a.y - a.r * 0.3, a.r * 0.22, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;
```

- [ ] **Step 5: Typecheck**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Build**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run build`
Expected: exit 0 (`tsc && vite build` both succeed).

- [ ] **Step 7: Visual verification (dev)**

Run dev (`npm run dev`, port 3004), open the Swarm view via `webapp-testing`/playwright, screenshot.
Confirm against acceptance: in_progress nodes pulse bright; a blocked agent shows a red `#e24b4a`
ring; stale agents read dim/gray; idle-no-heartbeat nodes are faint; no pink; glow intact.

- [ ] **Step 8: Commit (GATED — stage only, do NOT commit until boss approves)**

```bash
git add src/components/hero/SwarmHero.tsx
# git commit -m "feat(swarm): drive node visuals from live agent status (P0-1)"  # ← ONLY after boss approval
```

---

## Acceptance Criteria (PRD P0-1) → coverage

| Given/When/Then | Covered by |
|---|---|
| `in_progress` → bright pulse | `statusStyle` test + Task 2 draw (pulse 0.18, glow 1.4) |
| `blocked` → red ring `#e24b4a` | `statusStyle` test "blocked → red ring" + Task 2 ring draw |
| `stale: true` → dim/desaturated | `statusStyle` test "stale → dim + desaturated" + Task 2 `#6b7280` blend |
| `idle` + no heartbeat → faint | `statusStyle` test "idle with no heartbeat → faint" + Task 2 alpha |
| dark palette, no pink, glow preserved | `statusStyle` no-pink test + Task 2 keeps `shadowBlur`; ring is red-only |

## Verification before completion (run before claiming P0-1 done)

1. `npm run test:unit` — `swarmGraph.test.ts` green; pre-existing lib tests unaffected.
2. `cd agent-runtime && npm test` — still 297 pass (renderer-only change, must be untouched).
3. `npm run typecheck` — exit 0.
4. `npm run build` — exit 0.
5. Visual screenshot proving the 5 acceptance rows above.

## Self-Review

- **Spec coverage:** every P0-1 Given/When/Then maps to a test or a draw step (table above). ✔
- **Placeholders:** none — all code is concrete. ✔
- **Type consistency:** `StatusStyle` shape identical in helper, test usage, and `SwarmHero` import;
  `statusRef` typed `Map<string, StatusStyle>`; `statusStyle` reads only `column`/`stale`/`heartbeatAt`
  (all present on `AgentState`). ✔
- **Scope:** P0-1 only (visuals + helper). Packets (P0-2), hover (P0-3), panel (P0-4) untouched.
  `swarmGraph.ts` is created here and extended by later phases. ✔

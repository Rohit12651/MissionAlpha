# SwarmHero P0-3 — Hover Tooltip (Parallax-Correct Hit-Test) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.
> **BOSS DIRECTIVE:** Do **NOT** `git commit` until the boss approves. "Commit" steps = stage only.

**Goal:** Hovering an agent node shows a tooltip (`id · role · tier · status · current task`) anchored
at the cursor, with a hit-test that subtracts the canvas parallax offset (ox/oy) so it stays correct
while the graph drifts. Tooltip React state updates only when the hovered node CHANGES (never
per-frame). Cursor becomes a pointer over a node.

**Architecture:** Add pure helper `hitTest(nodes, px, py, ox, oy)` to `src/lib/swarmGraph.ts`
(unit-tested) — maps a cursor point to the agent node under it by subtracting the parallax offset.
In `SwarmHero`, pointer listeners live INSIDE the canvas effect (where `nodes` + `ox`/`oy` are in
scope); an `updateHover()` runs on pointermove AND each rAF frame (so a drifting node under a still
cursor still resolves), but only calls `setHovered` when the agent id changes. The tooltip is React
JSX positioned at the cursor; content comes from the live `agents` prop (status updates live).

**Tech Stack:** React 18 + TS, Canvas 2D, `node --test`, Vite.

---

## File Structure

- **Modify** `src/lib/swarmGraph.ts` — add `HitNode` type + `hitTest`.
- **Modify** `src/lib/__tests__/swarmGraph.test.ts` — add `hitTest` tests.
- **Modify** `src/components/hero/SwarmHero.tsx` — `hovered` state + `hoveredRef`; `updateHover()` in
  the canvas effect; pointer cursor; tooltip JSX.

---

### Task 1: Pure helper `hitTest` + unit tests

**Files:** Modify `src/lib/swarmGraph.ts`, `src/lib/__tests__/swarmGraph.test.ts`

- [ ] **Step 1: Write failing tests** — append to `swarmGraph.test.ts`:

```ts
import { hitTest } from "../swarmGraph.ts";

const HN = [
  { x: 100, y: 100, r: 10, agentId: "a" },
  { x: 300, y: 200, r: 8, agentId: "b" },
  { x: 150, y: 150, r: 6 }, // artifact node — no agentId, not hoverable
];

test("cursor on a node center (no parallax) returns its agentId", () => {
  assert.equal(hitTest(HN, 100, 100, 0, 0), "a");
});

test("cursor far from all nodes returns null", () => {
  assert.equal(hitTest(HN, 500, 500, 0, 0), null);
});

test("hit-test subtracts parallax offset (ox/oy)", () => {
  // node 'a' is drawn at screen (100+ox, 100+oy) = (120, 110); cursor there must still hit 'a'.
  assert.equal(hitTest(HN, 120, 110, 20, 10), "a");
  // without subtracting offset the same screen point would miss:
  assert.equal(hitTest(HN, 120, 110, 0, 0), null);
});

test("artifact nodes (no agentId) are not hoverable", () => {
  assert.equal(hitTest(HN, 150, 150, 0, 0), null);
});

test("just inside radius hits, just outside misses", () => {
  assert.equal(hitTest(HN, 109, 100, 0, 0), "a"); // dist 9 < r 10
  assert.equal(hitTest(HN, 112, 100, 0, 0), null); // dist 12 > r 10
});

test("overlapping nodes return the nearest agent", () => {
  const nodes = [
    { x: 100, y: 100, r: 20, agentId: "big" },
    { x: 105, y: 100, r: 20, agentId: "near" },
  ];
  assert.equal(hitTest(nodes, 104, 100, 0, 0), "near"); // closer to 'near' (dist 1) than 'big' (dist 4)
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && node --test src/lib/__tests__/swarmGraph.test.ts`
Expected: FAIL — `hitTest is not a function`.

- [ ] **Step 3: Implement** — append to `src/lib/swarmGraph.ts`:

```ts
/** Minimal node shape the hit-test needs (canvas-space center + radius + optional agent id). */
export interface HitNode {
  x: number;
  y: number;
  r: number;
  agentId?: string;
}

/**
 * Resolve the agent node under a cursor point. Pure.
 * The canvas draws nodes under `ctx.translate(ox, oy)`, so a node at (x,y) appears on screen at
 * (x+ox, y+oy). To hit-test we map the cursor back into node space by subtracting (ox, oy), then
 * pick the NEAREST agent node (has `agentId`) whose center is within its radius. Artifact nodes
 * (no `agentId`) are never returned. Returns the agent id, or null if none.
 */
export function hitTest(
  nodes: readonly HitNode[],
  px: number,
  py: number,
  ox: number,
  oy: number,
): string | null {
  const cx = px - ox;
  const cy = py - oy;
  let bestId: string | null = null;
  let bestD2 = Infinity;
  for (const n of nodes) {
    if (!n.agentId) continue;
    const dx = cx - n.x;
    const dy = cy - n.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= n.r * n.r && d2 < bestD2) {
      bestD2 = d2;
      bestId = n.agentId;
    }
  }
  return bestId;
}
```

- [ ] **Step 4: GREEN + typecheck**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run test:unit && npm run typecheck`
Expected: all green, exit 0.

- [ ] **Step 5: Commit (GATED — stage only)**

```bash
git add src/lib/swarmGraph.ts src/lib/__tests__/swarmGraph.test.ts
# git commit -m "feat(swarm): hitTest pure helper — parallax-correct node hover (P0-3)"  # after boss approval
```

---

### Task 2: Wire hover tooltip into SwarmHero

**Files:** Modify `src/components/hero/SwarmHero.tsx`

- [ ] **Step 1: Imports**

Extend the swarmGraph import and add agent-meta labels + `useState`:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
```
```ts
import { statusStyle, packetsFromFeed, hitTest, type StatusStyle } from "../../lib/swarmGraph";
import { COLUMN_LABEL, TIER_LABEL } from "../../lib/agentMeta";
```

- [ ] **Step 2: Hover state + ref**

Below `const feedRef = ...` add:

```ts
  const [hovered, setHovered] = useState<{ id: string; x: number; y: number } | null>(null);
  const hoveredRef = useRef<string | null>(null);
```

- [ ] **Step 3: Add `updateHover()` + hit-test on pointermove (inside canvas effect)**

Replace the existing pointer block:

```ts
    let mx = W / 2, my = H / 2, ox = 0, oy = 0;
    const onMove = (e: PointerEvent) => { mx = e.clientX; my = e.clientY; };
    window.addEventListener("pointermove", onMove);
```

with:

```ts
    let mx = W / 2, my = H / 2, ox = 0, oy = 0;
    // Parallax-correct hover: hitTest subtracts (ox, oy) — the same offset the draw applies. Only
    // push React state when the hovered agent CHANGES (never per-frame), per the PRD guardrail.
    const updateHover = () => {
      const hitId = hitTest(nodes, mx, my, ox, oy);
      if (hitId !== hoveredRef.current) {
        hoveredRef.current = hitId;
        cv.style.cursor = hitId ? "pointer" : "default";
        setHovered(hitId ? { id: hitId, x: mx, y: my } : null);
      }
    };
    const onMove = (e: PointerEvent) => { mx = e.clientX; my = e.clientY; updateHover(); };
    window.addEventListener("pointermove", onMove);
```

- [ ] **Step 4: Call `updateHover()` each frame (handles drift under a still cursor + reduced-motion)**

In `tick`, right after the parallax ease line `ox += (tox - ox) * 0.05; oy += (toy - oy) * 0.05;`, add:

```ts
      updateHover(); // node may drift under a stationary cursor — re-resolve each frame (no setState unless changed)
```

- [ ] **Step 5: Reset hover on close/unmount**

In the canvas effect cleanup (the `return () => { ... }`), add a hover reset so a stale tooltip can't
linger after close:

```ts
    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      hoveredRef.current = null; setHovered(null);
    };
```

- [ ] **Step 6: Render the tooltip JSX**

In the returned markup, after the `<canvas .../>` line, add the tooltip. Place it before the title
block. It is `pointer-events-none`, anchored at the cursor, content from the live `agents` prop:

```tsx
      {hovered && (() => {
        const a = agents.find((ag) => ag.id === hovered.id);
        if (!a) return null;
        return (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 max-w-[260px] rounded-lg px-3 py-2 text-[11px] leading-snug shadow-xl"
            style={{
              left: Math.min(hovered.x + 16, (typeof window !== "undefined" ? window.innerWidth : 1920) - 280),
              top: hovered.y + 16,
              background: "rgba(16,18,28,0.92)",
              border: "1px solid rgba(139,108,246,0.35)",
              backdropFilter: "blur(8px)",
              color: "#e7e9f0",
            }}
          >
            <div className="font-semibold" style={{ fontFamily: "ui-monospace, Menlo, monospace", color: "#f3f5f8" }}>{a.id}</div>
            <div className="mt-0.5" style={{ color: "#aab0be" }}>{a.role} · {TIER_LABEL[a.tier]} · {COLUMN_LABEL[a.column]}</div>
            {a.task && a.task !== "-" && (
              <div className="mt-1" style={{ color: "#c9cdd8" }}>{a.task}</div>
            )}
          </div>
        );
      })()}
```

- [ ] **Step 7: Typecheck + build**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 8: Interaction verification (webapp-testing, dev)**

Drive the running app: open hero, move cursor onto a node, assert a `[role="tooltip"]` appears with
that agent's id; move off → tooltip hides; confirm cursor is `pointer` over a node. Screenshot the
tooltip. (Parallax-correctness is proven by the `hitTest` unit test; the live check confirms wiring.)

- [ ] **Step 9: Commit (GATED — stage only)**

```bash
git add src/components/hero/SwarmHero.tsx
# git commit -m "feat(swarm): hover tooltip with parallax-correct hit-test (P0-3)"  # after boss approval
```

---

## Acceptance Criteria (PRD P0-3) → coverage

| Given/When/Then | Covered by |
|---|---|
| cursor within node radius (after subtracting parallax) → tooltip for THAT agent at cursor | `hitTest` parallax test + tooltip JSX at `hovered.x/y` |
| graph drifting/parallax-shifted → hit-test resolves correct node | `hitTest` ox/oy test + per-frame `updateHover()` |
| cursor leaves all nodes → tooltip hides | `updateHover` sets `null` + cleanup reset |
| hovering → cursor becomes pointer | `cv.style.cursor = "pointer"` on hit |
| tooltip React state only on hovered-node CHANGE (never per-frame) | `if (hitId !== hoveredRef.current)` guard |

## Accessibility (kw-design-accessibility-review / a11y-architect)

- Tooltip uses `role="tooltip"`; canvas hover is pointer-only. Keyboard-equivalent path = the cockpit
  roster/board (PRD open question default — document, don't add canvas keyboard focus in v1).
- Verify contrast of tooltip text on its background (target WCAG AA). Respect reduced-motion (no
  motion added beyond a CSS fade; hover still functions via the pointermove path).

## Verification before completion

1. `npm run test:unit` — P0-1/P0-2/P0-3 helper tests green.
2. `cd agent-runtime && npm test` — still 297.
3. `npm run typecheck` + `npm run build` — exit 0.
4. webapp-testing: tooltip appears/hides on hover, correct agent, pointer cursor; screenshot.
5. a11y review pass (contrast + reduced-motion + documented keyboard path).

## Self-Review

- **Spec coverage:** all five P0-3 Given/When/Then mapped. ✔
- **Placeholders:** none. ✔
- **Type consistency:** `hitTest(nodes, px, py, ox, oy): string|null`; `HitNode` matches the canvas
  `N` type (x,y,r,agentId?) so `nodes` passes directly; `hovered` state shape `{id,x,y}` used in JSX. ✔
- **Scope:** P0-3 only (hover). Click→panel is P0-4. Reuses build-once architecture from P0-2. ✔

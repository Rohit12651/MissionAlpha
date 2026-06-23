# SwarmHero P1-2 — Comms Label on Packet (full spec) — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **BOSS DIRECTIVE:** do NOT commit until asked.
> Fire: emil-design-eng (label fade) → impeccable (typeset micro-label) → TDD → verification.
> Agents: react-specialist, react-reviewer, performance-engineer (cap+fps), ui-ux-tester.

**Goal (PRD P1-2):** Each in-flight packet that represents a real `FeedEvent` shows a small mono
label of its `topic` (≤16 chars), fading in/out with the packet. Cursor-near packet's label is
emphasized; far ones stay subtle. Cap ~6 labels at once (nearest-to-cursor) for readability + 60fps.
No labels under `prefers-reduced-motion`.

**Architecture:** Builds on P0-2 (packets already carry `topic`) and the current cursor-near label
(replace it). Add a PURE helper `selectPacketLabels(items, max, nearPx)` that ranks packets by
distance-to-cursor, caps to `max`, truncates topics, and marks the near ones emphasized. The rAF
loop builds `{topic, dist}` per packet, calls the helper, and draws the returned labels with
per-packet fade. Canvas-only render → no React state, no per-frame renders.

**Tech:** React 18 + TS, Canvas 2D, node --test, Vite.

---

### Task 1: pure helper `selectPacketLabels` + tests

**Files:** `src/lib/swarmGraph.ts`, `src/lib/__tests__/swarmGraph.test.ts`

- [ ] **Step 1 — failing tests** (append to swarmGraph.test.ts):
```ts
import { selectPacketLabels } from "../swarmGraph.ts";

test("selectPacketLabels filters empty topics and caps at max, nearest first", () => {
  const items = [
    { topic: "assign", dist: 80 },
    { topic: "", dist: 5 },          // no topic → dropped
    { topic: "review-req", dist: 20 },
    { topic: "blocked", dist: 50 },
  ];
  const r = selectPacketLabels(items, 2);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.index), [2, 3]); // nearest two non-empty (dist 20, 50)
});

test("selectPacketLabels truncates topics to <=16 chars with ellipsis", () => {
  const r = selectPacketLabels([{ topic: "this-is-a-very-long-topic-name", dist: 1 }], 6);
  assert.equal(r[0].label.length, 16);
  assert.ok(r[0].label.endsWith("…"));
});

test("selectPacketLabels short topic is unchanged", () => {
  const r = selectPacketLabels([{ topic: "assign", dist: 1 }], 6);
  assert.equal(r[0].label, "assign");
});

test("selectPacketLabels emphasizes packets within nearPx", () => {
  const r = selectPacketLabels([{ topic: "a", dist: 30 }, { topic: "b", dist: 120 }], 6, 60);
  assert.equal(r.find((x) => x.index === 0)?.emphasized, true);
  assert.equal(r.find((x) => x.index === 1)?.emphasized, false);
});

test("selectPacketLabels returns [] when no topics", () => {
  assert.deepEqual(selectPacketLabels([{ topic: "", dist: 1 }], 6), []);
});
```

- [ ] **Step 2 — run, expect FAIL**:
  `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && node --test src/lib/__tests__/swarmGraph.test.ts`

- [ ] **Step 3 — implement** (append to swarmGraph.ts):
```ts
/** Input row for label selection: a packet's topic + its current distance to the cursor (px). */
export interface PacketLabelInput { topic: string; dist: number; }
/** A chosen label: which input `index` it maps to, the truncated text, and emphasis flag. */
export interface PacketLabel { index: number; label: string; emphasized: boolean; }

/**
 * Pick which in-flight packets get a topic label. Pure.
 * Drops empty topics, ranks by nearest-to-cursor, caps at `max` (readability + 60fps), truncates
 * each topic to <=16 chars (15 + ellipsis), and flags packets within `nearPx` as emphasized.
 */
export function selectPacketLabels(
  items: readonly PacketLabelInput[],
  max = 6,
  nearPx = 60,
): PacketLabel[] {
  return items
    .map((it, index) => ({ index, topic: it.topic, dist: it.dist }))
    .filter((it) => it.topic.length > 0)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max)
    .map((it) => ({
      index: it.index,
      label: it.topic.length > 16 ? it.topic.slice(0, 15) + "…" : it.topic,
      emphasized: it.dist <= nearPx,
    }));
}
```

- [ ] **Step 4 — GREEN + typecheck**: `npm run test:unit && npm run typecheck` (green, exit 0).

- [ ] **Step 5 — commit (GATED — stage only)**: `git add src/lib/swarmGraph.ts src/lib/__tests__/swarmGraph.test.ts`

---

### Task 2: draw fading, capped, emphasized labels in the canvas

**Files:** `src/components/hero/SwarmHero.tsx`

- [ ] **Step 1 — import**: add `selectPacketLabels` to the swarmGraph import.

- [ ] **Step 2 — replace the cursor-near single-label block** (the P1-2 v1 block added earlier inside
  the packet draw loop) — REMOVE that `if (pk.topic) { ... fillText ... }` block. The loop just draws
  the dots. After the packet-draw loop closes (after `ctx.globalAlpha = 1;`), add a labels pass:

```ts
      // P1-2: topic labels — capped, nearest-to-cursor, fading with each packet. None under reduced motion.
      if (!reduce) {
        const cnx = mx - ox, cny = my - oy; // cursor in node space
        const items = packets.map((pk) => {
          const x = pk.a.x + (pk.b.x - pk.a.x) * pk.p;
          const y = pk.a.y + (pk.b.y - pk.a.y) * pk.p;
          return { topic: pk.topic, dist: Math.hypot(x - cnx, y - cny) };
        });
        const labels = selectPacketLabels(items, 6, 60);
        ctx.font = "11px ui-monospace, Menlo, monospace";
        for (const lab of labels) {
          const pk = packets[lab.index];
          const x = pk.a.x + (pk.b.x - pk.a.x) * pk.p;
          const y = pk.a.y + (pk.b.y - pk.a.y) * pk.p;
          const fade = Math.sin(Math.PI * pk.p);          // fade in then out across the packet's life
          ctx.globalAlpha = (lab.emphasized ? 0.95 : 0.5) * fade;
          ctx.fillStyle = lab.emphasized ? "#ffffff" : "#aab0be";
          ctx.font = `${lab.emphasized ? 12 : 11}px ui-monospace, Menlo, monospace`;
          ctx.fillText(lab.label, x + 9, y - 7);
        }
        ctx.globalAlpha = 1;
      }
```

- [ ] **Step 3 — typecheck + build**: `npm run typecheck && npm run build` (exit 0).

- [ ] **Step 4 — visual verify (dev)**: inject a fresh feed event (see demo step) → labels ride real
  packets, fade in/out, nearest-to-cursor brighter/bigger; ≤6 at once; none with reduced motion.

- [ ] **Step 5 — commit (GATED — stage only)**: `git add src/components/hero/SwarmHero.tsx`

---

## Acceptance (PRD P1-2) → coverage

| Given/When/Then | Covered by |
|---|---|
| in-flight packet → mono topic label ≤16 chars, fading with packet | Task 2 draw + `fade=sin(π·p)` + truncate in helper |
| cursor-near packet emphasized; far subtle | helper `emphasized` + brighter/larger draw |
| many packets → ≤6 labels (nearest) | helper `max=6` + sort by dist |
| reduced-motion → no labels | `if (!reduce)` gate |

## Verify before done
- `npm run test:unit` green (5 new selectPacketLabels tests). `cd agent-runtime && npm test` = 297.
- `npm run typecheck` + `npm run build` exit 0.
- Visual: labels ride real packets (via injected comm), fade, cap 6, near-emphasis; none reduced-motion.

## Self-review
- Selection logic is the pure helper (tested); canvas only renders. No React state → no per-frame
  render. Truncation ≤16. Reduced-motion gated. Reuses P0-2 packet `topic`. No P0 regression. ✔

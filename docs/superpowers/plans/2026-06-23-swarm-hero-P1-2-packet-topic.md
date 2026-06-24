# SwarmHero P1-2 — Packet Topic on Hover/Near — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **BOSS DIRECTIVE:** do NOT commit until asked.

**Goal:** When the cursor is near a flying packet, show the `topic` of the real message that packet
represents. Real-comms packets carry their feed `topic`; idle-trickle packets carry none (no label).

**Architecture:** Packets already ride real `FeedEvent`s (P0-2). Extend `packetsFromFeed` to include
`topic`; carry it on each `Pkt`; in the rAF draw loop, when a packet's screen position is within a
small radius of the cursor (parallax-corrected) and it has a topic, draw the topic as a faint label
on the canvas next to the packet. Pure-canvas — no React state, no per-frame renders.

**Tech:** React 18 + TS, Canvas 2D, node --test, Vite.

---

### Task 1: `packetsFromFeed` carries `topic`

**Files:** `src/lib/swarmGraph.ts`, `src/lib/__tests__/swarmGraph.test.ts`

- [ ] **Step 1 — update existing P0-2 tests (RED)**: the 3 packet-shape assertions now expect `topic`.
  `ev(ts,from,to)` sets `topic:"t"`, so:
  - "a new event after baseline" → `[{ from:"b", to:"c", topic:"t" }]`
  - "multiple new events" → `[{ from:"b", to:"c", topic:"t" }, { from:"c", to:"a", topic:"t" }]`
  Add one test: `ev` with a distinct topic flows through:
  ```ts
  test("packetsFromFeed carries the event topic", () => {
    const feed = [ev("t1","a","b"), { ts:"t2", from:"b", to:"c", topic:"review-req", ref:"r", body:"b" }];
    const r = packetsFromFeed("t1", feed, has);
    assert.deepEqual(r.packets, [{ from:"b", to:"c", topic:"review-req" }]);
  });
  ```

- [ ] **Step 2 — run, expect FAIL** (packets lack `topic`):
  `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && node --test src/lib/__tests__/swarmGraph.test.ts`

- [ ] **Step 3 — implement**: in `swarmGraph.ts` add `topic` to `PacketSpawn` and push it:
  ```ts
  export interface PacketSpawn { from: string; to: string; topic: string; }
  ```
  ```ts
      if (e.ts > prevTs && hasNode(e.from) && hasNode(e.to)) {
        packets.push({ from: e.from, to: e.to, topic: e.topic });
      }
  ```

- [ ] **Step 4 — GREEN + typecheck**: `npm run test:unit && npm run typecheck` (all green, exit 0).

- [ ] **Step 5 — commit (GATED — stage only)**:
  `git add src/lib/swarmGraph.ts src/lib/__tests__/swarmGraph.test.ts`

---

### Task 2: Carry topic on packets + draw it near the cursor

**Files:** `src/components/hero/SwarmHero.tsx`

- [ ] **Step 1 — Pkt carries topic**:
  ```ts
    type Pkt = { a: typeof nodes[number]; b: typeof nodes[number]; p: number; sp: number; col: string; topic: string };
  ```

- [ ] **Step 2 — spawnPacket accepts topic** (default "" for trickle):
  ```ts
    const spawnPacket = (ia: number, ib: number, topic = "") => {
      if (ia < 0 || ib < 0) return;
      packets.push({ a: nodes[ia], b: nodes[ib], p: 0, sp: 0.01 + rnd() * 0.022, col: rnd() < 0.5 ? nodes[ia].col : nodes[ib].col, topic });
    };
  ```
  (Keep the existing guard line if present; only add `topic` param + field.)

- [ ] **Step 3 — feed-drive passes the real topic; trickle passes none**:
  ```ts
        for (const pk of res.packets) {
          spawnPacket(agentIdx.get(pk.from)!, agentIdx.get(pk.to)!, pk.topic);
          lastRealPacket = t;
        }
  ```
  (Trickle `spawnPacket(e[0], e[1])` stays — defaults topic="".)

- [ ] **Step 4 — draw topic when cursor is near the packet** — in the packet draw loop, after drawing
  the dot (after line ~359), add:
  ```ts
        // P1-2: show the message topic when the cursor is near a real-comms packet.
        if (pk.topic) {
          const cdx = (mx - ox) - x, cdy = (my - oy) - y; // cursor in node-space vs packet
          if (cdx * cdx + cdy * cdy < 26 * 26) {
            ctx.globalAlpha = 0.95;
            ctx.fillStyle = "#e7e9f0";
            ctx.font = "11px ui-monospace, Menlo, monospace";
            ctx.fillText(pk.topic, x + 9, y - 7);
            ctx.globalAlpha = 1;
          }
        }
  ```

- [ ] **Step 5 — typecheck + build**: `npm run typecheck && npm run build` (exit 0).

- [ ] **Step 6 — visual verify (dev)**: open hero; when a real-comms packet passes under the cursor,
  its topic shows next to it; idle-trickle packets show nothing.

- [ ] **Step 7 — commit (GATED — stage only)**:
  `git add src/components/hero/SwarmHero.tsx`

---

## Acceptance (PRD P1-2) → coverage

| PRD | Covered by |
|---|---|
| on hover/near a packet, show the topic of the message it represents | Task 2 Step 4 proximity draw + `packetsFromFeed` topic (Task 1) |

## Verify before done
- `npm run test:unit` green (incl. updated P0-2 packet-shape tests + new topic test).
- `cd agent-runtime && npm test` = 297.
- `npm run typecheck` + `npm run build` exit 0.
- Visual: topic label appears near a real packet under the cursor; trickle packets unlabeled.

## Self-review
- Pure helper change is unit-tested; topic flows helper → Pkt → canvas label. No React state added →
  no per-frame render (consistent with the P0-3 guardrail). Trickle packets (topic "") never label. ✔

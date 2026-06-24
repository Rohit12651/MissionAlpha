# SwarmHero P0-2 — Packets Reflect Real Comms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.
>
> **BOSS DIRECTIVE:** Do **NOT** `git commit` until the boss approves. "Commit" steps are GATED —
> stage only.

**Goal:** Replace random packet spawning with packets driven by real `FeedEvent`s (`from → to`), so
every packet represents an actual agent-to-agent message — while keeping a subtle idle trickle when
the feed is quiet, and honoring reduced-motion.

**Architecture:** Add pure helper `packetsFromFeed(prevTs, feed, hasNode)` to `src/lib/swarmGraph.ts`
(unit-tested) — given the last-seen `ts`, it returns the spawn list (`{from,to}[]`) for *new*
node-mappable events plus the new `lastTs`. Then refactor `SwarmHero`'s canvas so it **builds the
graph once** (deps keyed on agent membership, not on every poll) and reads live `feed` from a
`feedRef`; the rAF loop drains new feed events into packets via `packetsFromFeed` (throttled ~0.5s).
This also fixes the pre-existing per-poll teardown/flash flagged in P0-1 review — realizing the PRD
guardrail "canvas reads status/feed from a ref synced on prop change — never per-frame React renders."

**Tech Stack:** React 18 + TS, Canvas 2D, `node --test`, Vite.

---

## File Structure

- **Modify** `src/lib/swarmGraph.ts` — add `PacketSpawn` type + `packetsFromFeed` (alongside existing
  `statusStyle`).
- **Modify** `src/lib/__tests__/swarmGraph.test.ts` — add `packetsFromFeed` unit tests.
- **Modify** `src/components/hero/SwarmHero.tsx` — add `feedRef` synced on `[feed]`; change the canvas
  effect deps from `[open, agents, feed]` to `[open, agentSig]` (build once per membership); replace
  random/burst packet spawning with feed-driven spawning + quiet-trickle.

---

### Task 1: Pure helper `packetsFromFeed` + unit tests

**Files:**
- Modify: `src/lib/swarmGraph.ts`
- Modify: `src/lib/__tests__/swarmGraph.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `src/lib/__tests__/swarmGraph.test.ts`:

```ts
import { packetsFromFeed } from "../swarmGraph.ts";
import type { FeedEvent } from "../../data/types.ts";

function ev(ts: string, from: string, to: string): FeedEvent {
  return { ts, from, to, topic: "t", ref: "r", body: "b" };
}
const NODES = new Set(["a", "b", "c"]);
const has = (id: string) => NODES.has(id);

test("first call (prevTs null) establishes baseline, spawns nothing", () => {
  const feed = [ev("2026-01-01T00:00:01Z", "a", "b"), ev("2026-01-01T00:00:02Z", "b", "c")];
  const r = packetsFromFeed(null, feed, has);
  assert.deepEqual(r.packets, []);
  assert.equal(r.lastTs, "2026-01-01T00:00:02Z");
});

test("a new event after baseline spawns exactly one packet from→to", () => {
  const feed = [ev("2026-01-01T00:00:01Z", "a", "b"), ev("2026-01-01T00:00:02Z", "b", "c")];
  const r = packetsFromFeed("2026-01-01T00:00:01Z", feed, has);
  assert.deepEqual(r.packets, [{ from: "b", to: "c" }]);
  assert.equal(r.lastTs, "2026-01-01T00:00:02Z");
});

test("event whose from or to is not a node is skipped (no crash)", () => {
  const feed = [ev("2026-01-01T00:00:02Z", "a", "zzz"), ev("2026-01-01T00:00:03Z", "ghost", "b")];
  const r = packetsFromFeed("2026-01-01T00:00:01Z", feed, has);
  assert.deepEqual(r.packets, []);
  assert.equal(r.lastTs, "2026-01-01T00:00:03Z");
});

test("same feed re-fed (prevTs = lastTs) spawns no duplicates", () => {
  const feed = [ev("2026-01-01T00:00:01Z", "a", "b"), ev("2026-01-01T00:00:02Z", "b", "c")];
  const r = packetsFromFeed("2026-01-01T00:00:02Z", feed, has);
  assert.deepEqual(r.packets, []);
  assert.equal(r.lastTs, "2026-01-01T00:00:02Z");
});

test("multiple new events spawn one packet each, in order, lastTs = newest", () => {
  const feed = [
    ev("2026-01-01T00:00:01Z", "a", "b"),
    ev("2026-01-01T00:00:02Z", "b", "c"),
    ev("2026-01-01T00:00:03Z", "c", "a"),
  ];
  const r = packetsFromFeed("2026-01-01T00:00:01Z", feed, has);
  assert.deepEqual(r.packets, [{ from: "b", to: "c" }, { from: "c", to: "a" }]);
  assert.equal(r.lastTs, "2026-01-01T00:00:03Z");
});

test("empty feed returns prevTs unchanged and no packets", () => {
  const r = packetsFromFeed("2026-01-01T00:00:05Z", [], has);
  assert.deepEqual(r.packets, []);
  assert.equal(r.lastTs, "2026-01-01T00:00:05Z");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && node --test src/lib/__tests__/swarmGraph.test.ts`
Expected: FAIL — `packetsFromFeed is not a function`.

- [ ] **Step 3: Implement** — append to `src/lib/swarmGraph.ts`:

```ts
import type { FeedEvent } from "../data/types";

/** One packet to spawn along the from→to edge. */
export interface PacketSpawn {
  from: string;
  to: string;
}

/**
 * Compute which packets to spawn from the live feed since `prevTs`. Pure.
 * - First call (`prevTs === null`) establishes a baseline: spawns NOTHING (don't replay history as
 *   a burst on open) and returns the newest ts as `lastTs`.
 * - Subsequent calls spawn one packet per event strictly newer than `prevTs` whose `from` AND `to`
 *   are rendered nodes (`hasNode`). Events touching a non-node are skipped (no packet, no crash).
 * - `lastTs` advances to the newest event ts so the same feed re-fed spawns no duplicates.
 */
export function packetsFromFeed(
  prevTs: string | null,
  feed: readonly FeedEvent[],
  hasNode: (id: string) => boolean,
): { packets: PacketSpawn[]; lastTs: string | null } {
  if (feed.length === 0) return { packets: [], lastTs: prevTs };

  let newest = prevTs;
  for (const e of feed) if (newest === null || e.ts > newest) newest = e.ts;

  if (prevTs === null) return { packets: [], lastTs: newest };

  const packets: PacketSpawn[] = [];
  for (const e of feed) {
    if (e.ts > prevTs && hasNode(e.from) && hasNode(e.to)) {
      packets.push({ from: e.from, to: e.to });
    }
  }
  return { packets, lastTs: newest };
}
```

- [ ] **Step 4: Run tests + full lib suite + typecheck**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run test:unit && npm run typecheck`
Expected: all green (P0-1 + new P0-2 cases), typecheck exit 0.

- [ ] **Step 5: Commit (GATED — stage only)**

```bash
git add src/lib/swarmGraph.ts src/lib/__tests__/swarmGraph.test.ts
# git commit -m "feat(swarm): packetsFromFeed pure helper — feed-driven packet spawning (P0-2)"  # after boss approval
```

---

### Task 2: Drive canvas packets from the live feed (build-once refactor)

**Files:**
- Modify: `src/components/hero/SwarmHero.tsx`

No new unit test (canvas wiring); logic lives in `packetsFromFeed` (tested). Verified by typecheck +
build + visual (packets visibly traverse from→to edges; quiet feed still trickles).

- [ ] **Step 1: Import `packetsFromFeed`**

Extend the existing import:

```ts
import { statusStyle, packetsFromFeed, type StatusStyle } from "../../lib/swarmGraph";
```

- [ ] **Step 2: Add `feedRef` + a stable agent-membership signature; sync feed on `[feed]`**

Below `const statusRef = ...` add:

```ts
  const feedRef = useRef<readonly FeedEvent[]>(feed);
```

After the existing status-sync effect, add a feed-sync effect:

```ts
  // Keep the latest feed in a ref the rAF loop drains into packets — feed updates each poll WITHOUT
  // rebuilding the canvas (PRD real-time guardrail). The graph is built once (see canvas effect deps).
  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);
```

At the top of the component body (after the refs), compute a membership signature so the canvas
rebuilds only when the SET of agents changes — not on every status/feed poll:

```ts
  const agentSig = agents.map((a) => a.id).join("|");
```

- [ ] **Step 3: Replace random/burst packet spawning with feed-driven + quiet-trickle**

In the canvas effect, find the packet-spawn block (currently the two `if` blocks: the per-0.16s random
spawn and the per-2.4s burst, around lines 255-269) and replace BOTH with:

```ts
      // packets — driven by REAL feed comms (P0-2). Drain new feed events (throttled to the poll
      // cadence) into one packet each, from→to. When the feed is quiet, a subtle idle trickle keeps
      // the view alive (edge case 7) without faking comms volume.
      if (t - lastFeedCheck > 0.5) {
        lastFeedCheck = t;
        const res = packetsFromFeed(lastFeedTs, feedRef.current, (id) => agentIdx.has(id));
        for (const pk of res.packets) {
          spawnPacket(agentIdx.get(pk.from)!, agentIdx.get(pk.to)!);
          lastRealPacket = t;
        }
        lastFeedTs = res.lastTs;
      }
      // quiet trickle: only when no real comms for a while, emit a faint packet along a random edge.
      if (edges.length && t - lastRealPacket > 2.5 && t - lastTrickle > 0.8) {
        lastTrickle = t;
        const e = edges[(rnd() * edges.length) | 0];
        spawnPacket(e[0], e[1]);
      }
```

- [ ] **Step 4: Declare the new loop-local timers + feed baseline**

Find `let lastPk = 0, lastWave = 0, lastBurst = 0;` (around line 168) and replace with:

```ts
      let lastWave = 0;
      let lastFeedCheck = 0, lastFeedTs: string | null = null, lastRealPacket = -999, lastTrickle = 0;
```

(`lastPk` and `lastBurst` are removed — no longer used.) Then, right before the `tick` function is
first called (just before `if (reduce) { ... } else tick();`), establish the feed baseline so opening
the hero does NOT burst-replay the existing 120-event history:

```ts
    // baseline: mark all current feed events as "already seen" so we only packet NEW comms.
    lastFeedTs = packetsFromFeed(null, feedRef.current, (id) => agentIdx.has(id)).lastTs;
```

- [ ] **Step 5: Change the canvas effect deps — build once per membership (fixes per-poll flash)**

Change the canvas effect's dependency array (currently `}, [open, agents, feed]);`) to:

```ts
  }, [open, agentSig]);
```

Rationale: status flows via `statusRef` (synced on `[agents]`), feed flows via `feedRef` (synced on
`[feed]`); the heavy graph build only needs to re-run when the agent SET changes. This removes the
teardown/re-scatter that happened on every 2s poll and makes packets spawn against a stable graph.

> Note: the canvas closure still reads `agents`/`feed` ONCE at build time for topology + baseline;
> that is intentional and correct (topology = membership, which `agentSig` tracks).

- [ ] **Step 6: Typecheck + build**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run typecheck && npm run build`
Expected: both exit 0. (If `tsc` flags unused `lastPk`/`lastBurst`, ensure they were removed.)

- [ ] **Step 7: Visual verification (dev)**

Screenshot the hero. Confirm: packets travel along real from→to edges; with the static snapshot
(no new events after baseline) the **quiet trickle** keeps subtle motion (view not dead-still);
nodes still status-styled (P0-1 intact); no per-poll flash/re-scatter.

- [ ] **Step 8: Commit (GATED — stage only)**

```bash
git add src/components/hero/SwarmHero.tsx
# git commit -m "feat(swarm): spawn packets from real feed events + build-once canvas (P0-2)"  # after boss approval
```

---

## Acceptance Criteria (PRD P0-2) → coverage

| Given/When/Then | Covered by |
|---|---|
| new `FeedEvent {from,to}` both nodes → exactly one packet on from→to | `packetsFromFeed` test "one packet" + Task 2 drain |
| from/to not a node → no packet, no crash | `packetsFromFeed` test "skipped" + `hasNode` guard |
| empty/quiet feed → subtle idle trickle | Task 2 quiet-trickle block + test "empty feed" |
| same feed, no new events → no duplicates (last-seen ts) | `packetsFromFeed` test "no duplicates" |

## Verification before completion

1. `npm run test:unit` — P0-1 + P0-2 helper tests green.
2. `cd agent-runtime && npm test` — still 297 pass.
3. `npm run typecheck` — exit 0. `npm run build` — exit 0.
4. Visual: packets ride real edges; quiet trickle present; no flash; P0-1 visuals intact.

## Self-Review

- **Spec coverage:** all four P0-2 Given/When/Then mapped (table). ✔
- **Placeholders:** none — full code in every step. ✔
- **Type consistency:** `packetsFromFeed` signature identical in helper/tests/call site; returns
  `{packets: PacketSpawn[]; lastTs: string|null}`; `spawnPacket` already takes `(ia, ib)` node indices
  and `agentIdx.get` returns `number | undefined` (non-null asserted only after `hasNode` filter). ✔
- **Scope:** P0-2 only (packets + the build-once refactor it requires). Hover (P0-3) + panel (P0-4)
  untouched. The build-once refactor is the foundation P0-3/P0-4 also need. ✔

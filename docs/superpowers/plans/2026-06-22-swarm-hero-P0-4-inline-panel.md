# SwarmHero P0-4 — Inline Real-Time Inspect + Chat Panel (v2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.
> **BOSS DIRECTIVE:** Do **NOT** `git commit` until the boss approves. "Commit" steps = stage only.
> **SECURITY GATE:** P0-4 introduces the first user-action entry point. `security-reviewer` MUST pass
> before any commit (BLOCKING).

**Goal:** Clicking an agent node opens an inline panel **inside the hero** (hero stays open) showing
that agent's header (id · role · tier · live status), a live RECENT COMMS list, and the **existing
`ChatPane`** (embedded, not rebuilt). Clicking another node swaps the panel; ✕/Esc closes it; a click
on empty canvas closes it. When `onSelectAgent` is omitted (landing page) the hero is display-only.

**Architecture:** SwarmHero stays a renderer; selection is **controlled by App**. New optional props:
`openAgentId` (controlled selection), `onSelectAgent(id|null)` (click callback), `renderChat(id)`
(slot returning App's `<ChatPane>`). The click hit-test lives INSIDE the canvas effect (nodes + ox/oy
in scope) and is parallax-correct via the existing `hitTest`. App owns a **lazy per-agent message
store** (`Record<id, Msg[]>` + history fetch, mirroring the existing Boss-thread load) and returns a
real `ChatPane` (`isBoss=false`, `threadId=agentId`, `onCommand=sendCommand`) — **no second chat
engine, no new mutation path**. RECENT COMMS is a pure helper (`recentComms`) memoized on `(openId,
feed)`. Selection ring reads `openAgentId` from a ref so it never triggers per-frame React renders.

**Tech Stack:** React 18 + TS, Canvas 2D, `node --test`, Vite, Electron (packaged verify).

---

## Reuse / security guardrails (HARD)

- **No new chat code.** The composer/send/apply is the existing `ChatPane`, supplied by App via
  `renderChat`. Sending still routes through `sendCommand` + `PermissionGate` (unchanged gates).
- **No new mutation path.** Clicking only opens/swaps/closes the panel (read + inspect). The only
  write path remains ChatPane's existing gated flow.
- **Agent ids in URLs** (per-agent thread fetch) MUST be `encodeURIComponent`'d. Ids are already
  constrained server-side (`^[a-z0-9_-]`), but encode defensively.
- **Feed bodies render as text** (React auto-escapes) — no `dangerouslySetInnerHTML`.

---

## File Structure

- **Modify** `src/lib/swarmGraph.ts` — add `recentComms(feed, id, limit)`.
- **Modify** `src/lib/__tests__/swarmGraph.test.ts` — `recentComms` tests.
- **Modify** `src/components/hero/SwarmHero.tsx` — controlled selection props, click hit-test (inside
  canvas effect), Esc layering, selection ring, inline panel JSX (header + RECENT COMMS + chat slot).
- **Modify** `src/App.tsx` — `heroAgentId` state, lazy per-agent message store + history load, pass
  `openAgentId`/`onSelectAgent`/`renderChat` to `SwarmHero`.

---

### Task 1: Pure helper `recentComms` + unit tests

**Files:** Modify `src/lib/swarmGraph.ts`, `src/lib/__tests__/swarmGraph.test.ts`

- [ ] **Step 1: Write failing tests** — append to `swarmGraph.test.ts`:

```ts
import { recentComms } from "../swarmGraph.ts";

const FC = [
  ev("t1", "a", "b"),
  ev("t2", "b", "c"),
  ev("t3", "c", "a"),
  ev("t4", "a", "d"),
];

test("recentComms returns only events touching the agent, newest first", () => {
  const r = recentComms(FC, "a");
  assert.deepEqual(r.map((e) => e.ts), ["t4", "t3", "t1"]); // excludes t2 (b→c)
});

test("recentComms respects the limit", () => {
  const r = recentComms(FC, "a", 2);
  assert.deepEqual(r.map((e) => e.ts), ["t4", "t3"]);
});

test("recentComms returns [] when the agent has no comms", () => {
  assert.deepEqual(recentComms(FC, "zzz"), []);
});

test("recentComms returns [] for empty feed", () => {
  assert.deepEqual(recentComms([], "a"), []);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && node --test src/lib/__tests__/swarmGraph.test.ts`
Expected: FAIL — `recentComms is not a function`.

- [ ] **Step 3: Implement** — append to `src/lib/swarmGraph.ts`:

```ts
/**
 * The most recent feed events that touch an agent (`from === id || to === id`), newest first,
 * capped at `limit`. Pure. Assumes `feed` is in chronological (oldest-first) order, as the live
 * state serves it — so we walk from the end.
 */
export function recentComms(feed: readonly FeedEvent[], id: string, limit = 14): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (let i = feed.length - 1; i >= 0 && out.length < limit; i--) {
    const e = feed[i];
    if (e.from === id || e.to === id) out.push(e);
  }
  return out;
}
```

- [ ] **Step 4: GREEN + typecheck**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run test:unit && npm run typecheck`
Expected: all green, exit 0.

- [ ] **Step 5: Commit (GATED — stage only)**

```bash
git add src/lib/swarmGraph.ts src/lib/__tests__/swarmGraph.test.ts
# git commit -m "feat(swarm): recentComms pure helper for the inline panel (P0-4)"  # after boss approval
```

---

### Task 2: SwarmHero — controlled selection, click hit-test, inline panel

**Files:** Modify `src/components/hero/SwarmHero.tsx`

- [ ] **Step 1: Imports + new props**

Add `recentComms` to the swarmGraph import and `type ReactNode` to the React import:

```ts
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
```
```ts
import { statusStyle, packetsFromFeed, hitTest, recentComms, type StatusStyle } from "../../lib/swarmGraph";
import { COLUMN_LABEL, TIER_LABEL } from "../../lib/agentMeta";
```

Extend the component prop type/destructure:

```ts
export function SwarmHero({
  open,
  agents,
  feed = [],
  onClose,
  openAgentId = null,
  onSelectAgent,
  renderChat,
}: {
  open: boolean;
  agents: AgentState[];
  feed?: readonly FeedEvent[];
  onClose: () => void;
  /** Controlled selection — the agent whose inline panel is open (null = none). */
  openAgentId?: string | null;
  /** Click callback. WHEN OMITTED the hero is display-only (landing page) — clicks do nothing. */
  onSelectAgent?: (id: string | null) => void;
  /** Slot returning the existing ChatPane for an agent (App-owned; no chat code lives here). */
  renderChat?: (agentId: string) => ReactNode;
}) {
```

- [ ] **Step 2: Ref for the selection so the draw loop reads it without per-frame renders**

Below the existing refs add:

```ts
  const openIdRef = useRef<string | null>(openAgentId);
  useEffect(() => { openIdRef.current = openAgentId; }, [openAgentId]);
```

- [ ] **Step 3: Esc layering — panel first, then hero**

Replace the existing keydown effect:

```ts
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
```

with:

```ts
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openIdRef.current && onSelectAgent) onSelectAgent(null); // Esc once: close the panel
      else onClose();                                              // Esc again: close the hero
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onSelectAgent]);
```

- [ ] **Step 4: Click hit-test INSIDE the canvas effect (nodes + ox/oy in scope)**

Find the pointer block (added in P0-3) and add a click listener right after the `pointermove`
listener registration:

```ts
    const onMove = (e: PointerEvent) => { mx = e.clientX; my = e.clientY; updateHover(); };
    window.addEventListener("pointermove", onMove);
    // Click → select the node under the cursor (parallax-correct). Empty-canvas click closes the
    // panel. Display-only when onSelectAgent is omitted (landing page). Listener is on the canvas so
    // clicks on the panel chrome (sibling DOM above) never reach here.
    const onClick = (e: MouseEvent) => {
      if (!onSelectAgent) return;
      const id = hitTest(nodes, e.clientX, e.clientY, ox, oy);
      onSelectAgent(id); // id selects/swaps; null (empty canvas) closes
    };
    cv.addEventListener("click", onClick);
```

Update the cleanup to remove it:

```ts
    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      cv.removeEventListener("click", onClick);
      hoveredRef.current = null; setHovered(null);
    };
```

> The canvas effect deps are `[open, agentSig]`. `onSelectAgent` is read fresh via closure each build;
> App passes a stable `useCallback`, and selection itself flows through `openIdRef` (synced in Step 2),
> so the loop never needs a rebuild on selection. Keep the existing `eslint-disable` line.

- [ ] **Step 5: Selection ring (P1-1 folded in) in the node-draw loop**

In the "nodes + bloom" loop, after the blocked-ring block and before the specular highlight, add a
white selection ring for the open agent:

```ts
        // selection ring (P0-4): the open agent gets a crisp white ring.
        if (a.agentId && a.agentId === openIdRef.current) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "rgba(255,255,255,0.95)";
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(a.x, a.y, a.r * pulse + 6, 0, 6.2832); ctx.stroke();
        }
```

- [ ] **Step 6: Derive RECENT COMMS + open agent (memoized on (openAgentId, feed))**

In the component body (after `agentSig`), add:

```ts
  const comms = useMemo(
    () => (openAgentId ? recentComms(feed, openAgentId, 14) : []),
    [openAgentId, feed],
  );
  const openAgent = useMemo(
    () => (openAgentId ? agents.find((a) => a.id === openAgentId) ?? null : null),
    [openAgentId, agents],
  );
```

- [ ] **Step 7: Inline panel JSX**

In the returned markup, after the tooltip block and before the title block, add the panel. It is a
right-edge ~340px column; the graph keeps animating behind/left of it.

```tsx
      {openAgentId && openAgent && (
        <aside
          className="absolute right-0 top-0 z-20 flex h-full w-[340px] flex-col"
          style={{ background: "rgba(12,13,20,0.96)", borderLeft: "1px solid rgba(139,108,246,0.30)", backdropFilter: "blur(10px)" }}
          aria-label={`Inspect ${openAgent.id}`}
        >
          {/* header */}
          <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold"
              style={{ background: "rgba(139,108,246,0.18)", color: "#c9b8ff" }}>
              {openAgent.id.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold" style={{ fontFamily: "ui-monospace, Menlo, monospace", color: "#f3f5f8" }}>{openAgent.id}</div>
              <div className="truncate text-[11px]" style={{ color: "#9aa0ad" }}>{openAgent.role} · {TIER_LABEL[openAgent.tier]} · {COLUMN_LABEL[openAgent.column]}</div>
            </div>
            <button type="button" onClick={() => onSelectAgent?.(null)} aria-label="Close inspect panel" title="Close (Esc)"
              className="rounded-md p-1.5 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2" style={{ color: "#8a8f9c" }}>
              <X size={16} aria-hidden />
            </button>
          </div>
          {/* recent comms (live) */}
          <div className="border-b px-4 py-2" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#6b7280" }}>Recent comms</div>
            <ul className="max-h-[28%] space-y-1 overflow-y-auto">
              {comms.length === 0 && <li className="text-[11px]" style={{ color: "#6b7280" }}>no recent comms</li>}
              {comms.map((e, i) => {
                const out = e.from === openAgent.id;
                return (
                  <li key={`${e.ts}-${i}`} className="text-[11px] leading-snug">
                    <span style={{ color: out ? "#22d3ee" : "#8b6cf6" }}>{out ? `→ ${e.to}` : `← ${e.from}`}</span>
                    <span style={{ color: "#6b7280" }}> · {e.topic}</span>
                    {e.body && <span style={{ color: "#aab0be" }}> · {e.body}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
          {/* embedded ChatPane (App-owned; reused, not rebuilt) */}
          <div className="min-h-0 flex-1">
            {renderChat && renderChat(openAgent.id)}
          </div>
        </aside>
      )}
```

- [ ] **Step 8: Typecheck + build**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 9: Commit (GATED — after Task 4 security PASS, stage only)**

```bash
git add src/components/hero/SwarmHero.tsx
# commit deferred to Task 4 (security gate)
```

---

### Task 3: App — heroAgentId, per-agent message store, wire props

**Files:** Modify `src/App.tsx`

- [ ] **Step 1: Imports**

```ts
import { ChatPane, type Msg } from "./components/workspace/ChatPane";
```
(replace the existing `import type { Msg } from "./components/workspace/ChatPane";`)

Ensure these are imported (add what's missing):

```ts
import { TIER_ACCENT, TIER_LABEL } from "./lib/agentMeta";
import { runtimeToken } from "./lib/runtimeToken";
```
(`runtimeUrl` is already imported from `./lib/runtimeBase`.)

- [ ] **Step 2: State — selection + lazy per-agent message store**

Near the other `useState`s (e.g., after `heroOpen`):

```ts
  const [heroAgentId, setHeroAgentId] = useState<string | null>(null);
  const [agentMsgs, setAgentMsgs] = useState<Record<string, Msg[]>>({});
  const setAgentMessages = useCallback(
    (id: string) => (updater: (prev: Msg[]) => Msg[]) =>
      setAgentMsgs((m) => ({ ...m, [id]: updater(m[id] ?? []) })),
    [],
  );
```

- [ ] **Step 3: Lazy history load for the open agent (mirrors the Boss-thread load)**

Add after the existing Boss-thread load effect:

```ts
  // Load the opened agent's chat history once it is selected (same path as the Boss thread).
  useEffect(() => {
    if (!heroAgentId) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await runtimeToken();
        const res = await fetch(runtimeUrl(`/runtime/${encodeURIComponent(heroAgentId)}/thread`), {
          cache: "no-store", headers: { "x-runtime-token": token },
        });
        const msgs = res.ok ? (((await res.json()) as { messages?: Msg[] }).messages ?? []) : [];
        if (!cancelled) setAgentMsgs((m) => ({ ...m, [heroAgentId]: msgs }));
      } catch { /* empty */ }
    })();
    return () => { cancelled = true; };
  }, [heroAgentId]);
```

- [ ] **Step 4: `renderChat` slot — the EXISTING ChatPane for an agent (no new chat code)**

```ts
  const renderHeroChat = useCallback(
    (id: string) => {
      const a = state?.agents.find((x) => x.id === id);
      return (
        <ChatPane
          threadId={id}
          title={id}
          subtitle={a ? `${a.role} · ${TIER_LABEL[a.tier]}` : id}
          accent={a ? TIER_ACCENT[a.tier] : "accent-cyan"}
          isBoss={false}
          messages={agentMsgs[id] ?? []}
          setMessages={setAgentMessages(id)}
          onCommand={sendCommand}
        />
      );
    },
    [state?.agents, agentMsgs, setAgentMessages, sendCommand],
  );
```

- [ ] **Step 5: Wire the props into the SwarmHero usage (App:329)**

Replace:

```tsx
      {state && <SwarmHero open={heroOpen} agents={state.agents} feed={state.feed} onClose={() => setHeroOpen(false)} />}
```

with:

```tsx
      {state && (
        <SwarmHero
          open={heroOpen}
          agents={state.agents}
          feed={state.feed}
          onClose={() => { setHeroOpen(false); setHeroAgentId(null); }}
          openAgentId={heroAgentId}
          onSelectAgent={setHeroAgentId}
          renderChat={renderHeroChat}
        />
      )}
```

- [ ] **Step 6: Typecheck + build**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run typecheck && npm run build`
Expected: both exit 0.

---

### Task 4: Security review (BLOCKING) + verification + commit

- [ ] **Step 1: `security-reviewer` agent on the P0-4 diff** — MUST PASS before any commit. Scope:
  no new mutation/ungated path; agent id is encodeURIComponent'd in the thread URL; feed bodies render
  as escaped text; ChatPane reuse keeps all PermissionGate/onCommand gates; no secret/log leakage;
  clicking only opens/closes the panel. Fix any CRITICAL/HIGH before proceeding.

- [ ] **Step 2: `react-reviewer`** — hook correctness (renderChat useCallback deps, per-agent store
  immutability, selection ref vs render), no stale closure on `onSelectAgent`/`openAgentId`.

- [ ] **Step 3: webapp-testing / ui-ux-tester (dev)** — deterministic clicks (not sweeps): open hero,
  click a node → panel opens for THAT id (header + comms + ChatPane composer present); click another
  node → panel swaps id; ✕ closes; Esc-once closes panel, Esc-again closes hero; empty-canvas click
  closes; selection ring visible. Screenshot the open panel.

- [ ] **Step 4: Packaged Electron verify** — `npm run build` then launch the packaged app; repeat the
  click-through (open hero, click node, panel + ChatPane render, send is gated). Confirm parity with dev.

- [ ] **Step 5: Full gates** — `npm run test:unit` green; `cd agent-runtime && npm test` = 297;
  `npm run typecheck` + `npm run build` exit 0.

- [ ] **Step 6: Commit (GATED — only after security PASS AND boss approval, stage only otherwise)**

```bash
git add src/lib/swarmGraph.ts src/lib/__tests__/swarmGraph.test.ts src/components/hero/SwarmHero.tsx src/App.tsx
# git commit -m "feat(swarm): inline real-time inspect+chat panel embedding ChatPane (P0-4)"  # ONLY after security PASS + boss approval
```

---

## Acceptance Criteria (PRD P0-4) → coverage

| Given/When/Then | Covered by |
|---|---|
| click node → inline panel for THAT agent id, hero still visible behind | Task 2 click hit-test + panel JSX; controlled `openAgentId` |
| click another node → panel swaps to that agent | `onSelectAgent(id)` → App `heroAgentId` → re-render |
| RECENT COMMS reflects live feed, updates without reopening | `recentComms` memoized on `(openAgentId, feed)` (feed updates each poll) |
| embedded chat is the SAME ChatPane; send/apply via existing gates | App `renderChat` returns `<ChatPane onCommand={sendCommand}>`; no new code |
| clicked node shows white selection ring | Task 2 Step 5 selection ring |
| ✕ / Esc-once closes panel; Esc-again closes hero | close button + Esc layering (Step 3) |
| empty-canvas click closes the panel | `onClick` → `hitTest` null → `onSelectAgent(null)` |
| display-only when `onSelectAgent` omitted | `onClick` early-returns; no panel |
| verified in dev AND packaged Electron | Task 4 Steps 3–4 |

## Real-time guardrails (PRD)

- Panel data (`comms`, `openAgent`) derived via `useMemo` keyed on `(openAgentId, feed)` / `(openAgentId,
  agents)` — live updates as polls arrive, no reopen.
- Selection ring reads `openIdRef` in the rAF loop — no per-frame React render.
- Embedded `ChatPane` streams via its existing SSE path (unchanged).

## Self-Review

- **Spec coverage:** every P0-4 Given/When/Then mapped + P0-5 (display-only) covered. ✔
- **Placeholders:** none. ✔
- **Type consistency:** `openAgentId: string|null`; `onSelectAgent: (id:string|null)=>void`;
  `renderChat: (id:string)=>ReactNode`; `recentComms(feed,id,limit):FeedEvent[]`; App `setAgentMessages(id)`
  returns the `(updater)=>void` shape ChatPane expects. ✔
- **Reuse/security:** ChatPane embedded (no second engine); no new mutation path; id encoded; bodies
  escaped; security-reviewer gates the commit. ✔
- **Scope:** P0-4 + folds in P1-1 (selection ring) and P0-5 (display-only). ✔

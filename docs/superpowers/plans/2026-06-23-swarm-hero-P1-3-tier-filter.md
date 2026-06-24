# SwarmHero P1-3 — Filter / Dim by Tier (interactive legend) — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **BOSS DIRECTIVE:** do NOT commit until asked.
> Fire: impeccable (chip states) → emil-design-eng (dim ease) → kw-design-accessibility-review → TDD → verification.
> Agents: react-specialist (legend buttons + focus-set → canvas dim), a11y-architect (WCAG 2.2), ui-ux-tester.

**Goal (PRD P1-3):** The bottom legend chips (CEO / principal / senior / support) become clickable
filters. Click a tier → other tiers' nodes/edges/packets dim (lower opacity, no glow), focused tier
stays full, chip shows active. Multi-select = union. Click active chip again → remove. None active →
all full. Dim eases ≤200ms (instant under reduced-motion). Chips are real focusable buttons (Tab +
Enter/Space, visible focus ring, `aria-pressed`).

**Architecture:** Node `kind` already encodes tier (`ceo|principal|senior|support` + artifact kinds).
Add a PURE helper `focusDim(kind, focusSet)` → opacity multiplier. Legend chips become buttons that
toggle a React `focusTiers: Set<string>`. A `focusRef` mirrors it (synced on change) so the rAF loop
reads it with NO per-frame React render. Each node carries an eased `dim` lerped toward its target
(instant under reduced-motion); edges + packets + labels reuse the endpoints' eased `dim`.

**Tech:** React 18 + TS, Canvas 2D, node --test, Vite.

---

### Task 1: pure helper `focusDim` + tests

**Files:** `src/lib/swarmGraph.ts`, `src/lib/__tests__/swarmGraph.test.ts`

- [ ] **Step 1 — failing tests**:
```ts
import { focusDim } from "../swarmGraph.ts";

test("focusDim returns 1 for everything when focus is empty", () => {
  const f = new Set<string>();
  assert.equal(focusDim("ceo", f), 1);
  assert.equal(focusDim("file", f), 1);
});

test("focusDim keeps focused kinds full, dims others", () => {
  const f = new Set(["senior"]);
  assert.equal(focusDim("senior", f), 1);
  assert.equal(focusDim("principal", f), 0.12);
});

test("focusDim dims artifact kinds when any tier is focused", () => {
  assert.equal(focusDim("file", new Set(["ceo"])), 0.12);
});

test("focusDim union: any focused kind stays full", () => {
  const f = new Set(["ceo", "senior"]);
  assert.equal(focusDim("ceo", f), 1);
  assert.equal(focusDim("senior", f), 1);
  assert.equal(focusDim("support", f), 0.12);
});

test("focusDim honors a custom dim level", () => {
  assert.equal(focusDim("x", new Set(["ceo"]), 0.3), 0.3);
});
```

- [ ] **Step 2 — run, expect FAIL**.

- [ ] **Step 3 — implement** (append swarmGraph.ts):
```ts
/**
 * Opacity multiplier for a node/edge/packet of the given `kind` under a tier-focus set. Pure.
 * Empty focus → everything full (1). Otherwise focused kinds stay full; all others (incl. artifact
 * kinds) dim to `dimmed`.
 */
export function focusDim(kind: string, focus: ReadonlySet<string>, dimmed = 0.12): number {
  if (focus.size === 0) return 1;
  return focus.has(kind) ? 1 : dimmed;
}
```

- [ ] **Step 4 — GREEN + typecheck**.

- [ ] **Step 5 — commit (GATED — stage only)**.

---

### Task 2: focus state + eased canvas dim

**Files:** `src/components/hero/SwarmHero.tsx`

- [ ] **Step 1 — import** `focusDim`.

- [ ] **Step 2 — React state + ref** (near other state):
```ts
  const [focusTiers, setFocusTiers] = useState<ReadonlySet<string>>(new Set());
  const focusRef = useRef<ReadonlySet<string>>(focusTiers);
  useEffect(() => { focusRef.current = focusTiers; }, [focusTiers]);
  const toggleTier = (k: string) =>
    setFocusTiers((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
```

- [ ] **Step 3 — node carries eased `dim`**: add `dim: number` to type `N`, init `dim: 1` in `add(...)`.

- [ ] **Step 4 — ease + apply dim in the node-draw loop**. At the top of the per-node loop body add:
```ts
        const dimTarget = focusDim(a.kind, focusRef.current);
        a.dim += (dimTarget - a.dim) * (reduce ? 1 : 0.2); // ≤200ms ease; instant under reduced motion
```
  Then fold `a.dim` into the node alpha (`const alpha = (st ? st.alpha : 1) * a.dim;`) and skip glow
  when dimmed (`ctx.shadowBlur = a.dim < 0.5 ? 0 : a.r * 2 * glowK;`).

- [ ] **Step 5 — dim edges + packets via endpoints' eased dim**:
  - Edge stroke: multiply its alpha by `Math.max(nodes[ia].dim, nodes[ib].dim)`.
  - Packet dot + label: multiply alpha by `Math.max(pk.a.dim, pk.b.dim)`.

- [ ] **Step 6 — make the legend chips real buttons** (replace the `pointer-events-none` span row):
```tsx
      <div className="absolute bottom-6 left-8 flex flex-wrap gap-2 text-[11px]" role="group" aria-label="Filter by tier">
        {([["ceo","CEO","#f5b234"],["principal","principal / docs","#8b6cf6"],["senior","senior / files","#22d3ee"],["support","support","#8a8f9c"]] as const).map(([k,label,col]) => {
          const active = focusTiers.has(k);
          return (
            <button key={k} type="button" aria-pressed={active} onClick={() => toggleTier(k)}
              className="app-no-drag inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 outline-none transition-[background-color,opacity] duration-150 focus-visible:ring-2"
              style={{ borderColor: active ? col : "rgba(255,255,255,0.14)", background: active ? `color-mix(in oklch, ${col} 22%, transparent)` : "transparent", color: active ? "#f3f5f8" : "#9aa0ad", opacity: focusTiers.size && !active ? 0.6 : 1 }}>
              <span style={{ color: col }} aria-hidden>●</span>{label}
            </button>
          );
        })}
      </div>
```
  (Removes `pointer-events-none` so chips are clickable; `.app-no-drag` keeps them clickable in the
  packaged frameless window; native `<button>` gives Tab + Enter/Space; `aria-pressed` + `focus-visible:ring-2`.)

- [ ] **Step 7 — typecheck + build**.

- [ ] **Step 8 — verify (dev + keyboard)**: click a chip → other tiers dim (no glow), focused full,
  chip active; multi-select union; click active → off; none → all full; Tab to chips, Enter/Space
  toggles, focus ring visible; reduced-motion = instant dim. Screenshot a tier active.

- [ ] **Step 9 — commit (GATED — stage only)**.

---

## Acceptance (PRD P1-3) → coverage

| Given/When/Then | Covered by |
|---|---|
| click tier → other tiers' nodes/edges/packets dim (no glow), focused full, chip active | `focusDim` + Task 2 dim apply + chip active style |
| multi-select = union | `toggleTier` Set add + `focusDim` membership |
| click active again → remove; none → all full | `toggleTier` delete + `focusDim` empty→1 |
| dim eases ≤200ms, instant under reduced-motion | per-node `dim` lerp (×0.2 ≈150ms) / instant when `reduce` |
| chips = focusable buttons, Tab+Enter/Space, focus ring, aria-pressed | native `<button>` + `aria-pressed` + `focus-visible:ring-2` |

## Verify before done
- `npm run test:unit` green (5 new focusDim). `cd agent-runtime && npm test` = 297.
- `npm run typecheck` + `npm run build` exit 0.
- Dev + keyboard interaction; screenshot tier active. a11y review pass.

## Self-review
- Filter logic = pure `focusDim` (tested). Focus is React state; canvas reads via `focusRef` → no
  per-frame render. Dim eased via node.dim (instant reduced-motion). Reuses node `kind` (tier) +
  P0-2 packets. No new action surface (no security gate). No P0 regression. ✔

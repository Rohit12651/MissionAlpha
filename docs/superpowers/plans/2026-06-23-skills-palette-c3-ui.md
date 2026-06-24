# C3 — Persistent Dockable Virtualized Skills Palette — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development /
> superpowers:executing-plans. Steps `- [ ]`. TDD: RED → GREEN. Design chain (hallmark → impeccable →
> emil-design-eng → frontend-design) informs the component; webapp-testing verifies dev + packaged.

**Goal:** A new `SkillPalette` — a persistent, dockable LEFT panel listing the full 1,870-entry catalog
grouped by family (collapsible + counts), live search, ↑↓/Enter/Esc keyboard nav, VIRTUALIZED (only
visible rows mount → 60fps), opened from a title-bar "✦ Skills" button / "/" / a ⌘K command entry; pick
→ drops the skill's prompt into the ChatPane composer via the existing `prefill` flow.

**Architecture:** Pure, unit-tested grouping/virtualization logic in `src/lib/skillGroups.ts`
(`groupSkills`, `flattenRows`, `rowOffsets`, `visibleSlice`) keeps `SkillPalette.tsx` a thin view.
Catalog is **lazy-loaded** (`import("./lib/missionSkills")`) so the 1,870-entry array stays out of the
initial bundle. Pick reuses App's existing `prefill` state → ChatPane `setInput` + focus (no new path).

**Tech Stack:** React 19, framer-motion (installed), lucide-react, Tailwind + `tok()` CSS vars. No new dep.

---

## Recon facts (verified 2026-06-23)

- Catalog: `MISSION_SKILLS` (1,870) + `filterSkills`/`KIND_LABEL` exported from `src/lib/missionSkills.ts`.
  Each entry now has `family`. Bundle grew to ~946 kB → C3 **lazy-loads** the catalog.
- Pick path: App `setPrefill({text, nonce})` (App.tsx:254 `dispatchGoal`); ChatPane consumes `prefill`
  (ChatPane.tsx:227) → `setInput(text)` + focus. Reuse this — no new execution/dispatch.
- ⌘K already toggles the **actions** `CommandPalette` (App.tsx:247). Non-goal #4: keep it separate. So
  ⌘K reaches Skills via a NEW `paletteCommands` entry "Open Skills palette"; primary openers are the
  title-bar button + "/".
- TitleBar nav buttons use `NavButton`/`IconButton` + `tok()`; add a "✦ Skills" `NavButton` (Sparkles is
  taken by Swarm → use `Command`/`LayoutGrid`/`Library` icon).
- Tokens: `--c-bg .16`, `--c-panel .2`, `--c-panel-2 .24`, `--c-text .96`, `--c-muted .68`,
  `--c-border .3`, `--c-accent-cyan`. Focus ring `outline:2px solid --c-accent-cyan` (index.css:108).
  Reduced-motion net already in index.css; framer `useReducedMotion()` available. **No pink.**
- Motion budget (emil): open/close + dim ≤200ms, ease-out; instant under reduced-motion.

---

## File Structure

- Create: `src/lib/skillGroups.ts` — pure: `FAMILY_ORDER`, `groupSkills`, `flattenRows`, `rowOffsets`, `visibleSlice`.
- Create: `src/lib/__tests__/skillGroups.test.ts` — unit tests.
- Create: `src/components/skills/SkillPalette.tsx` — the dockable virtualized panel.
- Modify: `src/components/shell/TitleBar.tsx` — add `onOpenSkills` prop + "✦ Skills" button.
- Modify: `src/App.tsx` — `skillsOpen` state, `<SkillPalette>` mount, `onOpenSkills`, "/" global opener,
  lazy catalog load, pick→`setPrefill`, "Open Skills palette" command in `paletteCommands`.

---

## Task 1: Pure grouping — `groupSkills` + `FAMILY_ORDER`

**Files:** Create `src/lib/skillGroups.ts`; Test `src/lib/__tests__/skillGroups.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupSkills, FAMILY_ORDER } from "../skillGroups.ts";
import type { MissionSkill } from "../missionSkills.ts";

const S = (id: string, family: string, hint = id): MissionSkill =>
  ({ id, family, hint, title: `/${id}`, prompt: `Use the ${id} skill. `, kind: "skill" });

const FIX: MissionSkill[] = [
  S("zeta", "misc"), S("alpha", "misc"),
  S("sp-writing-plans", "sp · workflow"), S("impeccable", "ui/ux"),
  { id: "standup", family: "prompts", hint: "h", title: "/standup", prompt: "p", kind: "prompt" },
];

test("groupSkills returns families in FAMILY_ORDER, items sorted by id", () => {
  const g = groupSkills(FIX, "");
  const fams = g.map((x) => x.family);
  assert.equal(fams[0], "prompts"); // prompts first
  assert.ok(fams.indexOf("sp · workflow") < fams.indexOf("misc"));
  const misc = g.find((x) => x.family === "misc")!;
  assert.deepEqual(misc.items.map((s) => s.id), ["alpha", "zeta"]);
  assert.equal(misc.count, 2);
});

test("groupSkills filters by query across id + hint, drops empty families", () => {
  const g = groupSkills(FIX, "impec");
  assert.equal(g.length, 1);
  assert.equal(g[0].family, "ui/ux");
  assert.equal(g[0].items[0].id, "impeccable");
});

test("FAMILY_ORDER puts misc last and prompts first", () => {
  assert.equal(FAMILY_ORDER[0], "prompts");
  assert.equal(FAMILY_ORDER[FAMILY_ORDER.length - 1], "misc");
});
```

- [ ] **Step 2: Run → FAIL** (`cd ~/Downloads/WaahyuFOLDER/MissonAlpha && node --test src/lib/__tests__/skillGroups.test.ts`)

- [ ] **Step 3: Implement**

```ts
// src/lib/skillGroups.ts
import type { MissionSkill } from "./missionSkills.ts";

export interface SkillGroup { family: string; count: number; items: MissionSkill[]; }

// Preferred family order: prompts + workflow + the dev families first, the long tail mid,
// misc last. Families not listed fall in alpha order between the listed head and misc.
export const FAMILY_ORDER: string[] = [
  "prompts", "sp · workflow", "engineering", "ui/ux", "data", "product", "commands",
  "mcp", "plugin-dev", "documents", "claude-mem", "hyperframes", "gstack",
  "marketing", "sales", "hr", "operations", "support", "finance", "legal",
  "knowledge-work", "community", "ecc", "integrations", "misc",
];

function rank(family: string): number {
  const i = FAMILY_ORDER.indexOf(family);
  return i === -1 ? FAMILY_ORDER.length - 1.5 : i; // unknown families just before misc
}

function matches(s: MissionSkill, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return s.id.toLowerCase().includes(n) || s.hint.toLowerCase().includes(n) || s.title.toLowerCase().includes(n);
}

/** Pure: group skills by family (FAMILY_ORDER), filter by query, sort items by id, drop empties. */
export function groupSkills(skills: readonly MissionSkill[], query: string): SkillGroup[] {
  const q = query.trim();
  const byFam = new Map<string, MissionSkill[]>();
  for (const s of skills) {
    if (!matches(s, q)) continue;
    (byFam.get(s.family) ?? byFam.set(s.family, []).get(s.family)!).push(s);
  }
  const groups: SkillGroup[] = [];
  for (const [family, items] of byFam) {
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    groups.push({ family, count: items.length, items });
  }
  groups.sort((a, b) => rank(a.family) - rank(b.family) || (a.family < b.family ? -1 : 1));
  return groups;
}
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit**

```bash
git add src/lib/skillGroups.ts src/lib/__tests__/skillGroups.test.ts
git commit -m "feat(c3): add pure groupSkills + FAMILY_ORDER with unit tests"
```

---

## Task 2: Virtualization primitives — `flattenRows`, `rowOffsets`, `visibleSlice`

**Files:** Modify `src/lib/skillGroups.ts`; append tests

- [ ] **Step 1: Failing test** (append)

```ts
import { flattenRows, rowOffsets, visibleSlice, type FlatRow } from "../skillGroups.ts";

test("flattenRows yields header rows + item rows for expanded families only", () => {
  const groups = groupSkills(FIX, "");
  const collapsed = new Set<string>(["misc"]);
  const rows = flattenRows(groups, collapsed);
  const headers = rows.filter((r) => r.type === "header").map((r) => r.family);
  assert.deepEqual(new Set(headers), new Set(groups.map((g) => g.family)));
  // misc is collapsed → its items absent
  assert.ok(!rows.some((r) => r.type === "item" && r.skill!.family === "misc"));
  // an expanded family contributes its items
  assert.ok(rows.some((r) => r.type === "item" && r.skill!.id === "impeccable"));
});

test("rowOffsets returns cumulative tops + total height", () => {
  const rows: FlatRow[] = [
    { type: "header", family: "a", count: 1 },
    { type: "item", family: "a", skill: {} as any },
  ];
  const { tops, total } = rowOffsets(rows, 30, 44);
  assert.deepEqual(tops, [0, 30]);
  assert.equal(total, 30 + 44);
});

test("visibleSlice returns only rows intersecting the viewport (+overscan)", () => {
  const rows: FlatRow[] = Array.from({ length: 1000 }, (_, i) => ({ type: "item", family: "f", skill: { id: String(i) } as any }));
  const { tops } = rowOffsets(rows, 30, 40);
  const { start, end } = visibleSlice(tops, 40, /*scrollTop*/ 4000, /*viewportH*/ 400, /*overscan*/ 2);
  assert.ok(start <= 100 && end >= 110); // window around row ~100
  assert.ok(end - start < 40); // only a small window, not all 1000
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** (append)

```ts
export interface FlatRow { type: "header" | "item"; family: string; count?: number; skill?: MissionSkill; }

/** Pure: flatten groups to a render list — a header per family + item rows for expanded families. */
export function flattenRows(groups: SkillGroup[], collapsed: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const g of groups) {
    rows.push({ type: "header", family: g.family, count: g.count });
    if (!collapsed.has(g.family)) for (const s of g.items) rows.push({ type: "item", family: g.family, skill: s });
  }
  return rows;
}

/** Pure: cumulative top offset per row + total height, given fixed header/item heights. */
export function rowOffsets(rows: FlatRow[], headerH: number, itemH: number): { tops: number[]; total: number } {
  const tops: number[] = [];
  let y = 0;
  for (const r of rows) { tops.push(y); y += r.type === "header" ? headerH : itemH; }
  return { tops, total: y };
}

/** Pure: first/last row index intersecting [scrollTop, scrollTop+viewportH], padded by overscan. */
export function visibleSlice(tops: number[], itemH: number, scrollTop: number, viewportH: number, overscan: number): { start: number; end: number } {
  const n = tops.length;
  if (n === 0) return { start: 0, end: 0 };
  let start = 0;
  while (start < n - 1 && tops[start + 1] <= scrollTop) start++;
  let end = start;
  const bottom = scrollTop + viewportH;
  while (end < n && tops[end] < bottom) end++;
  return { start: Math.max(0, start - overscan), end: Math.min(n, end + overscan) };
}
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit**

```bash
git add src/lib/skillGroups.ts src/lib/__tests__/skillGroups.test.ts
git commit -m "feat(c3): add flattenRows/rowOffsets/visibleSlice virtualization helpers with tests"
```

---

## Task 3: `SkillPalette.tsx` — the dockable virtualized panel

**Files:** Create `src/components/skills/SkillPalette.tsx`

Render contract (apply hallmark structure / impeccable craft / emil motion):
- A fixed LEFT dock `width: 360px`, full height under the title bar, `bg-panel`, right border; a
  framer dim scrim over the rest (`bg` @ 55%, does NOT close on click — persistent). Open/close + dim
  ≤180ms ease-out; instant when `useReducedMotion()`.
- Header: "✦ Skills" title + result-count `aria-live="polite"` + ✕ close button.
- Search `<input role="combobox">` (debounced ~120ms into `query`), `aria-controls` the listbox.
- Body: a scroll container (`onScroll` → `scrollTop`) of fixed total height (spacer div) with only the
  `visibleSlice` rows absolutely positioned at their `tops[i]`. Header rows = family buttons
  (`aria-expanded`, toggle collapse, show count). Item rows = skill button (title `/id` + family chip +
  hint), `role="option"`, `aria-selected` on the active row.
- Keyboard: ↑/↓ move `activeIdx` over ITEM rows only (skip headers), scroll active into view; Enter →
  `onPick(skill)`; Esc → `onClose()`. Visible focus ring throughout.
- Pick default: close after pick (PRD default).

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Search, X, ChevronDown, ChevronRight, CornerDownLeft } from "lucide-react";
import type { MissionSkill } from "../../lib/missionSkills";
import { groupSkills, flattenRows, rowOffsets, visibleSlice } from "../../lib/skillGroups";
import { tok } from "../../lib/agentMeta";

const HEADER_H = 30;
const ITEM_H = 46;
const OVERSCAN = 4;

export function SkillPalette({
  open, onClose, skills, onPick,
}: {
  open: boolean;
  onClose: () => void;
  skills: readonly MissionSkill[];
  onPick: (s: MissionSkill) => void;
}) {
  const reduce = useReducedMotion();
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [activeIdx, setActiveIdx] = useState(0); // index into rows (item rows only are selectable)
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Debounce the query (≈120ms) so 1,870-entry filtering doesn't run per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 120);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const groups = useMemo(() => groupSkills(skills, query), [skills, query]);
  const rows = useMemo(() => flattenRows(groups, collapsed), [groups, collapsed]);
  const { tops, total } = useMemo(() => rowOffsets(rows, HEADER_H, ITEM_H), [rows]);
  const itemIdx = useMemo(() => rows.map((r, i) => (r.type === "item" ? i : -1)).filter((i) => i >= 0), [rows]);
  const resultCount = useMemo(() => groups.reduce((n, g) => n + g.count, 0), [groups]);

  const { start, end } = visibleSlice(tops, ITEM_H, scrollTop, viewportH, OVERSCAN);

  // Reset on open + focus input.
  useEffect(() => {
    if (!open) return;
    setRawQuery(""); setQuery(""); setCollapsed(new Set()); setActiveIdx(0); setScrollTop(0);
    if (scrollRef.current) setViewportH(scrollRef.current.clientHeight || 600);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Keep active within selectable rows.
  useEffect(() => {
    if (!itemIdx.includes(activeIdx) && itemIdx.length) setActiveIdx(itemIdx[0]);
  }, [itemIdx, activeIdx]);

  const scrollActiveIntoView = useCallback((rowIndex: number) => {
    const el = scrollRef.current; if (!el) return;
    const top = tops[rowIndex] ?? 0;
    const bottom = top + ITEM_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [tops]);

  const move = (dir: 1 | -1) => {
    if (!itemIdx.length) return;
    const pos = itemIdx.indexOf(activeIdx);
    const next = itemIdx[(pos + dir + itemIdx.length) % itemIdx.length];
    setActiveIdx(next);
    scrollActiveIntoView(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const r = rows[activeIdx];
      if (r?.type === "item" && r.skill) { onPick(r.skill); onClose(); }
    } else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  const toggle = (family: string) =>
    setCollapsed((c) => { const n = new Set(c); n.has(family) ? n.delete(family) : n.add(family); return n; });

  return (
    <AnimatePresence>
      {open && (
        <div key="skills" className="fixed inset-0 z-[70]" aria-hidden={false}>
          {/* dim scrim — persistent: clicking it does NOT close (Esc/✕/toggle only) */}
          <motion.div
            className="absolute inset-0"
            style={{ backgroundColor: `color-mix(in oklch, ${tok("bg")} 55%, transparent)` }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.16 }} aria-hidden
          />
          <motion.aside
            className="absolute left-0 top-0 flex h-full w-[360px] flex-col border-r border-border bg-panel shadow-2xl"
            style={{ paddingTop: "var(--titlebar-h)" }}
            role="dialog" aria-label="Skills palette"
            initial={{ x: reduce ? 0 : -24, opacity: reduce ? 1 : 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: reduce ? 0 : -16, opacity: reduce ? 1 : 0 }}
            transition={{ duration: reduce ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
            onKeyDown={onKeyDown}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <span className="text-[13px] font-semibold tracking-tight" style={{ color: tok("text") }}>✦ Skills</span>
              <span className="ml-auto font-mono text-[11px] tabular-nums" style={{ color: tok("muted") }} role="status" aria-live="polite">
                {resultCount} {resultCount === 1 ? "skill" : "skills"}
              </span>
              <button type="button" onClick={onClose} aria-label="Close skills palette"
                className="rounded-md p-1 outline-none transition-colors duration-150 hover:bg-panel-2 focus-visible:ring-2 motion-reduce:transition-none"
                style={{ color: tok("muted") }}>
                <X size={15} aria-hidden />
              </button>
            </div>

            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search size={15} aria-hidden style={{ color: tok("muted") }} />
              <input
                ref={inputRef} value={rawQuery} onChange={(e) => setRawQuery(e.target.value)}
                role="combobox" aria-expanded aria-controls="skills-list"
                aria-activedescendant={rows[activeIdx]?.type === "item" ? `skill-opt-${activeIdx}` : undefined}
                aria-autocomplete="list" placeholder="Search skills…" spellCheck={false} autoComplete="off"
                className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted"
                style={{ color: tok("text") }}
              />
            </div>

            {resultCount === 0 ? (
              <p className="px-4 py-8 text-center text-[13px]" style={{ color: tok("muted") }}>No skills match “{query}”.</p>
            ) : (
              <div
                ref={scrollRef} id="skills-list" role="listbox" aria-label="Skills"
                className="relative min-h-0 flex-1 overflow-y-auto"
                onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
              >
                <div style={{ height: total, position: "relative" }}>
                  {rows.slice(start, end).map((r, k) => {
                    const i = start + k;
                    const style: React.CSSProperties = { position: "absolute", top: tops[i], left: 0, right: 0, height: r.type === "header" ? HEADER_H : ITEM_H };
                    if (r.type === "header") {
                      const isCollapsed = collapsed.has(r.family);
                      return (
                        <button key={`h-${r.family}`} type="button" style={style}
                          onClick={() => toggle(r.family)} aria-expanded={!isCollapsed}
                          className="flex w-full items-center gap-1.5 px-3 text-left outline-none focus-visible:ring-2"
                        >
                          {isCollapsed ? <ChevronRight size={13} aria-hidden style={{ color: tok("muted") }} /> : <ChevronDown size={13} aria-hidden style={{ color: tok("muted") }} />}
                          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: tok("muted") }}>{r.family}</span>
                          <span className="font-mono text-[10px] tabular-nums" style={{ color: tok("muted"), opacity: 0.7 }}>{r.count}</span>
                        </button>
                      );
                    }
                    const s = r.skill!;
                    const isActive = i === activeIdx;
                    return (
                      <button key={`${s.kind}-${s.id}`} id={`skill-opt-${i}`} type="button" style={style}
                        role="option" aria-selected={isActive}
                        onMouseEnter={() => setActiveIdx(i)} onClick={() => { onPick(s); onClose(); }}
                        className="flex w-full items-center gap-2 px-3 text-left outline-none focus-visible:ring-2"
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-mono text-[12px]" style={{ color: tok("text"), backgroundColor: isActive ? `color-mix(in oklch, ${tok("accent-cyan")} 14%, transparent)` : "transparent" }}>{s.title}</span>
                          <span className="truncate text-[11px]" style={{ color: tok("muted") }}>{s.hint}</span>
                        </span>
                        {isActive && <CornerDownLeft size={12} aria-hidden style={{ color: tok("accent-cyan") }} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 2: Typecheck** — `npm run typecheck` → exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/skills/SkillPalette.tsx
git commit -m "feat(c3): add dockable virtualized SkillPalette component"
```

---

## Task 4: Wire TitleBar "✦ Skills" button

**Files:** Modify `src/components/shell/TitleBar.tsx`

- [ ] **Step 1: Add `onOpenSkills` to props + a NavButton** (use `Library` icon from lucide-react)

In imports add `Library`. In `TitleBarProps` add `onOpenSkills: () => void;`. In the destructure add
`onOpenSkills`. Before the Swarm `NavButton` in the right cluster, add:

```tsx
<NavButton label="Skills" icon={Library} onClick={onOpenSkills} />
```

- [ ] **Step 2: Typecheck** → exit 0 (will fail until App passes `onOpenSkills` — do Task 5 together).

---

## Task 5: Wire App — state, mount, "/", lazy load, pick, ⌘K command

**Files:** Modify `src/App.tsx`

- [ ] **Step 1: Lazy-load the catalog + add state** (near other useState)

```tsx
const [skillsOpen, setSkillsOpen] = useState(false);
const [catalog, setCatalog] = useState<readonly import("./lib/missionSkills").MissionSkill[]>([]);
useEffect(() => {
  if (skillsOpen && catalog.length === 0) {
    import("./lib/missionSkills").then((m) => setCatalog(m.MISSION_SKILLS));
  }
}, [skillsOpen, catalog.length]);
```

- [ ] **Step 2: "/" global opener** — extend the existing keydown effect (App.tsx:247). Open Skills on
"/" only when not typing in a field:

```tsx
if (e.key === "/" && !skillsOpen) {
  const t = e.target as HTMLElement;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (!typing) { e.preventDefault(); setSkillsOpen(true); }
}
```

- [ ] **Step 3: Pick handler → existing prefill flow** (reuse `setPrefill`/`dispatchGoal`)

```tsx
const pickSkillIntoComposer = useCallback((s: import("./lib/missionSkills").MissionSkill) => {
  setPrefill((p) => ({ text: s.prompt, nonce: p.nonce + 1 }));
}, []);
```

- [ ] **Step 4: Pass `onOpenSkills` to TitleBar + mount `<SkillPalette>`**

```tsx
// TitleBar:
onOpenSkills={() => setSkillsOpen(true)}
// near <CommandPalette ... /> (App.tsx:452):
<SkillPalette open={skillsOpen} onClose={() => setSkillsOpen(false)} skills={catalog} onPick={pickSkillIntoComposer} />
```

Add the import: `import { SkillPalette } from "./components/skills/SkillPalette";`

- [ ] **Step 5: Add a ⌘K command entry** — in the `paletteCommands` list add:

```tsx
{ id: "open-skills", group: "Open", title: "Skills palette", hint: "/", run: () => setSkillsOpen(true) },
```

- [ ] **Step 6: typecheck + build**

Run: `npm run typecheck && npm run build` → both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/components/shell/TitleBar.tsx
git commit -m "feat(c3): wire SkillPalette — title-bar button, '/' + ⌘K openers, prefill pick"
```

---

## Task 6: Browser verification (webapp-testing — dev) + perf

- [ ] **Step 1: Start dev** (`npm run dev`, port 3004) and open the cockpit.
- [ ] **Step 2: Open** — click "✦ Skills" → dock slides in from left, cockpit dims, stays open.
- [ ] **Step 3: "/"** — press "/" with nothing focused → opens. ⌘K → "Skills palette" → opens.
- [ ] **Step 4: Search** — type `impeccable` → filters to ui/ux; type `zzzz` → empty state.
- [ ] **Step 5: Collapse** — click a family header → collapses (chevron flips, items hide, count stays).
- [ ] **Step 6: Keyboard** — ↑↓ move selection, active row highlighted + scrolled into view; Enter →
  prompt drops into composer + composer focused; Esc → closes.
- [ ] **Step 7: Virtualization proof** — with all families expanded (~1,870 rows), inspect the DOM:
  only a small window of rows is mounted (count `[role=option]` nodes « 1,870). Scroll stays smooth.
- [ ] **Step 8: Screenshot** — palette open with a family expanded + a search active.

- [ ] **Step 9: Packaged Electron** — `npm run build` then run packaged app; repeat open/search/pick.

---

## Task 7: Reviewer gates + verification

- [ ] **Step 1: `react-reviewer`** — hook correctness (deps, no stale closures in keyboard/scroll),
  key stability (`${kind}-${id}`), no re-render storms; virtualization slice correctness.
- [ ] **Step 2: `performance-engineer`** — confirm only visible rows mount; 60fps scroll at 1,870 rows;
  debounced search; lazy catalog keeps it out of first paint.
- [ ] **Step 3: `ui-ux-tester`** — open/search/collapse/keyboard/pick flows; no dead ends; empty state.
- [ ] **Step 4: `sp-verification-before-completion`** — all C3 Given/When/Then green; `test:unit` +
  `typecheck` + `build` + agent-runtime 297 all green.

---

## Self-Review (plan vs C3 spec)

- **Opens via ✦ Skills / "/" / ⌘K; persistent until Esc/✕/toggle** → Tasks 4,5 (+ scrim non-closing). ✔
- **Collapsible family sections + counts** → header rows toggle `collapsed`; count shown. ✔
- **Live search, debounced, empty state** → 120ms debounce + empty branch. ✔
- **Virtualized — only visible rows mount @ 1,870** → `visibleSlice` + absolute rows; Task 6.7 proof. ✔
- **↑↓/Enter/Esc keyboard** → `onKeyDown` + `move`. ✔
- **Pick → prompt into composer, focus** → `pickSkillIntoComposer` → `setPrefill` → ChatPane. ✔
- **Cockpit dims but visible (docked, not modal-blocking)** → left aside + 55% scrim, non-closing. ✔
- **Dark palette, no pink, reduced-motion** → `tok()` cyan accent only; `useReducedMotion`. ✔
- **Keep ⌘K CommandPalette separate** → actions ⌘K unchanged; Skills via new command entry + button + "/". ✔
- **No new execution path** → pick only sets `prefill`; send stays in ChatPane gate. ✔
- **Placeholder/type scan:** `groupSkills`/`flattenRows`/`rowOffsets`/`visibleSlice`/`FlatRow` consistent
  across tasks; `MissionSkill` imported, `family: string`. ✔

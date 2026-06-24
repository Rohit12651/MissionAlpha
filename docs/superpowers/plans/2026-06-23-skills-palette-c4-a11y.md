# C4 — Skills Palette Accessibility (WCAG 2.2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps `- [ ]`.
> Fire: sp-writing-plans → kw-design-accessibility-review → a11y-architect + accessibility-tester +
> ui-ux-tester → sp-verification-before-completion. Ends with a desktop repackage + verify.

**Goal:** Make `SkillPalette` fully keyboard + screen-reader operable to WCAG 2.2 AA — correct
listbox/option semantics, per-row SR announcement (id + family + kind), live result count, real
`aria-expanded` family buttons, visible focus ring, `prefers-reduced-motion` instant, contrast ≥4.5:1 —
and ship it into the packaged desktop app.

**Architecture:** Most semantics already landed in C3 (`role="listbox"`, `aria-activedescendant`,
header buttons with `aria-expanded`, `aria-live` count, `focus-visible:ring-2`, `useReducedMotion`).
C4 closes the gaps the C3 react-review flagged + a formal WCAG pass: (1) per-option `aria-label`,
(2) guard `aria-activedescendant` against virtualized off-window ids, (3) verify/fix contrast, then
audit with the a11y agents and repackage.

---

## Gaps to close (from C3 review + WCAG 2.2)

1. **Per-row announcement** — option buttons announce only visible text; add `aria-label` = `id, family, kind`.
2. **Dangling `aria-activedescendant`** — when `activeIdx` is outside `[start,end]` (off-window) or on a
   header, the referenced id isn't in the DOM. Guard it.
3. **Contrast** — verify hint text (`--c-muted`) ≥4.5:1 on `--c-panel` in BOTH themes; bump if under.
4. **Reduced motion** — confirm open/close + dim are instant under `prefers-reduced-motion` (already wired).
5. **Keyboard completeness** — open→search→↑↓→Enter→Esc all reachable; visible focus ring throughout.

---

## File Structure

- Modify: `src/components/skills/SkillPalette.tsx` — `aria-label` per option, `aria-activedescendant` guard,
  any contrast token fix.
- Modify (if needed): `src/index.css` — a dedicated `--c-muted-strong` if `--c-muted` fails 4.5:1 for hints.

---

## Task 1: Per-option `aria-label` (id + family + kind)

- [ ] **Step 1: Edit the option button** in `SkillPalette.tsx` — add to the item `<button role="option">`:

```tsx
aria-label={`${s.title}, ${s.family}, ${s.kind}`}
```

- [ ] **Step 2: Typecheck** → exit 0.

---

## Task 2: Guard `aria-activedescendant` against off-window / header ids

- [ ] **Step 1: Replace the input's `aria-activedescendant`** so it only points at an item row that is
actually mounted in the current virtual window:

```tsx
aria-activedescendant={
  rows[activeIdx]?.type === "item" && activeIdx >= start && activeIdx < end
    ? `skill-opt-${activeIdx}`
    : undefined
}
```

- [ ] **Step 2: Typecheck** → exit 0.

---

## Task 3: Contrast verification + fix (≥4.5:1)

- [ ] **Step 1: Measure** the hint text (`--c-muted` on `--c-panel`) and family-header text in both
themes (dark `:root`, light `.light`). Tool: a11y-architect / accessibility-tester computes the ratio
from the oklch tokens in `src/index.css`.
- [ ] **Step 2: If under 4.5:1**, introduce `--c-muted-strong` (dark + light) and use it for the hint +
header label in `SkillPalette.tsx`. If already ≥4.5:1, record the measured ratios and make no change.
- [ ] **Step 3: typecheck + build** → exit 0.

---

## Task 4: A11y audit (agents) — fix findings

- [ ] **Step 1: `kw-design-accessibility-review`** skill + **`a11y-architect`** (WCAG 2.2) — audit
  `SkillPalette.tsx`: listbox/option/aria-activedescendant correctness, header `aria-expanded` buttons,
  `aria-live` count, focus order, focus ring visibility, reduced-motion, contrast ratios (numbers).
- [ ] **Step 2: `accessibility-tester`** — keyboard-only walkthrough + SR semantics over the live dev build.
- [ ] **Step 3: `ui-ux-tester`** — open/search/collapse/keyboard/pick flows, no dead ends.
- [ ] **Step 4:** Apply any CRITICAL/HIGH fixes they return; re-run typecheck/build.

---

## Task 5: Browser verification (a11y assertions)

- [ ] **Step 1:** Playwright over dev build: assert
  `[role="listbox"]` present; every visible `[role="option"]` has a non-empty `aria-label`;
  family header buttons have `aria-expanded`; the count node has `aria-live="polite"`; tab/arrow/enter/esc
  reachable; under `prefers-reduced-motion: reduce` the open is instant.
- [ ] **Step 2:** Screenshot keyboard focus ring on an option.

---

## Task 6: Ship to desktop (repackage + verify)

- [ ] **Step 1:** `npm run test:unit && npm run typecheck && npm run build` → 76 / 0 / 0.
- [ ] **Step 2:** `npm run electron:build` → repackage `release/mac-arm64/MissionAlpha.app` + dmg.
- [ ] **Step 3:** Hard-quit any running instance (`pkill -9 -f MissionAlpha`) then relaunch the fresh
  `.app` (a live renderer pins the old asar — MUST quit first).
- [ ] **Step 4:** Confirm in the packaged app: open palette, the a11y attributes are present
  (grep the new `app.asar` for `aria-label`/`aria-activedescendant` on options), keyboard nav works.
- [ ] **Step 5: `sp-verification-before-completion`** — all C4 acceptance green.

---

## Self-Review (plan vs C4 spec)

- **role="listbox" + aria-activedescendant** → present (C3) + guarded (Task 2). ✔
- **Family headers real buttons w/ aria-expanded** → C3. ✔
- **aria-live result count** → C3 `role="status" aria-live="polite"`. ✔
- **Each row announces id + family + kind** → Task 1 aria-label. ✔
- **Visible focus ring** → `focus-visible:ring-2` (C3) + verify Task 5. ✔
- **prefers-reduced-motion instant** → `useReducedMotion` (C3) + assert Task 5. ✔
- **Contrast ≥4.5:1** → Task 3 measure + fix. ✔
- **Ships in desktop** → Task 6 repackage + verify. ✔

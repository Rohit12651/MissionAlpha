# UX / Design Contract — Agent Factory (4 surfaces)

**Author:** principal-ux-design · **Date:** 2026-06-17 · Consumes: impeccable, emil-design-eng, hallmark.
Stack: React 19 + Vite + Tailwind + framer-motion. Match existing visual grammar exactly (see `src/index.css`, `PermissionGate.tsx`, `BossConsole.tsx`, `agentMeta.ts` `tok()`).

## New token — `--c-factory-violet` (only addition)
Add to both theme blocks in `src/index.css` after `--c-ceo-gold`:
```css
/* dark (:root) */  --c-factory-violet: oklch(0.78 0.13 300);
/* light */          --c-factory-violet: oklch(0.48 0.18 300);
```
Contrast: dark 0.78 on panel(0.2) ≈ 7.6:1, on bg ≈ 8.4:1; light 0.48 on white ≈ 5.0:1, on bg ≈ 4.8:1 — all ≥AA 4.5. Hue 300 is distinct from cyan(200)/gold(90)/amber(75): no status-color clash. `tok("factory-violet")` resolves automatically.

## Grammar (locked from existing code)
Type: mono `[9px]/[10px]/[11px] uppercase tracking-wide` labels; body `[12px]/[13px]`; heads `[14px]/[15px]`. Accent recipe (reuse %): wash 8%, chip-bg 10%, button-bg 14%, chip-border 24%, sub-border 26%, button-border 34%, glow `0 0 32px -8px`. Radii `rounded-md`/`rounded-[14px]`/`rounded-full`. Motion: branch on `useReducedMotion()`, enter ease-out ≤300ms (0.14/0.18/0.24), scale `0.95→1` (never `scale(0)`), never `easeIn` on UI, `▍ animate-pulse` for thinking, suppress `Loader2` spin under reduced-motion.

## 4 surfaces = 4 distinct macrostructures (hallmark anti-slop)
1. **Create-Agent flow** — console flow, NOT a stacked form. Violet describe-textarea ("what should this agent do?") → streamed authoring panel (auto-scroll, thinking cursor) → **spec review card** revealing staggered sections: editable title/role + id + tier badge, collapsible persona preview, violet skill chips, neutral tool badges, cyan integration chips, gold "CAN POST" marker → Discard / Re-author / Confirm.
2. **Agent gallery** — banded responsive grid (1/2/3/4 cols): "BUILT-IN SWARM" band + violet "CREATED BY BOSS" band. Card: status dot (`agentAccent`), `TIER_LABEL` badge, title + role-id, violet Crown "MADE BY BOSS" marker (created only), skill chips +overflow, click→drawer/detail. Stagger first ~12 cards. Dashed empty state for the created band.
3. **Skill catalog** — dense searchable list (NOT a grid; no stagger). Standalone + pick-mode (`mode` prop) inside create flow. Sticky search + platform filter, rows: label / id / description / tool+integration chips, gold "POSTS" badge for posting skills.
4. **Per-post approval modal** — `PostApprovalGate`, a `PermissionGate` fork (verbatim alertdialog / focus-trap / ESC / motion). Violet frame + gold confirm. Body: violet account-handle chips ("Posting to"), rendered content preview (scrollable, char count with amber/red limit state), cyan "DRY RUN" marker, confirm = "Post to N account(s)".

All four: empty/loading/error states; mobile 320–768 (full-screen sheets, sticky action bar, ≥44px targets); a11y inherits PermissionGate keyboard contract; OKLCH tokens only, zero inline hex.

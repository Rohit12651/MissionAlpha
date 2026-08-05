# Standalone Design + A11y Audit — Agent Inbox (post-P10 final gate)

**Date:** 2026-07-30 · **Product:** MissionAlpha — The Agent Inbox · **Record type:** PES audit + remediation record.

Closes the two OPTIONAL depth-gaps left open at P10 handoff (FINAL-SWEEP §4 items 5 & 6):
a standalone `hallmark`+`impeccable` scored design audit over the whole app (the design
gauntlet had only been applied *per-phase at build time*, never re-run as a final gate),
and a full WCAG 2.2 AA accessibility pass (P10 had only automated basics). Both audits were
run against the **live app** at `http://localhost:3004` plus the design-system source.

**No commits** — the global no-commit rule (program plan §4) is still in force; all work
sits in the working tree.

---

## 1. Scope — what was audited (honest boundary)

**Audited (live + source):**
- **Inbox** (product core) — page head, scoreboard chip, Queue panel, filter pills, delivery cards, empty/note states — desktop + **375 px** mobile.
- **ReviewPane** — text-rendered diff (P3 XSS guard confirmed), feedback textarea, Approve/Request-changes/Reject action set. *Read-only inspection — no Approve/Reject/Apply was clicked (they mutate the live repo).*
- **Global helm design system** — `src/theme/helm.css` (532 lines) read in full: tokens, motion, focus, reduced-motion, 8-state components.
- **Structural a11y** — the live accessibility tree (landmarks, headings, labels, tab order) via DOM inspection + computed WCAG contrast on every token pair.

**Not individually screen-walked (labeled gap):** Board, Settings (Policy/Workspace/Adapters/Users), Login gate, Onboarding. These render under the **same helm skin + tokens**, so the token-contrast and focus findings apply to them and the fixes propagate; they were not screenshotted surface-by-surface. The **light theme** is a non-helm legacy chrome path — the helm product surface is **dark-only by design** (confirmed: `helm.css` carries no light variant across all 532 lines), so there is no separate light-Inbox to audit.

---

## 2. Hallmark scored verdict

The Inbox CSS is stamped `Workbench (two-pane queue + sticky review) · technical-luxury · studied-DNA from the repo's own mockup`, with a self-declared pre-emit critique of **P5 H5 E4 S5 R5 V4**. Independent re-score confirms it:

| Axis | Score | Evidence |
|---|---|---|
| **Philosophy** | 5 | Coherent technical-luxury POV; studied-DNA from the repo's own design target; not a generic template. |
| **Hierarchy** | 5 | eyebrow → H1 → scoreboard → Queue panel → cards; scale + weight contrast throughout. |
| **Execution** | **4 → 5** | Fully tokenized, 8-state buttons, motion discipline, focus rings. *The one gap that held it at E4 was small-text contrast (§4) — now fixed → E5.* |
| **Specificity** | 5 | Domain-specific brass/ink, deliveries/queue/SLA vocabulary; nothing off-the-shelf. |
| **Restraint** | 5 | Calm, muted, no gratuitous motion. |
| **Variety** | 4 | Single skin — correct for an app (consistency > page-variety); not a slop signal. |

**Slop test:** no tells. Structural fingerprint is Workbench, not the AI hero→3-card→CTA template (N/A for an app). No generic gradient blobs, real font pairing (Space Grotesk/Lato display + IBM Plex mono system labels), semantic (not decorative) color, disciplined depth. **Verdict: passes the slop test; ship-grade design.**

**impeccable / emil / taste cross-check:** clean. Motion is `transform`+`opacity` only, every duration ≤ 240 ms, `--ease-out` cubic-bezier, `scale(0.97)` on press, focus rings **never animated** (shown instantly). Reduced-motion is handled **twice** — the `prefers-reduced-motion` media query *and* an explicit `[data-reduce-motion="on"]` Settings toggle (ADR-040) — stripping translate/scale/loops while keeping meaning-carrying opacity crossfades ≤ 140 ms. SLA "breathe" animates opacity only, runs only under 1 h remaining, and the countdown text still ticks (information, not motion) under reduced-motion. Hover states are correctly gated behind `@media (hover:hover) and (pointer:fine)`. Diff surface uses `overflow-x:auto` so the page body never h-scrolls at 320 px.

---

## 3. WCAG 2.2 AA — pass ledger (structural)

Verified against the live DOM + computed styles:

| Criterion | Result | Evidence |
|---|---|---|
| 1.1.1 Non-text content | PASS | 0 images without `alt`; globe backdrop is `aria-hidden`. |
| 1.3.1 Info & relationships | **FIX** → PASS | Labeled `banner`/`region`/`status`/`list` landmarks present; **Inbox had no `<main>`** → added (§4). |
| 1.4.3 Contrast (minimum) | **FIX** → PASS | Two token FAILs found + fixed (§4); all others 5.2–15:1. |
| 1.4.10 Reflow | PASS | No page h-scroll at 375 px or 320 px; diff scrolls inside its own box. |
| 1.4.11 Non-text contrast | PASS | Focus ring (brass-bright) **9.89:1** on ink (≥ 3). |
| 2.1.2 No keyboard trap | PASS | ReviewPane closes on **ESC** (tested live). |
| 2.4.1 Bypass blocks | **FIX** → PASS | Skip link added (§4) + `<main>` landmark. |
| 2.4.7 / 2.4.11 Focus visible | PASS | `:focus-visible` 2 px brass-bright ring, offset 2 px, instant; **confirmed on a real keyboard Tab** (ring rendered on the "All" pill). |
| 2.3.3 Animation from interactions | PASS | Reduced-motion honored via media query + explicit toggle. |
| 3.1.1 Language of page | PASS | `<html lang="en">`. |
| 3.3.2 / 4.1.2 Labels / name-role-value | PASS | 0 unlabeled buttons, 0 unlabeled inputs, 0 positive `tabindex`. |

---

## 4. Findings fixed this lane (Major)

All three are `[data-skin="helm"]`-scoped or shell-level → one fix corrects the whole product surface (Inbox, Board, Settings, Login, Onboarding all share the helm tokens).

### 4.1 Contrast — `--helm-paper-faint` (SC 1.4.3) — **MAJOR**
`#5d6579` drove eyebrows (11 px), chip labels ("UNRATED" 9.5 px), diff-meta, dashed notes, input placeholders.
Measured **2.70:1** on the chip deck, **2.95** on card deck, **3.21** on ink — all below AA 4.5:1.
**Fix:** `#5d6579 → #868fa3` (`src/theme/helm.css`). Now **4.84 / 5.30 / 5.77:1** — clears AA everywhere, stays below `--helm-paper-dim` so the paper/dim/faint tiers still read.

### 4.2 Contrast — `--helm-red` (SC 1.4.3) — **MAJOR**
`#c1554a` drove diff-del lines, reject-button text, failure chips ("12 FAILED", "6 FAIL", "REJECTED").
Measured **3.82:1** on deck, **4.16** on ink — below AA.
**Fix:** `#c1554a → #d16a5f` (`src/theme/helm.css`). Now **4.86 / 5.29 / 5.42:1** — clears AA, preserves the semantic-red identity.

### 4.3 Missing `<main>` landmark + no skip link (SC 1.3.1 / 2.4.1) — **MAJOR**
The Inbox rendered `InboxPanel` inside a plain `<div>` — the live tree had **0 `<main>`** on the product's primary surface (the existing `<main>` belongs to the legacy Board column).
**Fix (`src/App.tsx`):** Inbox container `<div>` → `<main id="ma-main" aria-label="Inbox">` (one main on the view, labeled); the Board `<main>` also gets `id="ma-main"` + `aria-label` so the skip link targets correctly in both views. Added a **skip link** as the first focusable element (`<a href="#ma-main">Skip to main content</a>`) with a dedicated `.ma-skip-link` rule in `src/index.css` (theme-aware via `--c-*` tokens; a plain rule rather than Tailwind `focus:` variants so it reveals in both dev and prod, independent of JIT). Verified **first-tabbable in DOM order**, tabbable (block/visible/natural tab-index), target `#ma-main` resolves.

---

## 5. Verification (independent — this lane)

- **Gates (final code):** `typecheck` 0 · `lint` 0/0 · `test:unit` **211/211** · `build` PASS · `index` **187.33 KB gz** (≤ 190 budget). Backend `test:runtime` (773) unaffected — no `agent-runtime/` change.
- **Live contrast re-run** (computed from the reloaded app's token values): **all pairs ≥ 4.5** — faint 4.84/5.30/5.77, red 4.86/5.29/5.42. `allPass: true`.
- **Landmark:** live DOM shows exactly one `MAIN[aria-label="Inbox"]#ma-main` on the Inbox view (was 0).
- **Skip link:** first-tabbable confirmed; reveal `:focus`/`:focus-visible` rule present in both the live stylesheet and the built `dist/assets/index-*.css`.
- **Focus rings:** real keyboard Tab rendered the brass focus-visible ring (observed on the "All" filter pill).
- **Visual regression:** screenshot-compared before/after — Inbox pixel-stable; the only change is marginally more legible faint labels and failure chips (the intended AA bump). No layout shift.
- **Diff scope:** 3 files, +45 / −5. No stray edits.

---

## 6. Known gaps & follow-ups (labeled)

1. **Legacy-cockpit double `role="main"`.** In the *legacy* Board view (non-default), `App.tsx`'s board `<main>` and `ChatPane.tsx`'s `<section role="main">` both render on desktop → two main landmarks. Pre-existing; **not fixed** this lane to keep the change surgical and scoped to the product surface (Operating Discipline 3). Recommended follow-up: change `ChatPane.tsx:606` `role="main"` → `aria-label="Conversation"` (drop the redundant landmark). Low risk, one attribute.
2. **Un-screen-walked surfaces.** Board / Settings / Login / Onboarding were not screenshotted individually (§1). They share the helm tokens (so the contrast + focus fixes apply) but a per-surface pixel sign-off was not performed.
3. **Shallow heading outline.** The Inbox exposes one `<h1>`; sub-sections (Queue, Filters, System status) are labeled `region`/`status` landmarks rather than headings — valid, but a richer heading outline would aid screen-reader navigation. Not a violation; left as-is.
4. **Skip-link live reveal not screenshotted.** Proven structurally (first-tabbable + correct `:focus` CSS in live sheet and built `dist`) rather than via a Tab-from-document-top screenshot — the browser-pane automation seeds focus mid-page, which makes a clean top-of-document Tab capture unreliable. The built artifact is authoritative.

---

## 7. Verdict

The Agent Inbox was already ship-grade design (hallmark P5 H5 E4 S5 R5 V4, slop-test clean, emil-compliant motion). This lane closed the one execution gap — **three WCAG AA failures** (two small-text contrast tokens + a missing `<main>`/skip link) — with a surgical 3-file change (45 lines), all gates re-green and every fix independently live-verified. Design execution is now effectively **E5**, and the product surface meets **WCAG 2.2 AA** on the audited criteria. FINAL-SWEEP §4 items 5 and 6 are closed for the audited scope; the labeled follow-ups above are the remaining, non-blocking work.

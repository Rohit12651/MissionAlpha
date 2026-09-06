# Type scale — the 9-step ladder and the full mapping

**Status:** decided. **Blocks:** Phase 9 (A2 component sweep).
**Owner decision, not a measurement.** The spec (`2026-08-10-excellence-manifesto-review.md`
rev 3) deliberately did not make this call; Phase 8 Task 8.0 makes it here, in writing,
before any component is touched.

---

## 1. What is actually there today

Measured on the working tree, not estimated:

```bash
grep -rhoE 'text-\[[0-9]+(\.[0-9]+)?px\]' src --include='*.tsx' | sort | uniq -c | sort -rn
grep -rhoE 'font-size:\s*[0-9]+(\.[0-9]+)?px' src/theme/*.css src/index.css | sort | uniq -c
```

| Surface | Distinct sizes | Total sites | Sub-12px sites |
|---|---|---|---|
| `.tsx` (`text-[Npx]`) | **15** | **556** across **64 files** | **372** |
| CSS (`font-size: Npx`) | **21** | 176 | **95** |

`.tsx` histogram, largest populations first:
`11px ×166 · 10px ×137 · 12px ×115 · 9px ×48 · 13px ×42 · 12.5px ×12 · 11.5px ×10 ·
8px ×7 · 14px ×5 · 15px ×4 · 13.5px ×4 · 10.5px ×2 · 8.5px ×1 · 17px ×1 · 25px ×1`

CSS histogram:
`12px ×28 · 11px ×26 · 10px ×23 · 13px ×16 · 9.5px ×15 · 12.5px ×10 · 10.5px ×10 ·
9px ×9 · 11.5px ×8 · 16px ×5 · 14px ×5 · 8.5px ×3 · 13.5px ×3 · 22px ×2 · 20px ×2 ·
15px ×2 · 8px ×1 · 30px ×1 · 26px ×1 · 24px ×1 · 19px ×1`

**The diagnosis.** The half-pixel sizes (8.5, 9.5, 10.5, 11.5, 12.5, 13.5) are not design
decisions — they are the residue of nudging one component at a time. 30 distinct sizes
across two surfaces, more than half of them below the legibility floor, is not a scale.

---

## 2. The ladder

Nine steps. **12px is an absolute floor** — nothing renders smaller, anywhere.

| Step | Token | px | rem | Ratio to previous | Role |
|---|---|---|---|---|---|
| 1 | `--type-1` | **12** | 0.75 | — | **Floor.** Meta, timestamps, chips, table meta, badges, keyboard hints |
| 2 | `--type-2` | **13** | 0.8125 | 1.083 | Dense secondary text that must read above meta: list rows, log lines, diff bodies |
| 3 | `--type-3` | **14** | 0.875 | 1.077 | **Body default.** Labels, buttons, form text, paragraph copy |
| 4 | `--type-4` | **16** | 1.0 | 1.143 | Emphasis body. Inputs, card titles, the one-line answer on a panel |
| 5 | `--type-5` | **19** | 1.1875 | 1.188 | Subsection headings, panel titles |
| 6 | `--type-6` | **22** | 1.375 | 1.158 | Section headings |
| 7 | `--type-7` | **26** | 1.625 | 1.182 | Page titles |
| 8 | `--type-8` | **30** | 1.875 | 1.154 | Stat values (the tile numbers) |
| 9 | `--type-9` | **36** | 2.25 | 1.2 | Hero number. **RESERVED — no site uses it today** |

### Two honest notes on the ladder

**The bottom three steps are deliberately tighter than 1.2.** A 1.2 ratio from a 12px
floor gives 12 → 14.4 → 17.3, which offers exactly one usable size between "meta" and
"heading" in a console whose whole job is dense tabular state. Steps 1–3 sit at 1.08/1.08
because this product genuinely needs three legible weights of small text; 12 → 14.4 would
force half of them back below the floor within a release. Above 16px the ladder is a clean
~1.15–1.2 geometric progression, which is where ratio actually buys hierarchy.

**Step 9 is reserved and unused.** Nothing in the tree is above 30px. It is documented as
headroom rather than quietly dropped so the ladder stays nine steps as specified — but a
reviewer should treat any *new* `--type-9` usage as needing a reason, not as free.

---

## 3. THE MAPPING — every existing size to a step

This table is the contract for Phase 9. It is mechanical: no judgement is needed per site.

| Existing | → Step | → px | Why |
|---|---|---|---|
| `8px`, `8.5px`, `9px`, `9.5px` | 1 | 12 | Far below the floor. These are the worst offenders (66 sites) |
| `10px`, `10.5px` | 1 | 12 | Below the floor |
| `11px`, `11.5px` | 1 | 12 | Below the floor. Largest single population (176 tsx + 34 CSS) |
| `12px`, `12.5px` | 1 | 12 | Already at the floor; `.5` residue collapses |
| `13px`, `13.5px` | 2 | 13 | Real, distinct usage — kept as its own step |
| `14px` | 3 | 14 | Body default |
| `15px`, `16px` | 4 | 16 | 15 is residue; 16 is the intended emphasis size |
| `17px`, `19px`, `20px` | 5 | 19 | Subsection band |
| `22px` | 6 | 22 | Section band |
| `24px`, `25px`, `26px` | 7 | 26 | Page-title band; 24/25 are residue |
| `30px` | 8 | 30 | Stat value |
| *(none)* | 9 | 36 | Reserved |

### The consequence, stated plainly

**Everything below 13px collapses to 12px.** That is 372 `.tsx` sites and 95 CSS
declarations moving up — visually the single largest change in the whole program, and the
reason Phase 9 runs in batches of ~10 files with a screenshot diff between each. Rows will
get taller. Some fixed-height containers will need to grow. **That is the intended
outcome, not a regression to be tuned away by shrinking something else.**

---

## 4. Rules Phase 9 must not break

1. **12px floor, no exceptions.** Verified by:
   ```bash
   grep -rhoE 'text-\[([0-9]|1[01])(\.[0-9]+)?px\]' src --include='*.tsx' | wc -l   # expect 0
   grep -rhoE 'font-size:\s*([0-9]|1[01])(\.[0-9]+)?px' src/theme/*.css src/index.css | wc -l  # expect 0
   ```
2. **No half-pixel sizes survive.** `grep -rE '[0-9]\.[0-9]+px' src` must return nothing
   for `font-size` / `text-[…]`.
3. **Contrast is re-verified after every batch.** The baseline is 5.30–13.82:1; nothing
   may land below **4.5:1** (WCAG AA for body text). A size change alters perceived
   contrast requirements at the boundary — 12px text is not "large text" under WCAG, so
   the 3:1 allowance does NOT apply anywhere in this ladder except step 8 and above.
4. **A batch is not done until `npm run test:visual` has been run and every diff reviewed
   by eye.** There are zero component/DOM tests; the screenshot net is the only one.
5. **New code lands on the ladder.** Any component written from Phase 8 onward uses a
   step, never a raw pixel. (Phase 4's `DiffEditor` already does — it deliberately used
   12px rather than copying the legacy 11px from `DiffBlock`.)

---

## 5. Token surface

The ladder ships as custom properties in `src/theme/tokens.css`, consumed by both surfaces:

```css
:root {
  --type-1: 0.75rem;    /* 12px — floor */
  --type-2: 0.8125rem;  /* 13px */
  --type-3: 0.875rem;   /* 14px — body */
  --type-4: 1rem;       /* 16px */
  --type-5: 1.1875rem;  /* 19px */
  --type-6: 1.375rem;   /* 22px */
  --type-7: 1.625rem;   /* 26px */
  --type-8: 1.875rem;   /* 30px */
  --type-9: 2.25rem;    /* 36px — reserved */
}
```

`rem`, not `px`, so a user's browser font-size setting is honoured — a px-locked scale
silently overrides an accessibility preference. The comments carry the px value because
every measurement in this document and in the sweep is expressed in px.

**Root font-size assumption:** 16px (browser default, unmodified by the app). The rem
values above are exact at that root. If the app ever sets a root font-size, this table's
px column becomes wrong and must be recomputed — not quietly left stale.

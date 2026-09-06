// THE COMPARISON CONTRACT — single source of truth for every screenshot assertion.
//
// PHASE 0 (autonomy program). This file exists because the net was BLIND and read as
// strict. Both specs used to declare their own `const STRICT = { maxDiffPixels: 0,
// animations: "disabled" }` with the comment "maxDiffPixels: 0 — strict". It is not.
//
// `maxDiffPixels` bounds HOW MANY pixels may differ. What decides WHICH pixels count as
// differing is pixelmatch's `threshold`, and it was never set — so it sat at Playwright's
// default 0.2. pixelmatch flags a pixel only when its YIQ colour distance exceeds
// `35215 * threshold^2`, i.e. 1408.6 at 0.2. The Phase 8.2 surface rewrite moved
// #0b1220 -> #050a14 (delta 33), #121b2e -> #182238 (delta 33) and #1e2b45 -> #243350
// (delta 30). Every one of them is two orders of magnitude below the cutoff, so a full
// palette rewrite across ~1.1 MILLION pixels was reported as ZERO differing pixels and
// the suite went 30/30 against baselines painted in the OLD colours.
//
// A net that cannot see the change it exists to gate is worse than no net: it manufactures
// confidence. Phase 9 rewrites 372 type sites with this as its only safety net.
//
// WHY NOT SIMPLY threshold: 0. That was tried first and MEASURED, not assumed. At
// threshold 0 (any non-identical pixel counts) a clean re-run of the unchanged app failed
// 4 of 30 tests, at 2, 5, 12 and 29 differing pixels. Every one of those pixels sat on a
// single 2px-wide vertical edge and differed by EXACTLY ±1 in one or two channels — the
// rasteriser's sub-pixel anti-aliasing rounding on a border, which no amount of
// clock/RNG/animation freezing removes. A net that fails 4 tests per run on an unchanged
// tree gets re-baselined out of habit, and that is precisely how the blind net survived a
// whole session unchallenged.
//
// So the gate is set by CAUSE, not by count. pixelmatch's threshold is a colour-DISTANCE
// cutoff (`35215 * threshold^2`), and in that metric rounding noise is separated from
// every real change this program makes by more than an order of magnitude. Measured:
//
//   signal                                             YIQ delta   vs cutoff 5.07
//   worst-case ±1 rounding, [-1,+1,+1]                      0.54   9x below   -> ignored
//   worst-case ±2 rounding, [-2,+2,+2]                      2.17   2.3x below -> ignored
//   --helm-line-soft -> --helm-line (TIGHTEST real pair)   30.38   6x above   -> caught
//   --helm-ink -> --helm-deck                             303.53   60x above  -> caught
//   #0b1220 -> #050a14 (the rewrite the net could not see)  33.19  6.5x above -> caught
//   old default threshold 0.2                        cutoff 1408.60 -> ALL of the above missed
//
// 0.012 sits at the widest gap in that table.
export const SCREENSHOT_THRESHOLD = 0.012;

// ── A SECOND EXCLUSION THIS FILE DOES NOT CONTROL — read before trusting the table above.
//
// Found in independent review of this very phase, which is the point: the original version
// of this comment claimed `threshold` decides which pixels count. It is not the only thing.
// Verified against the INSTALLED comparator (node_modules/playwright-core/lib/coreBundle.js
// at @playwright/test 1.62.1), not against documentation:
//
//   :7551  pixelmatch is called with `threshold: options.threshold ?? 0.2` — and that is
//          the ONLY option Playwright forwards.
//   :6623  pixelmatch's own default `includeAA: false` therefore stands.
//   :6666  `if (!options.includeAA && (antialiased(img1,...) || antialiased(img2,...)))`
//          -> the pixel is skipped ENTIRELY, whatever its colour delta.
//
// So a pixel that pixelmatch's 3x3-neighbourhood heuristic classifies as antialiased in
// EITHER image is dropped before the threshold is ever applied, and never reaches the
// maxDiffPixels count. This cannot be configured through Playwright's public API.
//
// WHY THE NUMBERS ABOVE STILL HOLD: the heuristic classifies a pixel as antialiased only
// when it has no same-coloured neighbour and sits between neighbourhood extremes. A
// UNIFORM SURFACE REPAINT — which is what this program does — leaves interior pixels with
// identical neighbours, so they are not AA-classified and are counted. That is why the
// palette rewrite scored 772,073 differing pixels rather than zero.
//
// WHERE IT COULD STILL HIDE SOMETHING, stated: a change confined to GLYPH EDGES (for
// instance a text-colour tweak on very small type, where few interior pixels exist) is
// partially masked. Phase 9 changes type SIZES, which reflow whole glyph runs and repaint
// interiors, so it is not the exposure here — but a future colour-only change to small text
// is, and the batch-by-batch eye review remains the backstop for it.
//
// comparator-sensitivity.test.mjs pins both source facts, so a Playwright upgrade that
// changes either one fails a test instead of silently moving the goalposts again.

// ── the SECOND noise class, and why one number could not cover both ──────────
//
// After the threshold was set, a clean re-run still failed ONE test — always the same one,
// always 17 pixels, always flipping between the same two exact values (38,76,59 <-> 34,69,54).
// Traced to its owner with elementFromPoint: `.helm-chip`, whose fill is
// `color-mix(in srgb, var(--helm-green) 13%, transparent)`. Those pixels are the
// ROUNDED-CORNER antialiasing of a TRANSLUCENT fill, and the compositor does not always
// round that blend the same way between processes. It is not animation (the element has
// none), not the clock, and not text (forcing grayscale font smoothing in FREEZE_CSS cut
// the text class from 86 pixels to 22 but left this one untouched).
//
// This class is the OPPOSITE SHAPE of the first: few pixels, LARGE delta (18.13 — above
// the 5.07 cutoff). Covering it with the threshold alone would need a cutoff above 18,
// leaving only 1.7x of margin to the tightest real surface step at 30.38 — too tight to
// trust. But it is tightly bounded in COUNT, while every real change this program makes is
// unbounded in count (the palette rewrite moved 772,073 pixels; a type-size change reflows
// a whole glyph run). So the count is the right instrument for this one, and only this one.
//
// 40 = the observed maximum of 17, measured across five full-suite runs (150 test
// executions), with ~2.3x headroom. Deliberately NOT rounded up to a comfortable 500.
//
// ── EVERYTHING THIS NET CANNOT SEE. The complete list, stated rather than buried.
//
// A net's blind spots are the only part of it that matters once it is green, so they are
// enumerated here rather than discovered later. (a) and (b) are chosen; (c), (d) and (e)
// are inherited from the comparator and the freeze and cannot be configured away.
//
//   (a) A colour change smaller than about 4 units per channel — below the 5.07 cutoff.
//   (b) A real change confined to fewer than 40 pixels — roughly a 6x6 block. Concrete
//       examples worth knowing: a badge digit flipping, a small status dot changing colour,
//       a focus ring on a small control.
//   (c) ANY pixel pixelmatch classifies as antialiased, at ANY delta, in UNBOUNDED number —
//       see the includeAA note above. This one does not consume the 40-pixel budget at all,
//       so a hairline that moves by 1px can be excused entirely.
//   (d) Font-smoothing and other subpixel-only rendering changes, because FREEZE_CSS forces
//       grayscale antialiasing at capture time. A regression that ONLY changed subpixel
//       text rendering would be invisible.
//   (e) Everything drawn into a <canvas> — FREEZE_CSS hides them (GlobeScene, SwarmHero,
//       PulseGlobe). Pre-existing and documented in harness.mjs; repeated here so the list
//       is complete in one place.
//   (f) EVERYTHING BELOW THE FOLD. `toHaveScreenshot` without `fullPage` captures the
//       VIEWPORT only, the viewports are 320x800 / 768x1024 / 1440x900, and src/theme/bos.css
//       has six-plus `overflow-y: auto` panes. Any pixel scrolled out of the initial view
//       never enters a capture at all. Unlike (b) this is UNBOUNDED — a whole component
//       below the fold can regress invisibly. This is the largest hole in the net and it is
//       structural, not a tolerance: closing it means capturing scrolled states or the full
//       page, which is a scope decision, not a constant to nudge.
//   (g) Transient interaction states — hover, focus, open modals, toasts. Nothing is ever
//       photographed mid-interaction, so their styling is uncovered.
//   (h) Data states absent from the recorded fixture — empty, error and loading layouts.
//       The fixture pins ONE world; the others are never rendered.
//
//   (i) ONE RENDERING CONFIGURATION. Chromium only (playwright.config.mjs declares no
//       `projects`, so the default single browser), `deviceScaleFactor: 1` only (retina
//       rasterisation is never captured), and three discrete widths only — a layout break
//       anywhere between them, e.g. 1024-1439 where the sidebar boundary lives, is
//       invisible. Compounds with the macOS-only note in harness.mjs: these baselines
//       certify one engine, one scale, one platform, three widths.
//
// (f) through (i) are arguably coverage rather than comparator blindness, but the heading
// says everything this net cannot see, so they are listed. All four were named in the
// independent verification of this phase, not discovered later in anger.
//
// Nothing PLANNED falls into (a) or (b): the surface ladder is >= 30 units and Phase 9
// changes type sizes, which reflow hundreds of pixels per site.
// comparator-sensitivity.test.mjs asserts (a) against the SHIPPED helm.css on every
// `npm run test:unit`, caps (b) so a future bump has to be deliberate, and pins the
// comparator source facts behind (c). Phase 9's own procedure — the visual suite alone
// between every batch of ~10 files, every diff reviewed by eye — is the backstop for the
// five IN-FRAME classes (a)-(e), and is not optional.
//
// NOTHING backstops (f)-(i). Eye-review of a visual diff cannot catch them by definition:
// below-the-fold content, un-photographed interaction states, fixture-absent data states
// and unrendered configurations never appear in any diff. Closing them needs the scope
// decisions named above (scrolled/full-page capture, more viewports, a second engine), not
// a constant to nudge. Said plainly because an earlier version of this sentence claimed the
// eye-review backstopped "all five" while the list had grown to eight.
export const MAX_DIFF_PIXELS = 40;

/** Every `toHaveScreenshot` call in this suite uses exactly this. */
export const STRICT = {
  maxDiffPixels: MAX_DIFF_PIXELS,
  threshold: SCREENSHOT_THRESHOLD,
  animations: "disabled",
};

// PHASE 0 — THE GUARD THAT KEEPS THE VISUAL NET HONEST.
//
// WHAT WENT WRONG, so this cannot happen twice. `npm run test:visual` reported 30/30 at
// `maxDiffPixels: 0` against baselines painted in the PREVIOUS palette, after Phase 8.2
// rewrote every surface colour. The comparator was running — swapping one page's baseline
// for another page's failed at 16,962 px — it simply could not SEE a colour change.
// pixelmatch flags a pixel only when its YIQ distance exceeds `35215 * threshold^2`, and
// `threshold` had never been set, so it sat at Playwright's default 0.2 => a cutoff of
// 1408.6. Every step of this theme's surface ladder scores ~30. The whole rewrite was
// below the noise floor.
//
// So the invariant this file enforces is the one that was violated:
//   EVERY ADJACENT PAIR ON THE SURFACE LADDER MUST BE VISIBLE TO THE CONFIGURED COMPARATOR.
// If someone raises the threshold, or adds a surface step finer than the comparator can
// resolve, this goes red at `npm run test:unit` — before a batch of Phase 9 rewrites is
// certified by a net that cannot read them.
//
// It runs under node:test (test:unit already globs test/visual/*.test.mjs) rather than
// under Playwright, because it is arithmetic about the comparison contract and needs no
// browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STRICT, SCREENSHOT_THRESHOLD, MAX_DIFF_PIXELS } from "./strict.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

// ── pixelmatch's colour metric, reproduced exactly ───────────────────────────
//
// Transcribed from pixelmatch (the comparator Playwright's toHaveScreenshot uses). The
// constants are its rgb2y/rgb2i/rgb2q coefficients and its 35215 maximum squared YIQ
// distance. Reproduced rather than imported because Playwright bundles pixelmatch
// internally and does not re-export it; the arithmetic is short enough to verify by eye
// and is pinned by the self-tests below.
const MAX_YIQ_DELTA = 35215;

const rgbToY = (r, g, b) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
const rgbToI = (r, g, b) => r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
const rgbToQ = (r, g, b) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;

/** #rrggbb -> [r,g,b]. Throws on anything else so a bad token cannot silently score 0. */
export function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * pixelmatch's squared YIQ distance for a given PER-CHANNEL delta.
 *
 * Taking channel deltas rather than two colours matters for the noise model below: the
 * transforms are linear, so the delta depends only on (dr, dg, db) and can be evaluated
 * for sign combinations that no particular pair of hex values has to realise.
 */
export function yiqDeltaFromChannels(dr, dg, db) {
  const dy = rgbToY(dr, dg, db);
  const di = rgbToI(dr, dg, db);
  const dq = rgbToQ(dr, dg, db);
  return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
}

/** pixelmatch's squared YIQ distance between two opaque colours. 0 when identical. */
export function yiqDelta(hexA, hexB) {
  const [r1, g1, b1] = parseHex(hexA);
  const [r2, g2, b2] = parseHex(hexB);
  return yiqDeltaFromChannels(r1 - r2, g1 - g2, b1 - b2);
}

/** The delta a pixel must EXCEED to be counted as differing at a given threshold. */
export function cutoffFor(threshold) {
  return MAX_YIQ_DELTA * threshold * threshold;
}

/** True when the configured comparator would flag a pixel that moved from a to b. */
export function isVisible(hexA, hexB, threshold = SCREENSHOT_THRESHOLD) {
  return yiqDelta(hexA, hexB) > cutoffFor(threshold);
}

// ── the ladder, read from the shipped stylesheet ─────────────────────────────
//
// Read from helm.css rather than hardcoded, so a future palette edit is checked against
// the comparator automatically instead of against a copy that drifts.
function helmTokens() {
  const css = readFileSync(join(REPO, "src", "theme", "helm.css"), "utf-8");
  const found = new Map();
  for (const m of css.matchAll(/^\s*(--helm-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/gm)) {
    if (!found.has(m[1])) found.set(m[1], m[2].toLowerCase());
  }
  return found;
}

/** Adjacent pairs on the surface ladder — the smallest steps the net must resolve. */
const LADDER_PAIRS = [
  ["--helm-ink", "--helm-deck"],
  ["--helm-deck", "--helm-deck-raised"],
  ["--helm-deck-raised", "--helm-line"],
  ["--helm-line-soft", "--helm-line"],
];

test("the metric can both pass and fail — identical colours score 0", () => {
  assert.equal(yiqDelta("#123456", "#123456"), 0);
  assert.equal(isVisible("#123456", "#123456"), false, "identical pixels must never count");
});

test("the metric scores a maximal change near its documented ceiling", () => {
  const d = yiqDelta("#000000", "#ffffff");
  assert.ok(d > 30000 && d <= MAX_YIQ_DELTA, `black vs white scored ${d}`);
  assert.equal(isVisible("#000000", "#ffffff"), true);
});

// ── the two edges of the gap the threshold sits in ───────────────────────────
//
// The whole design of strict.mjs is that ONE number has to sit between two measured
// quantities: above the rasteriser's rounding noise, below the smallest real change. Both
// edges are asserted, because moving the threshold to fix one silently breaks the other.

/**
 * The largest YIQ delta anti-aliasing rounding can produce at ±N units per channel.
 *
 * ENUMERATED, NOT REASONED. The first version of this returned `0.5053 * units^2` on the
 * argument that the worst case is the same sign on all three channels, because the i and q
 * coefficients each sum to zero and y then moves by exactly `units`. Independent
 * verification showed that is wrong: the y term is maximised that way, but i and q are
 * maximised by MIXED signs, and the mixed case wins overall —
 *
 *     ±1: same-sign 0.5053  vs  worst 0.5416 at [-1, +1, +1]   (7% higher)
 *     ±2: same-sign 2.0212  vs  worst 2.1662 at [-2, +2, +2]
 *
 * The conclusions were unaffected (both still clear the cutoff comfortably) but a guard
 * whose header says "measured, not assumed" had an assumed worst case inside it. All 27
 * sign combinations are now evaluated, so there is nothing left to get wrong.
 */
function roundingNoise(units) {
  const steps = [-units, 0, units];
  let worst = 0;
  for (const dr of steps) {
    for (const dg of steps) {
      for (const db of steps) {
        const d = yiqDeltaFromChannels(dr, dg, db);
        if (d > worst) worst = d;
      }
    }
  }
  return worst;
}

test("LOWER EDGE — ±1 and ±2 rasteriser rounding stay BELOW the cutoff", () => {
  // Measured on a clean re-run of the unchanged app at threshold 0: 4 of 30 tests failed
  // on 2/5/12/29 pixels, all on one 2px vertical edge, all off by exactly ±1. If this
  // assertion ever fails the suite will flake on an unchanged tree — and a flaky net gets
  // re-baselined, which is how the blind net survived.
  const cutoff = cutoffFor(SCREENSHOT_THRESHOLD);
  // Pin the enumerated worst cases so a regression in roundingNoise() itself is caught.
  // These are the values strict.mjs's table quotes; if they move, that table is stale.
  assert.ok(
    Math.abs(roundingNoise(1) - 0.5416) < 0.001,
    `worst-case ±1 rounding is ${roundingNoise(1).toFixed(4)}, not the 0.5416 strict.mjs documents`,
  );
  assert.ok(
    Math.abs(roundingNoise(2) - 2.1662) < 0.001,
    `worst-case ±2 rounding is ${roundingNoise(2).toFixed(4)}, not the 2.1662 strict.mjs documents`,
  );
  assert.ok(
    roundingNoise(1) < cutoff / 4,
    `±1 rounding scores ${roundingNoise(1).toFixed(3)} against cutoff ${cutoff.toFixed(2)} ` +
      `— too little headroom; the suite will flake on an unchanged app`,
  );
  assert.ok(
    roundingNoise(2) < cutoff,
    `±2 rounding scores ${roundingNoise(2).toFixed(2)} and would be counted as a real ` +
      `change at cutoff ${cutoff.toFixed(2)}`,
  );
  // A real ±1 example taken from the actual failing capture (vault-mobile-dark, x=16).
  assert.equal(isVisible("#2e3b58", "#2e3c58"), false, "observed AA noise must be ignored");
});

test("UPPER EDGE — EVERY adjacent surface step is visible to the configured comparator", () => {
  const tok = helmTokens();
  assert.ok(tok.size > 0, "no --helm-* hex tokens parsed out of helm.css");
  const cutoff = cutoffFor(SCREENSHOT_THRESHOLD);
  for (const [a, b] of LADDER_PAIRS) {
    const ca = tok.get(a);
    const cb = tok.get(b);
    assert.ok(ca, `${a} not found in helm.css`);
    assert.ok(cb, `${b} not found in helm.css`);
    const d = yiqDelta(ca, cb);
    assert.ok(
      d > cutoff * 3,
      `${a} (${ca}) -> ${b} (${cb}) scores ${d.toFixed(1)}, which does not clear the ` +
        `comparator cutoff ${cutoff.toFixed(2)} (threshold ${SCREENSHOT_THRESHOLD}) with ` +
        `the 3x margin this net is designed around. Below the cutoff the visual suite ` +
        `reports such a change as ZERO differing pixels — the exact defect Phase 0 fixed.`,
    );
  }
});

test("the gap is real — noise and signal are separated by more than 10x", () => {
  // The single number that justifies picking a threshold at all. If the design system ever
  // grows a surface step close to rounding noise, no threshold works and the net needs a
  // different instrument; this says so instead of letting someone nudge the constant.
  const tok = helmTokens();
  const smallestReal = Math.min(
    ...LADDER_PAIRS.map(([a, b]) => yiqDelta(tok.get(a), tok.get(b))),
  );
  assert.ok(
    smallestReal > roundingNoise(2) * 10,
    `the smallest real surface step (${smallestReal.toFixed(1)}) is not clearly separable ` +
      `from ±2 rasteriser noise (${roundingNoise(2).toFixed(2)}); no threshold can both ` +
      `see the change and ignore the noise`,
  );
});

test("the regression that shipped: the OLD default threshold could not see the rewrite", () => {
  // Documents the defect with numbers so the next reader does not have to re-derive it.
  // These are the exact before/after pairs from the Phase 8.2 surface rewrite.
  const rewrite = [
    ["#0b1220", "#050a14"],
    ["#121b2e", "#182238"],
    ["#1e2b45", "#243350"],
  ];
  for (const [before, after] of rewrite) {
    assert.equal(
      isVisible(before, after, 0.2),
      false,
      `${before} -> ${after} would have been VISIBLE at threshold 0.2 — the recorded ` +
        `explanation for the blind 30/30 run no longer holds; re-diagnose rather than ` +
        `trusting this note`,
    );
    assert.equal(
      isVisible(before, after, SCREENSHOT_THRESHOLD),
      true,
      `${before} -> ${after} is STILL invisible at the shipped threshold`,
    );
  }
});

test("both specs take their comparison options from strict.mjs, not a local literal", () => {
  // The drift guard. Re-declaring `const STRICT = {...}` inside a spec is exactly how the
  // threshold went missing in the first place; a local literal is silently weaker than
  // this file and nothing would say so.
  for (const spec of ["matrix.spec.mjs", "determinism.spec.mjs"]) {
    const src = readFileSync(join(HERE, spec), "utf-8");
    assert.match(src, /from\s+"\.\/strict\.mjs"/, `${spec} must import STRICT from strict.mjs`);
    assert.doesNotMatch(
      src,
      /const\s+STRICT\s*=/,
      `${spec} declares its own STRICT — it will drift from the comparison contract`,
    );
  }
});

test("the pixel budget stays a noise allowance, never a blanket tolerance", () => {
  // The budget exists for exactly one measured thing: rounded-corner antialiasing of the
  // translucent `.helm-chip` fill, which flips 17 pixels between two values. It is NOT a
  // general "close enough" dial, and the difference matters — at a few hundred it would
  // start hiding real single-component changes, which is the failure this phase fixed.
  assert.ok(
    MAX_DIFF_PIXELS >= 17 * 2,
    `budget ${MAX_DIFF_PIXELS} leaves no headroom over the 17-pixel noise floor measured ` +
      `across five full-suite runs; the suite will flake on an unchanged app`,
  );
  assert.ok(
    MAX_DIFF_PIXELS <= 100,
    `budget ${MAX_DIFF_PIXELS} is large enough to hide a real change to a small component ` +
      `(100 pixels is roughly a 10x10 block). If a run genuinely needs more, find the ` +
      `cause the way Phase 0 did — elementFromPoint on the differing coordinates — rather ` +
      `than raising this.`,
  );
});

// ── the comparator's OWN source, pinned ──────────────────────────────────────
//
// Every number in strict.mjs is derived from how the INSTALLED comparator behaves, not
// from documentation. Two facts carry the whole design, and both live in Playwright's
// vendored pixelmatch. If a version bump changes either, the arithmetic silently stops
// describing reality — which is precisely the failure mode this phase existed to fix — so
// they are asserted rather than assumed.
//
// This deliberately reads a node_modules file. That is the point: the assertion is about
// the dependency's actual behaviour, and it is version-pinned by package-lock.json.
const CORE_BUNDLE = join(REPO, "node_modules", "playwright-core", "lib", "coreBundle.js");

test("pixelmatch is still driven by `threshold` alone, with the cutoff strict.mjs assumes", () => {
  let src;
  try {
    src = readFileSync(CORE_BUNDLE, "utf-8");
  } catch {
    // Not fatal: a consumer may vendor Playwright differently. Say so rather than pass mutely.
    assert.fail(
      `cannot read ${CORE_BUNDLE} to verify the comparator contract. Re-derive the ` +
        `threshold arithmetic in strict.mjs against the installed comparator before trusting it.`,
    );
  }
  assert.match(
    src,
    /threshold:\s*options\.threshold\s*\?\?\s*0\.2/,
    "Playwright no longer forwards `threshold` the way strict.mjs assumes — re-derive the cutoffs",
  );
  assert.match(
    src,
    /35215\s*\*\s*options\.threshold\s*\*\s*options\.threshold/,
    "the `35215 * threshold^2` cutoff strict.mjs is built on is gone — every number there is now suspect",
  );
});

test("the UNMODELLED exclusion is still what strict.mjs documents: includeAA stays false", () => {
  // pixelmatch drops any pixel its antialiasing heuristic flags in EITHER image, whatever
  // the colour delta, and Playwright exposes no way to turn that off. strict.mjs explains
  // why a uniform surface repaint survives it and where it could still hide a change. If
  // this default ever flips, that explanation needs rewriting.
  const src = readFileSync(CORE_BUNDLE, "utf-8");
  assert.match(src, /includeAA:\s*false/, "pixelmatch's includeAA default changed");
  assert.match(
    src,
    /!options\.includeAA\s*&&\s*\(\s*antialiased\(/,
    "the antialiasing exclusion branch changed shape — re-read it and update strict.mjs",
  );
});

// ── the class-of-defect guard ────────────────────────────────────────────────
//
// THREE SEPARATE TIMES this program has been damaged by a comment asserting a property the
// code did not have:
//   1. "maxDiffPixels: 0 — strict" in both specs — the original blindness, a whole session
//      of green runs certifying nothing.
//   2. determinism.spec.mjs claiming `threshold: 0` after the contract became 0.012/40.
//      Written by me while FIXING (1). Caught in verification.
//   3. playwright.config.mjs saying "maxDiffPixels stays 0" eleven lines above the line
//      that sets 40. Written when the budget was 0, never updated. Caught in verification
//      of the fix for (2).
//
// A rule nobody enforces gets broken; each of these was found by a human-equivalent reading
// the file, which does not scale and did not catch them the first two times. So the rule is
// now a test: any comment in this harness that quotes a concrete maxDiffPixels or threshold
// value must agree with strict.mjs, UNLESS it is explicitly framed as history.
const HARNESS_FILES = [
  ["playwright.config.mjs", join(REPO, "playwright.config.mjs")],
  ["test/visual/strict.mjs", join(HERE, "strict.mjs")],
  ["test/visual/harness.mjs", join(HERE, "harness.mjs")],
  ["test/visual/matrix.spec.mjs", join(HERE, "matrix.spec.mjs")],
  ["test/visual/determinism.spec.mjs", join(HERE, "determinism.spec.mjs")],
  // The guard polices ITSELF. This file is dense with quoted historical values, so it is
  // the most likely place for a mis-framed one to hide, and exempting it would be the
  // same "trust me" move the whole phase is about.
  ["test/visual/comparator-sensitivity.test.mjs", join(HERE, "comparator-sensitivity.test.mjs")],
];

// A claim is exempt when its immediate context says, in so many words, that it describes
// the past. Deliberately narrow — vague hedging must NOT buy an exemption or the guard
// rots — but evaluated over a ±1-line window, because these files wrap prose and the
// framing ("used to declare", "went blind", "did not have") routinely lands on the
// neighbouring line.
// NOTE ON TWO ENTRIES THAT WEAKEN THIS LIST, kept deliberately and flagged rather than
// quietly relied on: "default" is needed for the many correct references to Playwright's
// DEFAULT 0.2, and "had" is ordinary past tense — but neither is inherently past-referring
// in every sentence, so each widens hole 1 below. "claiming" was added in an earlier pass
// and then REMOVED: it is not past-tense at all ("the spec is claiming threshold is 0.2 and
// we rely on that") and "became" already covers the line that needed it.
const HISTORICAL =
  /\b(was|were|used to|previously|no longer|old|older|originally|before|tried|default|sat at|reintroduc|went blind|never updated|became|had|did not|could not|would have)\b/i;

/** Every stale comparison claim in `text`. Exported shape: `file:line claims X N`. */
export function staleClaims(text, label = "source") {
  // The connector alternation is broader than the obvious `:` and `is`. Every addition
  // here came from probing the detector rather than from imagination: "stays at 0" and
  // "remains 0" both slipped past the first version, and "stays at" is a ONE-WORD variant
  // of the exact sentence that shipped as recurrence 3 — so the narrow version did not even
  // cover the common shape it claimed to.
  const CONNECTOR = String.raw`(?:stays(?:\s+at)?|remains(?:\s+at)?|sits\s+at|is|of|:|=)`;
  const claims = [
    {
      what: "maxDiffPixels",
      re: new RegExp(String.raw`maxDiffPixels[\`'"\s]*` + CONNECTOR + String.raw`\s*\`?(\d+)`, "gi"),
      truth: MAX_DIFF_PIXELS,
    },
    {
      what: "threshold",
      re: new RegExp(String.raw`threshold[\`'"\s]*` + CONNECTOR + String.raw`\s*\`?(\d*\.?\d+)`, "gi"),
      truth: SCREENSHOT_THRESHOLD,
    },
  ];
  const lines = text.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    // The framing may sit on either neighbour, so judge the window, not the line.
    const context = [lines[i - 1] ?? "", line, lines[i + 1] ?? ""].join(" ");
    for (const { what, re, truth } of claims) {
      for (const m of line.matchAll(re)) {
        if (Number(m[1]) === Number(truth)) continue; // agrees with the contract
        if (HISTORICAL.test(context)) continue; // explicitly describing the past
        out.push(`${label}:${i + 1} claims ${what} ${m[1]} (actual ${truth}) — ${line.trim()}`);
      }
    }
  });
  return out;
}

test("the stale-claim detector can FAIL — a present-tense wrong value is caught", () => {
  // A guard that cannot fail manufactures confidence. This is the exact sentence that
  // shipped in playwright.config.mjs and was found only by independent verification.
  const bad = "// polling; this removes the cliff behind it. maxDiffPixels stays " + "0 — the STRICTNESS of\n// the comparison is untouched, only how long it is given to converge.";
  assert.equal(staleClaims(bad).length, 1, "the detector missed a present-tense stale claim");
});

test("phrasings that USED to evade the detector are now caught", () => {
  // Every one of these was found by probing the detector, not by imagining it, and each
  // slipped through an earlier version. "stays at 0" is the damning one: a single extra
  // word away from the sentence that actually shipped as recurrence 3, which means the
  // narrow version did not cover even the common shape its own comment claimed.
  // The fixtures are SPLIT immediately before the number so the literal claim never
  // appears in this file's own text. This file is inside HARNESS_FILES — it scans itself —
  // and a fixture written literally would be indistinguishable from a real stale claim.
  // Splitting is used in preference to an "ignore this line" sentinel on purpose: a
  // sentinel is a bypass, and a bypass in the guard against unenforced claims is the last
  // thing this phase should ship.
  for (const phrasing of [
    "// maxDiffPixels stays at " + "0 and that is the whole story",
    "// maxDiffPixels remains " + "0 in this configuration",
    "// the budget remains at " + "0 — threshold remains " + "0.2 for our purposes",
    "// threshold sits at " + "0.2 here",
  ]) {
    assert.ok(
      staleClaims(phrasing).length > 0,
      `the detector still misses: ${phrasing}`,
    );
  }
});

test("the stale-claim detector does NOT fire on properly framed history", () => {
  const ok = '// Both specs used to declare their own `const STRICT = { maxDiffPixels: ' + '0,\n// animations: "disabled" }` with the comment "maxDiffPixels: ' + '0 — strict". It is not.';
  assert.deepEqual(staleClaims(ok), [], "the detector flagged a correctly-framed historical reference");
});

test("THE DETECTOR'S OWN LIMITS — pinned, so nobody mistakes it for a proof", () => {
  // This test asserts that two constructions DO get through. That is deliberate. The
  // detector is a net for the COMMON shape of this defect — a flat present-tense
  // restatement of a stale number, which is exactly what all three real occurrences were.
  // It is NOT a proof, and if it were left to imply otherwise it would itself become a
  // thing that claims a property it does not have, which is the joke this phase cannot
  // afford to make a fourth time. Both holes were found by probing my own detector.
  //
  // If someone genuinely closes one of these, this test fails and they must update the
  // Known Gaps entry rather than silently gaining confidence.

  // HOLE 1 — a historical word anywhere in the ±1-line window exempts the whole window,
  // including a claim that is genuinely present-tense.
  const mixed = "// the old code was fine; maxDiffPixels is " + "0 now";
  assert.deepEqual(
    staleClaims(mixed),
    [],
    "HOLE 1 appears closed — the detector now distinguishes a current claim from a " +
      "historical one in the same window. Update the Known Gaps entry.",
  );

  // HOLE 2 — the match is per line, so a claim wrapped across a line break escapes.
  const wrapped = "// maxDiffPixels is\n// " + "0";
  assert.deepEqual(
    staleClaims(wrapped),
    [],
    "HOLE 2 appears closed — the detector now spans line breaks. Update the Known Gaps entry.",
  );
});

test("no comment in the harness quotes a maxDiffPixels or threshold that disagrees with strict.mjs", () => {
  const offences = HARNESS_FILES.flatMap(([label, path]) =>
    staleClaims(readFileSync(path, "utf-8"), label),
  );
  assert.deepEqual(
    offences,
    [],
    `a comment asserts a comparison value the code does not use. This is the defect class ` +
      `that made the visual net blind for an entire session, and it has now recurred three ` +
      `times. Either correct the number or frame the sentence as history.\n${offences.join("\n")}`,
  );
});

test("the contract itself is what the specs think it is", () => {
  assert.equal(STRICT.threshold, SCREENSHOT_THRESHOLD);
  assert.equal(STRICT.maxDiffPixels, MAX_DIFF_PIXELS);
  assert.equal(STRICT.animations, "disabled");
});

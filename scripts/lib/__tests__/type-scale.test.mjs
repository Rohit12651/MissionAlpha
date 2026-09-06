// PHASE 9 — tests for the type-scale sweep.
//
// This runs in the `test:vendor` suite, so the codemod is gated by the same pipeline as
// everything else. A transform that touches 556 sites across 64 files in a codebase with
// ZERO component tests has to be provably correct on its own terms first.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FLOOR_PX,
  LADDER,
  mapSize,
  subFloorSizes,
  sweepCss,
  sweepTsx,
} from "../type-scale.mjs";

test("the ladder is the nine steps from the spec, ascending", () => {
  assert.deepEqual(LADDER, [12, 13, 14, 16, 19, 22, 26, 30, 36]);
  assert.equal(FLOOR_PX, 12);
});

test("every mapped size lands ON the ladder — never between steps", () => {
  for (const px of [8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 17, 19, 20, 22, 24, 25, 26, 30, 36]) {
    const to = mapSize(px);
    assert.ok(LADDER.includes(to), `${px} mapped to ${to}, which is not a ladder step`);
  }
});

test("THE FLOOR: everything below 13px collapses to exactly 12", () => {
  for (const px of [8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5]) {
    assert.equal(mapSize(px), 12, `${px} did not collapse to the floor`);
  }
});

test("no mapped size is ever below the floor", () => {
  for (const px of [8, 9, 10, 11, 12, 13, 14, 16, 19, 22, 26, 30]) {
    assert.ok(mapSize(px) >= FLOOR_PX, `${px} mapped below the floor`);
  }
});

test("an UNDECIDED size returns null rather than a nearest match", () => {
  // Silently snapping an unlisted size to its nearest step would re-introduce exactly the
  // thing this sweep removes: a size nobody decided on.
  for (const px of [7, 18, 21, 28, 40, 100, 0, -3, Number.NaN]) {
    assert.equal(mapSize(px), null, `${px} was silently snapped`);
  }
});

// ── the .tsx transform ─────────────────────────────────────────────────────────

test("sweepTsx rewrites sub-floor sizes and reports the count", () => {
  const src = `<span className="helm-mono text-[11px]">a</span><b className="text-[9px]">b</b>`;
  const out = sweepTsx(src);
  assert.equal(out.changed, 2);
  assert.equal(out.code, `<span className="helm-mono text-[12px]">a</span><b className="text-[12px]">b</b>`);
  assert.deepEqual(out.unmapped, []);
});

test("sweepTsx leaves a size already on the ladder byte-identical", () => {
  const src = `<span className="text-[12px] text-[14px] text-[26px]" />`;
  const out = sweepTsx(src);
  assert.equal(out.changed, 0);
  assert.equal(out.code, src, "an on-ladder file must not be rewritten at all");
});

test("sweepTsx reports an unmapped size and does NOT touch it", () => {
  const src = `<span className="text-[18px]" />`;
  const out = sweepTsx(src);
  assert.equal(out.changed, 0);
  assert.deepEqual(out.unmapped, [18]);
  assert.equal(out.code, src);
});

test("sweepTsx ignores every other arbitrary value", () => {
  // A greedy regex here would rewrite spacing, widths and line-heights too.
  const src = `<div className="w-[11px] p-[9px] leading-[10px] gap-[8px] text-[11px]" />`;
  const out = sweepTsx(src);
  assert.equal(out.code, `<div className="w-[11px] p-[9px] leading-[10px] gap-[8px] text-[12px]" />`);
  assert.equal(out.changed, 1);
});

test("sweepTsx handles half-pixel sizes, which are the residue this removes", () => {
  const out = sweepTsx(`<i className="text-[12.5px]" /><i className="text-[13.5px]" />`);
  assert.equal(out.code, `<i className="text-[12px]" /><i className="text-[13px]" />`);
  assert.equal(out.changed, 2);
});

// ── the CSS transform ──────────────────────────────────────────────────────────

test("sweepCss rewrites font-size declarations only", () => {
  const src = `.a { font-size: 11px; line-height: 11px; border-width: 9px; }`;
  const out = sweepCss(src);
  assert.equal(out.code, `.a { font-size: 12px; line-height: 11px; border-width: 9px; }`);
  assert.equal(out.changed, 1);
});

test("sweepCss tolerates the whitespace variants that actually occur", () => {
  const out = sweepCss(`.a{font-size:9.5px}\n.b {  font-size:   10px ; }`);
  assert.match(out.code, /font-size:12px/);
  assert.match(out.code, /font-size: {3}12px/);
  assert.equal(out.changed, 2);
});

test("sweepCss leaves rem and other units alone", () => {
  const src = `.a { font-size: 0.75rem; } .b { font-size: 1em; } .c { font-size: var(--type-1); }`;
  assert.equal(sweepCss(src).code, src);
});

// ── the exit gate, as a function ───────────────────────────────────────────────

test("subFloorSizes finds every remaining violation on both surfaces", () => {
  const src = `<span className="text-[11px]" />\n.a { font-size: 9px; }`;
  assert.deepEqual(subFloorSizes(src).sort((a, b) => a - b), [9, 11]);
});

test("subFloorSizes is empty on a swept source — the Phase 9 exit condition", () => {
  const swept = sweepTsx(`<span className="text-[8px] text-[11px] text-[12.5px]" />`).code;
  assert.deepEqual(subFloorSizes(swept), []);
});

test("subFloorSizes is repeatable — the shared regexes do not leak lastIndex", () => {
  // Module-level /g regexes are stateful. Two calls must agree, or the gate reports
  // "clean" on the second run of a dirty file.
  const src = `<span className="text-[11px]" />`;
  assert.deepEqual(subFloorSizes(src), subFloorSizes(src));
});

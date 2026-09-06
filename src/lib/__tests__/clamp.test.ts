// clamp(n, min, max) — pure numeric utility. Runs under
// `node --experimental-strip-types --test` with zero runtime deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "../clamp.ts";

test("value inside range is returned unchanged", () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test("value below min is clamped to min", () => {
  assert.equal(clamp(-3, 0, 10), 0);
});

test("value above max is clamped to max", () => {
  assert.equal(clamp(15, 0, 10), 10);
});

test("value exactly at min bound is returned as min", () => {
  assert.equal(clamp(0, 0, 10), 0);
});

test("value exactly at max bound is returned as max", () => {
  assert.equal(clamp(10, 0, 10), 10);
});

test("NaN returns min", () => {
  assert.equal(clamp(NaN, 0, 10), 0);
});

test("when min > max the arguments are swapped before clamping", () => {
  // min=10, max=0 → effective range [0, 10] after swap
  assert.equal(clamp(5, 10, 0), 5, "inside swapped range");
  assert.equal(clamp(-1, 10, 0), 0, "below swapped range clamps to effective min");
  assert.equal(clamp(11, 10, 0), 10, "above swapped range clamps to effective max");
});

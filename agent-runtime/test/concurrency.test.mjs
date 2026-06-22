// agent-runtime/test/concurrency.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMaxInflight } from "../concurrency.mjs";

test("env override wins, unclamped", () => {
  assert.equal(computeMaxInflight({ env: { RUNTIME_MAX_INFLIGHT: "20" }, cpuCount: 4 }), 20);
  assert.equal(computeMaxInflight({ env: { RUNTIME_MAX_INFLIGHT: "1" }, cpuCount: 64 }), 1);
});

test("cpu-derived = clamp(cpuCount-1, 2, 6) when no env", () => {
  // Ceiling is RAM/subscription-governed (each slot = a heavy `claude` child),
  // NOT CPU-governed — perf-engineer review capped it at 6, env raises it.
  assert.equal(computeMaxInflight({ env: {}, cpuCount: 1 }), 2);  // floor
  assert.equal(computeMaxInflight({ env: {}, cpuCount: 2 }), 2);  // floor
  assert.equal(computeMaxInflight({ env: {}, cpuCount: 5 }), 4);  // mid
  assert.equal(computeMaxInflight({ env: {}, cpuCount: 8 }), 6);  // ceil
  assert.equal(computeMaxInflight({ env: {}, cpuCount: 14 }), 6); // ceil
});

test("garbage env ignored → falls through to cpu-derived", () => {
  for (const bad of ["", "abc", "0", "-5", "  ", "3.5x"]) {
    assert.equal(computeMaxInflight({ env: { RUNTIME_MAX_INFLIGHT: bad }, cpuCount: 8 }), 6);
  }
});

test("missing/zero cpuCount still yields the floor", () => {
  assert.equal(computeMaxInflight({ env: {}, cpuCount: 0 }), 2);
  assert.equal(computeMaxInflight({ env: {} }), 2);
});

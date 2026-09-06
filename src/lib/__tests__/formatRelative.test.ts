// Story-Pipeline (sr-backend) — contract-lock test for src/lib/formatRelative.ts.
// Pins the approved design against silent drift: exactly two exports, (iso, nowMs)
// parameter order, the "\u2014" em-dash sentinel for unparseable/missing input (guards
// the junk "#" heartbeat row replayed by lib/replay.ts), and TRUNCATION-based buckets
// (floor, never round — 1.5 minutes must read "1m ago", not "2m ago").
// Pure + clock-injected (fixed epoch base), runs under `node --experimental-strip-types --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as mod from "../formatRelative.ts";
import { formatRelative, compactAge } from "../formatRelative.ts";

/** Fixed "now" so every expectation below is deterministic forever. */
const NOW = Date.parse("2026-08-04T12:00:00Z");
/** iso string for `sec` seconds before NOW */
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

test("module exports exactly formatRelative and compactAge (no drift)", () => {
  assert.deepEqual(
    Object.keys(mod).sort(),
    ["compactAge", "formatRelative"],
    "approved design allows exactly these two exports",
  );
  assert.equal(typeof mod.formatRelative, "function");
  assert.equal(typeof mod.compactAge, "function");
});

test("sentinel is the em-dash U+2014 for missing/unparseable timestamps", () => {
  const junk = ["#", "", null, undefined, "not-a-date", "2026-13-45T99:99:99Z"];
  for (const bad of junk) {
    assert.equal(formatRelative(bad as string, NOW), "\u2014", `formatRelative(${String(bad)})`);
    assert.equal(compactAge(bad as string, NOW), "\u2014", `compactAge(${String(bad)})`);
    // explicit code-point check so a look-alike dash can never sneak past review
    assert.equal((formatRelative(bad as string, NOW) ?? "").charCodeAt(0), 0x2014);
  }
});

test("parameter order is (iso, nowMs): swapped args degrade to the sentinel", () => {
  // correct order: past iso first, epoch-ms second → real age
  assert.equal(formatRelative(ago(30), NOW), "30s ago");
  // wrong order: an epoch-ms number in the iso slot fails Date.parse → sentinel
  assert.equal(formatRelative(NOW as unknown as string, NOW), "\u2014");
  assert.equal(compactAge(NOW as unknown as string, NOW), "\u2014");
});

test("formatRelative buckets truncate (floor) at 5s/60s/3600s/86400s", () => {
  assert.equal(formatRelative(ago(0), NOW), "just now");
  assert.equal(formatRelative(ago(4), NOW), "just now", "< 5s is still just now");
  assert.equal(formatRelative(ago(5), NOW), "5s ago");

  assert.equal(formatRelative(ago(45), NOW), "45s ago");
  assert.equal(formatRelative(ago(59), NOW), "59s ago");
  assert.equal(formatRelative(ago(60), NOW), "1m ago");

  // the truncation tripwires: rounding would flip these
  assert.equal(formatRelative(ago(90), NOW), "1m ago", "1.5m floors, not rounds");
  assert.equal(formatRelative(ago(119), NOW), "1m ago");
  assert.equal(formatRelative(ago(3599), NOW), "59m ago");
  assert.equal(formatRelative(ago(3600), NOW), "1h ago");
  assert.equal(formatRelative(ago(5400), NOW), "1h ago", "1.5h floors, not rounds");
  assert.equal(formatRelative(ago(86399), NOW), "23h ago");
  assert.equal(formatRelative(ago(86400), NOW), "1d ago");
  assert.equal(formatRelative(ago(129600), NOW), "1d ago", "1.5d floors, not rounds");
});

test("compactAge mirrors the same thresholds minus the 'ago' suffix", () => {
  assert.equal(compactAge(ago(0), NOW), "0s");
  assert.equal(compactAge(ago(45), NOW), "45s");
  assert.equal(compactAge(ago(60), NOW), "1m");
  assert.equal(compactAge(ago(90), NOW), "1m", "truncation, not rounding");
  assert.equal(compactAge(ago(3600), NOW), "1h");
  assert.equal(compactAge(ago(86400), NOW), "1d");
  assert.equal(compactAge(ago(172800), NOW), "2d");
});

test("future timestamps clamp to zero (no negative ages between polls)", () => {
  const future = new Date(NOW + 30_000).toISOString();
  assert.equal(formatRelative(future, NOW), "just now");
  assert.equal(compactAge(future, NOW), "0s");
});

// P6 / ADR-053 — pure UI helpers: the risk chip mapping, the SLA countdown
// formatter, and the policy-editor reducers. DOM-free so `node --strip-types` runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  riskLabel,
  riskTone,
  formatSla,
  setBand,
  addDeny,
  removeDeny,
  BEHAVIOR_OPTIONS,
  clampLimit,
  type PolicyBands,
} from "../inboxClient.ts";
import { slaNotificationText } from "../deliveryNotify.ts";

// ── RiskChip mapping (band → label + tone) ───────────────────────────────────
test("risk band maps to label + tone; null → unrated/muted", () => {
  assert.equal(riskLabel("low"), "low risk");
  assert.equal(riskLabel("medium"), "medium");
  assert.equal(riskLabel("high"), "high risk");
  assert.equal(riskLabel(null), "unrated");
  assert.equal(riskTone("low"), "green");
  assert.equal(riskTone("medium"), "amber");
  assert.equal(riskTone("high"), "red");
  assert.equal(riskTone(null), "muted");
});

// ── SlaTimer formatter ───────────────────────────────────────────────────────
test("formatSla returns null for a null deadline", () => {
  assert.equal(formatSla(null), null);
});

test("formatSla counts down and flags hot under one hour", () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const in2h = new Date(now + 2 * 3600_000).toISOString();
  const v2 = formatSla(in2h, now)!;
  assert.equal(v2.label, "SLA 02:00:00");
  assert.equal(v2.hot, false);
  assert.equal(v2.expired, false);

  const in30m = new Date(now + 30 * 60_000).toISOString();
  const v30 = formatSla(in30m, now)!;
  assert.equal(v30.label, "SLA 30:00", "under an hour drops the hours field");
  assert.equal(v30.hot, true);
});

test("formatSla reports expired at/after the deadline", () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const past = new Date(now - 1000).toISOString();
  const v = formatSla(past, now)!;
  assert.equal(v.label, "SLA expired");
  assert.equal(v.expired, true);
  assert.equal(v.hot, true);
  assert.equal(v.secondsLeft, 0);
});

// ── policy-editor reducers (pure, immutable) ─────────────────────────────────
test("setBand returns a new object with one band changed", () => {
  const bands: PolicyBands = { low: "notify", medium: "human", high: "typed_confirm" };
  const next = setBand(bands, "low", "auto_approve");
  assert.equal(next.low, "auto_approve");
  assert.equal(bands.low, "notify", "original is not mutated");
  assert.notEqual(next, bands);
});

test("addDeny trims, dedupes, and ignores empty; removeDeny filters", () => {
  const list = ["**/.env"];
  assert.deepEqual(addDeny(list, "  **/secrets/**  "), ["**/.env", "**/secrets/**"]);
  assert.deepEqual(addDeny(list, "**/.env"), ["**/.env"], "no duplicate");
  assert.deepEqual(addDeny(list, "   "), ["**/.env"], "empty ignored");
  assert.deepEqual(removeDeny(["a", "b", "c"], "b"), ["a", "c"]);
});

test("BEHAVIOR_OPTIONS never offers auto_approve for medium or high", () => {
  assert.ok(BEHAVIOR_OPTIONS.low.includes("auto_approve"));
  assert.ok(!BEHAVIOR_OPTIONS.medium.includes("auto_approve" as never));
  assert.ok(!BEHAVIOR_OPTIONS.high.includes("auto_approve" as never));
  assert.deepEqual(BEHAVIOR_OPTIONS.high, ["typed_confirm", "human"]);
});

// ── half-life re-notification copy ───────────────────────────────────────────
test("slaNotificationText names the agent + band", () => {
  const { title, body } = slaNotificationText({ id: "x", agentId: "web-1", band: "high" });
  assert.match(title, /awaiting your decision/i);
  assert.match(body, /web-1/);
  assert.match(body, /high risk/);
});

// ── PHASE 2 TASK 2.2 — the size ceiling's editor helper ─────────────────────
// The server REJECTS a ceiling of 0 or below outright: stored, it would be
// indistinguishable from "unset" on the next load, and "unset" falls back to a more
// permissive default. The editor must not let the operator type a value that will bounce.
test("clampLimit never produces a value the server would reject", () => {
  assert.equal(clampLimit(0, 50), 1);
  assert.equal(clampLimit(-7, 50), 1);
  assert.equal(clampLimit(Number.NaN, 50), 1);
  assert.equal(clampLimit(Number.POSITIVE_INFINITY, 50), 1);
  assert.equal(clampLimit(3.9, 50), 3);
  assert.equal(clampLimit(999, 50), 50, "a ceiling of 999 files is an unbounded gate with extra steps");
  assert.equal(clampLimit(8, 50), 8);
});

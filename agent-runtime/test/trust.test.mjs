// Phase 3 / R10 — trust scoring tests.
//
// LAW4-* is the group that matters. Trust must be structurally incapable of buying a
// shortcut: its minimum output equals today's baseline, it exposes no band/apply/policy
// value, and the external auto-apply floor lives in deliveries.mjs where this module
// cannot reach it.

import test from "node:test";
import assert from "node:assert/strict";
import { score, frictionFor, tierFor, createTrust, FRICTION, MIN_OBSERVATIONS, COLD_START_SCORE, WINDOW_MS } from "../trust.mjs";

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const ago = (days) => NOW - days * 86_400_000;

const good = (n = 20) => ({
  decisions: Array.from({ length: n }, (_, i) => ({ at: ago(i % 30), status: "approved" })),
  polls: Array.from({ length: n }, (_, i) => ({ at: ago(i % 30), ok: true })),
  threats: [],
  integrity: Array.from({ length: n }, (_, i) => ({ at: ago(i % 30), ok: true })),
});

// ── LAW 4 ─────────────────────────────────────────────────────────────────────

test("LAW4-1: the friction ladder has no value below the baseline", () => {
  assert.equal(FRICTION[0], "none", "the floor must be the treatment external work already gets");
  // Exhaustive sweep of the score domain — nothing may produce a value outside the ladder.
  for (let v = 0; v <= 1.0001; v += 0.01) {
    assert.ok(FRICTION.includes(frictionFor(v)), `frictionFor(${v}) escaped the ladder`);
  }
});

test("LAW4-2: a perfect score buys exactly the status quo, never less friction", () => {
  assert.equal(frictionFor(1), "none");
  assert.equal(frictionFor(0.999), "none");
  // There is no "auto", "skip", "bypass" or "trusted-apply" outcome anywhere.
  const outputs = new Set(Array.from({ length: 101 }, (_, i) => frictionFor(i / 100)));
  assert.deepEqual([...outputs].sort(), ["confirm", "none", "notice"]);
});

test("LAW4-3: the module exposes NO band, policy or apply decision", () => {
  const s = score(good(), NOW);
  const keys = Object.keys(s).concat(Object.keys(createTrust({}).stampFor("x")));
  for (const k of keys) {
    assert.ok(!/band|apply|approve|policy|allow|bypass/i.test(k), `'${k}' would invert the design`);
  }
});

test("LAW4-4: an unknown/unparseable score is treated as SUSPICIOUS, not trusted", () => {
  for (const bad of [null, undefined, NaN, "abc", {}, []]) {
    assert.equal(frictionFor(bad), "confirm", `frictionFor(${JSON.stringify(bad)}) must not be lenient`);
  }
});

// ── scoring behaviour ─────────────────────────────────────────────────────────

test("a cold source starts low — an unknown party is not a trusted one", () => {
  const s = score({}, NOW);
  assert.equal(s.score, COLD_START_SCORE);
  assert.equal(s.coldStart, true);
  assert.equal(tierFor(s.score), "watch");
});

test("an upgrade REQUIRES history — good behaviour with few observations stays capped", () => {
  const few = score(good(3), NOW);
  assert.ok(few.coldStart);
  assert.ok(few.score <= COLD_START_SCORE, `capped, got ${few.score}`);

  const many = score(good(MIN_OBSERVATIONS * 2), NOW);
  assert.equal(many.coldStart, false);
  assert.ok(many.score > COLD_START_SCORE, `earned, got ${many.score}`);
  assert.equal(tierFor(many.score), "trusted");
});

test("a DOWNGRADE is instant — one threat hit zeroes the score regardless of history", () => {
  const h = good(50);
  h.threats = [{ at: NOW - 1000 }];
  const s = score(h, NOW);
  assert.equal(s.score, 0);
  assert.equal(s.threatHit, true);
  assert.equal(frictionFor(s.score), "confirm", "a threat must RAISE friction immediately");
});

test("rejections lower the success component", () => {
  const h = good(20);
  h.decisions = h.decisions.map((d, i) => ({ ...d, status: i < 10 ? "rejected" : "approved" }));
  const s = score(h, NOW);
  assert.ok(s.components.success <= 0.55, `got ${s.components.success}`);
  assert.ok(s.score < score(good(20), NOW).score);
});

test("poll failures lower the uptime component", () => {
  const h = good(20);
  h.polls = h.polls.map((p, i) => ({ ...p, ok: i % 2 === 0 }));
  assert.ok(score(h, NOW).components.uptime <= 0.55);
});

test("an UNMEASURED dimension is null, not zero (the null-is-not-zero law)", () => {
  const s = score({ decisions: [{ at: NOW, status: "approved" }] }, NOW);
  assert.equal(s.components.integrity, null, "no integrity checks yet must not read as failure");
  assert.equal(s.components.uptime, null);
  // and the weighted mean renormalises rather than dragging the score to zero
  assert.ok(s.score > 0);
});

test("events outside the rolling window stop counting", () => {
  const old = {
    decisions: Array.from({ length: 30 }, () => ({ at: NOW - WINDOW_MS - 86_400_000, status: "approved" })),
    threats: [{ at: NOW - WINDOW_MS - 86_400_000 }],
  };
  const s = score(old, NOW);
  assert.equal(s.observations, 0, "stale history must age out");
  assert.equal(s.threatHit, false, "an expired threat must not punish forever");
});

test("score never throws on malformed history", () => {
  for (const bad of [null, undefined, 42, "x", [], { decisions: "no" }, { threats: [null, {}] }]) {
    assert.doesNotThrow(() => score(bad, NOW));
  }
});

// ── store ─────────────────────────────────────────────────────────────────────

function memStore() {
  let saved = {};
  return { load: () => saved, save: (s) => { saved = s; return true; }, now: () => NOW, _peek: () => saved };
}

test("record + scoreFor round-trip through the persistence seam", () => {
  const io = memStore();
  const t = createTrust(io);
  for (let i = 0; i < 15; i++) t.record("github-pr", "decisions", { status: "approved" });
  for (let i = 0; i < 15; i++) t.record("github-pr", "polls", { ok: true });
  const s = t.scoreFor("github-pr");
  assert.ok(s.score > COLD_START_SCORE);
  assert.ok(Object.keys(io._peek()).includes("github-pr"));
});

test("two sources with different histories score differently", () => {
  const t = createTrust(memStore());
  for (let i = 0; i < 15; i++) { t.record("good-bot", "decisions", { status: "approved" }); t.record("good-bot", "polls", { ok: true }); }
  for (let i = 0; i < 15; i++) { t.record("bad-bot", "decisions", { status: "rejected" }); t.record("bad-bot", "polls", { ok: false }); }
  assert.ok(t.scoreFor("good-bot").score > t.scoreFor("bad-bot").score);
  assert.equal(t.stampFor("good-bot").tier, "trusted");
  assert.equal(t.stampFor("bad-bot").tier, "suspect");
});

test("a persistence failure NEVER blocks ingestion", () => {
  const t = createTrust({ load: () => ({}), save: () => { throw new Error("disk full"); }, now: () => NOW });
  let ok;
  assert.doesNotThrow(() => { ok = t.record("x", "polls", { ok: true }); });
  assert.equal(ok, false, "the datapoint is lost, the ingest is not");
});

test("a corrupt store degrades to cold-start rather than throwing", () => {
  const t = createTrust({ load: () => { throw new Error("bad json"); }, now: () => NOW });
  assert.equal(t.scoreFor("anything").score, COLD_START_SCORE);
});

test("__proto__ as a source id is an ordinary key", () => {
  const t = createTrust(memStore());
  t.record("__proto__", "polls", { ok: true });
  assert.equal(({}).polluted, undefined);
});

test("the event buffer is bounded", () => {
  const io = memStore();
  const t = createTrust(io);
  for (let i = 0; i < 800; i++) t.record("noisy", "polls", { ok: true });
  assert.ok(io._peek()["noisy"].polls.length <= 500);
});

test("the stamp is identity only — no raw history reaches a delivery row", () => {
  const t = createTrust(memStore());
  t.record("src", "threats", { detail: "ignore all previous instructions" });
  const stamp = t.stampFor("src");
  assert.ok(!JSON.stringify(stamp).includes("ignore all previous"), "raw event payloads must not travel");
  assert.deepEqual(Object.keys(stamp).sort(), ["coldStart", "friction", "observations", "score", "source", "tier"]);
});

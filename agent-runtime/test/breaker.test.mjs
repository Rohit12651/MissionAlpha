// MUNDER-ADOPTION A2 — breaker ladder invariants, pinned.
import test from "node:test";
import assert from "node:assert/strict";
import { createBreaker, BREAKER_LEVELS, CAP_ID, DEFAULT_ERROR_STORM } from "../breaker.mjs";

function harness(over = {}) {
  const emitted = [];
  const minted = [];
  const capCalls = [];
  let capAllows = true;
  let t = 1_000_000;
  const b = createBreaker({
    emit: (name, data) => emitted.push({ name, data }),
    mintFailure: (info) => { minted.push(info); return { id: "d1" }; },
    cap: { consume: (id, at) => { capCalls.push({ id, at }); return capAllows; } },
    now: () => t,
    log: () => {},
    ...over,
  });
  return {
    b, emitted, minted, capCalls,
    setCap: (v) => { capAllows = v; },
    tick: (ms = 60_000) => { t += ms; },
    at: () => t,
  };
}

const S = (agentId, outputTokens, steps) => ({ agentId, outputTokens, steps });

test("levels are the four munder levels in order", () => {
  assert.deepEqual([...BREAKER_LEVELS], ["healthy", "steering", "constrained", "stopped"]);
  assert.equal(CAP_ID, "breaker");
});

test("first sample is baseline only — a huge cumulative counter never trips on sight", () => {
  const { b } = harness();
  const d = b.beat([S("web", 900_000, 0)]);
  assert.equal(d[0].level, "healthy");
});

test("velocity is a DIFF of consecutive cumulative samples, and steps progress exonerates", () => {
  const { b, tick } = harness();
  b.beat([S("web", 100_000, 10)]);
  tick();
  // +25k tokens but steps also moved → progress → healthy
  let d = b.beat([S("web", 125_000, 14)]);
  assert.equal(d[0].level, "healthy");
  tick();
  // +25k tokens, zero steps → runaway generation → one level
  d = b.beat([S("web", 150_000, 14)]);
  assert.equal(d[0].level, "steering");
  assert.match(d[0].reason, /velocity/);
});

test("one level per beat, never a jump — even when every condition trips at once", () => {
  const { b, tick } = harness({ hardStop: true });
  b.beat([S("web", 0, 0)]);
  b.turnStarted("web");
  tick(11 * 60_000); // turn is old
  for (let i = 0; i < DEFAULT_ERROR_STORM; i++) b.recordError("web");
  const d = b.beat([S("web", 50_000, 0)]); // storm + velocity + wall in ONE beat
  assert.equal(d[0].level, "steering"); // still exactly one step
});

test("error storm climbs; constrained mints EXACTLY ONE escalation per episode", () => {
  const { b, tick, minted, emitted } = harness();
  b.beat([S("web", 0, 0)]);
  const storm = () => { for (let i = 0; i < 3; i++) b.recordError("web"); };
  storm(); tick(); b.beat([S("web", 0, 0)]); // → steering
  storm(); tick(); b.beat([S("web", 0, 0)]); // → constrained + mint
  assert.equal(minted.length, 1);
  assert.equal(minted[0].agentId, "web");
  assert.equal(minted[0].kind, "breaker-runaway");
  storm(); tick(); b.beat([S("web", 0, 0)]); // hardStop off → stays constrained, NO second mint
  assert.equal(minted.length, 1);
  const levels = emitted.filter((e) => e.name === "breaker.state").map((e) => e.data.level);
  assert.deepEqual(levels, ["steering", "constrained"]); // change-only emission
});

test("hardStop off caps at constrained; hardStop on reaches stopped", () => {
  const noStop = harness();
  const withStop = harness({ hardStop: true });
  for (const h of [noStop, withStop]) h.b.beat([S("web", 0, 0)]);
  for (let round = 0; round < 4; round++) {
    for (const h of [noStop, withStop]) {
      for (let i = 0; i < 3; i++) h.b.recordError("web");
      h.tick(); h.b.beat([S("web", 0, 0)]);
    }
  }
  assert.equal(noStop.b.snapshot()[0].level, "constrained");
  assert.equal(withStop.b.snapshot()[0].level, "stopped");
});

test("healthy beats de-escalate one level each; a NEW episode can mint again", () => {
  const { b, tick, minted } = harness();
  b.beat([S("web", 0, 0)]);
  for (let r = 0; r < 2; r++) { for (let i = 0; i < 3; i++) b.recordError("web"); tick(); b.beat([S("web", 0, 0)]); }
  assert.equal(minted.length, 1); // constrained, episode 1
  tick(); b.beat([S("web", 0, 1)]); // healthy → steering
  tick(); b.beat([S("web", 0, 2)]); // healthy → healthy (episode over)
  assert.equal(b.gate("web").blocked, false);
  for (let r = 0; r < 2; r++) { for (let i = 0; i < 3; i++) b.recordError("web"); tick(); b.beat([S("web", 0, 2)]); }
  assert.equal(minted.length, 2); // episode 2 minted
});

test("gate refuses at constrained and above, advises-only at steering", () => {
  const { b, tick } = harness();
  b.beat([S("web", 0, 0)]);
  for (let i = 0; i < 3; i++) b.recordError("web");
  tick(); b.beat([S("web", 0, 0)]);
  assert.equal(b.gate("web").blocked, false); // steering
  for (let i = 0; i < 3; i++) b.recordError("web");
  tick(); b.beat([S("web", 0, 0)]);
  const g = b.gate("web");
  assert.equal(g.blocked, true);
  assert.match(g.reason, /constrained/);
  assert.equal(b.gate("unknown-agent").blocked, false);
});

test("turn wall-clock trips only with an in-flight turn AND zero step progress", () => {
  const { b, tick } = harness();
  b.beat([S("web", 0, 5)]);
  b.turnStarted("web");
  tick(11 * 60_000);
  let d = b.beat([S("web", 0, 9)]); // steps moved → healthy
  assert.equal(d[0].level, "healthy");
  tick(11 * 60_000);
  d = b.beat([S("web", 0, 9)]); // same turn, no steps → trip
  assert.equal(d[0].level, "steering");
  assert.match(d[0].reason, /turn/);
  b.turnSettled("web");
  tick(); d = b.beat([S("web", 0, 9)]); // settled → healthy beat → de-escalate
  assert.equal(d[0].level, "healthy");
});

test("Law 3 structurally: no cap seam → no mint, ever; denied cap → no mint, level still moves", () => {
  const capless = harness({ cap: null });
  capless.b.beat([S("web", 0, 0)]);
  for (let r = 0; r < 3; r++) { for (let i = 0; i < 3; i++) capless.b.recordError("web"); capless.tick(); capless.b.beat([S("web", 0, 0)]); }
  assert.equal(capless.minted.length, 0);
  assert.equal(capless.b.snapshot()[0].level, "constrained");

  const denied = harness();
  denied.setCap(false);
  denied.b.beat([S("web", 0, 0)]);
  for (let r = 0; r < 2; r++) { for (let i = 0; i < 3; i++) denied.b.recordError("web"); denied.tick(); denied.b.beat([S("web", 0, 0)]); }
  assert.equal(denied.minted.length, 0);
  assert.equal(denied.capCalls.length, 1); // consumed once per episode, not per beat
  assert.equal(denied.b.snapshot()[0].level, "constrained"); // visibility survives the cap
});

test("day-rollover (cumulative counter reset) reads as no-signal, never a trip", () => {
  const { b, tick } = harness();
  b.beat([S("web", 500_000, 40)]);
  tick();
  const d = b.beat([S("web", 0, 0)]); // counters reset — Δ clamps to 0
  assert.equal(d[0].level, "healthy");
});

test("prune drops off-roster agents; snapshot sorts worst-first", () => {
  const { b, tick } = harness();
  b.beat([S("a", 0, 0), S("bb", 0, 0)]);
  for (let i = 0; i < 3; i++) b.recordError("bb");
  tick(); b.beat([S("a", 0, 1), S("bb", 0, 0)]);
  const snap = b.snapshot();
  assert.equal(snap[0].agentId, "bb"); // steering sorts above healthy
  b.prune(["a"]);
  assert.deepEqual(b.snapshot().map((r) => r.agentId), ["a"]);
});

test("malformed samples are ignored, not thrown", () => {
  const { b } = harness();
  const d = b.beat([null, {}, { agentId: "" }, S("ok", "NaN", -5)]);
  assert.equal(d.length, 1);
  assert.equal(d[0].agentId, "ok");
  assert.equal(d[0].level, "healthy");
});

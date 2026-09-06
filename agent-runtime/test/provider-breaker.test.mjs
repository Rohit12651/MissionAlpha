// #8 — ONE PROVIDER, MANY CALLERS, NO SHARED MEMORY OF "IT SAID NO".
//
// Observed live on 2026-08-24: `stealth/ox-alpha` rate-limited every call for the better
// part of an hour. Backoff existed, but it was per (story, stage) and per task — so six
// blocked stories and a queue of build tasks each waited out their OWN private timer and
// then all knocked again. Every caller learned the same fact separately, paid for it
// separately, and told the operator about it separately.
//
// This is the shared memory. It is deliberately NOT the per-agent runaway breaker
// (breaker.mjs): that one asks "is this AGENT misbehaving", this one asks "is this
// ENDPOINT refusing everyone".
//
// THE LINE THAT MATTERS: only provider WEATHER opens it. A 401, a missing model, a bad
// prompt are settled answers about US, and a cooldown on those would hide a blocker the
// operator has to clear behind a timer that looks like rate limiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderBreaker, isProviderOverload } from "../provider-breaker.mjs";

test("PB-1: only provider weather counts as overload", () => {
  for (const e of [
    'HTTP 429 — {"error":{"code":429}}',
    "stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.",
    "HTTP 503 service unavailable",
    "HTTP 502 bad gateway",
    "Overloaded",
    "socket hang up",
    "read ECONNRESET",
  ]) assert.equal(isProviderOverload(e), true, e);

  for (const e of [
    "API Error: 401 OAuth access token has expired",
    "HTTP 403 forbidden",
    "account 'OX Alpha' has no model id set",
    "invalid api key",
    "the agent produced an empty artifact",
    "",
    null,
  ]) assert.equal(isProviderOverload(e), false, String(e));
});

const mk = (over = {}) => {
  let t = 1_000_000;
  const b = createProviderBreaker({
    now: () => t, cooldownBaseMs: 30_000, cooldownMaxMs: 300_000, log: () => {}, ...over,
  });
  return { b, advance: (ms) => { t += ms; }, at: () => t };
};

test("PB-2: a fresh key is closed — nothing has said no yet", () => {
  const { b } = mk();
  assert.deepEqual(b.canCall("acct-1"), { ok: true, remainingMs: 0, reason: null });
});

test("PB-3: one overload opens a cooldown; the window grows with consecutive refusals", () => {
  const { b, advance } = mk();
  b.record("acct-1", { ok: false, error: "HTTP 429 rate-limited" });
  assert.equal(b.canCall("acct-1").ok, false);
  assert.equal(b.canCall("acct-1").remainingMs, 30_000);

  advance(30_000);
  assert.equal(b.canCall("acct-1").ok, true, "the window closes on its own");

  b.record("acct-1", { ok: false, error: "HTTP 429" });
  assert.equal(b.canCall("acct-1").remainingMs, 60_000, "second consecutive refusal doubles it");
});

test("PB-4: the cooldown is capped", () => {
  const { b } = mk();
  for (let i = 0; i < 12; i++) b.record("acct-1", { ok: false, error: "HTTP 429" });
  assert.equal(b.canCall("acct-1").remainingMs, 300_000);
});

test("PB-5: a success closes it immediately — the provider is answering again", () => {
  const { b } = mk();
  b.record("acct-1", { ok: false, error: "HTTP 429" });
  assert.equal(b.canCall("acct-1").ok, false);
  b.record("acct-1", { ok: true });
  assert.deepEqual(b.canCall("acct-1"), { ok: true, remainingMs: 0, reason: null });
});

test("PB-6: a SETTLED failure never opens it — an auth error must not look like weather", () => {
  const { b } = mk();
  b.record("acct-1", { ok: false, error: "API Error: 401 OAuth access token has expired" });
  assert.equal(b.canCall("acct-1").ok, true, "a 401 is a blocker for the operator, not a timer");
});

test("PB-7: a provider-supplied Retry-After wins when it is longer than ours", () => {
  const { b } = mk();
  b.record("acct-1", { ok: false, error: "HTTP 429", retryAfterMs: 120_000 });
  assert.equal(b.canCall("acct-1").remainingMs, 120_000);
  // …and never SHORTENS the guard below our own backoff.
  const { b: b2 } = mk();
  b2.record("acct-2", { ok: false, error: "HTTP 429", retryAfterMs: 1_000 });
  assert.equal(b2.canCall("acct-2").remainingMs, 30_000);
});

test("PB-8: keys are independent — one provider cooling does not gag another", () => {
  const { b } = mk();
  b.record("acct-1", { ok: false, error: "HTTP 429" });
  assert.equal(b.canCall("acct-1").ok, false);
  assert.equal(b.canCall("acct-2").ok, true);
});

test("PB-9: an absent or unknown key is always callable — never fail closed on ignorance", () => {
  const { b } = mk();
  assert.equal(b.canCall(null).ok, true);
  assert.equal(b.canCall("").ok, true);
  assert.equal(b.canCall(undefined).ok, true);
});

test("PB-10: snapshot reports only OPEN keys, with the reason the operator needs", () => {
  const { b } = mk();
  b.record("acct-1", { ok: false, error: "HTTP 429 rate-limited upstream" });
  b.record("acct-2", { ok: true });
  const snap = b.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].key, "acct-1");
  assert.equal(snap[0].consecutive, 1);
  assert.match(snap[0].reason, /429|rate/i);
  assert.ok(snap[0].remainingMs > 0);
});

test("PB-11: recording is total — a malformed outcome can never throw into a dispatch path", () => {
  const { b } = mk();
  assert.doesNotThrow(() => b.record("acct-1", null));
  assert.doesNotThrow(() => b.record(null, { ok: false, error: "HTTP 429" }));
  assert.doesNotThrow(() => b.record("acct-1", { ok: false, error: { not: "a string" } }));
  assert.equal(b.canCall("acct-1").ok, true, "nothing malformed was believed");
});

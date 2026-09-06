// D5 — CONTINUOUS OPERATION ACROSS A TRANSIENT PROVIDER FAULT.
//
// Measured live: a story was advanced into `requirements`, the provider answered
// `HTTP 429 — stealth/ox-alpha is temporarily rate-limited upstream. Please retry
// shortly.`, and pipeline.failStage parked the story `blocked`. Nothing ever re-entered
// it. The engine queue has had 429 backoff since ADR-028; the STORY pipeline had none, so
// one rate-limit ended the story until a human noticed — in a product whose entire claim
// is "autonomous between decisions".
//
// This module decides WHICH blocked stories deserve another attempt and WHEN. It is pure
// over an injected store + clock, so every rule is provable without a runtime.
//
// The line it must not cross: an AUTHENTICATION failure, a missing account, a bad config
// are settled answers. Retrying them burns the provider's rate limit to re-derive a fact
// we already have, and hides a blocker the operator has to act on. Deterministic beats
// transient whenever both match.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTransientReason, stageAttempts, retryDelayMs, MAX_STAGE_ATTEMPTS, createStageRetry,
} from "../stage-retry.mjs";

test("SR-1: provider-transient reasons are retryable", () => {
  for (const r of [
    'openai-compat chat failed: HTTP 429 — {"error":{"message":"Provider returned error","code":429}}',
    "stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.",
    "HTTP 503 service unavailable",
    "HTTP 502 bad gateway",
    "socket hang up",
    "read ECONNRESET",
    "connect ETIMEDOUT 1.2.3.4:443",
    "getaddrinfo EAI_AGAIN api.example.com",
    "the stage deadline elapsed — the request timed out",
    "OX Alpha returned an empty reply",
    "Overloaded",
  ]) assert.equal(isTransientReason(r), true, r);
});

test("SR-2: settled failures are NEVER retried, even when they also look transient", () => {
  for (const r of [
    "Failed to authenticate. API Error: 401 OAuth access token has expired.",
    "HTTP 403 forbidden",
    "invalid api key",
    "no active account cannot run the autonomous engine",
    "quality config unavailable",
    "insufficient_quota — please add credits",
    // Deterministic wins even when a transient word is present.
    "HTTP 401 unauthorized (retry shortly)",
  ]) assert.equal(isTransientReason(r), false, r);
});

test("SR-3: an unrecognised reason is NOT retried — silence is not a licence to spend", () => {
  assert.equal(isTransientReason("something nobody has classified"), false);
  assert.equal(isTransientReason(""), false);
  assert.equal(isTransientReason(null), false);
});

test("SR-4: attempts are counted from the story's own failure rows, per stage", () => {
  const log = [
    { stage: "requirements", event: "advance", ts: 1 },
    { stage: "requirements", event: "requirements-failed", ref: "HTTP 429", ts: 2 },
    { stage: "requirements", event: "requirements-retry", ts: 3 },
    { stage: "requirements", event: "requirements-failed", ref: "HTTP 429", ts: 4 },
    { stage: "design", event: "design-failed", ref: "HTTP 429", ts: 5 },
  ];
  assert.equal(stageAttempts(log, "requirements"), 2, "retry rows are not failures");
  assert.equal(stageAttempts(log, "design"), 1);
  assert.equal(stageAttempts(log, "plan"), 0);
});

test("SR-5: the backoff grows and is capped", () => {
  const o = { baseDelayMs: 30_000, maxDelayMs: 600_000 };
  assert.equal(retryDelayMs(1, o), 30_000);
  assert.equal(retryDelayMs(2, o), 60_000);
  assert.equal(retryDelayMs(3, o), 120_000);
  assert.equal(retryDelayMs(99, o), 600_000, "capped, never unbounded");
});

// ── the sweep ────────────────────────────────────────────────────────────────────
function fakeStories(rows) {
  const updates = [];
  return {
    updates,
    listStories: ({ status } = {}) => rows.filter((r) => !status || r.story.status === status).map((r) => r.story),
    getLog: (id) => (rows.find((r) => r.story.id === id)?.log ?? []),
    update: (id, patch) => { updates.push({ id, patch }); const r = rows.find((x) => x.story.id === id); if (r) Object.assign(r.story, { status: patch.status ?? r.story.status }); },
  };
}
const blocked = (id, stage, reason, ts, extraLog = []) => ({
  story: { id, stage, status: "blocked", title: id },
  log: [...extraLog, { stage, event: `${stage}-failed`, ref: reason, ts }],
});

const mk = (stories, over = {}) => {
  const entered = [];
  const r = createStageRetry({
    stories,
    enterStage: async (storyId, stage, opts) => { entered.push({ storyId, stage, opts }); return { ok: true }; },
    now: over.now ?? (() => 1_000_000),
    baseDelayMs: 30_000, maxDelayMs: 600_000,
    log: () => {},
    ...over,
  });
  return { retry: r, entered };
};

test("SR-6: a 429-blocked story is re-entered once its backoff has elapsed", async () => {
  const stories = fakeStories([blocked("story_a", "requirements", "HTTP 429 rate-limited", 900_000)]);
  const { retry, entered } = mk(stories); // now = 1_000_000, failed at 900_000 ⇒ 100s > 30s
  const r = await retry.sweep();
  assert.equal(r.started, 1);
  assert.deepEqual(entered, [{ storyId: "story_a", stage: "requirements", opts: { rerun: true } }]);
  assert.equal(stories.updates[0].patch.status, "active", "the story leaves `blocked` before it is re-entered");
  assert.match(String(stories.updates[0].patch.event), /requirements-retry/);
});

test("SR-7: the backoff is respected — too soon means not yet", async () => {
  const stories = fakeStories([blocked("story_a", "requirements", "HTTP 429", 990_000)]); // 10s ago
  const { retry, entered } = mk(stories);
  const r = await retry.sweep();
  assert.equal(r.started, 0);
  assert.deepEqual(entered, []);
});

test("SR-8: a deterministic failure is never re-entered, however long it waits", async () => {
  const stories = fakeStories([blocked("story_a", "design", "API Error: 401 OAuth access token has expired", 1)]);
  const { retry, entered } = mk(stories);
  assert.equal((await retry.sweep()).started, 0);
  assert.deepEqual(entered, []);
});

test("SR-9: the attempt budget is bounded — an exhausted story stays blocked", async () => {
  const past = Array.from({ length: MAX_STAGE_ATTEMPTS }, (_, i) => ({ stage: "requirements", event: "requirements-failed", ref: "HTTP 429", ts: 100 + i }));
  const stories = fakeStories([{ story: { id: "story_a", stage: "requirements", status: "blocked" }, log: past }]);
  const { retry, entered } = mk(stories);
  assert.equal((await retry.sweep()).started, 0);
  assert.deepEqual(entered, []);
});

test("SR-10: a RUNNING story is never disturbed — only a stalled one is rescued", async () => {
  // The guarantee this has always protected: never re-dispatch a stage that is genuinely
  // in flight. Post-SR-15 the discriminator is TIME, not status — an `active` story whose
  // last row is recent is working, and an `active` story with nothing moving for longer
  // than the stage deadline is gone. `now` here is 1s past the row, i.e. plainly working.
  const stories = fakeStories([{ story: { id: "story_a", stage: "design", status: "active" }, log: [{ stage: "design", event: "design-failed", ref: "HTTP 429", ts: 999_000 }] }]);
  const { retry, entered } = mk(stories);
  assert.equal((await retry.sweep()).started, 0);
  assert.deepEqual(entered, []);
});

test("SR-11: a story already being re-entered is not started twice by an overlapping sweep", async () => {
  const stories = fakeStories([blocked("story_a", "requirements", "HTTP 429", 900_000)]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const entered = [];
  const retry = createStageRetry({
    stories,
    enterStage: async (storyId, stage, opts) => { entered.push({ storyId, stage, opts }); await gate; return {}; },
    now: () => 1_000_000, baseDelayMs: 30_000, maxDelayMs: 600_000, log: () => {},
  });
  const first = retry.sweep();
  const second = await retry.sweep();
  assert.equal(second.started, 0, "the second sweep sees the first still in flight");
  release();
  await first;
  assert.equal(entered.length, 1);
});

test("SR-12: a failing re-entry never throws out of the sweep", async () => {
  const stories = fakeStories([blocked("story_a", "requirements", "HTTP 429", 900_000)]);
  const retry = createStageRetry({
    stories,
    enterStage: async () => { throw new Error("pipeline exploded"); },
    now: () => 1_000_000, baseDelayMs: 30_000, maxDelayMs: 600_000, log: () => {},
  });
  const r = await retry.sweep();
  assert.equal(r.started, 1, "it was started");
  assert.equal(r.errors, 1, "and the fault is counted, not thrown");
});

test("SR-13: a pipeline that DECLINES the re-entry puts the story back to blocked", async () => {
  // An `active` story that nothing is working on is worse than a `blocked` one: it is the
  // silent non-event the whole program exists to remove. A decline is not a start.
  const stories = fakeStories([blocked("story_a", "requirements", "HTTP 429", 900_000)]);
  const retry = createStageRetry({
    stories,
    enterStage: async () => ({ skipped: true, reason: "story is at 'design', not 'requirements'" }),
    now: () => 1_000_000, baseDelayMs: 30_000, maxDelayMs: 600_000, log: () => {},
  });
  await retry.sweep();
  const last = stories.updates.at(-1);
  assert.equal(last.patch.status, "blocked");
  assert.match(String(last.patch.ref), /retry declined/);
});

test("SR-14: a THROWN re-entry also lands back on blocked, not left half-started", async () => {
  const stories = fakeStories([blocked("story_a", "requirements", "HTTP 429", 900_000)]);
  const retry = createStageRetry({
    stories,
    enterStage: async () => { throw new Error("pipeline exploded"); },
    now: () => 1_000_000, baseDelayMs: 30_000, maxDelayMs: 600_000, log: () => {},
  });
  const r = await retry.sweep();
  assert.equal(r.errors, 1);
  assert.equal(stories.updates.at(-1).patch.status, "blocked");
});

// ── STALLED-ACTIVE: the failure mode the retry itself can create ─────────────────
//
// Observed while driving the live loop with this very sweep running: `story_8361a8…`
// sat `active` at `requirements` for twenty minutes with no new log row and nothing in
// flight. A story parked `blocked` is at least visible; a story parked `active` claims
// someone is working on it, which is the silent non-event this whole program exists to
// remove — and the retry sweep is what puts stories into `active`, so it owns the rescue.
//
// The bound is the stage deadline plus a margin: past that, the stage is not slow, it is
// gone. The SAME attempt budget applies, so a story that stalls repeatedly still ends up
// parked for a human instead of looping forever.
const stalledStory = (id, stage, lastTs) => ({
  story: { id, stage, status: "active", title: id },
  log: [{ stage, event: `${stage}-retry`, ref: "attempt 2/4", ts: lastTs }],
});

test("SR-15: a story ACTIVE past the stall deadline is re-entered, not left claiming progress", async () => {
  const stories = fakeStories([stalledStory("story_s", "requirements", 100_000)]);
  const { retry, entered } = mk(stories, { now: () => 1_000_000, stallMs: 720_000 });
  const r = await retry.sweep();
  assert.equal(r.started, 1);
  assert.deepEqual(entered, [{ storyId: "story_s", stage: "requirements", opts: { rerun: true } }]);
});

test("SR-16: a story that is merely SLOW is left alone — a stage takes minutes", async () => {
  const stories = fakeStories([stalledStory("story_s", "requirements", 900_000)]); // 100s ago
  const { retry, entered } = mk(stories, { now: () => 1_000_000, stallMs: 720_000 });
  assert.equal((await retry.sweep()).started, 0);
  assert.deepEqual(entered, []);
});

test("SR-17: a stalled story still obeys the attempt budget", async () => {
  const rows = Array.from({ length: MAX_STAGE_ATTEMPTS }, (_, i) => ({ stage: "requirements", event: "requirements-failed", ref: "HTTP 429", ts: 100 + i }));
  const stories = fakeStories([{ story: { id: "story_s", stage: "requirements", status: "active" }, log: rows }]);
  const { retry, entered } = mk(stories, { now: () => 1_000_000, stallMs: 720_000 });
  assert.equal((await retry.sweep()).started, 0);
  assert.deepEqual(entered, []);
});

test("SR-18: an in-flight re-entry that never settles is evicted so recovery can proceed", async () => {
  const stories = fakeStories([blocked("story_a", "requirements", "HTTP 429", 900_000)]);
  const entered = [];
  let now = 1_000_000;
  const retry = createStageRetry({
    stories,
    // First call never settles (the orphan). The second must, or this test would hang on
    // the very promise it is proving we no longer wait for.
    enterStage: async (storyId, stage, opts) => {
      entered.push({ storyId, stage, opts });
      if (entered.length === 1) return new Promise(() => {});
      return { ok: true };
    },
    now: () => now, baseDelayMs: 30_000, maxDelayMs: 600_000, stallMs: 720_000, log: () => {},
  });
  retry.sweep();                       // starts, never settles
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(retry.inFlightCount(), 1);
  now += 800_000;                      // past the stall deadline
  await retry.sweep();
  assert.equal(retry.inFlightCount() <= 1, true);
  assert.equal(entered.length, 2, "the story is retried again rather than held hostage by a dead promise");
});

// ── #8 — the sweep must not join the herd ────────────────────────────────────────
// Six blocked stories, one shared upstream limit. Without this, every due story re-enters
// on the same beat and they all get 429 together — the exact behaviour observed live.
test("SR-19: no story is re-entered while the provider is refusing everyone", async () => {
  const stories = fakeStories([blocked("story_a", "requirements", "HTTP 429", 900_000)]);
  const { retry, entered } = mk(stories, { providerHoldMs: () => 45_000 });
  const r = await retry.sweep();
  assert.equal(r.started, 0);
  assert.equal(r.providerHeld, true, "the sweep says WHY it did nothing");
  assert.deepEqual(entered, []);
});

test("SR-20: once the provider is answering again, the same story is re-entered", async () => {
  const stories = fakeStories([blocked("story_a", "requirements", "HTTP 429", 900_000)]);
  const { retry, entered } = mk(stories, { providerHoldMs: () => 0 });
  assert.equal((await retry.sweep()).started, 1);
  assert.equal(entered.length, 1);
});

test("SR-21: an unwired or throwing provider probe never blocks the sweep", async () => {
  const stories = fakeStories([blocked("story_a", "requirements", "HTTP 429", 900_000)]);
  const { retry } = mk(stories, { providerHoldMs: () => { throw new Error("no breaker"); } });
  assert.equal((await retry.sweep()).started, 1, "a broken optimisation must not become a gate");
});

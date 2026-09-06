// AUTONOMY PROGRAM PHASE 3 — the handback dispatcher, and the loop guard.
//
// What these pin is the SINGLE MOST IMPORTANT ITEM in the whole autonomy plan, in its own
// words: a reject must ENQUEUE the rework automatically, carrying the reviewer's reason as
// the brief. Before this module the story bounced stage and nobody picked it up.
//
// And the thing that makes an autonomous rework loop safe to leave running: a cap. Without
// one, reviewer-blocks-fixer-fixes-reviewer-blocks is a denial-of-service on your own
// budget, spending real money every round, forever.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createStoryHandback, reworkBrief, SEAT_FOR_STAGE, DEFAULT_MAX_ROUNDS } from "../story-handback.mjs";

const hb = (over = {}) => ({
  storyId: "story_abc",
  fromStage: "review-qa",
  toStage: "build",
  byAgent: "reviewer",
  toAgent: null,
  reason: "auth middleware compares tokens with == and admits an expired one",
  evidence: ["vault:v_123", "task_9"],
  round: 1,
  ...over,
});

function rig(over = {}) {
  const enqueued = [];
  const alerts = [];
  const updates = [];
  const h = createStoryHandback({
    enqueueGoal: (g) => { enqueued.push(g); return { goalId: "goal_1", firstTaskId: "t1" }; },
    stories: { update: (id, patch) => { updates.push({ id, ...patch }); } },
    mintAlert: (a) => alerts.push(a),
    ...over,
  });
  return { h, enqueued, alerts, updates };
}

test("A REJECT DISPATCHES THE REWORK — to the seat that owns the target stage", () => {
  const { h, enqueued } = rig();
  const out = h.dispatch(hb());
  assert.equal(out.dispatched, true);
  assert.equal(out.seat, "sr-backend", "build rework goes to the builder");
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].agentId, "sr-backend");
  assert.equal(enqueued[0].storyId, "story_abc");
  assert.equal(enqueued[0].priority, "high", "rework has already been through the pipeline once");
});

test("the reviewer's REASON travels verbatim as the brief — never a paraphrase", () => {
  const { h, enqueued } = rig();
  h.dispatch(hb());
  const brief = enqueued[0].steps[0];
  assert.match(brief, /auth middleware compares tokens with == and admits an expired one/);
  assert.match(brief, /review-qa/);
  assert.match(brief, /build/);
  assert.match(brief, /reviewer/);
  assert.match(brief, /vault:v_123/, "the evidence the sender was looking at travels too");
});

test("an explicitly named seat beats the stage default", () => {
  const { h, enqueued } = rig();
  h.dispatch(hb({ toAgent: "sr-frontend" }));
  assert.equal(enqueued[0].agentId, "sr-frontend");
});

// ── THE LOOP GUARD ───────────────────────────────────────────────────────────
test("the cap STOPS the loop and pages a human — it does not keep dispatching", () => {
  const { h, enqueued, alerts, updates } = rig({ maxRounds: 3 });
  for (const round of [1, 2, 3]) assert.equal(h.dispatch(hb({ round })).dispatched, true);
  assert.equal(enqueued.length, 3);

  const out = h.dispatch(hb({ round: 4 }));
  assert.equal(out.escalated, true);
  assert.equal(out.kind, "rework-capped");
  assert.equal(enqueued.length, 3, "bounce 4 must not queue more paid work");
  assert.equal(updates.at(-1).status, "blocked", "a capped story must not read as still running");
  assert.equal(alerts.length, 1);
  assert.equal(alerts.at(-1).taskId, "story_abc", "one alert per story — two stuck stories never collapse into one row");
  assert.match(alerts.at(-1).detail, /not converging/i);
  assert.match(alerts.at(-1).detail, /cap of 3/);
});

test("the escalation carries the LAST reason, so the human is not sent to read the log", () => {
  const { h, alerts } = rig({ maxRounds: 1 });
  h.dispatch(hb({ round: 2, reason: "still returns 500 on an expired token" }));
  assert.match(alerts[0].detail, /still returns 500 on an expired token/);
});

test("BOTH halves of the escalation are attempted — a failing block must not suppress the alert", () => {
  // A story parked `blocked` with no Inbox row is invisible; an Inbox row on a story still
  // marked `active` reads as though the loop is running. Neither may swallow the other.
  const { h, alerts } = rig({
    maxRounds: 1,
    stories: { update: () => { throw new Error("db is locked"); } },
  });
  const out = h.dispatch(hb({ round: 5 }));
  assert.equal(out.escalated, true);
  assert.equal(alerts.length, 1, "the operator must still be paged");
});

test("the default cap exists — an unset maxRounds is not an unlimited one", () => {
  const { h, enqueued, alerts } = rig();
  assert.equal(h.maxRounds, DEFAULT_MAX_ROUNDS);
  h.dispatch(hb({ round: DEFAULT_MAX_ROUNDS + 1 }));
  assert.equal(enqueued.length, 0);
  assert.equal(alerts.length, 1);
});

// ── nothing is ever silently dropped ────────────────────────────────────────
test("a stage NO SEAT owns escalates rather than vanishing", () => {
  const { h, enqueued, alerts } = rig({ seats: { build: null } });
  const out = h.dispatch(hb());
  assert.equal(out.escalated, true);
  assert.equal(out.kind, "handback-unroutable");
  assert.equal(enqueued.length, 0);
  assert.match(alerts[0].detail, /no seat owns/i);
});

test("NO ENGINE WIRED reports the truth — it never claims a dispatch that did not happen", () => {
  const { h, alerts } = rig({ enqueueGoal: null });
  const out = h.dispatch(hb());
  assert.equal(out.escalated, true);
  assert.equal(out.kind, "handback-undispatched");
  assert.match(alerts[0].detail, /no engine is wired/i);
});

test("a FULL BACKLOG escalates — a rejected enqueue is not a dispatch", () => {
  const { h, alerts } = rig({ enqueueGoal: () => ({ error: "backlog full" }) });
  const out = h.dispatch(hb());
  assert.equal(out.escalated, true);
  assert.match(alerts[0].detail, /backlog full/);
});

test("a THROWN enqueue escalates too, and never propagates — the bounce already committed", () => {
  const { h, alerts } = rig({ enqueueGoal: () => { throw new Error("queue exploded"); } });
  const out = h.dispatch(hb());
  assert.equal(out.escalated, true);
  assert.match(alerts[0].detail, /queue exploded/);
});

test("a handback with no storyId is a no-op, not a crash", () => {
  const { h, enqueued } = rig();
  assert.equal(h.dispatch({}).skipped, true);
  assert.equal(h.dispatch().skipped, true);
  assert.equal(enqueued.length, 0);
});

// ── the seat map ────────────────────────────────────────────────────────────
test("every stage that can be REJECTED INTO has an owner — except intake", () => {
  // STORY_BACK's targets are the stages a bounce can land on. A target with no seat would
  // escalate every single time, which is a config bug dressed as a safety feature.
  for (const stage of ["requirements", "design", "plan", "build", "review-qa", "deploy-watch"]) {
    assert.ok(SEAT_FOR_STAGE[stage], `no seat owns '${stage}'`);
  }
  assert.equal(SEAT_FOR_STAGE.idea, undefined, "nothing is bounced back to intake");
});

test("the brief is bounded — a pasted essay cannot become an unbounded prompt", () => {
  const brief = reworkBrief({ fromStage: "review-qa", toStage: "build", byAgent: "reviewer", reason: "x".repeat(50_000), evidence: [] });
  assert.ok(brief.length <= 4000, `brief was ${brief.length} chars`);
});

test("a missing reason is stated as missing, never rendered as an empty instruction", () => {
  const brief = reworkBrief({ fromStage: "review-qa", toStage: "build" });
  assert.match(brief, /no reason was recorded/i);
});

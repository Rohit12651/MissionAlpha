// Story-Pipeline S6 — the Stories client's PURE view-model. Zero DOM, zero network, so it runs
// under `node --experimental-strip-types --test`. Pins the stage machine mirror, the spine fold,
// the status tone map, the clarify-thread fold, and the two-human-gate invariant.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STORY_STAGES,
  STORY_STATUSES,
  STORY_GATE_STAGES,
  isGateStage,
  stageLabel,
  stageIndex,
  statusTone,
  statusLabel,
  spineFor,
  columns,
  columnFor,
  clarifyThread,
  openQuestionCount,
  whenLabel,
  taskErrorText,
  type Story,
  manualAdvance,
} from "../storiesClient.ts";

const mk = (over: Partial<Story> = {}): Story => ({
  id: "story_a",
  title: "A story",
  idea: "an idea",
  spec: null,
  designRef: null,
  stage: "idea",
  status: "active",
  answers: null,
  venture: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test("stage machine mirrors the backend: 8 ordered stages, idea first, accept last", () => {
  assert.equal(STORY_STAGES.length, 8);
  assert.equal(STORY_STAGES[0], "idea");
  assert.equal(STORY_STAGES[STORY_STAGES.length - 1], "accept");
  assert.deepEqual([...STORY_STAGES], [
    "idea", "requirements", "design", "plan", "build", "review-qa", "deploy-watch", "accept",
  ]);
});

test("the two human gates are design (TAP 1) and deploy-watch (TAP 2 / Ship) — and only those", () => {
  assert.deepEqual([...STORY_GATE_STAGES], ["design", "deploy-watch"]);
  assert.equal(isGateStage("design"), true);
  assert.equal(isGateStage("deploy-watch"), true);
  assert.equal(isGateStage("build"), false);
  assert.equal(isGateStage("accept"), false);
  // Exactly two — the program-wide "two human taps" invariant.
  assert.equal(STORY_STAGES.filter(isGateStage).length, 2);
});

test("stageLabel + stageIndex resolve known stages and degrade honestly", () => {
  assert.equal(stageLabel("review-qa"), "Review · QA");
  assert.equal(stageLabel("deploy-watch"), "Ship · Watch");
  assert.equal(stageLabel("bogus"), "bogus");
  assert.equal(stageIndex("design"), 2);
  assert.equal(stageIndex("bogus"), -1);
});

test("statusTone maps every status; waiting-you=amber, blocked/rejected=red, shipped=green", () => {
  assert.equal(statusTone("waiting-you"), "amber");
  assert.equal(statusTone("blocked"), "red");
  assert.equal(statusTone("rejected"), "red");
  assert.equal(statusTone("shipped"), "green");
  assert.equal(statusTone("active"), "brass");
  assert.equal(statusTone("weird"), "muted");
  for (const s of STORY_STATUSES) assert.ok(statusLabel(s).length > 0);
});

test("spineFor: before-current done, current current, after todo; gates flagged", () => {
  const spine = spineFor(mk({ stage: "plan", status: "active" }));
  assert.equal(spine.length, 8);
  assert.equal(spine[stageIndex("idea")].state, "done");
  assert.equal(spine[stageIndex("design")].state, "done");
  assert.equal(spine[stageIndex("plan")].state, "current");
  assert.equal(spine[stageIndex("build")].state, "todo");
  assert.equal(spine[stageIndex("design")].isGate, true);
  assert.equal(spine[stageIndex("deploy-watch")].isGate, true);
});

test("spineFor: a shipped story is all-done", () => {
  const spine = spineFor(mk({ stage: "accept", status: "shipped" }));
  assert.ok(spine.every((n) => n.state === "done"));
});

test("spineFor: waiting-you marks the current gate node awaitingYou", () => {
  const spine = spineFor(mk({ stage: "design", status: "waiting-you" }));
  const design = spine[stageIndex("design")];
  assert.equal(design.state, "current");
  assert.equal(design.awaitingYou, true);
  assert.equal(design.rejected, false);
});

test("spineFor: a rejected story marks the current node rejected", () => {
  const spine = spineFor(mk({ stage: "design", status: "rejected" }));
  assert.equal(spine[stageIndex("design")].rejected, true);
});

test("columns: 8 ordered columns, each story in its stage, newest-updated first", () => {
  const cols = columns([
    mk({ id: "s1", stage: "build", updatedAt: 10 }),
    mk({ id: "s2", stage: "build", updatedAt: 20 }),
    mk({ id: "s3", stage: "idea", updatedAt: 5 }),
  ]);
  assert.equal(cols.length, 8);
  assert.deepEqual(cols.map((c) => c.stage), [...STORY_STAGES]);
  const build = cols.find((c) => c.stage === "build")!;
  assert.deepEqual(build.stories.map((s) => s.id), ["s2", "s1"]); // newest updated first
  assert.equal(cols.find((c) => c.stage === "idea")!.stories.length, 1);
  assert.equal(cols.find((c) => c.stage === "accept")!.stories.length, 0);
});

test("columnFor: an unknown stage buckets into idea rather than vanishing", () => {
  assert.equal(columnFor({ stage: "nonsense" as Story["stage"] }), "idea");
  assert.equal(columnFor({ stage: "review-qa" }), "review-qa");
});

test("clarifyThread: folds answers JSON, keeps answered + open, ignores malformed", () => {
  const json = JSON.stringify({ questions: [
    { id: "q0", q: "Which auth?", a: "OIDC" },
    { id: "q1", q: "Rate limit?", a: null },
    { q: "no id here", a: null }, // id synthesized
    { a: "no question" }, // dropped (no q)
    "garbage", // dropped
  ] });
  const thread = clarifyThread(json);
  assert.equal(thread.length, 3);
  assert.equal(thread[0].a, "OIDC");
  assert.equal(thread[1].a, null);
  assert.equal(thread[2].id, "q2"); // synthesized from index
  assert.equal(openQuestionCount(json), 2);
});

test("clarifyThread: null / empty / non-JSON fold to an empty thread, never throw", () => {
  assert.deepEqual(clarifyThread(null), []);
  assert.deepEqual(clarifyThread(""), []);
  assert.deepEqual(clarifyThread("{not json"), []);
  assert.deepEqual(clarifyThread(JSON.stringify({ questions: "nope" })), []);
  assert.equal(openQuestionCount(null), 0);
});

test("taskErrorText: folds the {kind,msg} engine error to a render-safe string, never an object", () => {
  assert.equal(taskErrorText({ kind: "test-failed", msg: "2 assertions failed" }), "test-failed · 2 assertions failed");
  assert.equal(taskErrorText({ kind: "spawn" }), "spawn");
  assert.equal(taskErrorText({ msg: "boom" }), "boom");
  assert.equal(taskErrorText({}), null);
  assert.equal(taskErrorText(null), null);
});

test("whenLabel: compact UTC stamp; invalid/missing → em dash", () => {
  assert.equal(whenLabel(Date.UTC(2026, 7, 4, 14, 0)), "Aug 4 · 14:00 UTC");
  assert.equal(whenLabel(NaN), "—");
});

// ── D6 — the control the Stories UI never had ───────────────────────────────────
test("manualAdvance offers START only at idea, and RETRY only when blocked", () => {
  assert.equal(manualAdvance({ stage: "idea", status: "active" })?.kind, "start");
  assert.equal(manualAdvance({ stage: "design", status: "blocked" })?.kind, "retry");
  assert.equal(manualAdvance({ stage: "requirements", status: "blocked" })?.kind, "retry");
  // A stage that is mid-flight must NOT offer a button — a second dispatch of a running
  // stage is exactly the double-spend the pipeline's own dedupe exists to prevent.
  assert.equal(manualAdvance({ stage: "design", status: "active" }), null);
  assert.equal(manualAdvance({ stage: "design", status: "waiting-you" }), null);
  assert.equal(manualAdvance({ stage: "accept", status: "shipped" }), null);
  assert.equal(manualAdvance({ stage: "design", status: "rejected" }), null);
  assert.equal(manualAdvance(null), null);
});

// Phase G — the mockup's card time: "Ns ago" / "Nm ago" / "Nh ago" (mockup ago()).
import { agoLabel } from "../storiesClient.ts";

test("agoLabel speaks the mockup's relative time", () => {
  const now = 1_786_500_000_000;
  assert.equal(agoLabel(now - 42_000, now), "42s ago");
  assert.equal(agoLabel(now - 31 * 60_000, now), "31m ago");
  assert.equal(agoLabel(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(agoLabel(now + 5_000, now), "0s ago", "a clock-skewed future time never reads negative");
  assert.equal(agoLabel(Number.NaN, now), "—", "an unknown time is a dash, never 'just now'");
});

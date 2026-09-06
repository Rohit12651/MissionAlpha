// AUTONOMY PROGRAM PHASE 3 — THE FULL ROUND TRIP, read off real SQLite rows.
//
// The plan's exit for this phase, in its own words: build → review-qa → reject → back to
// build → advance → review-qa → accept, shown as `story_log` rows. This file is that proof,
// with the real stories store, the real database and the real handback dispatcher wired the
// way `server.mjs` wires them. Only the engine is a recorder — what is under test is that a
// reject DISPATCHES, not what the dispatched agent then writes.
//
// The defect this closes: the loop existed as a state machine and nothing drove it. A story
// bounced and sat there. The reviewer gate was the only caller that enqueued anything, so a
// reject from the HTTP route — an operator, or any other agent — moved a stage and stopped.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDb } from "../db.mjs";
import { createStories } from "../stories.mjs";
import { createStoryHandback } from "../story-handback.mjs";

let root, handle, db, stories, handback, enqueued, alerts;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-handback-rt-")));
  mkdirSync(join(root, "data"), { recursive: true });
  handle = openDb({ path: join(root, "data", "mission.db"), patchesDir: join(root, "patches") });
  db = handle.db;
  enqueued = [];
  alerts = [];
  // Wired exactly as server.mjs does: the store fires onHandback, the dispatcher reads
  // lazily, so the two can be constructed in either order.
  stories = createStories({
    db,
    onHandback: (hb) => handback.dispatch(hb),
    log: () => {},
  });
  handback = createStoryHandback({
    enqueueGoal: (g) => { enqueued.push(g); return { goalId: `goal_${enqueued.length}` }; },
    stories,
    mintAlert: (a) => alerts.push(a),
    maxRounds: 3,
    log: () => {},
  });
});

afterEach(() => {
  try { handle?.close?.(); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

/** Walk a fresh story forward to `build` through the real advance() machine. */
function storyAtBuild() {
  const s = stories.createStory({ title: "Expire tokens correctly", idea: "auth admits expired tokens" });
  for (const _ of ["requirements", "design", "plan", "build"]) stories.advance(s.id, { event: "advance" });
  assert.equal(stories.getStory(s.id).stage, "build");
  return s.id;
}

const logRows = (id) => db.prepare("SELECT seq, stage, event, ref, from_stage, by_agent, to_agent, evidence FROM story_log WHERE story_id = ? ORDER BY seq ASC").all(id);

test("THE ROUND TRIP: build → review-qa → reject → build → advance → review-qa → accept", () => {
  const id = storyAtBuild();

  stories.advance(id, { event: "build-complete" });
  assert.equal(stories.getStory(id).stage, "review-qa");

  // The reviewer sends it back. THE POINT OF THE PHASE: this dispatches the rework.
  stories.reject(id, {
    toStage: "build",
    reason: "auth middleware compares tokens with == and admits an expired one",
    byAgent: "reviewer",
    toAgent: "sr-backend",
    evidence: ["vault:v_abc", "task_17"],
  });
  assert.equal(stories.getStory(id).stage, "build", "the story bounced back to build");
  assert.equal(enqueued.length, 1, "and somebody was actually given the work");
  assert.equal(enqueued[0].agentId, "sr-backend");
  assert.equal(enqueued[0].storyId, id);
  assert.match(enqueued[0].steps[0], /compares tokens with ==/, "the reviewer's own words, verbatim");

  // The fix lands and the story walks forward again, to the terminal stage.
  stories.advance(id, { event: "build-complete" });
  stories.advance(id, { event: "review-passed" });
  stories.advance(id, { event: "deployed" });
  const final = stories.getStory(id);
  assert.equal(final.stage, "accept");
  assert.equal(final.status, "shipped");

  // THE EVIDENCE — read off the table, not through the API that wrote it.
  const rows = logRows(id);
  // `event` is the CALLER's verb for the transition (the store does not invent one), so the
  // trail reads as the pipeline's own vocabulary rather than a uniform "advance".
  const trail = rows.map((r) => `${r.event}:${r.stage}`);
  assert.deepEqual(trail, [
    "create:idea",
    "advance:requirements",
    "advance:design",
    "advance:plan",
    "advance:build",
    "build-complete:review-qa",
    "reject:build",           // ← the bounce
    "build-complete:review-qa", // ← and the SAME story coming back through, fixed
    "review-passed:deploy-watch",
    "deployed:accept",
  ]);
  // seq is per-story monotonic with no gaps — the log is the whole story, in order.
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("THE HANDBACK IS STRUCTURED — who, to whom, from where, why, and on what evidence", () => {
  const id = storyAtBuild();
  stories.advance(id, { event: "build-complete" });
  stories.reject(id, {
    toStage: "build",
    reason: "expired token accepted",
    byAgent: "reviewer",
    toAgent: "sr-backend",
    evidence: ["vault:v_abc", "task_17"],
  });

  const row = logRows(id).find((r) => r.event === "reject");
  assert.equal(row.from_stage, "review-qa", "a bare `ref` string could never answer 'from where'");
  assert.equal(row.stage, "build");
  assert.equal(row.by_agent, "reviewer");
  assert.equal(row.to_agent, "sr-backend");
  assert.deepEqual(JSON.parse(row.evidence), ["vault:v_abc", "task_17"]);

  // And it survives to the wire shape the Story thread renders.
  const entry = stories.getLog(id).find((e) => e.event === "reject");
  assert.equal(entry.fromStage, "review-qa");
  assert.equal(entry.byAgent, "reviewer");
  assert.equal(entry.toAgent, "sr-backend");
  assert.deepEqual(entry.evidence, ["vault:v_abc", "task_17"]);
});

test("an ORDINARY ADVANCE carries no handback fields — no 'from: null → to: null' noise", () => {
  const id = storyAtBuild();
  const adv = stories.getLog(id).find((e) => e.event === "advance");
  assert.equal(adv.fromStage, undefined);
  assert.equal(adv.byAgent, undefined);
  assert.equal(adv.evidence, undefined);
});

test("THE LOOP GUARD IS DURABLE — the count comes from the log, so a restart does not reset it", () => {
  const id = storyAtBuild();
  // Three bounces, three dispatches.
  for (let i = 0; i < 3; i++) {
    stories.advance(id, { event: "build-complete" });
    stories.reject(id, { toStage: "build", reason: `still failing (${i + 1})`, byAgent: "reviewer" });
  }
  assert.equal(enqueued.length, 3);
  assert.equal(stories.reworkCount(id, "build"), 3);

  // A RESTART. A fresh store over the same database — which is exactly what an in-memory
  // round counter loses, and why a story could bounce forever across restarts.
  const stories2 = createStories({ db, onHandback: (hb) => handback2.dispatch(hb), log: () => {} });
  const enqueued2 = [], alerts2 = [];
  const handback2 = createStoryHandback({
    enqueueGoal: (g) => { enqueued2.push(g); return { goalId: "g" }; },
    stories: stories2,
    mintAlert: (a) => alerts2.push(a),
    maxRounds: 3,
    log: () => {},
  });
  assert.equal(stories2.reworkCount(id, "build"), 3, "the count survived the restart");

  stories2.advance(id, { event: "build-complete" });
  stories2.reject(id, { toStage: "build", reason: "still failing (4)", byAgent: "reviewer" });

  assert.equal(enqueued2.length, 0, "bounce 4 must not buy another round");
  assert.equal(alerts2.length, 1, "it pages the BOSS instead");
  assert.match(alerts2[0].detail, /not converging/i);
  assert.equal(stories2.getStory(id).status, "blocked", "and the story stops reading as active");
});

test("A DISPATCH FAULT NEVER UN-BOUNCES THE STORY — the transition already committed", () => {
  const id = storyAtBuild();
  stories.advance(id, { event: "build-complete" });
  const boom = createStories({
    db,
    onHandback: () => { throw new Error("the dispatcher exploded"); },
    log: () => {},
  });
  // The reject itself must still succeed and still be durable.
  const after = boom.reject(id, { toStage: "build", reason: "x", byAgent: "reviewer" });
  assert.equal(after.stage, "build");
  assert.equal(logRows(id).filter((r) => r.event === "reject").length, 1);
});

test("UNTRUSTED handback text is capped at rest — an essay cannot become an unbounded row", () => {
  const id = storyAtBuild();
  stories.advance(id, { event: "build-complete" });
  stories.reject(id, {
    toStage: "build",
    reason: "r".repeat(50_000),
    byAgent: "a".repeat(500),
    evidence: Array.from({ length: 200 }, () => "e".repeat(5000)),
  });
  const row = logRows(id).find((r) => r.event === "reject");
  assert.ok(row.ref.length <= 512, `ref was ${row.ref.length}`);
  assert.ok(row.by_agent.length <= 64, `by_agent was ${row.by_agent.length}`);
  const ev = JSON.parse(row.evidence);
  assert.ok(ev.length <= 10, `evidence had ${ev.length} items`);
  for (const e of ev) assert.ok(e.length <= 200, `evidence item was ${e.length}`);
});

test("an ILLEGAL back-jump still 409s and dispatches NOTHING", () => {
  const id = storyAtBuild();
  stories.advance(id, { event: "build-complete" }); // review-qa
  assert.throws(() => stories.reject(id, { toStage: "idea", reason: "nope" }), /illegal reject/);
  assert.equal(enqueued.length, 0, "a refused transition must not queue paid work");
  assert.equal(stories.getStory(id).stage, "review-qa", "and must not move the story");
});

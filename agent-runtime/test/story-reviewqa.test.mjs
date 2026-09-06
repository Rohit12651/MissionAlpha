// Story-Pipeline S4 — the review-QA stage driver (reviewer gate + QA gate + PR stage) over
// injected fakes. Proves: reviewer pass advances review-qa→deploy-watch; reviewer block bounces
// to build + mints fix goals; exhausted rounds block the story; QA skip is logged honestly; PR
// skip (gh unauthed) is logged honestly; a malformed verdict fails closed to block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStoryReviewQa } from "../story-reviewqa.mjs";

function world({ reviewerDispatch, e2eCmd = null, gh = { authenticated: false }, sandbox } = {}) {
  const events = [];
  const advances = [];
  const rejects = [];
  const alerts = [];
  const goalsEnqueued = [];
  const vaultWrites = [];
  const story = { id: "story_1", title: "Referral", stage: "review-qa", status: "active" };
  const stories = {
    getStory: () => ({ ...story }),
    advance: (id, m) => { advances.push(m); story.stage = "deploy-watch"; return story; },
    reject: (id, m) => { rejects.push(m); story.stage = "build"; story.status = "active"; return story; },
    update: (id, m) => { events.push(m); if (m.status) story.status = m.status; return story; },
  };
  const rq = createStoryReviewQa({
    stories,
    vault: { write: (r) => { vaultWrites.push(r); return { id: r.id }; } },
    reviewerDispatch,
    aggregate: () => ({ goals: [{ seat: "sr-backend", state: "done", tasks: [{ taskId: "task_1", status: "done", result: "applied 1: src/impl.ts" }] }], counts: { done: 1 }, total: 1 }),
    enqueueGoal: (g) => { goalsEnqueued.push(g); return { goalId: "goal_x", firstTaskId: "task_y" }; },
    mintAlert: (a) => alerts.push(a),
    sandbox,
    loadQualityConfig: () => ({ config: { e2eCmd, timeoutMs: 1000 } }),
    qaCwd: "/repo",
    pr: { ghStatus: async () => gh, deliverApproved: async () => ({ mode: "branch" }) },
    maxReviewRounds: 2,
  });
  return { rq, events, advances, rejects, alerts, goalsEnqueued, vaultWrites, story };
}

test("reviewer PASS + QA skip + PR skip → advance to deploy-watch, honestly logged", async () => {
  const w = world({ reviewerDispatch: async () => ({ verdict: "pass", blockers: [] }) });
  const r = await w.rq.run("story_1");
  assert.equal(r.advanced, true);
  assert.equal(w.story.stage, "deploy-watch");
  // honest skips recorded
  assert.ok(w.events.some((e) => e.event === "qa-skipped"), "qa-skipped logged");
  assert.ok(w.events.some((e) => e.event === "pr-skipped" && e.ref === "gh-unauthed"), "pr-skipped logged with reason");
  // verdict artifact written
  assert.ok(w.vaultWrites.some((v) => v.id.startsWith("review-")), "verdict artifact landed");
});

// CORRECTED IN AUTONOMY PHASE 3, not preserved. This test asserted that the reviewer gate
// ENQUEUES the fix goals itself. That was the specification of the defect: the gate was the
// only route in the system that dispatched rework, so a reject arriving any other way (the
// HTTP route, an operator, another agent) bounced a story nobody then picked up. Dispatch is
// now `stories.reject()`'s job for EVERY caller — keeping the gate's private enqueue would
// pay for the same fix twice. What the gate owes is a STRUCTURED bounce; that is asserted
// here, and the dispatch it triggers is proven in story-handback-roundtrip.test.mjs.
test("reviewer BLOCK bounces to build with a STRUCTURED handback — and enqueues nothing itself", async () => {
  const w = world({ reviewerDispatch: async () => ({ verdict: "block", blockers: ["no error handling", "missing test"] }) });
  const r = await w.rq.run("story_1");
  assert.equal(r.pass, false);
  assert.equal(w.story.stage, "build", "story bounced back to build");
  assert.equal(w.goalsEnqueued.length, 0, "the gate must not double-dispatch what reject() dispatches");
  assert.equal(w.rejects.length, 1);
  const hb = w.rejects[0];
  assert.equal(hb.toStage, "build");
  assert.equal(hb.byAgent, "reviewer", "who sent it back");
  assert.equal(hb.toAgent, "sr-backend", "who is expected to pick it up");
  assert.ok(hb.evidence.includes("no error handling"), "the blockers travel as evidence, not as prose");
  assert.ok(hb.evidence.includes("missing test"));
  assert.match(hb.reason, /round 1/);
  assert.equal(w.advances.length, 0, "did not advance on a block");
});

test("reviewer block EXHAUSTS after the round budget → story blocked + one alert", async () => {
  const w = world({ reviewerDispatch: async () => ({ verdict: "block", blockers: ["still broken"] }) });
  await w.rq.run("story_1"); // round 1 → bounce
  w.story.stage = "review-qa"; // simulate build completing and re-entering review-qa
  await w.rq.run("story_1"); // round 2 → bounce
  w.story.stage = "review-qa";
  const r = await w.rq.run("story_1"); // round 3 → exhausted → block
  assert.equal(r.blocked, true);
  assert.equal(w.story.status, "blocked");
  assert.equal(w.alerts.length, 1, "exactly one block alert");
});

test("a malformed verdict FAILS CLOSED to block (never an unearned pass)", async () => {
  const w = world({ reviewerDispatch: async () => ({ verdict: "looks good to me!", blockers: [] }) });
  const r = await w.rq.run("story_1");
  assert.equal(r.pass, false, "an invalid verdict must not pass");
  assert.notEqual(w.story.stage, "deploy-watch");
});

test("QA gate RUNS a configured e2eCmd INSIDE the sandbox with network:false", async () => {
  let seen = null;
  const w = world({
    reviewerDispatch: async () => ({ verdict: "pass" }),
    e2eCmd: ["playwright", "test"],
    sandbox: {
      dockerAvailable: async () => true,
      runInSandbox: async (worktreeDir, command, opts) => { seen = { worktreeDir, command, opts }; return { stdout: "3 passed", stderr: "", timedOut: false, exitCode: 0 }; },
    },
  });
  const r = await w.rq.run("story_1");
  assert.equal(r.advanced, true);
  assert.equal(seen.command, "playwright test", "validated e2e argv joined to a clean command");
  assert.equal(seen.worktreeDir, "/repo", "mounted the repo root");
  assert.equal(seen.opts.network, false, "network is OFF — no exfil");
  assert.ok(w.events.some((e) => e.event === "qa-passed"), "qa-passed logged");
});

test("a failing configured e2e blocks the story (never advances)", async () => {
  const w = world({
    reviewerDispatch: async () => ({ verdict: "pass" }),
    e2eCmd: ["playwright", "test"],
    sandbox: { dockerAvailable: async () => true, runInSandbox: async () => ({ stdout: "", stderr: "1 failed", timedOut: false, exitCode: 1 }) },
  });
  const r = await w.rq.run("story_1");
  assert.equal(r.stopped, "qa");
  assert.equal(w.story.status, "blocked");
  assert.ok(w.events.some((e) => e.event === "qa-failed"));
});

test("a configured e2e FAILS CLOSED when Docker is unavailable — blocks, no un-jailed run", async () => {
  let ran = false;
  const w = world({
    reviewerDispatch: async () => ({ verdict: "pass" }),
    e2eCmd: ["playwright", "test"],
    sandbox: { dockerAvailable: async () => false, runInSandbox: async () => { ran = true; return { exitCode: 0 }; } },
  });
  const r = await w.rq.run("story_1");
  assert.equal(r.stopped, "qa");
  assert.equal(w.story.status, "blocked", "no daemon must never advance a configured gate");
  assert.equal(ran, false, "the un-jailed sandbox path must NOT run");
  assert.ok(w.events.some((e) => e.event === "qa-failed"));
});

test("PR stage attempts delivery when gh is authenticated", async () => {
  const w = world({ reviewerDispatch: async () => ({ verdict: "pass" }), gh: { authenticated: true } });
  const r = await w.rq.run("story_1");
  assert.equal(r.advanced, true);
  assert.ok(w.events.some((e) => e.event === "pr-landed"), "pr-landed logged when authed");
});

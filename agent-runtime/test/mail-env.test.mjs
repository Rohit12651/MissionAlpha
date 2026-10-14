// Step 1 ratchet — the mail MCP env binds the JOB id from ctx.storyId (Manager-planned work
// carries the job id there, see server.mjs signalManager) and the GOAL id from ctx.goalId.
// A ctx with no storyId binds "" for the job, never the goal id in its place.
// Mutation proof (2026-09-17): MA_MAIL_JOB_ID: ctx?.storyId → ctx?.goalId →
//   ✖ MAILENV-1  AssertionError: Expected values to be strictly equal: actual: 'goal_3', expected: 'job_7'
//   ✖ MAILENV-2  (job id was the goal id). Restored, md5 110c9b97… matched, 3/3 green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mailEnvFor } from "../mail-env.mjs";

const roster = { all: () => [{ id: "sr-backend", role: "worker" }, { id: "tech-lead", role: "manager" }] };
const seat = { id: "sr-backend" };

test("MAILENV-1: job id comes from storyId, goal id from goalId", () => {
  const env = mailEnvFor({ seat, ctx: { storyId: "job_7", goalId: "goal_3", taskId: "task_9" }, roster, mailDir: "/tmp/m" });
  assert.equal(env.MA_MAIL_JOB_ID, "job_7");
  assert.equal(env.MA_MAIL_GOAL_ID, "goal_3");
  assert.equal(env.MA_MAIL_TASK_ID, "task_9");
  assert.equal(env.MA_MAIL_AGENT_ID, "sr-backend");
});

test("MAILENV-2: no storyId → job id is empty, NOT the goal id", () => {
  const env = mailEnvFor({ seat, ctx: { goalId: "goal_3", taskId: "task_9" }, roster, mailDir: "/tmp/m" });
  assert.equal(env.MA_MAIL_JOB_ID, "");
  assert.equal(env.MA_MAIL_GOAL_ID, "goal_3");
});

test("MAILENV-3: roles only — no writeScope leaks into the env", () => {
  const r = { all: () => [{ id: "sr-backend", role: "worker", writeScope: ["src/**"] }] };
  const env = mailEnvFor({ seat, ctx: {}, roster: r, mailDir: "/tmp/m" });
  assert.deepEqual(JSON.parse(env.MA_MAIL_ROLES), { "sr-backend": "worker" });
  assert.ok(!JSON.stringify(env).includes("src/**"));
});

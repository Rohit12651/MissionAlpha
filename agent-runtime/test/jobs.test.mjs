// Phase 9 · task 9.1 — the JOB store.
//
// A Job is NOT a Story. It has its own gate slot, its own answer route, its own stall clock
// and its own retry budget. Sharing the Story tables would mean a Job's clarify question
// competing for a Story's pending gate slot, and a Job's stall being measured by a clock
// designed for a different lifecycle.
//
// TRANSITIONS ARE CLOSED, like stories.mjs: an unlisted move is a refusal, not a silent write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../db.mjs";
import {
  createJobs, JOB_STATUSES, JobError,
  MAX_CREATES_PER_WINDOW, CREATE_WINDOW_MS, DUP_WINDOW_MS,
} from "../jobs.mjs";

const mk = (over = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ma-jobs-"));
  const db = openDb({ path: join(dir, "mission.db"), patchesDir: join(dir, "patches") });
  return createJobs({ db, scrub: (t) => t, ...over });
};

test("JOB-1: create seeds `intake` and returns a server-minted id", () => {
  const jobs = mk();
  const j = jobs.create({ title: "Relative time", brief: "dates should read as 3 minutes ago" });
  assert.match(j.id, /^job_[0-9a-f]{12}$/);
  assert.equal(j.status, "intake");
  assert.equal(j.title, "Relative time");
});

test("JOB-2: title and brief are required and trimmed", () => {
  const jobs = mk();
  assert.throws(() => jobs.create({ title: "   ", brief: "x" }), JobError);
  assert.throws(() => jobs.create({ title: "t", brief: "  " }), JobError);
});

test("JOB-3: an oversized brief is refused, not silently truncated", () => {
  const jobs = mk();
  assert.throws(() => jobs.create({ title: "t", brief: "x".repeat(20_000) }), /brief/i);
});

test("JOB-4: the scrub runs on stored text", () => {
  const jobs = mk({ scrub: (t) => t.replace(/sk-live-\S+/g, "[REDACTED]") });
  const j = jobs.create({ title: "t", brief: "key sk-live-DEADBEEF" });
  assert.equal(jobs.get(j.id).brief.includes("sk-live-DEADBEEF"), false);
});

test("JOB-5: the transition table is CLOSED — an unlisted move is refused", () => {
  const jobs = mk();
  const j = jobs.create({ title: "t", brief: "b" });
  assert.throws(() => jobs.setStatus(j.id, "shipped"), /cannot go/i, "intake → shipped is not a transition");
  assert.throws(() => jobs.setStatus(j.id, "not-a-status"), /unknown status/i);
});

test("JOB-6: the happy path walks intake → clarify → planned → building → review → shipped", () => {
  const jobs = mk();
  const j = jobs.create({ title: "t", brief: "b" });
  for (const s of ["clarify", "planned", "building", "review", "awaiting-you", "shipped"]) {
    jobs.setStatus(j.id, s);
    assert.equal(jobs.get(j.id).status, s);
  }
});

test("JOB-7: any status may go to `blocked` — a job can fail from anywhere", () => {
  for (const from of ["intake", "clarify", "planned", "building", "review"]) {
    const jobs = mk();
    const j = jobs.create({ title: "t", brief: "b" });
    let cur = "intake";
    for (const s of ["clarify", "planned", "building", "review"]) {
      if (cur === from) break;
      jobs.setStatus(j.id, s); cur = s;
    }
    assert.doesNotThrow(() => jobs.setStatus(j.id, "blocked"), `${from} → blocked must be allowed`);
  }
});

test("JOB-8: setStatus emits job.changed with identity only", () => {
  const seen = [];
  const jobs = mk({ emit: (n, p) => seen.push([n, p]) });
  const j = jobs.create({ title: "t", brief: "b" });
  jobs.setStatus(j.id, "clarify");
  const frames = seen.filter(([n]) => n === "job.changed");
  assert.ok(frames.length >= 1);
  assert.deepEqual(Object.keys(frames.at(-1)[1]).sort(), ["id", "status"], "no brief, no answers on the bus");
});

test("JOB-9: questions and answers persist on the Job", () => {
  const jobs = mk();
  const j = jobs.create({ title: "t", brief: "b" });
  jobs.setQuestions(j.id, ["tz?", "format?"]);
  assert.deepEqual(jobs.get(j.id).questions, ["tz?", "format?"]);
  jobs.setAnswers(j.id, [{ q: "tz?", a: "UTC" }]);
  assert.deepEqual(jobs.get(j.id).answers, [{ q: "tz?", a: "UTC" }]);
});

test("JOB-10: answering twice is a 409 — a fact is asked once", () => {
  const jobs = mk();
  const j = jobs.create({ title: "t", brief: "b" });
  jobs.setAnswers(j.id, [{ q: "tz?", a: "UTC" }]);
  assert.throws(() => jobs.setAnswers(j.id, [{ q: "tz?", a: "local" }]), /already answered/i);
});

test("JOB-11: tasks are stored against the job and read back in order", () => {
  const jobs = mk();
  const j = jobs.create({ title: "t", brief: "b" });
  jobs.setTasks(j.id, [
    { title: "one", skillsRequired: ["api"], steps: ["do a"] },
    { title: "two", skillsRequired: ["test"], steps: ["do b"] },
  ]);
  const ts = jobs.tasks(j.id);
  assert.deepEqual(ts.map((t) => t.title), ["one", "two"]);
  assert.equal(ts[0].status, "planned");
  assert.match(ts[0].id, /^jt_[0-9a-f]{12}$/);
});

test("JOB-12: a task's seat and ids are set as it progresses", () => {
  const jobs = mk();
  const j = jobs.create({ title: "t", brief: "b" });
  jobs.setTasks(j.id, [{ title: "one", skillsRequired: ["api"], steps: ["s"] }]);
  const [t] = jobs.tasks(j.id);
  jobs.updateTask(t.id, { seat: "sr-backend", goalId: "goal_1", taskId: "task_1", status: "queued" });
  const [after] = jobs.tasks(j.id);
  assert.deepEqual(
    { seat: after.seat, goalId: after.goalId, taskId: after.taskId, status: after.status },
    { seat: "sr-backend", goalId: "goal_1", taskId: "task_1", status: "queued" });
});

test("JOB-13: get() on an unknown id is null, never a throw", () => {
  assert.equal(mk().get("job_nope"), null);
});

test("JOB-14: list returns newest-first", () => {
  const jobs = mk();
  const a = jobs.create({ title: "a", brief: "brief a" });
  const b = jobs.create({ title: "b", brief: "brief b" });
  assert.deepEqual(jobs.list().map((x) => x.id), [b.id, a.id]);
});

test("JOB-15: source/externalKey exist now so Phase 13 needs no migration", () => {
  const jobs = mk();
  const j = jobs.create({ title: "t", brief: "brief one" });
  assert.equal(jobs.get(j.id).source, "paste");
  const k = jobs.create({ title: "t2", brief: "brief two", source: "jira", externalKey: "ENG-1" });
  assert.equal(jobs.get(k.id).externalKey, "ENG-1");
  assert.throws(() => jobs.create({ title: "t3", brief: "brief three", source: "jira", externalKey: "ENG-1" }),
    /already/i, "externalKey is UNIQUE — the same ticket cannot open two jobs");
});

test("JOB-16: JOB_STATUSES is the closed set the CHECK constraint enforces", () => {
  assert.deepEqual([...JOB_STATUSES].sort(),
    ["awaiting-you", "blocked", "building", "clarify", "intake", "planned", "review", "shipped"]);
});

// ── Phase 12 · task 12.1 — the create caps ───────────────────────────────────
//
// Ash's ONE tool is `create_job`. A model that retries its own tool call, or loops, would
// otherwise mint a job per attempt. The caps live HERE, in the store, and not in the MCP
// server, for the reason addendum #14/#20 keeps producing: a rule enforced only at one
// caller is allow-by-default for every other caller — a direct `POST /runtime/jobs` curl,
// the console button, and any future door would all bypass it.
//
// Both caps read the DB rather than an in-memory counter: they survive a restart, hold
// across two runtime processes sharing a database, and add no state that can drift.

const AT = (t) => () => t;      // a frozen clock; the window is what is under test, not wall time

test("ASH-CAP-1: a SIXTH create inside the window is refused with 429", () => {
  const t0 = 1_700_000_000_000;
  let now = t0;
  const jobs = mk({ clock: () => now });
  for (let i = 0; i < MAX_CREATES_PER_WINDOW; i += 1) {
    now = t0 + i;                                   // distinct briefs, so the DUP guard is not what fires
    jobs.create({ title: `t${i}`, brief: `brief number ${i}` });
  }
  now = t0 + 1_000;
  let e = null;
  try { jobs.create({ title: "t6", brief: "brief number six" }); } catch (x) { e = x; }
  assert.ok(e instanceof JobError, "the sixth create must throw a JobError");
  assert.equal(e.status, 429, "the sixth create in a minute must be rate-limited, not accepted");
});

test("ASH-CAP-2: the window SLIDES — the same sixth create succeeds a minute later", () => {
  const t0 = 1_700_000_000_000;
  let now = t0;
  const jobs = mk({ clock: () => now });
  for (let i = 0; i < MAX_CREATES_PER_WINDOW; i += 1) { now = t0 + i; jobs.create({ title: `t${i}`, brief: `brief number ${i}` }); }
  now = t0 + CREATE_WINDOW_MS + 1;
  const j = jobs.create({ title: "t6", brief: "brief number six" });
  assert.match(j.id, /^job_/, "a fixed quota that never refills is a lockout, not a rate cap");
});

test("ASH-DUP-1: the SAME brief inside the duplicate window is refused with 409", () => {
  const t0 = 1_700_000_000_000;
  let now = t0;
  const jobs = mk({ clock: () => now });
  jobs.create({ title: "Relative time", brief: "dates should read as 3 minutes ago" });
  now = t0 + DUP_WINDOW_MS - 1;
  let e = null;
  try { jobs.create({ title: "Relative time again", brief: "dates should read as 3 minutes ago" }); } catch (x) { e = x; }
  assert.ok(e instanceof JobError, "a duplicate must throw a JobError");
  assert.equal(e.status, 409, "a retried tool call must not mint a second identical job");
});

test("ASH-DUP-2: the same brief AFTER the window is a new job — the guard is not a permanent ban", () => {
  const t0 = 1_700_000_000_000;
  let now = t0;
  const jobs = mk({ clock: () => now });
  const a = jobs.create({ title: "Relative time", brief: "dates should read as 3 minutes ago" });
  now = t0 + DUP_WINDOW_MS + 1;
  const b = jobs.create({ title: "Relative time", brief: "dates should read as 3 minutes ago" });
  assert.notEqual(b.id, a.id, "asking for the same thing again later is a legitimate request");
});

// The two guards must be able to DISAGREE, or a test cannot tell which one fired
// (addendum #38 — a test whose branches produce the same value cannot see the bug between them).
test("ASH-DUP-3: the same TITLE with a different brief is not a duplicate", () => {
  const t0 = 1_700_000_000_000;
  const jobs = mk({ clock: AT(t0) });
  jobs.create({ title: "Relative time", brief: "dates should read as 3 minutes ago" });
  const b = jobs.create({ title: "Relative time", brief: "and durations should read as 2h 5m" });
  assert.match(b.id, /^job_/, "the duplicate guard keys on the BRIEF — the title is a label, not the spec");
});

// ── Phase 12 · task 12.2 — the board's live signal ───────────────────────────
//
// `job.changed` was emitted on create and on setStatus only. A JOB's status changes a handful
// of times; its TASKS change constantly — a seat is assigned, a task goes queued → running →
// held → done. Every one of those moves a card, and none of them reached the bus, so the board
// would have been live for the columns and frozen for their contents.
//
// The frame stays IDENTITY ONLY ({id, status}) exactly as create/setStatus emit it: a bus frame
// reaches every connected seat, and a task title is not something to broadcast. The client
// re-reads the gated GET.

const bus = () => { const seen = []; return { seen, emit: (name, payload) => seen.push({ name, payload }) }; };

test("ASH-BUS-1: assigning a seat to a task emits job.changed", () => {
  const b = bus();
  const jobs = mk({ emit: b.emit });
  const j = jobs.create({ title: "t", brief: "a brief for the bus test" });
  jobs.setStatus(j.id, "planned");
  jobs.setTasks(j.id, [{ title: "a", skillsRequired: ["api"], steps: ["s"] }]);
  const before = b.seen.length;
  jobs.updateTask(jobs.tasks(j.id)[0].id, { seat: "charizard", status: "queued" });
  const after = b.seen.slice(before).filter((e) => e.name === "job.changed");
  assert.equal(after.length, 1, "a task that moved did not reach the bus — the card would never move");
  assert.equal(after[0].payload.id, j.id, "the frame must name the JOB, which is what the board re-reads");
});

test("ASH-BUS-2: planting the task list emits it too — the columns fill from empty", () => {
  const b = bus();
  const jobs = mk({ emit: b.emit });
  const j = jobs.create({ title: "t", brief: "another brief for the bus test" });
  jobs.setStatus(j.id, "planned");
  const before = b.seen.length;
  jobs.setTasks(j.id, [{ title: "a", skillsRequired: ["api"], steps: ["s"] }]);
  assert.ok(b.seen.slice(before).some((e) => e.name === "job.changed"), "setTasks was invisible to the board");
});

test("ASH-BUS-3: the frame is IDENTITY ONLY — a title or a brief must never ride the bus", () => {
  const b = bus();
  const jobs = mk({ emit: b.emit });
  jobs.create({ title: "SECRET-TITLE", brief: "SECRET-BRIEF-TEXT" });
  const wire = JSON.stringify(b.seen);
  assert.ok(!wire.includes("SECRET-TITLE"), "the title reached every connected seat");
  assert.ok(!wire.includes("SECRET-BRIEF-TEXT"), "the brief reached every connected seat");
});

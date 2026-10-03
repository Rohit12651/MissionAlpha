// Phase 12 / task 12.2 — the PURE half of the jobs client. Zero DOM, zero network, so it runs
// under `node --experimental-strip-types` alongside the other pure-layer specs.
//
// What these pin:
//  1. THE PARSER IS DEFENSIVE. A malformed row is dropped and the rest still render. A board
//     that white-screens because one job arrived without a title is worse than one that shows
//     seven cards and drops the eighth.
//  2. AN UNKNOWN STATUS IS NEVER RE-HOMED. Bucketing it into `blocked` (or `building`) would
//     put a false status in front of the operator. It goes to `unplaced` and the board labels
//     it as unknown — addendum #2: a fallback may say "unknown", it may never state a fact.
//  3. THE COLUMN SET IS THE RUNTIME'S. JC-6 imports the server's own closed set, so a status
//     added there and not here fails at once instead of silently hiding a whole column.

import test from "node:test";
import assert from "node:assert/strict";
import { JOB_STATUSES as RUNTIME_STATUSES } from "../../../agent-runtime/jobs.mjs";
import {
  JOB_STATUSES, columns, isGateStatus, parseJobDetail, parseJobs, statusTone, taskTone,
} from "../jobsClient.ts";

const J = (over: Record<string, unknown> = {}) => ({
  id: "job_aaaaaaaaaaaa", title: "Relative time", status: "building",
  prUrl: null, blockedOn: null, createdAt: 1000, updatedAt: 2000, ...over,
});

test("JC-1: a row with no id is DROPPED and the rest still render", () => {
  const out = parseJobs({ jobs: [J(), { title: "no id" }, J({ id: "job_bbbbbbbbbbbb" })] });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((j) => j.id), ["job_aaaaaaaaaaaa", "job_bbbbbbbbbbbb"]);
});

test("JC-2: a missing title degrades to a placeholder — it never invents one", () => {
  const [j] = parseJobs({ jobs: [J({ title: undefined })] });
  assert.equal(j.title, "(untitled)");
});

test("JC-3: a payload that is not a job list is an EMPTY board, never a throw", () => {
  for (const bad of [null, undefined, 42, "jobs", [], { jobs: "nope" }, {}]) {
    assert.deepEqual(parseJobs(bad), [], `parseJobs(${JSON.stringify(bad)}) did not degrade`);
  }
});

test("JC-4: columns keep the runtime's order, and a column is newest-first", () => {
  const cols = columns([
    J({ id: "job_old", status: "building", updatedAt: 10 }),
    J({ id: "job_new", status: "building", updatedAt: 99 }),
    J({ id: "job_ship", status: "shipped" }),
  ]);
  assert.deepEqual(cols.map((c) => c.status), [...JOB_STATUSES]);
  const building = cols.find((c) => c.status === "building");
  assert.deepEqual(building?.jobs.map((j) => j.id), ["job_new", "job_old"]);
});

test("JC-5: an UNKNOWN status is never re-homed into a real column", () => {
  const cols = columns([J({ id: "job_weird", status: "marinating" })]);
  for (const c of cols) {
    assert.equal(c.jobs.length, 0, `a job with an unknown status was shown as ${c.status}`);
  }
  assert.deepEqual(cols.unplaced?.map((j) => j.id) ?? [], ["job_weird"]);
});

// The catalog-equality ratchet. The client mirrors a CLOSED set the runtime owns; a status
// added there and forgotten here would hide an entire column with no error anywhere.
test("JC-6: the client's status list IS the runtime's closed set", () => {
  assert.deepEqual([...JOB_STATUSES].sort(), [...RUNTIME_STATUSES].sort());
});

test("JC-7: the gate column is the one the BOSS is being waited on for", () => {
  assert.equal(isGateStatus("awaiting-you"), true);
  for (const s of JOB_STATUSES.filter((x) => x !== "awaiting-you")) {
    assert.equal(isGateStatus(s), false, `${s} was marked a gate — the amber column must mean ONE thing`);
  }
});

test("JC-8: tones separate 'needs you' from 'went wrong' from 'done'", () => {
  assert.equal(statusTone("awaiting-you"), "amber");
  assert.equal(statusTone("blocked"), "red");
  assert.equal(statusTone("shipped"), "green");
  assert.equal(statusTone("marinating"), "muted", "an unknown status must not borrow a real tone");
});

test("JC-9: parseJobDetail drops a malformed task and keeps the job", () => {
  const d = parseJobDetail({
    job: J(),
    tasks: [
      { id: "jt_1", jobId: "job_aaaaaaaaaaaa", seq: 1, title: "UI", seat: "pikachu", status: "done", changedPaths: ["src/a.tsx"] },
      { seq: 2, title: "no id" },
    ],
    gates: [],
  });
  assert.equal(d.job?.id, "job_aaaaaaaaaaaa");
  assert.equal(d.tasks.length, 1);
  assert.equal(d.tasks[0].seat, "pikachu");
  assert.deepEqual(d.tasks[0].changedPaths, ["src/a.tsx"]);
});

test("JC-10: a task with no seat reads as unassigned — never as someone", () => {
  const d = parseJobDetail({ job: J(), tasks: [{ id: "jt_1", title: "t", status: "queued" }], gates: [] });
  assert.equal(d.tasks[0].seat, "", "an invented seat puts a name on work nobody is doing");
  assert.equal(taskTone("blocked"), "red");
  assert.equal(taskTone("done"), "green");
});

test("JC-TONE-ANS: a task waiting on a PEER reads as in motion — not idle, and not as needing the BOSS", () => {
  // Phase D · task 13. `awaiting-answer` fell through to `muted`, the tone of a task nobody has
  // touched — while that task is mid-conversation and holding its write scope. Amber is wrong
  // too: in this palette amber means YOU must act (held, awaiting-you), and nobody needs the BOSS
  // here — a peer is producing the answer. Brass is the truth: work in motion.
  assert.equal(taskTone("awaiting-answer"), "brass");
  assert.notEqual(taskTone("awaiting-answer"), taskTone("held"), "it must not borrow the tone that asks the BOSS to act");
  // UNRELATED: an unknown status still reads as muted, never as a real outcome.
  assert.equal(taskTone("something-new"), "muted");
});

test("JC-11: a detail payload that is junk is an empty detail, never a throw", () => {
  for (const bad of [null, 7, "x", { job: "nope" }]) {
    const d = parseJobDetail(bad);
    assert.equal(d.job, null);
    assert.deepEqual(d.tasks, []);
  }
});

test("JC-12: the thread is parsed, and a row with no id is dropped like every other row", () => {
  const d = parseJobDetail({
    job: J(),
    tasks: [],
    gates: [],
    log: [
      { id: "m1", from: "sr-backend", to: "tech-lead", kind: "done", body: "finished", at: 5 },
      { from: "nobody", body: "no id" },
    ],
  });
  assert.equal(d.log.length, 1);
  assert.equal(d.log[0].from, "sr-backend");
  assert.equal(d.log[0].body, "finished");
});

test("JC-13: a detail with no log at all is an EMPTY thread, never undefined", () => {
  const d = parseJobDetail({ job: J(), tasks: [], gates: [] });
  assert.deepEqual(d.log, [], "the drawer must be able to map() it without a guard");
});

// Phase B · Task 5 — the one word the board shows for a shipped job. Codex F12: "shipped" could
// not be told apart from a prepared local branch. Mutation proof (2026-09-17): outcomeTone("pr") → "amber" →
// ✖ JOBS-OUTCOME-2 actual: 'amber', expected: 'green'. Restored, md5 matched.
import { outcomeTone, outcomeLabel } from "../jobsClient.ts"; // parseJobs is already imported above

test("JOBS-OUTCOME-1: shipOutcome is parsed from summary.ship.outcome and only the three known words survive", () => {
  const rows = parseJobs({ jobs: [
    { id: "job_1", title: "a", status: "shipped", summary: { ship: { outcome: "pr" } } },
    { id: "job_2", title: "b", status: "shipped", summary: { ship: { outcome: "pushed" } } },
    { id: "job_3", title: "c", status: "shipped", summary: { ship: { outcome: "local-branch" } } },
    { id: "job_4", title: "d", status: "shipped", summary: { ship: { outcome: "banana" } } },
    { id: "job_5", title: "e", status: "building" },
  ] });
  assert.deepEqual(rows.map((r) => r.shipOutcome), ["pr", "pushed", "local-branch", null, null]);
});

test("JOBS-OUTCOME-2: tone and label are semantic — pr is green, pushed brass, local-branch amber", () => {
  assert.equal(outcomeTone("pr"), "green");
  assert.equal(outcomeTone("pushed"), "brass");
  assert.equal(outcomeTone("local-branch"), "amber");
  assert.equal(outcomeLabel("pr"), "PR");
  assert.equal(outcomeLabel("pushed"), "pushed");
  assert.equal(outcomeLabel("local-branch"), "local branch");
});

// ── Phase F · task 20 — the CEO's verdict on the card ────────────────────────────
// A job's `summary.strategy.verdict` is the CEO's answer. It is read on EVERY status after
// strategy (a killed job is `blocked`; a proceeded one moves on), so it is a property of the job,
// not of a column. Only the three real words survive — addendum #2: never state a fact we lack.
import { verdictTone, verdictLabel } from "../jobsClient.ts";

test("JC-STRAT-1: the CEO's verdict is parsed from summary.strategy.verdict — only the three words survive", () => {
  const jobs = parseJobs({ jobs: [
    { id: "job_a", title: "a", status: "clarify", summary: { strategy: { verdict: "proceed", why: "w" } } },
    { id: "job_b", title: "b", status: "blocked", summary: { strategy: { verdict: "kill" } } },
    { id: "job_c", title: "c", status: "awaiting-you", summary: { strategy: { verdict: "defer" } } },
    { id: "job_d", title: "d", status: "clarify", summary: { strategy: { verdict: "yolo" } } },
    { id: "job_e", title: "e", status: "strategy" },
  ] });
  assert.deepEqual(jobs.map((j) => j.strategyVerdict), ["proceed", "kill", "defer", null, null]);
});

test("JC-STRAT-2: verdict tones are semantic, and `strategy` itself is work in motion", () => {
  assert.equal(verdictTone("proceed"), "green");
  assert.equal(verdictTone("defer"), "amber", "defer puts a question to the BOSS");
  assert.equal(verdictTone("kill"), "red");
  assert.equal(statusTone("strategy"), "brass", "the CEO is thinking — not idle, not waiting on the BOSS");
  assert.equal(isGateStatus("strategy"), false, "amber means the BOSS must act; the CEO's turn is not that");
  assert.equal(verdictLabel("kill"), "CEO: kill");
  const col = columns(parseJobs({ jobs: [{ id: "job_s", title: "s", status: "strategy" }] })).find((c) => c.status === "strategy");
  assert.equal(col?.label, "Strategy");
  assert.equal(col?.jobs.length, 1, "a strategy job lands in its own column, not in `unplaced`");
});

test("JC-STRAT-3: the board has a Strategy column between Intake and Clarify", () => {
  const i = JOB_STATUSES.indexOf("strategy");
  assert.equal(JOB_STATUSES[i - 1], "intake");
  assert.equal(JOB_STATUSES[i + 1], "clarify");
});

// ── #4 (2026-09-27) — answering a job's questions from the Inbox ─────────────────────────────
import { buildJobAnswers } from "../jobsClient.ts";

test("JC-ANS-1: the job's questions are parsed — the Inbox asks exactly what the Manager asked", () => {
  const { job } = parseJobDetail({ job: J({ questions: ["Which DB?", "", 7, "Dark mode?"] }) });
  assert.deepEqual(job?.questions, ["Which DB?", "Dark mode?"]);
  assert.deepEqual(parseJobs({ jobs: [J()] })[0].questions, [], "no questions ⇒ an empty list, never undefined");
});

test("JC-ANS-2: answers pair each question with its text, trimmed", () => {
  const r = buildJobAnswers(["Which DB?", "Dark mode?"], ["  sqlite ", "yes"]);
  assert.deepEqual(r, { ok: true, answers: [{ q: "Which DB?", a: "sqlite" }, { q: "Dark mode?", a: "yes" }] });
});

test("JC-ANS-3: every question must be answered — a blank answer is refused, naming the question", () => {
  const r = buildJobAnswers(["Which DB?", "Dark mode?"], ["sqlite", "   "]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /Dark mode\?/);
  assert.equal(buildJobAnswers([], []).ok, false, "a gate with no questions has nothing to answer");
});

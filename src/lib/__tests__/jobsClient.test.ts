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

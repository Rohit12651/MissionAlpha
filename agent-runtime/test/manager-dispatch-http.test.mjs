// Phase 9 · tasks 9.3 / 9.4 / 9.5 — the Job routes, end to end, with NO MODEL.
//
// This is the shape 14.1 needs: the whole loop under RUNTIME_MANAGER_DISPATCH=deterministic.
// It is also how Phase 9 is proven while the Manager prompts still await the BOSS's read
// (9.0 is a blocking checkpoint — "9.3+ do not run live before this").
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3996;
const TOK = "jobtok";
const H = { Host: `localhost:${PORT}`, "Content-Type": "application/json" };
const auth = { ...H, "x-runtime-token": TOK };

let proc;
test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-http-"));
  proc = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: { ...process.env, RUNTIME_BACKEND: "mock", RUNTIME_PORT: String(PORT),
      RUNTIME_TOKEN: TOK, RUNTIME_TOKEN_DIR: dir, RUNTIME_DB_PATH: join(dir, "mission.db"),
      RUNTIME_MAIL_DIR: join(dir, "mail"), RUNTIME_MANAGER_DISPATCH: "deterministic", RUNTIME_SLA_SWEEP_MS: "5000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 30_000);
    proc.stdout.on("data", (b) => { if (String(b).includes(`listening :${PORT}`)) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}`)); });
  });
});
test.after(() => { try { proc?.kill(); } catch { /* gone */ } });

function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = ""; res.on("data", (c) => { out += c; });
      res.on("end", () => { let j = null; try { j = JSON.parse(out); } catch { /* */ } resolve({ status: res.statusCode, body: out, json: j }); });
    });
    r.on("error", reject); r.end(body);
  });
}

test("JOBHTTP-1: the job routes are GATED — no token is 401", async () => {
  assert.equal((await req("GET", "/runtime/jobs", H)).status, 401);
  assert.equal((await req("POST", "/runtime/jobs", H, "{}")).status, 401);
});

test("JOBHTTP-2: POST /runtime/jobs creates a job in `intake`", async () => {
  const r = await req("POST", "/runtime/jobs", auth, JSON.stringify({
    title: "Relative time", brief: "Change the ui component so dates read as 3 minutes ago, and add a test.",
  }));
  assert.equal(r.status, 201, r.body);
  assert.match(r.json.id, /^job_[0-9a-f]{12}$/);
  assert.equal(r.json.status, "intake");
});

test("JOBHTTP-3: a job with no title or no brief is a 400, not a silent create", async () => {
  assert.equal((await req("POST", "/runtime/jobs", auth, JSON.stringify({ title: "", brief: "b" }))).status, 400);
  assert.equal((await req("POST", "/runtime/jobs", auth, JSON.stringify({ title: "t" }))).status, 400);
});

test("JOBHTTP-4: an oversized brief is REFUSED — a spec is never silently truncated", async () => {
  const r = await req("POST", "/runtime/jobs", auth, JSON.stringify({ title: "t", brief: "x".repeat(11_000) }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /brief exceeds/);
});

test("JOBHTTP-5: GET /runtime/jobs/:id returns the job, its tasks, its gates and its thread", async () => {
  const c = await req("POST", "/runtime/jobs", auth, JSON.stringify({ title: "T", brief: "change the api endpoint" }));
  const r = await req("GET", `/runtime/jobs/${c.json.id}`, auth);
  assert.equal(r.status, 200);
  // `log` arrived with 12.2: the board's drawer shows the messages the seats exchanged,
  // read from mailbox.thread(jobId). The key set is pinned on purpose — a route that
  // quietly grows a field is a wire contract nobody reviewed.
  assert.deepEqual(Object.keys(r.json).sort(), ["gates", "job", "log", "tasks"]);
  assert.equal(r.json.job.id, c.json.id);
});

test("JOBHTTP-6: an unknown job is 404 and DELETE is 405", async () => {
  assert.equal((await req("GET", "/runtime/jobs/job_deadbeefdead", auth)).status, 404);
  assert.equal((await req("DELETE", "/runtime/jobs", auth)).status, 405);
});

test("JOBHTTP-7: THE LOOP — the heartbeat walks a job intake → planned → building, no model", async () => {
  const c = await req("POST", "/runtime/jobs", auth, JSON.stringify({
    title: "Formatter", brief: "change the ui component and add a test for relative dates",
  }));
  const id = c.json.id;
  // The heartbeat advances ONE job per tick, so this polls rather than assuming a tick count.
  let job = null;
  for (let i = 0; i < 60; i++) {
    const r = await req("GET", `/runtime/jobs/${id}`, auth);
    job = r.json;
    if (job.job.status === "building" || job.job.status === "blocked") break;
    await new Promise((res) => setTimeout(res, 500));
  }
  assert.equal(job.job.status, "building", `job did not reach building: ${JSON.stringify(job.job)}`);
  assert.ok(job.tasks.length >= 2, `expected ui + test tasks, got ${JSON.stringify(job.tasks.map((t) => t.title))}`);
  // ASSIGNED BY SKILL: the runtime chose these seats from the roster; no model named one.
  const seats = job.tasks.map((t) => t.seat);
  assert.ok(seats.includes("sr-frontend"), `ui work must land on sr-frontend; got ${seats}`);
  assert.ok(seats.includes("qa"), `test work must land on qa; got ${seats}`);
  // SUPERSEDED BY PHASE C · task 9. This asserted "every task must be enqueued on the engine",
  // which WAS the P-F08 defect: every seat's worktree was cut from the same HEAD at once, so an
  // ordered plan was ordered in name only. The runtime now dispatches one task at a time and
  // cuts each later worktree from the previous task's commit. This is the end-to-end proof of
  // that through the real server — the unit-level SEQ-3 cannot see the HTTP path.
  const queued = job.tasks.filter((t) => t.goalId && t.taskId);
  assert.equal(queued.length, 1, `exactly one task in flight; got ${JSON.stringify(job.tasks.map((t) => [t.title, t.status]))}`);
  assert.equal(queued[0].status, "queued");
  for (const t of job.tasks) {
    if (t.goalId) continue;
    assert.ok(["planned", "awaiting-hire"].includes(t.status), `an un-dispatched task waits; got ${t.status}`);
  }
});

test("JOBHTTP-8: a brief that asks a question mints ONE job gate and waits", async () => {
  // ITS OWN SERVER, for the reason JOBHTTP-12 has one — and the reason grew. Widening the
  // poll window to 60s was not enough: once the gate-decision routing was FIXED (an approved
  // answer plans the job instead of blocking it), the earlier tests stopped parking their jobs
  // in `blocked` and started leaving them LIVE. The heartbeat then round-robins a growing set
  // on one shared server, and this test began failing with `read ECONNRESET` — a transport
  // failure under contention, not a wrong answer. Measured: failed 3 of 3 full-suite runs with
  // the fix present, passed 3 of 3 in isolation, and passed with the fix reverted.
  const dir8 = mkdtempSync(join(tmpdir(), "job-ask-"));
  const PORT8 = 3999;
  const p8 = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: { ...process.env, RUNTIME_BACKEND: "mock", RUNTIME_PORT: String(PORT8),
      RUNTIME_TOKEN: TOK, RUNTIME_TOKEN_DIR: dir8, RUNTIME_DB_PATH: join(dir8, "mission.db"),
      RUNTIME_MAIL_DIR: join(dir8, "mail"), RUNTIME_MANAGER_DISPATCH: "deterministic",
      RUNTIME_SLA_SWEEP_MS: "5000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ask server did not start")), 30_000);
      p8.stdout.on("data", (b) => { if (String(b).includes(`listening :${PORT8}`)) { clearTimeout(t); resolve(); } });
      p8.on("exit", (c) => { clearTimeout(t); reject(new Error(`ask server exited ${c}`)); });
    });
    const call = (method, path, body) => new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: PORT8, path, method,
        headers: { Host: `localhost:${PORT8}`, "Content-Type": "application/json", "x-runtime-token": TOK } }, (res) => {
        let out = ""; res.on("data", (c) => { out += c; });
        res.on("end", () => { let j = null; try { j = JSON.parse(out); } catch { /* */ } resolve({ status: res.statusCode, json: j }); });
      });
      r.on("error", reject); r.end(body);
    });

    const c = await call("POST", "/runtime/jobs", JSON.stringify({
      title: "Ambiguous", brief: "please ask me what the default should be",
    }));
    assert.equal(c.status, 201);
    const id = c.json.id;
    let job = null;
    for (let i = 0; i < 120; i++) {
      job = (await call("GET", `/runtime/jobs/${id}`)).json;
      if (job.job.status === "awaiting-you") break;
      await new Promise((res) => setTimeout(res, 500));
    }
    assert.equal(job.job.status, "awaiting-you");
    assert.equal(job.gates.length, 1, "one decision the BOSS makes in one sitting = one gate");
    assert.equal(job.gates[0].jobId, id, "and it is a JOB gate, not a story gate");
    assert.equal(job.gates[0].storyId, null);
  } finally {
    try { p8.kill(); } catch { /* gone */ }
  }
});

test("JOBHTTP-9: answering resolves the gate and moves the job on", async () => {
  const c = await req("POST", "/runtime/jobs", auth, JSON.stringify({
    title: "Ambiguous2", brief: "please ask me about the api default",
  }));
  const id = c.json.id;
  for (let i = 0; i < 120; i++) {
    const j = (await req("GET", `/runtime/jobs/${id}`, auth)).json;
    if (j.job.status === "awaiting-you") break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const a = await req("POST", `/runtime/jobs/${id}/answer`, auth, JSON.stringify({ answers: [{ q: "default?", a: "UTC" }] }));
  assert.equal(a.status, 200, a.body);
  // POSITIVE, not `notEqual(..., "awaiting-you")`. The negative form is what let a real defect
  // through the 9.6 live run: `decide()` fires onDecided with {status, by, feedback} and the
  // job route read `info.decision ?? info.verb`, so an APPROVED answer arrived as null and the
  // job went to `blocked` — which is not "awaiting-you", so the old assertion passed happily.
  // A test for "did it move on" must name WHERE it moved (addendum #22).
  assert.equal(a.json.job.status, "planned",
    `an approved answer must plan the job, not ${a.json.job.status}` +
    (a.json.job.blockedOn ? ` (blockedOn: ${a.json.job.blockedOn})` : ""));
  assert.deepEqual(a.json.job.answers, [{ q: "default?", a: "UTC" }]);
});

test("JOBHTTP-10: answering twice is a 409 — a fact is asked once", async () => {
  const c = await req("POST", "/runtime/jobs", auth, JSON.stringify({ title: "A3", brief: "please ask me something" }));
  const id = c.json.id;
  for (let i = 0; i < 120; i++) {
    const j = (await req("GET", `/runtime/jobs/${id}`, auth)).json;
    if (j.job.status === "awaiting-you") break;
    await new Promise((res) => setTimeout(res, 500));
  }
  await req("POST", `/runtime/jobs/${id}/answer`, auth, JSON.stringify({ answers: [{ q: "x", a: "1" }] }));
  const second = await req("POST", `/runtime/jobs/${id}/answer`, auth, JSON.stringify({ answers: [{ q: "x", a: "2" }] }));
  assert.equal(second.status, 409);
});

test("JOBHTTP-11: an answer with no answers[] is a 400", async () => {
  // REUSES a job the earlier tests left behind rather than creating one. 12.1 caps creates at
  // 5 per minute in the STORE, and this file makes more than that against one server, so a
  // fresh create here would 429 — and this test would then fail for a reason it never claimed
  // to be about. It needs A job id, not a NEW job.
  const list = await req("GET", "/runtime/jobs", auth);
  const id = list.json.jobs[0]?.id;
  assert.ok(id, "no job to answer against — the earlier tests should have left several");
  assert.equal((await req("POST", `/runtime/jobs/${id}/answer`, auth, JSON.stringify({ answers: [] }))).status, 400);
});

test("JOBHTTP-12: THE WHOLE LOOP — a job is resolved end to end with no model and no human", async () => {
  // ITS OWN SERVER, ON PURPOSE. Every earlier test in this file leaves a live job behind, the
  // heartbeat ticks them all, and the engine has its own concurrency cap — so on the shared
  // instance this job's task queued behind that backlog and the test failed for lack of a
  // TURN, not for lack of a signal. That is a misleading red, so this runs alone.
  //
  // THE GAP THIS CLOSES: before the engine → Manager signal was wired, a job reached
  // `building` and sat there forever, because nothing told the Manager its tasks had ended.
  // The runtime now synthesizes `done` / `blocked` mail from the task's own terminal
  // transition (sender `engine`, role `system`, which may mail ONLY the Manager), so a seat
  // that crashes — or simply never reports — cannot strand a job.
  const dir2 = mkdtempSync(join(tmpdir(), "job-loop-"));
  const PORT2 = 3998;
  const p2 = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: { ...process.env, RUNTIME_BACKEND: "mock", RUNTIME_PORT: String(PORT2),
      RUNTIME_TOKEN: TOK, RUNTIME_TOKEN_DIR: dir2, RUNTIME_DB_PATH: join(dir2, "mission.db"),
      RUNTIME_MAIL_DIR: join(dir2, "mail"), RUNTIME_MANAGER_DISPATCH: "deterministic",
      RUNTIME_SLA_SWEEP_MS: "5000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("loop server did not start")), 30_000);
      p2.stdout.on("data", (b) => { if (String(b).includes(`listening :${PORT2}`)) { clearTimeout(t); resolve(); } });
      p2.on("exit", (c) => { clearTimeout(t); reject(new Error(`loop server exited ${c}`)); });
    });
    const call = (method, path, body) => new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: PORT2, path, method,
        headers: { Host: `localhost:${PORT2}`, "Content-Type": "application/json", "x-runtime-token": TOK } }, (res) => {
        let out = ""; res.on("data", (c) => { out += c; });
        res.on("end", () => { let j = null; try { j = JSON.parse(out); } catch { /* */ } resolve({ status: res.statusCode, json: j }); });
      });
      r.on("error", reject); r.end(body);
    });

    const c = await call("POST", "/runtime/jobs", JSON.stringify({
      title: "Loop", brief: "change the api endpoint for relative dates",
    }));
    assert.equal(c.status, 201);
    const id = c.json.id;

    let seen = null;
    for (let i = 0; i < 120; i++) {
      seen = (await call("GET", `/runtime/jobs/${id}`)).json;
      if (["review", "awaiting-you", "blocked", "shipped"].includes(seen.job.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.notEqual(seen.job.status, "building",
      `the job stalled in building — the engine → Manager signal is not reaching it: ${JSON.stringify(seen.tasks)}`);
    // Under RUNTIME_BACKEND=mock with no active credential the engine task cannot run, so it
    // ends terminal-failed. That is the INTERESTING case: it proves the runtime told the
    // Manager (the seat never mailed anything), the Manager marked the task blocked, and —
    // having nothing to reorder — escalated to a human rather than spinning.
    assert.ok(["review", "awaiting-you", "blocked"].includes(seen.job.status),
      `expected review / awaiting-you / blocked, got ${seen.job.status}`);
    for (const t of seen.tasks) {
      assert.notEqual(t.status, "queued",
        `task "${t.title}" was never resolved — the Manager never learned what happened to it`);
    }
    if (seen.job.status === "awaiting-you") {
      assert.ok(seen.gates.length >= 1, "an escalation must reach the BOSS as a real gate, not a log line");
    }
  } finally {
    try { p2.kill(); } catch { /* gone */ }
  }
});

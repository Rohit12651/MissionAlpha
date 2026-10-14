// #4 (2026-09-27) — a job's CLARIFY gate is answered, never waved through.
//
// A job mints `question` gates for four reasons, told apart by slot: `<job>-q` carries the
// Manager's questions (and the CEO's "Proceed anyway?"), while `-hire`, `-esc-N` and `-blocked-T`
// are yes/no decisions. `POST /inbox/:id/approve` on the clarify gate moved the job to `planned`
// with NO answers stored — the Manager then planned on facts nobody gave it, and a deferred job was
// "yes"-ed without the yes/no the CEO asked for. Bulk approve had been made to skip EVERY job
// question gate for the same reason, which also stopped the decision gates being bulk-approved.
// Now: the clarify gate refuses approve (answer it through /runtime/jobs/:id/answer); the
// decision gates take approve/reject as before, in the single and the bulk path alike.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

import { isJobClarifyGate } from "../deliveries.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("CLARIFY-1: the clarify gate is recognised by its slot; decision gates and story questions are not", () => {
  const J = "job_aaaaaaaaaaaa";
  assert.equal(isJobClarifyGate({ kind: "question", jobId: J, taskId: `${J}-q` }), true);
  for (const slot of ["-hire", "-esc-2", "-blocked-task_x"]) {
    assert.equal(isJobClarifyGate({ kind: "question", jobId: J, taskId: `${J}${slot}` }), false, slot);
  }
  assert.equal(isJobClarifyGate({ kind: "question", storyId: "st_1", jobId: null, taskId: "st_1-q0" }), false);
  assert.equal(isJobClarifyGate({ kind: "job-approval", jobId: J, taskId: `${J}-q` }), false);
  assert.equal(isJobClarifyGate(null), false);
});

test("CLARIFY-2: both Inbox decide routes consult the one predicate — no second copy of the rule", () => {
  const ast = parse(readFileSync(join(ROOT, "agent-runtime", "server.mjs"), "utf8"), { ecmaVersion: "latest", sourceType: "module" });
  let calls = 0, inlineCopies = 0;
  const walk = (n) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "CallExpression" && n.callee?.name === "isJobClarifyGate") calls++;
    // the old bulk rule: `row?.kind === "question" && row?.jobId`
    if (n.type === "LogicalExpression" && n.operator === "&&" && n.left?.type === "BinaryExpression"
      && n.left.right?.value === "question" && n.right?.property?.name === "jobId") inlineCopies++;
    for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") walk(v); }
  };
  walk(ast);
  assert.ok(calls >= 2, `the single and the bulk decide route both call isJobClarifyGate (found ${calls})`);
  assert.equal(inlineCopies, 0, "the blanket 'every job question' skip is gone");
});

// ── end to end, on a live runtime with the deterministic Manager ──
const PORT = 3979, TOK = "clarifytok";
let proc;
test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-clarify-"));
  proc = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: { ...process.env, RUNTIME_BACKEND: "mock", RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK,
      RUNTIME_TOKEN_DIR: dir, RUNTIME_DB_PATH: join(dir, "mission.db"), RUNTIME_MAIL_DIR: join(dir, "mail"),
      RUNTIME_MANAGER_DISPATCH: "deterministic", RUNTIME_SLA_SWEEP_MS: "5000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 30_000);
    proc.stdout.on("data", (b) => { if (String(b).includes(`listening :${PORT}`)) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}`)); });
  });
});
test.after(() => { try { proc?.kill(); } catch { /* gone */ } });

const call = (method, path, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, path, method,
    headers: { Host: `localhost:${PORT}`, "Content-Type": "application/json", "x-runtime-token": TOK } }, (res) => {
    let out = ""; res.on("data", (c) => { out += c; });
    res.on("end", () => { let j = null; try { j = JSON.parse(out); } catch { /* */ } resolve({ status: res.statusCode, json: j }); });
  });
  r.on("error", reject); r.end(body);
});

async function jobAwaitingAnswers(title) {
  const c = await call("POST", "/runtime/jobs", JSON.stringify({ title, brief: `please defer this: ${title}` }));
  assert.equal(c.status, 201, JSON.stringify(c.json));
  let detail = null;
  for (let i = 0; i < 120; i++) {
    detail = (await call("GET", `/runtime/jobs/${c.json.id}`)).json;
    if (detail.job.status === "awaiting-you" || detail.job.status === "blocked") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(detail.job.status, "awaiting-you", `precondition: the job waits on its questions (got ${detail.job.status})`);
  const gate = (await call("GET", "/inbox?status=pending&limit=200")).json.deliveries
    .find((d) => d.jobId === c.json.id && d.kind === "question");
  assert.ok(gate && gate.taskId === `${c.json.id}-q`, `precondition: the job's clarify gate is in the Inbox ${JSON.stringify(gate)}`);
  return { job: detail.job, gate };
}

test("CLARIFY-3: approving a job's clarify gate from the Inbox is refused — the job still waits, nothing is stored", async () => {
  const { job, gate } = await jobAwaitingAnswers("Tidy the changelog");
  const r = await call("POST", `/inbox/${gate.id}/approve`, JSON.stringify({}));
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.match(r.json.error, /answer/i);
  const after = (await call("GET", `/runtime/jobs/${job.id}`)).json.job;
  assert.equal(after.status, "awaiting-you", "an approve must not move the job past its questions");
  assert.equal(after.answers, null, "no answers were invented");
});

test("CLARIFY-4 (GOOD): answering through the job's route still plans it, and records the answer", async () => {
  const { job } = await jobAwaitingAnswers("Rename the settings tab");
  const r = await call("POST", `/runtime/jobs/${job.id}/answer`, JSON.stringify({ answers: [{ q: job.questions[0], a: "yes" }] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.job.status, "planned");
  assert.deepEqual(r.json.job.answers, [{ q: job.questions[0], a: "yes" }]);
});

test("CLARIFY-5 (GOOD): the clarify gate can still be REJECTED from the Inbox — the BOSS may decline the job", async () => {
  const { job, gate } = await jobAwaitingAnswers("Move the footer links");
  const r = await call("POST", `/inbox/${gate.id}/reject`, JSON.stringify({ feedback: "not now" }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await call("GET", `/runtime/jobs/${job.id}`)).json.job.status, "blocked");
});

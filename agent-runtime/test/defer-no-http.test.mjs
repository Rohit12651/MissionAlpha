// DEFER-NO, end to end — the real server, the real routes, the deterministic CEO.
//
// The bug: a job the CEO deferred asks the BOSS "Proceed anyway?" inside its question gate, and
// POST /runtime/jobs/:id/answer approved that gate whatever the answer said — "no" shipped work
// the BOSS had declined. This runs the whole path on a live runtime: the deterministic dispatcher
// says `defer` for a brief containing the word, the job reaches awaiting-you, and the answer
// decides it. Its own server because the store caps creates at 5 a minute (JOBHTTP-11's note).
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
const PORT = 3978;
const TOK = "defertok";
let proc;

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-defer-"));
  proc = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: { ...process.env, RUNTIME_BACKEND: "mock", RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK,
      RUNTIME_TOKEN_DIR: dir, RUNTIME_DB_PATH: join(dir, "mission.db"), RUNTIME_MAIL_DIR: join(dir, "mail"),
      RUNTIME_MANAGER_DISPATCH: "deterministic",
      // One heartbeat per 5 s instead of the default minute — JOBHTTP-12's setting, same reason.
      RUNTIME_SLA_SWEEP_MS: "5000" },
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

async function deferredJob(title) {
  const c = await call("POST", "/runtime/jobs", JSON.stringify({ title, brief: `please defer this: ${title}` }));
  assert.equal(c.status, 201, JSON.stringify(c.json));
  let job = null;
  for (let i = 0; i < 120; i++) {
    job = (await call("GET", `/runtime/jobs/${c.json.id}`)).json.job;
    if (job.status === "awaiting-you" || job.status === "blocked") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(job.status, "awaiting-you", `precondition: the deferred job waits on the BOSS (got ${job.status}, ${job.blockedOn})`);
  assert.equal(job.summary?.strategy?.verdict, "defer", "precondition: the CEO deferred it");
  assert.match(job.questions[0], /DEFERRING.*Proceed anyway\?/);
  return job;
}

test("DEFER-NO-E2E-1: answering 'no' blocks the deferred job — it is never planned", async () => {
  const job = await deferredJob("Tidy the changelog");
  const r = await call("POST", `/runtime/jobs/${job.id}/answer`, JSON.stringify({ answers: [{ q: job.questions[0], a: "no" }] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.job.status, "blocked", `a 'no' must not plan the job (got ${r.json.job.status})`);
  assert.match(r.json.job.blockedOn, /deferred/);
});

test("DEFER-NO-E2E-2: an ambiguous answer is a 400 and stores nothing; a later 'yes' plans it", async () => {
  const job = await deferredJob("Rename the settings tab");
  const bad = await call("POST", `/runtime/jobs/${job.id}/answer`, JSON.stringify({ answers: [{ q: job.questions[0], a: "no problem, go ahead" }] }));
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /yes or no/);
  const ok = await call("POST", `/runtime/jobs/${job.id}/answer`, JSON.stringify({ answers: [{ q: job.questions[0], a: "yes" }] }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.job.status, "planned");
});

test("DEFER-NO-E2E-3: a bulk approve cannot say yes to the CEO's defer — the gate is skipped, the job still waits", async () => {
  // Security review 2026-09-24: one bulk approve answered "Proceed anyway?" for every deferred job
  // in it — the answer that decides the job never went through deferAnswer.
  const job = await deferredJob("Reword the empty state");
  const detail = (await call("GET", `/runtime/jobs/${job.id}`)).json;
  const gate = (detail.gates || []).find((g) => g.kind === "question");
  assert.ok(gate, "precondition: the deferred job has an open question gate");
  // The gate is rated high-risk, so a bare bulk approve is already refused (400). The hole is the
  // CONFIRMED bulk approve: ticking "yes to high-risk" must still not answer the CEO's question.
  const r = await call("POST", "/inbox/bulk-decide", JSON.stringify({ ids: [gate.id], decision: "approve", confirmHighRisk: true }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.decided, 0);
  assert.match(r.json.results[0].error, /answer/i);
  assert.equal((await call("GET", `/runtime/jobs/${job.id}`)).json.job.status, "awaiting-you", "the job must still be waiting on the BOSS");
});

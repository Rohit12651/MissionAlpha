// Phase 3 / R9 — GET /runtime/selfgrade.
//
// Same gate and same GET-only posture as /runtime/doctor: the report enumerates this
// install's configuration weaknesses, which is reconnaissance, not public information.

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
const PORT = 3991;
const TOK = "selfgradetok";
const BASE = `http://127.0.0.1:${PORT}`;
const HOSTH = { Host: `localhost:${PORT}` };

let proc;

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "selfgrade-"));
  proc = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: { ...process.env, RUNTIME_BACKEND: "mock", RUNTIME_PORT: String(PORT),
      RUNTIME_TOKEN: TOK, RUNTIME_TOKEN_DIR: dir, RUNTIME_DB_PATH: join(dir, "mission.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 30_000);
    proc.stdout.on("data", (b) => { if (String(b).includes(`listening :${PORT}`)) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}`)); });
  });
});
test.after(() => { try { proc?.kill(); } catch { /* gone */ } });

const call = (method, headers) => fetch(`${BASE}/runtime/selfgrade`, { method, headers });
function raw(method, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = ""; res.on("data", (c) => { out += c; }); res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject); req.end();
  });
}

test("AUTH-1: authenticated GET returns a real grade", async () => {
  const r = await call("GET", { ...HOSTH, "x-runtime-token": TOK });
  assert.equal(r.status, 200);
  const g = await r.json();
  assert.ok(Number.isInteger(g.score) && g.score >= 0 && g.score <= 100);
  assert.ok(["A", "B", "C", "D", "F"].includes(g.grade));
  assert.ok(Array.isArray(g.findings));
});

test("AUTH-2: no token is 401 — config weaknesses are not public", async () => {
  assert.equal((await call("GET", HOSTH)).status, 401);
});

test("AUTH-3: a rebound Host is 403", async () => {
  assert.equal((await raw("GET", "/runtime/selfgrade", { Host: "evil.example.com", "x-runtime-token": TOK })).status, 403);
});

test("AUTH-4: POST is 405", async () => {
  assert.equal((await call("POST", { ...HOSTH, "x-runtime-token": TOK })).status, 405);
});

test("the grade is computed from the LIVE surface, not a stub", async () => {
  const g = await (await call("GET", { ...HOSTH, "x-runtime-token": TOK })).json();
  // hooks are constructed and enabled by this server, so that section must be graded.
  assert.ok(g.checked.includes("hooks"), `checked=${g.checked}`);
  assert.ok(g.checked.length >= 2, "more than one live section must be graded");
});

test("the response never carries config VALUES, only findings", async () => {
  const rawBody = await (await call("GET", { ...HOSTH, "x-runtime-token": TOK })).text();
  assert.ok(!rawBody.includes(TOK), "the runtime token must never appear");
});

test("doctor surfaces the same grade — one number, not two that can disagree", async () => {
  const doc = await (await fetch(`${BASE}/runtime/doctor`, { headers: { ...HOSTH, "x-runtime-token": TOK } })).json();
  const line = doc.checks.find((c) => c.id === "selfgrade");
  assert.ok(line, "doctor must carry the self-grade line");
  assert.notEqual(line.detail, "self-grade not wired");
  assert.match(line.detail, /\d+\/100/);
});

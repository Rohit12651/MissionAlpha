// SECURITY — /api/command must refuse a CROSS-ORIGIN caller.
//
// THE DEFECT (found by the Phase 7 security review; PRE-EXISTING, not Phase 7's):
// `/api/command` is dispatched at server.mjs:3658, ~440 lines BEFORE the `needsAuth` block,
// so the only global check it passed was `hostOk`. A browser sets Host from the URL, so any
// page on the machine could do:
//
//   fetch("http://localhost:3006/api/command", { method:"POST", mode:"no-cors",
//     headers:{"Content-Type":"text/plain"},
//     body:'{"type":"task","target":"tech-lead","body":"..."}' })
//
// `text/plain` avoids the CORS preflight, so it is a "simple request": the side effect lands
// and the attacker never needs to read the response. The handler writes
// `agent-status/commands/<id>.json`, and scripts/consume_commands.py drains that directory
// each scheduler tick and EXECUTES it. That is unauthenticated task injection.
//
// WHY ORIGIN AND NOT A TOKEN: vite.config.ts only attaches x-runtime-token on /apply and
// /changes, so requiring a token here would 401 the cockpit's own command button. `originOk`
// closes the browser-driven attack with no client change. Stated honestly: this is CSRF
// mitigation, not authentication — a non-browser caller that sends no Origin still passes,
// which is the same posture every other route on this path already has.
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
const PORT = 3994;
const TOK = "apicmdtok";

let proc;
test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "api-cmd-"));
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

function post(path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method: "POST", headers }, (res) => {
      let out = ""; res.on("data", (c) => { out += c; }); res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject); req.end(body);
  });
}
const CMD = JSON.stringify({ type: "task", target: "tech-lead", body: "injected by a cross-origin page" });

test("APICMD-1: a CROSS-ORIGIN POST is refused", async () => {
  const r = await post("/api/command",
    { Host: `localhost:${PORT}`, Origin: "http://evil.example.com", "Content-Type": "text/plain" }, CMD);
  assert.equal(r.status, 403, `a page on evil.example.com must not queue a task; got ${r.status} ${r.body.slice(0, 120)}`);
});

test("APICMD-2: the text/plain preflight-dodge is refused too", async () => {
  // The exact shape from the review: a "simple request" that skips the CORS preflight.
  const r = await post("/api/command",
    { Host: `localhost:${PORT}`, Origin: "https://attacker.test", "Content-Type": "text/plain" }, CMD);
  assert.equal(r.status, 403);
});

test("APICMD-3: the cockpit's OWN origin still works, with no token", async () => {
  // vite.config.ts does not attach x-runtime-token to /api/command. If this 401s or 403s,
  // the fix has broken the cockpit's command button.
  const r = await post("/api/command",
    { Host: `localhost:${PORT}`, Origin: `http://localhost:${PORT}`, "Content-Type": "application/json" }, CMD);
  assert.notEqual(r.status, 403, `the cockpit's own origin must not be refused; got ${r.body.slice(0, 160)}`);
  assert.notEqual(r.status, 401, "requiring a token here would break the cockpit button");
});

test("APICMD-4: a non-browser caller sending NO Origin still works", async () => {
  // Stated so nobody mistakes this for authentication: curl and the CLI still pass.
  const r = await post("/api/command",
    { Host: `localhost:${PORT}`, "Content-Type": "application/json" }, CMD);
  assert.notEqual(r.status, 403);
});

test("APICMD-5: a rebound Host is still refused (the pre-existing control is intact)", async () => {
  const r = await post("/api/command",
    { Host: "evil.example.com", "Content-Type": "application/json" }, CMD);
  assert.equal(r.status, 403);
});

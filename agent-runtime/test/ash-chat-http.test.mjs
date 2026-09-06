// Phase 12 · task 12.1 — ASH's tool against the REAL runtime.
//
// ash-tools.test.mjs drives the MCP server against a stub, so it can pin one status at a time.
// This file removes the stub: a booted runtime, its real routes, its real job store. It is the
// difference between "the courier relays a 409" and "a 409 is what this runtime actually says
// when a brief is submitted twice" — addendum #25, a dependency every test injects is a
// dependency no test proves is wired.
//
// NOT covered here, and disclosed rather than implied: the CHAT SPAWN's composition of the ash
// MCP config. `cliReply` builds its argv inline and server.mjs boots on import, so there is no
// seam to assert without a live `claude` turn. That is proven at runtime in 12.1's live proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_CREATES_PER_WINDOW } from "../jobs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ASH_MCP = join(ROOT, "agent-runtime", "mcp", "ash-tools.mjs");
const PORT = 3995;
const TOK = "ashtok";
const H = { Host: `localhost:${PORT}`, "Content-Type": "application/json" };
const auth = { ...H, "x-runtime-token": TOK };
const BASE = `http://127.0.0.1:${PORT}`;

let proc;
test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-http-"));
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

/** Drive the MCP server exactly as the runtime does: one JSON-RPC line in, one frame out. */
function ashCall(env, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [ASH_MCP], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("ash mcp did not answer")); }, 15_000);
    p.stdout.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer); p.kill("SIGTERM");
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
    });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_job", arguments: args } })}\n`);
  });
}
const text = (frame) => String(frame?.result?.content?.[0]?.text ?? "");
const count = async () => (await req("GET", "/runtime/jobs", auth)).json.jobs.length;

test("ACH-1: the DUPLICATE cap is the ROUTE's, not the tool's — a direct curl gets it too", async () => {
  const brief = "make the inbox dates read as 3 minutes ago";
  assert.equal((await req("POST", "/runtime/jobs", auth, JSON.stringify({ title: "a", brief }))).status, 201);
  const dup = await req("POST", "/runtime/jobs", auth, JSON.stringify({ title: "a different label", brief }));
  assert.equal(dup.status, 409, dup.body);
  assert.match(dup.json.error, /identical brief/i);
});

test("ACH-2: create_job through the REAL server creates a REAL row", async () => {
  const before = await count();
  const f = await ashCall({ MA_ASH_BASE: BASE, MA_ASH_TOKEN: TOK },
    { title: "Dark mode", brief: "add a dark theme toggle to the settings page" });
  assert.equal(f.result.isError, undefined, text(f));
  const id = (text(f).match(/job_[0-9a-f]{12}/) || [])[0];
  assert.ok(id, `no job id in: ${text(f)}`);
  assert.equal(await count(), before + 1);
  const row = await req("GET", `/runtime/jobs/${id}`, auth);
  assert.equal(row.json.job.title, "Dark mode");
  assert.equal(row.json.job.status, "intake");
});

test("ACH-3: the SAME brief through the tool is refused, and NO second row appears", async () => {
  const args = { title: "Dark mode again", brief: "add a dark theme toggle to the settings page" };
  const before = await count();
  const f = await ashCall({ MA_ASH_BASE: BASE, MA_ASH_TOKEN: TOK }, args);
  assert.equal(f.result.isError, true, "a duplicate reported as success is how one job becomes five");
  assert.match(text(f), /identical brief/i);
  assert.ok(!/job_[0-9a-f]{12}/.test(text(f)), "a refusal must not carry a job id");
  assert.equal(await count(), before, "the store grew on a refused create");
});

test("ACH-4: a WRONG token is refused by the ROUTE — the courier cannot authorise itself", async () => {
  const before = await count();
  const f = await ashCall({ MA_ASH_BASE: BASE, MA_ASH_TOKEN: "not-the-token" },
    { title: "sneaky", brief: "a brief nobody approved" });
  assert.equal(f.result.isError, true);
  assert.match(text(f), /refused \(401\)|refused \(403\)/, text(f));
  assert.equal(await count(), before, "an unauthorised create landed a row");
});

test("ACH-5: the RATE cap fires, and it fires at or before the stated number", async () => {
  let created = 0;
  let saw429 = null;
  for (let i = 0; i < MAX_CREATES_PER_WINDOW + 4; i += 1) {
    const r = await req("POST", "/runtime/jobs", auth,
      JSON.stringify({ title: `rate ${i}`, brief: `a distinct brief for rate probe number ${i}` }));
    if (r.status === 429) { saw429 = r; break; }
    if (r.status === 201) created += 1;
  }
  assert.ok(saw429, "the rate cap never fired — a model in a retry loop would mint jobs forever");
  assert.match(saw429.json.error, /too many jobs/i);
  // Distinct briefs, so the DUPLICATE guard cannot be what stopped it (addendum #38: two
  // guards that produce the same outcome make a test that cannot tell which one fired).
  assert.ok(created <= MAX_CREATES_PER_WINDOW,
    `${created} rows were created before the cap of ${MAX_CREATES_PER_WINDOW} fired`);
});

test("ACH-6: the tool relays the rate refusal too, and lands nothing", async () => {
  const before = await count();
  const f = await ashCall({ MA_ASH_BASE: BASE, MA_ASH_TOKEN: TOK },
    { title: "one more", brief: "yet another distinct brief, submitted while the window is full" });
  assert.equal(f.result.isError, true);
  assert.match(text(f), /too many jobs/i);
  assert.equal(await count(), before);
});

// ── 12.2 — the thread the board's drawer renders ─────────────────────────────
test("ACH-7: a job's detail carries its MAIL THREAD, not just its tasks", async () => {
  // Reuses a job the earlier tests already created rather than making one: the rate window is
  // shared across this file, and a test that competes with the cap it is not testing is a test
  // that fails for a reason it never claimed to be about.
  const list = await req("GET", "/runtime/jobs", auth);
  const id = list.json.jobs[0]?.id;
  assert.ok(id, "no job to thread — the earlier tests should have left several");

  // `engine` → `tech-lead` is system → manager, which the role table allows.
  const m = await req("POST", "/runtime/mail", auth, JSON.stringify({
    from: "engine", to: "tech-lead", kind: "done", body: "task finished", jobId: id,
  }));
  assert.equal(m.status, 201, m.body);

  const d = await req("GET", `/runtime/jobs/${id}`, auth);
  assert.equal(d.status, 200, d.body);
  assert.ok(Array.isArray(d.json.log), "the detail must carry a log array, even when empty");
  assert.ok(d.json.log.length >= 1, "the routed message never reached the thread the drawer reads");
});

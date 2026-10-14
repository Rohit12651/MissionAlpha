// Phase 1 / R4 — GET /runtime/doctor route.
//
// AUTH-* is the load-bearing group. A doctor report is a READ, but it enumerates this
// install's weaknesses — no active account, gh missing, encryption off, the exact DB and
// repo paths. That is a reconnaissance surface, so it must never be looser than any other
// /runtime read. An earlier revision of this route sat OUTSIDE the needsAuth list and
// answered 200 to an unauthenticated caller; these tests exist so that cannot recur.

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
const PORT = 3993;
const TOK = "doctorhttptok";
const BASE = `http://127.0.0.1:${PORT}`;
const HOSTH = { Host: `localhost:${PORT}` };

let proc;

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-http-"));
  proc = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: {
      ...process.env,
      RUNTIME_BACKEND: "mock",
      RUNTIME_PORT: String(PORT),
      RUNTIME_TOKEN: TOK,
      RUNTIME_TOKEN_DIR: dir,
      RUNTIME_DB_PATH: join(dir, "mission.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 30_000);
    proc.stdout.on("data", (b) => {
      if (String(b).includes(`listening :${PORT}`)) { clearTimeout(t); resolve(); }
    });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}`)); });
  });
});

test.after(() => { try { proc?.kill(); } catch { /* already gone */ } });

const call = (method, headers) => fetch(`${BASE}/runtime/doctor`, { method, headers });

// fetch() treats Host as a forbidden header and silently drops an override, so the
// DNS-rebinding case must go through a raw node:http request that actually sends the
// crafted Host — the same reason cadence-http.test.mjs carries this helper.
function raw(method, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("AUTH-1: an authenticated GET returns the report", async () => {
  const r = await call("GET", { ...HOSTH, "x-runtime-token": TOK });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.checks) && body.checks.length >= 8);
  assert.ok(["ok", "warn", "fail"].includes(body.status));
  assert.ok(body.summary && Number.isFinite(body.summary.fail));
});

test("AUTH-2: NO TOKEN is 401 — a health report is not public reconnaissance", async () => {
  assert.equal((await call("GET", HOSTH)).status, 401);
});

test("AUTH-3: a wrong token is 401", async () => {
  assert.equal((await call("GET", { ...HOSTH, "x-runtime-token": "nope" })).status, 401);
});

test("AUTH-4: a rebound Host is 403 even with a valid token", async () => {
  const r = await raw("GET", "/runtime/doctor", { Host: "evil.example.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
});

test("a known path with the wrong verb is 405, not 404", async () => {
  assert.equal((await call("POST", { ...HOSTH, "x-runtime-token": TOK })).status, 405);
});

test("the report names the live account state — the 3-day-outage check", async () => {
  const body = await (await call("GET", { ...HOSTH, "x-runtime-token": TOK })).json();
  const acct = body.checks.find((c) => c.id === "account");
  assert.ok(acct, "the account check must always be present");
  // With no configured account this install fails; either way the check must be decisive
  // and, when not ok, must carry an actionable fix.
  if (acct.status !== "ok") assert.ok(acct.fix && acct.fix.length > 10, "a failing check must tell the operator what to type");
});

test("the report composes the LIVE resource guard, not a re-derived guess", async () => {
  const body = await (await call("GET", { ...HOSTH, "x-runtime-token": TOK })).json();
  const guard = body.checks.find((c) => c.id === "guard");
  assert.ok(guard);
  assert.notEqual(guard.detail, "guard not wired", "the route must pass the real guard handle");
});

test("the report never leaks a credential", async () => {
  const raw = await (await call("GET", { ...HOSTH, "x-runtime-token": TOK })).text();
  assert.ok(!raw.includes(TOK), "the runtime token must not appear in the report");
  assert.ok(!/sk-[a-z]/i.test(raw));
});

test("R1: the LIVE server reports its lifecycle hooks as enabled", async () => {
  const body = await (await call("GET", { ...HOSTH, "x-runtime-token": TOK })).json();
  const hooks = body.checks.find((c) => c.id === "hooks");
  assert.ok(hooks, "the hooks check must be present");
  assert.notEqual(hooks.detail, "hooks probe not wired", "engineHooks must be handed to the doctor");
  assert.equal(hooks.status, "ok");
  // 5 closed lifecycle events, all enabled by default.
  assert.match(hooks.detail, /5\/5 events enabled/);
});

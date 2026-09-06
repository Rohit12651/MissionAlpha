// Phase 7 / task 7.1 — GET /runtime/roster.
//
// THE DEFECT THIS PINS, and it shipped in this very phase: the route was added and was
// UNAUTHENTICATED. `needsAuth` in server.mjs is an ALLOW-LIST of gated paths, so a new
// route is ungated by DEFAULT and nothing complains. Verified live before the fix:
//   $ curl -s http://127.0.0.1:3005/runtime/roster        → the full roster, no token
//   $ curl -s http://127.0.0.1:3005/runtime/doctor        → {"error":"unauthorized"}
// PES addendum #14 in its inverse form ("a deny list is allow-by-default for everything it
// does not name"). The roster enumerates every seat and the exact globs it may write —
// reconnaissance in the same sense selfgrade is.
//
// Shaped after selfgrade-http.test.mjs, which pins the same posture for its neighbour.
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
const TOK = "rostertok";
const BASE = `http://127.0.0.1:${PORT}`;
const HOSTH = { Host: `localhost:${PORT}` };

let proc;

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "roster-http-"));
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

const call = (method, headers) => fetch(`${BASE}/runtime/roster`, { method, headers });
function raw(method, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = ""; res.on("data", (c) => { out += c; }); res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject); req.end();
  });
}

test("ROSTER-HTTP-1: an authenticated GET returns the seeded roster", async () => {
  const r = await call("GET", { ...HOSTH, "x-runtime-token": TOK });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.members.length, 12);
  assert.deepEqual(body.members.map((m) => m.id), [
    "ceo", "tech-lead", "pm-analyst", "architect", "reviewer", "devops", "sre",
    "docs-writer", "java17-engineer", "sr-frontend", "sr-backend", "qa",
  ]);
  const fe = body.members.find((m) => m.id === "sr-frontend");
  assert.deepEqual(fe.writeScope, ["src/**"]);
});

test("ROSTER-HTTP-2: NO token is 401 — the seat/scope map is not public", async () => {
  const r = await call("GET", HOSTH);
  assert.equal(r.status, 401, "an unauthenticated caller must not learn which seat may write where");
  assert.equal((await r.text()).includes("writeScope"), false, "no roster content may leak in the refusal");
});

test("ROSTER-HTTP-3: a WRONG token is 401", async () => {
  assert.equal((await call("GET", { ...HOSTH, "x-runtime-token": "not-the-token" })).status, 401);
});

test("ROSTER-HTTP-4: a rebound Host is 403", async () => {
  assert.equal((await raw("GET", "/runtime/roster", { Host: "evil.example.com", "x-runtime-token": TOK })).status, 403);
});

test("ROSTER-HTTP-5: the route is GET-only", async () => {
  assert.equal((await call("POST", { ...HOSTH, "x-runtime-token": TOK })).status, 405);
});

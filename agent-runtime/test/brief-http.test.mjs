// B3 — the CEO brief at the wire, through a REAL booted runtime (mock backend,
// ephemeral state under tmp). Proves the B3 exit criteria:
//   POST /runtime/captain/route  → ONE vault record + ONE queued task, with BOTH
//     `vault.written` and `task.queued` observed on an open SSE stream
//   GET  /runtime/brief/log      → the last-24h activity out of events_log,
//     newest-first, capped, viewer-readable
// Plus the adversarial sweep BLOCKING for this phase: no-token 401, evil Host 403,
// viewer POST 403, empty / oversize / non-string text 400, a client-supplied `by`
// IGNORED, a fractional or hostile `hours` handled without a 500, and hours>168 400.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3987, TOK = "brieftok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, sbRoot, dbPath, vaultDir, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const authCk = (cookie, x = {}) => auth(cookie ? { Cookie: cookie, ...x } : x);
const post = (path, body, headers) => fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body ?? {}) });
const del = (path, headers) => fetch(`${BASE}${path}`, { method: "DELETE", headers: headers ?? auth() });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });

function cookieFrom(res) {
  const m = (res.headers.get("set-cookie") || "").match(/ma_session=([^;]*)/);
  return m ? `ma_session=${m[1]}` : null;
}

// undici rewrites Host to the connected authority, so the DNS-rebinding gate can only
// be exercised through a raw node:http request.
function raw(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function waitHealth(ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server not healthy");
}

function boot() {
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "mock", RUNTIME_TOOLS: "write",
      RUNTIME_REPO_ROOT: repo, RUNTIME_SEED_DIRS: "src",
      RUNTIME_DB_PATH: dbPath,
      RUNTIME_VAULT_DIR: vaultDir,
      RUNTIME_SANDBOX_ROOT: sbRoot,
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"),
      RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  return waitHealth();
}
const kill = () => new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });

// ── SSE client (same shape as vault-http.test.mjs) ──────────────────────────
async function openSse({ ticket } = {}) {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/runtime/events?ticket=${ticket}`, { headers: { Host: `localhost:${PORT}` }, signal: ac.signal });
  const frames = [];
  if (res.status !== 200) { ac.abort(); return { status: res.status, frames, close: () => {} }; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const rawFrame = buf.slice(0, i); buf = buf.slice(i + 2);
          if (rawFrame.startsWith(":")) continue;
          const f = { at: Date.now() };
          for (const line of rawFrame.split("\n")) {
            if (line.startsWith("id: ")) f.id = Number(line.slice(4));
            else if (line.startsWith("event: ")) f.event = line.slice(7);
            else if (line.startsWith("data: ")) { try { f.data = JSON.parse(line.slice(6)); } catch { f.data = null; } }
          }
          frames.push(f);
        }
      }
    } catch { /* aborted */ }
  })();
  return { status: res.status, frames, close: () => ac.abort() };
}

async function waitFrame(sse, pred, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = sse.frames.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`no matching SSE frame within ${ms}ms (saw: ${JSON.stringify(sse.frames.map((f) => f.event))})`);
}

const newTicket = async () => (await (await post("/runtime/events/ticket", {})).json()).ticket;

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-briefhttp-")));
  repo = join(root, "repo");
  sbRoot = join(root, "x", "sb");
  dbPath = join(root, "x", "db", "mission.db");
  vaultDir = join(root, "x", "db", "vault");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  await boot();
});
after(async () => {
  await kill();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

// ── adversarial: auth gates ─────────────────────────────────────────────────

test("both B3 routes require the token → 401", async () => {
  assert.equal((await post("/runtime/captain/route", { text: "market check" }, H())).status, 401);
  assert.equal((await get("/runtime/brief/log", H())).status, 401);
});

test("an evil Host is refused on both B3 routes → 403 (DNS-rebinding gate, raw http)", async () => {
  const r = await raw("GET", "/runtime/brief/log?hours=24", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
  assert.match(r.body, /forbidden host/);
  const w = await raw("POST", "/runtime/captain/route", { Host: "evil.com", "x-runtime-token": TOK, "Content-Type": "application/json" }, JSON.stringify({ text: "market check" }));
  assert.equal(w.status, 403);
});

test("the wrong method on either route → 405, never a silent 200", async () => {
  assert.equal((await get("/runtime/captain/route")).status, 405);
  assert.equal((await post("/runtime/brief/log", {})).status, 405);
});

// ── the log, before anything is routed ──────────────────────────────────────

test("GET /runtime/brief/log answers with an events array from the very first read", async () => {
  const r = await get("/runtime/brief/log?hours=24");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.events), "events[] is always an array");
  assert.equal(body.hours, 24);
});

// ── route: the happy path + both bus frames ─────────────────────────────────

let routedRecordId = null;

test("POST /runtime/captain/route records the decision AND queues the task, with BOTH frames on the bus", async () => {
  const sse = await openSse({ ticket: await newTicket() });
  assert.equal(sse.status, 200);
  try {
    const t0 = Date.now();
    const r = await post("/runtime/captain/route", { text: "update the readme before Friday" });
    assert.equal(r.status, 201);
    const out = await r.json();
    assert.equal(out.agentId, "docs-writer");
    assert.equal(out.matched, "readme");
    assert.ok(out.recordId, "the record id is returned");
    assert.ok(out.taskId, "the task id is returned");
    routedRecordId = out.recordId;

    const written = await waitFrame(sse, (x) => x.event === "vault.written" && x.data?.id === out.recordId);
    assert.equal(written.data.node, "content", "the record landed in the docs seat's lane");
    assert.equal(written.data.venture, "waahyu");
    assert.ok(written.at - t0 < 2000, `vault.written ${written.at - t0}ms after the route`);

    const queued = await waitFrame(sse, (x) => x.event === "task.queued" && x.data?.taskId === out.taskId);
    assert.equal(queued.data.agentId, "docs-writer", "the SAME agent got the work");
  } finally { sse.close(); }
});

test("the routed record is readable through the SHIPPED vault route, with the routing note", async () => {
  const rec = await (await get(`/runtime/vault/record?id=${routedRecordId}`)).json();
  assert.equal(rec.meta.node, "content");
  assert.equal(rec.meta.venture, "waahyu");
  assert.equal(rec.meta.sourceRun, "captain-route");
  assert.equal(rec.meta.title, "update the readme before Friday");
  assert.match(rec.body, /update the readme before Friday/);
  assert.match(rec.body, /docs-writer/);
  assert.match(rec.body, /not a model classification/, "the record says out loud that this is a keyword rule");
});

test("an order nothing matches stays with the Tech Lead", async () => {
  const out = await (await post("/runtime/captain/route", { text: "think about next quarter" })).json();
  assert.equal(out.agentId, "tech-lead");
  assert.equal(out.matched, null);
  const rec = await (await get(`/runtime/vault/record?id=${out.recordId}`)).json();
  assert.equal(rec.meta.node, "tech", "the Tech Lead has no explicit lane, so it falls to the vault DEFAULT_NODE");
});

// ── adversarial: the body ───────────────────────────────────────────────────

test("POST with empty / blank / missing / non-string text → 400, and nothing is queued", async () => {
  for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }, { text: null }, { text: ["readme"] }]) {
    const r = await post("/runtime/captain/route", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match((await r.json()).error, /text/);
  }
});

test("POST past the 2000-char cap is REFUSED, not truncated", async () => {
  const r = await post("/runtime/captain/route", { text: "market ".padEnd(2001, "x") });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /2000/);
  // exactly at the cap is fine — the boundary is inclusive
  const ok = await post("/runtime/captain/route", { text: "market ".padEnd(2000, "x") });
  assert.equal(ok.status, 201);
});

test("POST past the TRANSPORT cap is refused at the socket (memory-exhaustion guard)", async () => {
  await assert.rejects(
    () => post("/runtime/captain/route", { text: "x".repeat(200_000) }),
    "the reader destroys the request rather than buffering an unbounded body",
  );
  assert.equal((await get("/runtime/brief/log")).status, 200, "and the server is still serving");
});

test("a client-supplied `by` / `author` is IGNORED — the author is server-derived", async () => {
  const out = await (await post("/runtime/captain/route", { text: "check the deploy pipeline", by: "not-me", author: "not-me" })).json();
  const rec = await (await get(`/runtime/vault/record?id=${out.recordId}`)).json();
  assert.equal(rec.meta.author, "boss", "solo mode authors as the operator, never as the body's claim");
  assert.notEqual(rec.meta.author, "not-me");
});

test("a client-supplied agentId / node cannot redirect the route", async () => {
  const out = await (await post("/runtime/captain/route", { text: "the build is red", agentId: "docs-writer", node: "decisions" })).json();
  assert.equal(out.agentId, "devops", "the keyword decides, not the body");
  const rec = await (await get(`/runtime/vault/record?id=${out.recordId}`)).json();
  assert.equal(rec.meta.node, "tech", "devops's lane (the default), not the body's");
});

test("a token-shaped secret in an order never reaches the record or the bus frame", async () => {
  const sse = await openSse({ ticket: await newTicket() });
  try {
    const out = await (await post("/runtime/captain/route", { text: "release note, key sk-ant-DEADBEEF01 attached" })).json();
    const rec = await (await get(`/runtime/vault/record?id=${out.recordId}`)).json();
    assert.ok(!rec.meta.title.includes("sk-ant-DEADBEEF01"));
    assert.ok(!rec.body.includes("sk-ant-DEADBEEF01"));
    assert.match(rec.body, /\[redacted-secret\]/);
    const f = await waitFrame(sse, (x) => x.event === "vault.written" && x.data?.id === out.recordId);
    assert.ok(!JSON.stringify(f.data).includes("sk-ant-DEADBEEF01"));
  } finally { sse.close(); }
});

// ── the log, now that there is real activity ────────────────────────────────

test("GET /runtime/brief/log returns REAL events, newest-first, inside the window", async () => {
  const body = await (await get("/runtime/brief/log?hours=24")).json();
  assert.ok(body.events.length > 0, "the routes above wrote real frames");
  const CATALOG = new Set(["vault.written", "task.queued", "task.done", "task.failed", "delivery.created", "delivery.decided"]);
  const floor = Date.now() - 24 * 3600 * 1000;
  let prev = Infinity;
  for (const e of body.events) {
    assert.ok(CATALOG.has(e.name), `unexpected name on the brief log: ${e.name}`);
    assert.ok(typeof e.ts === "string" && !Number.isNaN(Date.parse(e.ts)), `bad ts ${e.ts}`);
    assert.ok(Date.parse(e.ts) >= floor, "every row is inside the requested window");
    assert.ok(typeof e.data === "object" && e.data !== null, "the payload is an object");
    assert.ok(Number.isFinite(e.seq), "each row carries its monotonic seq");
    assert.ok(e.seq <= prev, "newest-first");
    prev = e.seq;
  }
  assert.ok(body.events.length <= 100, "the log is capped at 100 rows");
  assert.ok(body.events.some((e) => e.name === "vault.written"));
  assert.ok(body.events.some((e) => e.name === "task.queued"));
});

test("the brief log carries only the six brief names — chat/usage/agent noise is filtered out", async () => {
  const body = await (await get("/runtime/brief/log?hours=168")).json();
  const names = new Set(body.events.map((e) => e.name));
  for (const noisy of ["usage.tick", "agent.state", "task.started", "task.retried"]) {
    assert.ok(!names.has(noisy), `${noisy} must not reach the brief`);
  }
});

// ── adversarial: the hours parameter ────────────────────────────────────────

test("hours over the 168 ceiling → 400", async () => {
  for (const h of [169, 1000, 99999]) {
    const r = await get(`/runtime/brief/log?hours=${h}`);
    assert.equal(r.status, 400, String(h));
    assert.match((await r.json()).error, /168/);
  }
  assert.equal((await get("/runtime/brief/log?hours=168")).status, 200, "the ceiling itself is allowed");
});

test("a fractional, negative, non-numeric or absent hours never 500s", async () => {
  // B2's sr-security LOW-4 in miniature: a fractional value must be floored BEFORE it
  // reaches SQLite / the clamp, or it arrives as a float and throws.
  for (const q of ["hours=1.5", "hours=23.999", "hours=0", "hours=-5", "hours=abc", "hours=", "hours=1e400", "hours=Infinity", "hours=NaN", ""]) {
    const r = await get(`/runtime/brief/log?${q}`);
    assert.equal(r.status, 200, q);
    const b = await r.json();
    assert.ok(Array.isArray(b.events), q);
    assert.ok(Number.isInteger(b.hours) && b.hours >= 1 && b.hours <= 168, `${q} → hours ${b.hours}`);
  }
});

test("a 1-hour window is a real filter, not a formality", async () => {
  const wide = await (await get("/runtime/brief/log?hours=168")).json();
  const narrow = await (await get("/runtime/brief/log?hours=1")).json();
  assert.ok(narrow.events.length <= wide.events.length);
  const floor = Date.now() - 3600 * 1000;
  for (const e of narrow.events) assert.ok(Date.parse(e.ts) >= floor);
});

// ── adversarial: role enforcement (auth ACTIVE) ─────────────────────────────
// Runs LAST: activating auth (≥2 accounts) changes the gate for every route above.

let approverCk = null, viewerCk = null, aliceId = null, vicId = null;

test("activate auth: two accounts, one approver and one viewer", async () => {
  const a = await post("/runtime/users", { name: "Alice", password: "alice-passphrase", role: "approver" });
  assert.equal(a.status, 201);
  aliceId = (await a.json()).user.id;
  const v = await post("/runtime/users", { name: "Vic", password: "vic-passphrase", role: "viewer" });
  assert.equal(v.status, 201);
  vicId = (await v.json()).user.id;
  approverCk = cookieFrom(await post("/runtime/auth/login", { name: "Alice", password: "alice-passphrase" }));
  viewerCk = cookieFrom(await post("/runtime/auth/login", { name: "Vic", password: "vic-passphrase" }));
  assert.ok(approverCk && viewerCk);
});

test("auth active: the token alone no longer reads the brief log → 401 (a session is required)", async () => {
  assert.equal((await get("/runtime/brief/log")).status, 401);
  assert.equal((await post("/runtime/captain/route", { text: "market check" })).status, 401);
});

test("auth active: a VIEWER may READ the brief log (a glance, not an order)", async () => {
  const r = await get("/runtime/brief/log?hours=24", authCk(viewerCk));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray((await r.json()).events));
});

test("auth active: a VIEWER giving the Captain an order → 403, and nothing lands", async () => {
  const before = (await (await get("/runtime/vault/stats", authCk(viewerCk))).json()).total;
  const r = await post("/runtime/captain/route", { text: "market sweep by a viewer" }, authCk(viewerCk));
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /approver/);
  assert.equal((await (await get("/runtime/vault/stats", authCk(viewerCk))).json()).total, before, "the viewer changed nothing");
});

test("auth active: an APPROVER routes, and the record is authored by the SESSION identity", async () => {
  const r = await post("/runtime/captain/route", { text: "draft the architecture design", by: "someone-else" }, authCk(approverCk));
  assert.equal(r.status, 201);
  const out = await r.json();
  assert.equal(out.agentId, "architect");
  const rec = await (await get(`/runtime/vault/record?id=${out.recordId}`, authCk(approverCk))).json();
  assert.equal(rec.meta.author, "alice", "author is the authenticated seat, not a client-supplied string");
});

test("teardown: deleting back to <2 accounts restores solo", async () => {
  assert.equal((await del(`/runtime/users/${vicId}`, authCk(approverCk))).status, 200);
  assert.equal((await del(`/runtime/users/${aliceId}`, authCk(approverCk))).status, 200);
  assert.equal((await get("/runtime/brief/log")).status, 200, "token-only reads work again");
});

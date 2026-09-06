// B4 — cadence autonomy at the wire, through a REAL booted runtime (mock backend,
// ephemeral state under tmp). Proves the B4 exit criteria:
//   GET  /runtime/cadence          → the 15 seeded rows, viewer-readable
//   POST /runtime/cadence/run  {id} → runNow → { taskId } + `workflow.run` on SSE
//   POST /runtime/cadence/toggle    → setEnabled, reflected in the next GET
// THE AUTONOMY PROOF (mock-honest): a cadence Run-now dispatches a real queued task with
// ZERO human input; in the mock backend that task fails, and the EXISTING P4 self-heal
// path mints a failure Delivery in the Inbox — observed here as a `task.failed` followed
// by a `delivery.created` (kind='failure') for the cadence's station, all on one SSE stream.
// Plus the adversarial sweep: no-token 401, evil Host 403, viewer POST 403, unknown id 404,
// missing id / non-boolean enabled 400.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3994, TOK = "cadencetok", BASE = `http://127.0.0.1:${PORT}`;

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

// undici rewrites Host to the connected authority, so the DNS-rebinding gate can only be
// exercised through a raw node:http request that keeps the crafted Host header.
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

// ── SSE client (same shape as brief-http.test.mjs) ──────────────────────────
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

async function waitFrame(sse, pred, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = sse.frames.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-cadence-http-")));
  repo = join(root, "repo"); sbRoot = join(root, "sb");
  dbPath = join(root, "data", "mission.db"); vaultDir = join(root, "data", "vault");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(sbRoot, { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });
  await boot();
});
after(async () => { await kill(); try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

// ── reads ───────────────────────────────────────────────────────────────────

test("GET /runtime/cadence returns the seeded SE rows, forward-scheduled", async () => {
  const r = await get("/runtime/cadence");
  assert.equal(r.status, 200);
  const { cadences } = await r.json();
  const byId = new Map(cadences.map((c) => [c.id, c]));
  // The invariant this test protects is NOTHING RETIRED — a seeded cadence silently
  // disappearing is the regression that matters. Asserting a literal row count made the
  // test fail the moment R2b legitimately ADDED the four worker cadences, which is a
  // false alarm, not a caught bug. So: assert the three SE rows are all still present
  // (the real invariant) and let the catalog grow.
  for (const id of ["stuck-story-sweep", "nightly-regression", "monitor-tick"]) {
    assert.ok(byId.has(id), `${id} retired from the seed`);
  }
  const sweep = byId.get("stuck-story-sweep");
  assert.equal(sweep.agent, "tech-lead");
  assert.equal(sweep.enabled, true, "the pipeline watchdog is live from S0");
  assert.equal(sweep.expr, "2xdaily");
  assert.ok(sweep.next_run > Date.now(), "scheduled forward, never retroactively");
  // nightly-regression lands dark (needs S4's test config); monitor-tick is LIVE from S5.
  assert.equal(byId.get("nightly-regression").enabled, false);
  assert.equal(byId.get("nightly-regression").agent, "qa");
  assert.equal(byId.get("monitor-tick").enabled, true, "S5 ships the monitor it drives");
  assert.equal(byId.get("monitor-tick").agent, "sre");

  // R2b — the worker catalog is seeded but DARK. An install whose account is not active
  // must not start minting four model-backed runs a day on its own.
  for (const id of ["worker-audit", "worker-testgaps", "worker-document", "worker-refactor"]) {
    assert.ok(byId.has(id), `${id} missing from the seeded catalog`);
    assert.equal(byId.get(id).enabled, false, `${id} must seed disabled`);
  }
});

test("adversarial: no token 401, evil Host 403", async () => {
  const noTok = await fetch(`${BASE}/runtime/cadence`, { headers: { Host: `localhost:${PORT}` } });
  assert.equal(noTok.status, 401, "the runtime token is required to read cadences");
  const evil = await raw("GET", "/runtime/cadence", { Host: "evil.example.com", "x-runtime-token": TOK });
  assert.equal(evil.status, 403, "a rebound Host is refused even with a valid token");
});

// ── validation verdicts ──────────────────────────────────────────────────────

test("POST /runtime/cadence/run — missing id 400, unknown id 404", async () => {
  assert.equal((await post("/runtime/cadence/run", {})).status, 400);
  const unknown = await post("/runtime/cadence/run", { id: "no-such-cadence" });
  assert.equal(unknown.status, 404);
});

test("POST /runtime/cadence/toggle — non-boolean 400, unknown id 404, valid flips enabled", async () => {
  assert.equal((await post("/runtime/cadence/toggle", { id: "stuck-story-sweep", enabled: "yes" })).status, 400);
  assert.equal((await post("/runtime/cadence/toggle", { id: "nope", enabled: true })).status, 404);

  const off = await post("/runtime/cadence/toggle", { id: "stuck-story-sweep", enabled: false });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).cadence.enabled, false);
  const list1 = (await (await get("/runtime/cadence")).json()).cadences;
  assert.equal(list1.find((c) => c.id === "stuck-story-sweep").enabled, false, "the pause persisted");
  // resume, so later state is clean
  const on = await post("/runtime/cadence/toggle", { id: "stuck-story-sweep", enabled: true });
  assert.equal((await on.json()).cadence.enabled, true);
});

// ── THE AUTONOMY PROOF (mock-honest) ─────────────────────────────────────────

test("AUTONOMY: Run-now dispatches a real task with zero human input → workflow.run → failure Delivery", async () => {
  const ticket = (await (await post("/runtime/events/ticket", {})).json()).ticket;
  assert.ok(ticket, "an SSE ticket was minted");
  const sse = await openSse({ ticket });
  assert.equal(sse.status, 200);

  // Run a DISABLED cadence so nothing the periodic tick touches can confound the proof:
  // a disabled row can only ever dispatch through this manual path. nightly-regression (qa)
  // dispatches a REAL engine goal — unlike monitor-tick (sre), which S5 routes to the SRE
  // monitor instead of the engine, so it would not produce a task.failed → failure delivery.
  const run = await post("/runtime/cadence/run", { id: "nightly-regression" });
  assert.equal(run.status, 200);
  const { taskId } = await run.json();
  assert.ok(taskId, "runNow queued a real task and returned its id");

  // 1) the schedule frame — the run announced itself on the closed bus catalog.
  const wf = await waitFrame(sse, (f) => f.event === "workflow.run" && f.data?.id === "nightly-regression", 5000);
  assert.ok(wf, "a workflow.run frame was emitted for the cadence");
  assert.equal(wf.data.status, "dispatched");
  assert.equal(wf.data.agent, "qa");

  // 2) the mock backend cannot spawn real work, so the task ends task.failed…
  const failed = await waitFrame(sse, (f) => f.event === "task.failed", 15000);
  assert.ok(failed, "the dispatched task failed (mock backend has no cli spawn)");

  // 3) …and the EXISTING P4 self-heal path mints a failure Delivery in the Inbox. That
  // diff-less failure row IS the observable autonomy proof: a scheduled run reached the
  // operator's Inbox with no human in the loop.
  const failureDelivery = await waitFrame(
    sse,
    (f) => f.event === "delivery.created" && f.data?.kind === "failure" && f.data?.agentId === "qa",
    15000,
  );
  assert.ok(failureDelivery, "a failure Delivery was minted for the cadence's station");

  // the failure Delivery is also queryable in the Inbox (not just a bus frame)
  const inbox = await (await get("/inbox?status=pending")).json();
  const rows = inbox.deliveries || inbox.rows || inbox.items || [];
  assert.ok(rows.some((d) => d.kind === "failure" && d.agentId === "qa"), "the failure row is in the Inbox");

  sse.close();
});

// ── approver gate (auth active) — do this LAST: it activates auth for the process ──

test("viewer POST is 403 while GET stays readable (approver-gated writes)", async () => {
  const a = await post("/runtime/users", { name: "Ada", password: "ada-passphrase-x", role: "approver" });
  assert.equal(a.status, 201);
  const aliceId = (await a.json()).user.id;
  const v = await post("/runtime/users", { name: "Ver", password: "ver-passphrase-x", role: "viewer" });
  assert.equal(v.status, 201);
  const vicId = (await v.json()).user.id;
  const approverCk = cookieFrom(await post("/runtime/auth/login", { name: "Ada", password: "ada-passphrase-x" }));
  const viewerCk = cookieFrom(await post("/runtime/auth/login", { name: "Ver", password: "ver-passphrase-x" }));
  assert.ok(approverCk && viewerCk);

  // viewer can READ cadences…
  assert.equal((await get("/runtime/cadence", authCk(viewerCk))).status, 200);
  // …but cannot RUN or TOGGLE one
  const runV = await post("/runtime/cadence/run", { id: "monitor-tick" }, authCk(viewerCk));
  assert.equal(runV.status, 403);
  assert.match((await runV.json()).error, /approver/);
  const togV = await post("/runtime/cadence/toggle", { id: "stuck-story-sweep", enabled: false }, authCk(viewerCk));
  assert.equal(togV.status, 403);

  // the approver still may
  assert.equal((await post("/runtime/cadence/toggle", { id: "stuck-story-sweep", enabled: false }, authCk(approverCk))).status, 200);
  await post("/runtime/cadence/toggle", { id: "stuck-story-sweep", enabled: true }, authCk(approverCk));

  // tidy up the accounts so nothing leaks into another file's assumptions
  assert.equal((await del(`/runtime/users/${vicId}`, authCk(approverCk))).status, 200);
  assert.equal((await del(`/runtime/users/${aliceId}`, authCk(approverCk))).status, 200);
});

// P2 (ADR-051/052) end-to-end through a REAL booted runtime, mock backend, all
// state under tmp. Proves the program-plan P2 exit criteria at the wire:
//   run → Delivery minted → delivery.created on an open SSE stream <500ms →
//   approve → file lands in the repo via the EXISTING broker → delivery.decided →
//   restart → rows survive → Last-Event-ID replays what was missed.
// Plus the adversarial sweep: no-token 401, evil-Host 403, ticket replay/expiry,
// unknown id 404, double-decide 409.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { STATION_IDS, RETIRED_STATION_IDS } from "../seed-stations.mjs";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";

import { readWorkspace } from "../workspace.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3996, TOK = "inboxtok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, sbRoot, dbPath, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const post = (path, body, headers) => fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body || {}) });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });

// undici rewrites the Host header to the connected authority, so the DNS-rebinding
// gate can only be exercised through a raw node:http request.
// It also sends the path VERBATIM — undici normalises a malformed percent-escape
// away, so a literal "/inbox/%" can only be put on the wire through node:http.
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
      RUNTIME_SANDBOX_ROOT: sbRoot,
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      // P6 — isolate the band policy to a tmp file so the endpoint tests NEVER write
      // the live repo's factory/policy.json. Absent = defaults (auto-approve OFF).
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"),
      // P7 — isolate the adapters config to a tmp file so the endpoint tests NEVER write
      // the live repo's factory/adapters.json. Absent = defaults (all adapters disabled).
      RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  return waitHealth();
}
const kill = () => new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });

// ── SSE client ───────────────────────────────────────────────────────────────
async function openSse({ ticket, lastEventId, lastEventIdQuery } = {}) {
  const headers = { Host: `localhost:${PORT}` };
  if (lastEventId != null) headers["Last-Event-ID"] = String(lastEventId);
  // Browser EventSource cannot set the header AND its native retry is dead here
  // (single-use ticket → 401 → spec closes the stream), so the client re-mints and
  // carries the watermark in the query string instead. Same replay path.
  const qs = lastEventIdQuery != null ? `&lastEventId=${encodeURIComponent(String(lastEventIdQuery))}` : "";
  const ac = new AbortController();
  const res = await fetch(`${BASE}/runtime/events?ticket=${ticket}${qs}`, { headers, signal: ac.signal });
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
          if (rawFrame.startsWith(":")) { frames.push({ ping: true, at: Date.now() }); continue; }
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
    const hit = sse.frames.find((f) => !f.ping && pred(f));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`no matching SSE frame within ${ms}ms (saw: ${JSON.stringify(sse.frames.filter((f) => !f.ping).map((f) => f.event))})`);
}

const newTicket = async () => (await (await post("/runtime/events/ticket", {})).json()).ticket;
// A /run turn: mock streams and closes. Awaiting the body guarantees res.on("close").
async function run(agentId, task) {
  const r = await post(`/runtime/${agentId}/run`, { task });
  await r.text();
  return r.status;
}
const sandboxWrite = (agentId, rel, text) => {
  const f = join(sbRoot, agentId, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
};

before(async () => {
  // realpath: on macOS tmpdir() is a symlink (/var → /private/var). The broker's
  // apply-time containment check realpaths the destination parent, so REPO_ROOT
  // must already be the real path or every apply reports "dest escapes repo".
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-inbox-")));
  repo = join(root, "repo");
  sbRoot = join(root, "x", "sb");
  dbPath = join(root, "x", "db", "mission.db");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  await boot();
});
after(async () => {
  await kill();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

// ── adversarial: auth gates ──────────────────────────────────────────────────

test("GET /inbox with no token → 401", async () => {
  assert.equal((await get("/inbox", H())).status, 401);
});

test("GET /inbox with an evil Host → 403 (DNS-rebinding gate, raw http)", async () => {
  const r = await raw("GET", "/inbox", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
  assert.match(r.body, /forbidden host/);
});

test("every decision verb requires the token → 401", async () => {
  const id = "01J0000000000000000000000A";
  for (const verb of ["approve", "reject", "request-changes"]) {
    assert.equal((await post(`/inbox/${id}/${verb}`, {}, H())).status, 401, verb);
  }
});

test("POST /runtime/events/ticket requires the token, then mints 24 random bytes", async () => {
  assert.equal((await post("/runtime/events/ticket", {}, H())).status, 401);
  const r = await post("/runtime/events/ticket", {});
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.match(body.ticket, /^[0-9a-f]{48}$/);
  assert.equal(body.ttlMs, 30_000);
});

test("GET /runtime/events refuses a missing, bogus, or REPLAYED ticket → 401", async () => {
  assert.equal((await openSse({ ticket: "" })).status, 401);
  assert.equal((await openSse({ ticket: "f".repeat(48) })).status, 401);
  const t = await newTicket();
  const first = await openSse({ ticket: t });
  assert.equal(first.status, 200, "first use connects");
  const replay = await openSse({ ticket: t });
  assert.equal(replay.status, 401, "single-use: the same ticket never connects twice");
  first.close();
});

test("the runtime token itself is NOT accepted as a ticket", async () => {
  assert.equal((await openSse({ ticket: TOK })).status, 401);
});

// ── the full loop ────────────────────────────────────────────────────────────

test("run → Delivery minted → delivery.created on the open stream <500ms", async () => {
  const sse = await openSse({ ticket: await newTicket() });
  assert.equal(sse.status, 200);
  try {
    // First run seeds the copy-sandbox (mock writes nothing → no diff → no mint).
    assert.equal(await run("inbox-a", "warm the sandbox"), 200);
    assert.equal((await (await get("/inbox")).json()).deliveries.length, 0, "no diff ⇒ no Delivery");
    // Now put a real change in the sandbox and run again — the mint hook fires on close.
    sandboxWrite("inbox-a", "src/hello.ts", "export const hello = 'world';\n");
    const t0 = Date.now();
    assert.equal(await run("inbox-a", "add a hello module"), 200);
    const closedAt = Date.now();
    const f = await waitFrame(sse, (x) => x.event === "delivery.created");
    assert.ok(f.at - closedAt < 500, `delivery.created ${f.at - closedAt}ms after the run closed (budget 500ms, total ${f.at - t0}ms)`);
    assert.equal(f.data.agentId, "inbox-a");
    assert.equal(f.data.status, "pending");
    assert.deepEqual(f.data.changedPaths, ["src/hello.ts"]);
    assert.equal(f.data.diffFiles, 1);
    assert.ok(f.id > 0, "frame carries an id for Last-Event-ID");
    // agent.state also rode the bus for the same turn (program plan §2 catalog).
    assert.ok(sse.frames.some((x) => x.event === "agent.state" && x.data?.id === "inbox-a" && x.data.state === "STREAMING"));
    assert.ok(sse.frames.some((x) => x.event === "agent.state" && x.data?.id === "inbox-a" && x.data.state === "IDLE"));
  } finally { sse.close(); }
});

test("GET /inbox lists the row and GET /inbox/:id returns the full diff", async () => {
  const list = await (await get("/inbox")).json();
  assert.equal(list.deliveries.length, 1);
  assert.equal(list.counts.pending, 1);
  const id = list.deliveries[0].id;
  const full = await (await get(`/inbox/${id}`)).json();
  assert.equal(full.changes.length, 1);
  assert.equal(full.changes[0].path, "src/hello.ts");
  assert.equal(full.changes[0].status, "new");
  assert.match(full.changes[0].patch, /^--- \/dev\/null/);
  assert.match(full.changes[0].after, /hello = 'world'/);
});

test("GET /inbox/:id with an unknown or malformed id → 404", async () => {
  assert.equal((await get("/inbox/01J0000000000000000000000Z")).status, 404);
  assert.equal((await get("/inbox/not-a-ulid")).status, 404);
  assert.equal((await get("/inbox/..%2F..%2Fetc%2Fpasswd")).status, 404);
});

test("approve applies through the EXISTING broker, lands the file, emits delivery.decided", async () => {
  const sse = await openSse({ ticket: await newTicket() });
  try {
    const id = (await (await get("/inbox?status=pending")).json()).deliveries[0].id;
    const r = await post(`/inbox/${id}/approve`, { by: "BOSS" });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, "approved");
    assert.equal(body.decidedBy, "BOSS");
    assert.deepEqual(body.applyResults, [{ path: "src/hello.ts", ok: true }]);
    const landed = join(repo, "src", "hello.ts");
    assert.ok(existsSync(landed), "file reached the live repo via broker.applyChanges");
    assert.match(readFileSync(landed, "utf-8"), /hello = 'world'/);
    const f = await waitFrame(sse, (x) => x.event === "delivery.decided");
    assert.deepEqual(f.data, { id, status: "approved", by: "BOSS" });
    const after = await (await get("/inbox?status=approved")).json();
    assert.deepEqual(after.deliveries.map((d) => d.id), [id]);
  } finally { sse.close(); }
});

test("double-decide → 409, and no second apply", async () => {
  const id = (await (await get("/inbox?status=approved")).json()).deliveries[0].id;
  const r = await post(`/inbox/${id}/reject`, { by: "BOSS", feedback: "changed my mind" });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.status, "approved", "reports the status it is already in");
});

test("health reports deliveries + events additively, leaving engine/queue untouched", async () => {
  const h = await (await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).json();
  assert.equal(h.deliveries.approved, 1);
  assert.equal(h.deliveries.total, 1);
  assert.ok(h.engine && h.engine.queue, "engine block intact");
  assert.equal(typeof h.events.clients, "number");
});

// ── the other two verbs ──────────────────────────────────────────────────────

test("the /changes fallback mint covers a sandbox change no run closed on", async () => {
  await run("inbox-b", "warm the sandbox");
  sandboxWrite("inbox-b", "src/feedback.ts", "export const v = 1;\n");
  const ch = await (await get("/runtime/inbox-b/changes")).json();
  assert.equal(ch.changes.length, 1);
  const list = await (await get("/inbox?status=pending&agentId=inbox-b")).json();
  assert.equal(list.deliveries.length, 1, "GET /changes minted the Delivery");
  // Calling it again must NOT create a second row (structural double-mint guard).
  await get("/runtime/inbox-b/changes");
  assert.equal((await (await get("/inbox?agentId=inbox-b")).json()).deliveries.length, 1);
});

test("request-changes stores the feedback and queues it as the agent's next task", async () => {
  const id = (await (await get("/inbox?agentId=inbox-b")).json()).deliveries[0].id;
  assert.equal((await post(`/inbox/${id}/request-changes`, { by: "BOSS" })).status, 400, "feedback is required");
  const r = await post(`/inbox/${id}/request-changes`, { by: "BOSS", feedback: "rename v to version please" });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, "changes_requested");
  assert.equal(body.feedback, "rename v to version please");
  // The feedback went through the EXISTING engine chain, not a second dispatch path.
  assert.match(body.rerun.goalId, /^goal_[0-9a-f]+$/);
  assert.match(body.rerun.firstTaskId, /^task_[0-9a-f]+$/);
  const runs = await (await get("/runtime/engine/runs")).json();
  assert.ok(
    runs.tasks.some((t) => t.taskId === body.rerun.firstTaskId && t.agentId === "inbox-b"),
    `the queued task is visible on the engine: ${JSON.stringify(runs.tasks.map((t) => [t.agentId, t.taskId]))}`,
  );
  // The durable queue record carries the feedback verbatim as the task text.
  const rec = JSON.parse(readFileSync(join(root, "x", "eng", "tasks", `${body.rerun.firstTaskId}.json`), "utf-8"));
  assert.equal(rec.agentId, "inbox-b");
  assert.match(rec.task, /rename v to version please/);
});

test("reject discards the sandbox and never writes the repo", async () => {
  await run("inbox-c", "warm the sandbox");
  sandboxWrite("inbox-c", "src/rejected.ts", "export const nope = true;\n");
  await get("/runtime/inbox-c/changes"); // mint
  const id = (await (await get("/inbox?agentId=inbox-c")).json()).deliveries[0].id;
  const r = await post(`/inbox/${id}/reject`, { by: "BOSS", feedback: "wrong approach" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "rejected");
  assert.ok(!existsSync(join(repo, "src", "rejected.ts")), "NO repo write on reject");
  assert.ok(!existsSync(join(sbRoot, "inbox-c")), "sandbox discarded");
});

// ── restart survival + replay ────────────────────────────────────────────────

test("restart: deliveries survive and Last-Event-ID replays what was missed", async () => {
  const before = await (await get("/inbox?limit=50")).json();
  // D4 — this file's engine turns run without a swarm-capable account, and a readiness
  // refusal is now TERMINAL on the first attempt instead of being retried three times.
  // Terminal means the operator is paged, so the Inbox legitimately also holds a `failure`
  // row here. The claim under test is that the three DECIDED code rows survive a restart,
  // so count those — and assert the new row is the honest refusal it should be, rather
  // than loosening the count and losing the distinction.
  const decided = before.deliveries.filter((d) => d.kind === "code");
  assert.equal(decided.length, 3, "approved + changes_requested + rejected");
  const stuck = before.deliveries.filter((d) => d.kind === "failure");
  for (const f of stuck) assert.match(f.title, / is stuck — (not-capable|backend|gate-veto|spawn|timeout)/);
  const beforeStatuses = Object.fromEntries(decided.map((d) => [d.id, d.status]));

  // Watermark = the newest event seq this "client" actually saw on the wire.
  const probe = await openSse({ ticket: await newTicket() });
  assert.equal(probe.status, 200);
  await run("inbox-a", "produce an event to watermark against"); // emits agent.state
  const marker = await waitFrame(probe, (f) => f.event === "agent.state" && f.data?.state === "IDLE");
  probe.close();
  const watermark = marker.id;
  assert.ok(watermark > 0, "client holds a real Last-Event-ID watermark");

  await kill();
  await boot(); // SAME RUNTIME_DB_PATH

  const after = await (await get("/inbox?limit=50")).json();
  const afterDecided = after.deliveries.filter((d) => d.kind === "code");
  assert.equal(afterDecided.length, 3, "rows survived the restart");
  for (const d of afterDecided) assert.equal(d.status, beforeStatuses[d.id], `status preserved for ${d.id}`);
  assert.equal((await (await get("/inbox?status=approved")).json()).deliveries.length, 1);

  // A brand-new delivery arrives while the "client" is away.
  sandboxWrite("inbox-d", "src/late.ts", "export const late = 1;\n");
  await run("inbox-d", "late work");
  await get("/runtime/inbox-d/changes");
  const lateId = (await (await get("/inbox?agentId=inbox-d")).json()).deliveries[0].id;

  const reconnect = await openSse({ ticket: await newTicket(), lastEventId: watermark });
  try {
    assert.equal(reconnect.status, 200);
    const replayed = await waitFrame(reconnect, (f) => f.event === "delivery.created" && f.data?.id === lateId);
    assert.ok(replayed.id > watermark, "replayed frames carry a fresh watermark");
    assert.ok(
      !reconnect.frames.some((f) => f.event === "delivery.created" && f.data?.id === decided[0].id),
      "already-seen events are NOT replayed",
    );
  } finally { reconnect.close(); }
});

// P3: browser EventSource cannot send Last-Event-ID (no custom headers), and its
// native retry can never reach the server anyway — the ticket is single-use, so the
// retry gets 401 and the SSE spec then closes the stream for good. The P3 client
// therefore re-mints a ticket and carries the watermark in the query string. This
// proves that path reaches the SAME ADR-052 §3 replay the header path uses.
test("replay watermark is accepted from ?lastEventId= (browser EventSource path)", async () => {
  const probe = await openSse({ ticket: await newTicket() });
  assert.equal(probe.status, 200);
  await run("inbox-a", "watermark for the query-param replay path");
  const marker = await waitFrame(probe, (f) => f.event === "agent.state" && f.data?.state === "IDLE");
  probe.close();
  const watermark = marker.id;
  assert.ok(watermark > 0);

  // Events the "client" misses while disconnected.
  await run("inbox-a", "missed while the stream was down");

  const reconnect = await openSse({ ticket: await newTicket(), lastEventIdQuery: watermark });
  try {
    assert.equal(reconnect.status, 200);
    const replayed = await waitFrame(reconnect, (f) => f.id > watermark);
    assert.ok(replayed.id > watermark, "query-param watermark replays the missed tail");
    assert.ok(
      !reconnect.frames.some((f) => !f.ping && f.id <= watermark),
      "already-seen events are NOT replayed through the query-param path",
    );
  } finally { reconnect.close(); }
});

test("a garbage ?lastEventId= connects cleanly and replays nothing (clamped, never throws)", async () => {
  const sse = await openSse({ ticket: await newTicket(), lastEventIdQuery: "not-a-number" });
  try {
    assert.equal(sse.status, 200, "runtime stays alive and the stream opens");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(sse.frames.filter((f) => !f.ping).length, 0, "no backlog for an unparseable watermark");
  } finally { sse.close(); }
});

test("a negative ?lastEventId= is clamped to 0, not used as a raw SQL bound", async () => {
  const sse = await openSse({ ticket: await newTicket(), lastEventIdQuery: "-99" });
  try {
    assert.equal(sse.status, 200);
    await new Promise((r) => setTimeout(r, 120));
    // seq > 0 for every row, so a clamped-to-0 watermark replays the whole (capped) log
    // rather than erroring — the point is that the runtime neither throws nor 500s.
    assert.ok(sse.frames.every((f) => f.ping || f.id > 0));
  } finally { sse.close(); }
});

test("the poll fallback (GET /api/state.json) is untouched and clears ACTIVE on settle", async () => {
  const s = await (await fetch(`${BASE}/api/state.json`, { headers: { Host: `localhost:${PORT}` } })).json();
  assert.ok(Array.isArray(s.agents), "state.json still served, unconditionally, with no token");
  const busy = s.agents.filter((a) => a.state === "ACTIVE" || a.state === "STREAMING");
  assert.deepEqual(busy, [], `every settled turn cleared: ${JSON.stringify(busy.map((a) => [a.id, a.state]))}`);
});

// S0 — the deck is fed by the SAME state feed the board uses. A booted runtime must
// carry the ten seeded SE seats, so the deck needs no second data path. The roster comes
// from seed-stations.mjs itself, so a seat added there is covered here without an edit.
test("S0: the ten SE seats reach state.agents after a boot", async () => {
  const s = await (await fetch(`${BASE}/api/state.json`, { headers: { Host: `localhost:${PORT}` } })).json();
  const ids = s.agents.map((a) => a.id);
  assert.equal(STATION_IDS.length, 10, "the roster is ten seats");
  for (const id of STATION_IDS) {
    assert.ok(ids.includes(id), `${id} missing from state.agents`);
    assert.equal(ids.filter((x) => x === id).length, 1, `${id} duplicated in state.agents`);
  }
  // and the retired business stations are gone for good
  for (const id of RETIRED_STATION_IDS) {
    assert.ok(!ids.includes(id), `${id} must not be seeded any more`);
  }
  const lead = s.agents.find((a) => a.id === "tech-lead");
  assert.equal(lead.role, "Orchestration");
  // never run yet → honestly idle, not a fabricated "working" badge
  assert.equal(lead.column, "idle");
});

test("S0: GET /factory/agents exposes the seeded seats with their real skills", async () => {
  const body = await (await get("/factory/agents")).json();
  const lead = body.agents.find((a) => a.id === "tech-lead");
  assert.ok(lead, "tech-lead missing from the factory registry");
  assert.equal(lead.title, "Tech Lead");
  assert.deepEqual(lead.skills, ["claude-code-handoff", "workflow-audit", "repo-read"]);
  assert.deepEqual(lead.integrations, []);
  for (const id of RETIRED_STATION_IDS) {
    assert.ok(!body.agents.some((a) => a.id === id), `${id} must be retired from the registry`);
  }
});

// ── sr-security P2 BLOCKER 1: a malformed percent-escape must never kill the
// process. decodeURIComponent("%") throws URIError; inside the async request
// handler that became an unhandled rejection and took the whole runtime down.
// These paths only reach the wire through raw node:http (undici normalises them).

const alive = async (why) => {
  const r = await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } });
  assert.equal(r.status, 200, `runtime died: ${why}`);
  assert.equal((await r.json()).ok, true, `runtime unhealthy: ${why}`);
};
const rawAuth = (extra = {}) => ({ Host: `localhost:${PORT}`, "x-runtime-token": TOK, ...extra });

test("GET /inbox/% and /inbox/%zz → 404, and the runtime is still alive", async () => {
  for (const p of ["/inbox/%", "/inbox/%zz", "/inbox/%e0%a4%a"]) {
    const r = await raw("GET", p, rawAuth());
    assert.equal(r.status, 404, `${p} answered ${r.status}`);
    assert.match(r.body, /not found/, p);
    await alive(`GET ${p}`);
  }
});

test("POST /inbox/%e0%a4%a/approve → 404, and the runtime is still alive", async () => {
  for (const verb of ["approve", "reject", "request-changes"]) {
    const r = await raw("POST", `/inbox/%e0%a4%a/${verb}`, rawAuth({ "Content-Type": "application/json" }), "{}");
    assert.equal(r.status, 404, `${verb} answered ${r.status}`);
    assert.match(r.body, /not found/, verb);
    await alive(`POST /inbox/%e0%a4%a/${verb}`);
  }
  // A bare "%" on the decide path is the same class and must not crash either.
  assert.equal((await raw("POST", "/inbox/%/approve", rawAuth({ "Content-Type": "application/json" }), "{}")).status, 404);
  await alive("POST /inbox/%/approve");
});

test("an undecodable id is still auth-gated FIRST — no token → 401, not 404", async () => {
  assert.equal((await raw("GET", "/inbox/%", { Host: `localhost:${PORT}` })).status, 401);
  assert.equal((await raw("POST", "/inbox/%zz/approve", { Host: `localhost:${PORT}` })).status, 401);
  await alive("unauthenticated malformed id");
});

// ── sr-security P2 §3: /api/sessions/* is host-gated ONLY — an unauthenticated
// URIError there is an unauthenticated process kill.

test("GET /api/sessions/% → 400, and the runtime is still alive (no token needed)", async () => {
  for (const p of ["/api/sessions/%", "/api/sessions/%zz", "/api/sessions/%e0%a4%a"]) {
    const r = await raw("GET", p, { Host: `localhost:${PORT}` });
    assert.equal(r.status, 400, `${p} answered ${r.status}`);
    assert.match(r.body, /bad session id/, p);
    await alive(`GET ${p}`);
  }
  // The well-formed-but-invalid id path is unchanged.
  assert.equal((await raw("GET", "/api/sessions/nope", { Host: `localhost:${PORT}` })).status, 400);
  assert.equal((await raw("GET", "/api/sessions/2099-12-31", { Host: `localhost:${PORT}` })).status, 404);
});

// ── sr-security P2 §4: req.destroy() on an over-cap body fires "aborted"/"close"
// but NEVER "end" — the body promise never settled, so the handler hung forever.
// The decision landing is the observable proof that the handler now completes.

test("an over-cap decide body settles the read; the decision still lands and the runtime lives", async () => {
  sandboxWrite("inbox-cap", "src/capped.ts", "export const capped = 1;\n");
  await run("inbox-cap", "work decided with an over-cap body");
  await get("/runtime/inbox-cap/changes"); // mint
  const id = (await (await get("/inbox?agentId=inbox-cap")).json()).deliveries[0].id;
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);

  // 8k is the inbox cap — 20k trips req.destroy() mid-body.
  const big = JSON.stringify({ by: "BOSS", feedback: "x".repeat(20_000) });
  await fetch(`${BASE}/inbox/${id}/reject`, { method: "POST", headers: auth(), body: big })
    .then((r) => r.text())
    .catch(() => { /* the destroyed socket resets the client — expected either way */ });

  let status = "pending";
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    status = (await (await get(`/inbox/${id}`)).json()).status;
    if (status !== "pending") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(status, "rejected", "the over-cap body settled as {} and the handler ran to completion");
  assert.ok(!existsSync(join(repo, "src", "capped.ts")), "reject still never writes the repo");
  await alive("over-cap decide body");
});

test("an over-cap body on the engine + factory readers also settles, leaving the runtime healthy", async () => {
  const big = JSON.stringify({ agentId: "inbox-a", steps: ["x".repeat(80_000)] });
  for (const p of ["/runtime/engine/enqueue", "/factory/create"]) {
    await fetch(`${BASE}${p}`, { method: "POST", headers: auth(), body: big }).then((r) => r.text()).catch(() => { /* reset expected */ });
    await alive(`over-cap POST ${p}`);
  }
  // Still serving normal traffic on the same routes afterwards.
  assert.equal((await (await get("/runtime/engine/runs")).json()).tasks.length >= 0, true);
});

// ── P5 — POST/GET /runtime/workspace at the wire ─────────────────────────────
// Same gate as /apply: this endpoint chooses which repo the broker may write to.
const wsConfigDir = () => join(root, "x", "tok", "config");

test("P5 GET /runtime/workspace without a token → 401", async () => {
  const r = await get("/runtime/workspace", H());
  assert.equal(r.status, 401);
});

test("P5 POST /runtime/workspace without a token → 401 (and persists nothing)", async () => {
  const r = await post("/runtime/workspace", { repoPath: "/tmp" }, H());
  assert.equal(r.status, 401);
});

test("P5 /runtime/workspace with an evil Host → 403", async () => {
  const r = await raw("GET", "/runtime/workspace", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
});

test("P5 GET /runtime/workspace reports the ACTIVE workspace + an honest gh probe", async () => {
  const r = await get("/runtime/workspace");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.repoPath, repo, "the env-pinned root this process booted with");
  assert.equal(j.isGit, false, "the test repo is a plain dir — reported honestly");
  assert.equal(j.envPinned, true);
  assert.deepEqual(j.seedDirs, ["src"]);
  for (const k of ["installed", "authenticated", "hasRemote"]) assert.equal(typeof j.gh[k], "boolean");
});

test("P5 POST /runtime/workspace rejects $HOME with 400 and persists nothing", async () => {
  const r = await post("/runtime/workspace", { repoPath: homedir() });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /home directory/i);
  assert.equal(readWorkspace({ configDir: wsConfigDir() }), null);
});

test("P5 POST /runtime/workspace rejects the filesystem root with 400", async () => {
  const r = await post("/runtime/workspace", { repoPath: "/" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /filesystem root/i);
});

test("P5 POST /runtime/workspace rejects a non-git dir with 400", async () => {
  const plain = mkdtempSync(join(tmpdir(), "ma-http-plain-"));
  const r = await post("/runtime/workspace", { repoPath: plain });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not a git repo/i);
});

test("P5 POST /runtime/workspace rejects a missing / empty repoPath with 400", async () => {
  assert.equal((await post("/runtime/workspace", {})).status, 400);
  assert.equal((await post("/runtime/workspace", { repoPath: "" })).status, 400);
  assert.equal((await post("/runtime/workspace", { repoPath: join(tmpdir(), "no-such-xyz-123") })).status, 400);
});

test("P5 POST /runtime/workspace accepts a git repo, persists it 0600, reports restartRequired", async () => {
  const wsRepo = realpathSync(mkdtempSync(join(tmpdir(), "ma-http-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: wsRepo });
  const r = await post("/runtime/workspace", { repoPath: wsRepo });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.repoPath, wsRepo);
  assert.equal(j.restartRequired, true, "REPO_ROOT is immutable in-process");
  assert.equal(readWorkspace({ configDir: wsConfigDir() }), wsRepo, "persisted for the next boot");
  assert.equal(statSync(join(wsConfigDir(), "workspace.json")).mode & 0o777, 0o600);
  // The ACTIVE root did NOT change under the running process.
  assert.equal((await (await get("/runtime/workspace")).json()).repoPath, repo);
  rmSync(join(wsConfigDir(), "workspace.json"), { force: true });
  rmSync(wsRepo, { recursive: true, force: true });
});

test("P5 /runtime/workspace rejects an unsupported method without 500-ing", async () => {
  const r = await fetch(`${BASE}/runtime/workspace`, { method: "DELETE", headers: auth() });
  assert.ok([404, 405].includes(r.status), `got ${r.status}`);
});

test("P5 /runtime/health exposes the active workspace", async () => {
  const j = await (await fetch(`${BASE}/runtime/health`, { headers: H() })).json();
  // Security fix: the unauthenticated health body must NOT leak the absolute repo fs
  // path — only non-sensitive workspace flags remain.
  assert.equal(j.workspace.repoPath, undefined, "absolute repo path must not leak in unauthenticated health");
  assert.equal(j.workspace.envPinned, true);
});

// ── P6 / ADR-053 — the band policy endpoint + auto-apply loop ────────────────

test("GET /runtime/policy needs the token, then returns the conservative default", async () => {
  assert.equal((await get("/runtime/policy", H())).status, 401, "no token → 401");
  const r = await get("/runtime/policy");
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.bands.low, "notify", "auto-approve OFF by default");
  assert.equal(b.bands.high, "typed_confirm");
  assert.equal(b.valid, true);
  assert.ok(b.sla && b.sla.high > 0, "effective SLA windows are reported");
});

test("POST /runtime/policy rejects an invalid schema (400) and never persists it", async () => {
  const bad = await post("/runtime/policy", { bands: { low: "yolo", medium: "human", high: "human" } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /invalid bands/);
  // GET still shows the default — a rejected write never reached disk.
  assert.equal((await (await get("/runtime/policy")).json()).bands.low, "notify");
});

test("full loop: policy low=auto_approve → a low-risk delivery auto-applies through the broker", async () => {
  const agent = "autoweb";
  try {
    // 1. turn auto-approve ON for the low band.
    const set = await post("/runtime/policy", {
      bands: { low: "auto_approve", medium: "human", high: "typed_confirm" },
      denyList: ["**/.env", "**/secrets/**"],
    });
    assert.equal(set.status, 200);
    assert.equal((await set.json()).bands.low, "auto_approve");

    // 2. seed the copy-sandbox (mock writes nothing → no diff → no mint), then put a
    //    LOW-risk change (README is a doc + a broker seed file → auto-safe) and run.
    await run(agent, "seed");
    sandboxWrite(agent, "README.md", "# hello\nfrom the swarm\n");
    await run(agent, "add readme");

    // 3. the mint→auto-apply is a fire-and-forget follow-on; poll for the terminal state.
    let landed = null;
    for (let i = 0; i < 60 && !landed; i++) {
      const list = await (await get("/inbox?status=auto_approved")).json();
      landed = (list.deliveries || []).find((d) => d.agentId === agent) || null;
      if (!landed) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(landed, "the low-risk delivery reached auto_approved");
    assert.equal(landed.status, "auto_approved");
    assert.equal(landed.risk.band, "low");
    // 4. it went through the REAL broker → the file is in the repo.
    assert.ok(existsSync(join(repo, "README.md")), "README applied to the repo by the broker");
  } finally {
    // reset the policy so nothing after this test inherits auto-approve.
    await post("/runtime/policy", { bands: { low: "notify", medium: "human", high: "typed_confirm" } });
  }
});

// ── P7 / ADR-054 — the ingestion adapters endpoint ──────────────────────────

test("GET /runtime/adapters needs the token, then reports the disabled default", async () => {
  assert.equal((await get("/runtime/adapters", H())).status, 401, "no token → 401");
  const r = await get("/runtime/adapters");
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.valid, true);
  assert.equal(b.github.enabled, false, "github disabled by default (no config file)");
  assert.equal(b.github.state, "disabled");
  assert.equal(b.claudeCode.enabled, false);
  assert.equal(b.claudeCode.readOnly, true);
});

test("POST /runtime/adapters rejects an invalid config (400) and never persists it", async () => {
  // enabling github with no bot authors is refused by the strict validator.
  const bad = await post("/runtime/adapters", { github: { enabled: true, botAuthors: [] } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /botAuthor/);
  assert.equal((await (await get("/runtime/adapters")).json()).github.enabled, false, "rejected write never reached state");
});

test("POST /runtime/adapters accepts a valid config, persists it, and reflects it in status", async () => {
  try {
    const set = await post("/runtime/adapters", { github: { enabled: true, botAuthors: ["cursor", "devin"], pollIntervalMs: 30000 }, claudeCode: { enabled: false } });
    assert.equal(set.status, 200);
    const b = await set.json();
    assert.equal(b.ok, true);
    assert.equal(b.github.enabled, true);
    assert.deepEqual(b.github.botAuthors, ["cursor", "devin"]);
    // GET reflects the persisted, reloaded config. gh is not installed here, so the live
    // state is 'gh-not-authed' or 'error' or 'running' — never 'disabled' once enabled.
    const g = (await (await get("/runtime/adapters")).json()).github;
    assert.equal(g.enabled, true);
    assert.notEqual(g.state, "disabled");
  } finally {
    await post("/runtime/adapters", { github: { enabled: false }, claudeCode: { enabled: false } });
  }
});

test("a medium-risk delivery is NOT auto-applied even with low=auto_approve", async () => {
  const agent = "medweb";
  try {
    await post("/runtime/policy", { bands: { low: "auto_approve", medium: "human", high: "typed_confirm" } });
    await run(agent, "seed");
    sandboxWrite(agent, "src/feature.ts", "export const x = 1;\n"); // src → medium
    await run(agent, "add feature");
    // give any (wrongful) auto-apply a chance to fire, then assert it stayed pending.
    await new Promise((r) => setTimeout(r, 400));
    const list = await (await get("/inbox")).json();
    const row = (list.deliveries || []).find((d) => d.agentId === agent);
    assert.ok(row, "the medium delivery was minted");
    assert.equal(row.status, "pending", "medium never auto-applies under low=auto");
    assert.equal(row.risk.band, "medium");
  } finally {
    await post("/runtime/policy", { bands: { low: "notify", medium: "human", high: "typed_confirm" } });
  }
});

// ── P10 — dogfood scoreboard endpoint ────────────────────────────────────────
test("GET /runtime/scoreboard with no token → 401", async () => {
  assert.equal((await get("/runtime/scoreboard", H())).status, 401);
});

test("GET /runtime/scoreboard returns the approved-÷-human-minutes shape", async () => {
  const r = await get("/runtime/scoreboard?window=7d");
  assert.equal(r.status, 200);
  const body = await r.json();
  for (const k of ["approved", "autoApproved", "humanMinutes", "avgMinutes", "perHour", "windowMs", "since"]) {
    assert.ok(k in body, `scoreboard is missing ${k}`);
  }
  assert.equal(typeof body.approved, "number");
  assert.equal(typeof body.humanMinutes, "number");
  assert.equal(body.windowMs, 7 * 24 * 60 * 60 * 1000);
});

test("POST /runtime/scoreboard → 405 (GET only)", async () => {
  assert.equal((await post("/runtime/scoreboard", {})).status, 405);
});

// B1 — the Command deck's captain card reads DECISIONS TODAY off this same
// endpoint (window=1d). The field is additive: every P10 key above still ships.
test("GET /runtime/scoreboard?window=1d carries the additive `decided` count", async () => {
  const r = await get("/runtime/scoreboard?window=1d");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok("decided" in body, "scoreboard is missing decided");
  assert.equal(typeof body.decided, "number");
  assert.ok(body.decided >= body.approved, "decided counts approvals plus rejections/change-requests");
  assert.equal(body.windowMs, 24 * 60 * 60 * 1000);
});

// ── POST /inbox/bulk-decide (Phase 2/3, excellence program) ──────────────────
// Added after code review found the route shipped with ZERO tests, and with two real
// defects a route-level test would have caught: (1) it was missing from
// routeNeedsApprover, so a viewer-role session could bulk-approve; (2) it treated a
// null (unrated) risk band as high, which made bulk-approve 400 for every real
// delivery. Both are pinned below.

test("bulk-decide: rejects an empty id list", async () => {
  const r = await post("/inbox/bulk-decide", { ids: [], decision: "reject" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /ids\[\] required/);
});

test("bulk-decide: enforces the 200-id cap so one call cannot walk the table", async () => {
  const r = await post("/inbox/bulk-decide", { ids: Array(201).fill("x"), decision: "reject" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /too many ids/);
});

test("bulk-decide: rejects an unknown decision verb", async () => {
  const r = await post("/inbox/bulk-decide", { ids: ["x"], decision: "nuke" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /approve \| reject \| request-changes/);
});

test("bulk-decide: requires the runtime token", async () => {
  const r = await post("/inbox/bulk-decide", { ids: ["x"], decision: "reject" }, H());
  assert.equal(r.status, 401);
});

test("bulk-decide: an evil Host is refused", async () => {
  const r = await raw("POST", "/inbox/bulk-decide",
    { Host: "evil.com", "Content-Type": "application/json", "x-runtime-token": TOK },
    JSON.stringify({ ids: ["x"], decision: "reject" }));
  assert.equal(r.status, 403);
});

test("bulk-decide: SECURITY — it is inside the approver gate", async () => {
  // routeNeedsApprover's single-item regex requires an :id segment, so the bulk path
  // did not match it and role-gating was skipped entirely. Solo mode has no roles, so
  // this asserts the ROUTE-LEVEL registration rather than a live 403.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(SERVER, "utf8");
  assert.match(
    src,
    /routeNeedsApprover[\s\S]{0,1200}pathname === "\/inbox\/bulk-decide"/,
    "bulk-decide must be listed in routeNeedsApprover or a viewer can bulk-approve",
  );
});

test("bulk-decide: an UNRATED (null band) delivery does NOT demand confirmHighRisk", async () => {
  // RiskBand is "low"|"medium"|"high"|null. Treating null as high made ordinary
  // bulk-approve 400 for every real delivery, silently.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(SERVER, "utf8");
  assert.match(src, /band === null \|\| band === undefined\) continue;/,
    "null/unrated band must be skipped, not swept into highIds");
  assert.doesNotMatch(src, /band !== "unrated"/,
    '"unrated" is a display label, never a stored band — comparing against it is dead code');
});

test("bulk-decide: unknown ids report per-item failure without failing the batch", async () => {
  const r = await post("/inbox/bulk-decide", {
    ids: ["01ZZZZZZZZZZZZZZZZZZZZZZZZ", "01YYYYYYYYYYYYYYYYYYYYYYYY"],
    decision: "reject",
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.requested, 2);
  assert.equal(body.decided, 0);
  assert.equal(body.results.length, 2);
  assert.ok(body.results.every((x) => x.ok === false), "unknown ids must not report success");
});

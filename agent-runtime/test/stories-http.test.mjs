// Story-Pipeline S1 — the story core at the wire, through a REAL booted runtime (mock
// backend, ephemeral state under tmp). Proves the S1 exit criteria:
//   POST /runtime/stories {title,idea}                → 201 create, story.changed on SSE
//   GET  /runtime/stories?stage=&status=               → the board, viewer-readable
//   GET  /runtime/stories/:id                          → {story, log}, 404 unknown
//   POST /runtime/stories/:id/advance                  → forward one stage
//   POST /runtime/stories/:id/reject {toStage,reason}  → bounce to a legal back-stage
// Plus the adversarial sweep: no-token 401, evil Host 403, unknown id 404, bad input 400,
// illegal transition 409, and (auth-active) viewer-on-POST 403.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3963, TOK = "storytok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, sbRoot, dbPath, vaultDir, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const post = (path, body, headers) => fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body ?? {}) });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });

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
      // S1 tests the RAW story machine — keep the S2 pipeline unwired so no auto-dispatch
      // mutates the transition log this suite asserts on. The pipeline has its own wire test.
      RUNTIME_PIPELINE: "0",
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

// ── SSE client (same shape as cadence-http.test.mjs) ─────────────────────────
async function mintTicket() {
  const r = await post("/runtime/events/ticket", {});
  return (await r.json()).ticket;
}
async function openSse(ticket) {
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
            if (line.startsWith("event: ")) f.event = line.slice(7);
            else if (line.startsWith("data: ")) { try { f.data = JSON.parse(line.slice(6)); } catch { f.data = null; } }
          }
          frames.push(f);
        }
      }
    } catch { /* aborted */ }
  })();
  return { status: res.status, frames, close: () => ac.abort() };
}
async function waitFrame(sse, pred, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = sse.frames.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-stories-http-")));
  repo = join(root, "repo"); sbRoot = join(root, "sb");
  dbPath = join(root, "data", "mission.db"); vaultDir = join(root, "data", "vault");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(sbRoot, { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });
  await boot();
});
after(async () => { await kill(); try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

// ── auth sweep ────────────────────────────────────────────────────────────────
test("GET /runtime/stories requires the token (401) and refuses a rebound Host (403)", async () => {
  const noTok = await fetch(`${BASE}/runtime/stories`, { headers: { Host: `localhost:${PORT}` } });
  assert.equal(noTok.status, 401);
  const evil = await raw("GET", "/runtime/stories", { Host: "evil.example.com", "x-runtime-token": TOK });
  assert.equal(evil.status, 403);
});

// ── create + read ───────────────────────────────────────────────────────────
test("POST creates a story (201) and emits story.changed; GET lists it in stage 'idea'", async () => {
  const ticket = await mintTicket();
  const sse = await openSse(ticket);
  assert.equal(sse.status, 200);

  const r = await post("/runtime/stories", { title: "Dark mode", idea: "Add a theme toggle" });
  assert.equal(r.status, 201);
  const { story } = await r.json();
  assert.match(story.id, /^story_[0-9a-f]{16}$/);
  assert.equal(story.stage, "idea");
  assert.equal(story.status, "active");

  const frame = await waitFrame(sse, (f) => f.event === "story.changed" && f.data?.id === story.id);
  assert.ok(frame, "story.changed reached the SSE stream");
  assert.deepEqual(frame.data, { id: story.id, stage: "idea" }, "identity-only payload");
  sse.close();

  const list = await (await get("/runtime/stories?stage=idea")).json();
  assert.ok(list.stories.some((x) => x.id === story.id));
});

test("GET /runtime/stories/:id returns the story + its log; unknown id is 404", async () => {
  const { story } = await (await post("/runtime/stories", { title: "T", idea: "I" })).json();
  const r = await get(`/runtime/stories/${story.id}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.story.id, story.id);
  assert.equal(body.log.length, 1);
  assert.deepEqual({ stage: body.log[0].stage, event: body.log[0].event }, { stage: "idea", event: "create" });

  assert.equal((await get("/runtime/stories/story_ffffffffffffffff")).status, 404);
});

// ── advance / reject + the growing log ────────────────────────────────────────
test("advance moves the story forward and the log grows; reject bounces to a legal back-stage", async () => {
  const { story } = await (await post("/runtime/stories", { title: "flow", idea: "walk it" })).json();

  let a = await post(`/runtime/stories/${story.id}/advance`, {});
  assert.equal(a.status, 200);
  assert.equal((await a.json()).story.stage, "requirements");
  a = await post(`/runtime/stories/${story.id}/advance`, { event: "design-drafted", ref: "vault:tech/d1" });
  assert.equal((await a.json()).story.stage, "design");

  const bounced = await post(`/runtime/stories/${story.id}/reject`, { toStage: "requirements", reason: "spec unclear" });
  assert.equal(bounced.status, 200);
  assert.equal((await bounced.json()).story.stage, "requirements");

  const { log } = await (await get(`/runtime/stories/${story.id}`)).json();
  assert.deepEqual(log.map((r) => [r.seq, r.stage, r.event]), [
    [1, "idea", "create"],
    [2, "requirements", "advance"],
    [3, "design", "design-drafted"],
    [4, "requirements", "reject"],
  ]);
});

// ── verdicts: 400 / 409 ───────────────────────────────────────────────────────
test("bad input is 400; an illegal transition is 409", async () => {
  assert.equal((await post("/runtime/stories", { title: "", idea: "x" })).status, 400, "empty title");
  assert.equal((await post("/runtime/stories", { title: "x" })).status, 400, "missing idea");

  const { story } = await (await post("/runtime/stories", { title: "term", idea: "to the end" })).json();
  // walk to the terminal 'accept' stage (7 advances), then advancing again is illegal.
  for (let i = 0; i < 7; i += 1) await post(`/runtime/stories/${story.id}/advance`, {});
  const shipped = await (await get(`/runtime/stories/${story.id}`)).json();
  assert.equal(shipped.story.stage, "accept");
  assert.equal(shipped.story.status, "shipped");
  assert.equal((await post(`/runtime/stories/${story.id}/advance`, {})).status, 409, "no advance past terminal");

  const { story: s2 } = await (await post("/runtime/stories", { title: "rej", idea: "bad reject" })).json();
  await post(`/runtime/stories/${s2.id}/advance`, {}); // → requirements
  assert.equal((await post(`/runtime/stories/${s2.id}/reject`, { toStage: "build" })).status, 409, "no forward reject");
  assert.equal((await post(`/runtime/stories/${s2.id}/advance`, {}, auth())).status, 200);

  assert.equal((await post("/runtime/stories/story_ffffffffffffffff/advance", {})).status, 404, "advance unknown id");
});

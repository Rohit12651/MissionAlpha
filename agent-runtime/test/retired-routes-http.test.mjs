// S0 / story pipeline — the RETIRED business surfaces at the wire, through a REAL booted
// runtime (mock backend, ephemeral state under tmp).
//
// This file REPLACES test/leads-http.test.mjs and test/content-http.test.mjs. Their
// contract was "these routes exist and behave". The new contract is "these routes do not
// exist", and that is worth asserting rather than silently dropping: a re-introduced
// /runtime/leads or /runtime/content route — by a bad merge, a revert, or a stale build —
// turns this file red instead of quietly resurrecting the business layer.
//
// What is proven here:
//   • every former leads/content path 404s on GET and POST, with a token and without
//   • the runtime still boots and serves its real routes (health + a live read), so a
//     404 here means "route gone", not "server broken"
//   • `lead.moved` / `content.changed` stay RESERVED in the closed SSE catalog (disclosed
//     decision: removing wire-contract names is riskier than leaving them dormant) — the
//     catalog is asserted in test/events.test.mjs; nothing emits them any more.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3983, TOK = "retiredtok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, sbRoot, dbPath, vaultDir, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const post = (path, body, headers) => fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body ?? {}) });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });

function raw(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = ""; res.on("data", (c) => { out += c; }); res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject); req.end(body);
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
      RUNTIME_DB_PATH: dbPath, RUNTIME_VAULT_DIR: vaultDir, RUNTIME_SANDBOX_ROOT: sbRoot,
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"), RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  return waitHealth();
}
const kill = () => new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });


before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-retiredhttp-")));
  repo = join(root, "repo");
  sbRoot = join(root, "x", "sb");
  dbPath = join(root, "x", "db", "mission.db");
  vaultDir = join(root, "x", "db", "vault");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  await boot();
});
after(async () => { await kill(); try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

// The former B6 surface, in full. Every one of these answered 200/201/400/403 before S0.
const RETIRED_PATHS = [
  "/runtime/leads",
  "/runtime/leads/move",
  "/runtime/leads/abc123/draft",
  "/runtime/leads/abc123/note",
  "/runtime/content",
  "/runtime/content/abc123/status",
  "/runtime/content/abc123/update",
  "/runtime/content/abc123/approve",
];

// ── the runtime is genuinely up (so a 404 below means "gone", not "dead") ─────
test("control: the booted runtime still serves its real routes", async () => {
  assert.equal((await fetch(`${BASE}/runtime/health`, { headers: H() })).status, 200);
  const r = await get("/runtime/vault/stats");
  assert.equal(r.status, 200, "a shipped viewer read still answers");
});

// ── the retired routes are GONE ──────────────────────────────────────────────
test("every retired leads/content path 404s on GET (authed)", async () => {
  for (const p of RETIRED_PATHS) {
    assert.equal((await get(p)).status, 404, `GET ${p} must be gone`);
  }
});

test("every retired leads/content path 404s on POST (authed)", async () => {
  for (const p of RETIRED_PATHS) {
    assert.equal((await post(p, { venture: "waahyu", name: "x", title: "x" })).status, 404, `POST ${p} must be gone`);
  }
});

test("a retired path is not silently re-gated: unauthenticated it 404s too, never 401", async () => {
  // The auth allow-list no longer names them, so they never reach the token gate — an
  // absent route must not look like a protected one.
  for (const p of RETIRED_PATHS) {
    const g = await get(p, H());
    assert.equal(g.status, 404, `unauthed GET ${p}`);
    const o = await post(p, {}, H());
    assert.equal(o.status, 404, `unauthed POST ${p}`);
  }
});

test("the DNS-rebinding host gate still fronts the runtime (retired path, raw http)", async () => {
  const r = await raw("GET", "/runtime/leads", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
  assert.match(r.body, /forbidden host/);
});

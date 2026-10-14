// MUNDER-ADOPTION A2 — the breaker route at the wire, through a REAL booted runtime
// (mock backend, all state under tmp). Pins: the route joins the SAME auth gate as
// /runtime/doctor (401 bare, 403 evil Host), is GET-only (405), and serves the ladder
// snapshot shape the StatusStrip chip and the drawer read.
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
const PORT = 3981, TOK = "breakertok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, child;
const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });

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

async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    try { const r = await get("/runtime/health", H()); if (r.status) return; } catch { /* boot race */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("runtime never came up");
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-breaker-")));
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "mock", RUNTIME_TOOLS: "write",
      RUNTIME_REPO_ROOT: repo, RUNTIME_SEED_DIRS: "src",
      RUNTIME_DB_PATH: join(root, "x", "db", "mission.db"),
      RUNTIME_SANDBOX_ROOT: join(root, "x", "sb"),
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"),
      RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      RUNTIME_WORKER_CAP_FILE: join(root, "x", "worker-caps.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  await waitHealth();
});
after(async () => {
  await new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

test("GET /runtime/breaker with no token → 401 (joins the doctor's gate)", async () => {
  assert.equal((await get("/runtime/breaker", H())).status, 401);
});

test("GET /runtime/breaker with an evil Host → 403 (DNS-rebinding gate)", async () => {
  const r = await raw("GET", "/runtime/breaker", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
});

test("GET /runtime/breaker serves the snapshot shape; a fresh boot is all-healthy/empty", async () => {
  const r = await get("/runtime/breaker");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.capId, "breaker");
  assert.equal(typeof body.hardStop, "boolean");
  assert.equal(body.hardStop, false); // default posture: the ladder caps at constrained
  assert.ok(Array.isArray(body.agents));
});

test("POST /runtime/breaker → 405 (read-only surface; no write path exists)", async () => {
  const r = await raw("POST", "/runtime/breaker", auth());
  assert.equal(r.status, 405);
});

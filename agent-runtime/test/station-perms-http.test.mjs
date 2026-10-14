// CC-Primitives P1 — per-station INTERACTIVE permission mode at the wire, through a REAL
// booted runtime (mock backend, ephemeral state under tmp). Proves:
//   token required (401) → evil Host 403 → GET default effective == global → PUT sets an
//   override, GET reflects it, and it lands in the isolated JSON file → invalid mode 400
//   (nothing persisted) → wrong method 405.
// The approver gate on PUT reuses the SAME routeNeedsApprover mechanism proven by the
// vault/engine mutation tests; this file covers the endpoint contract + validation.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3969, TOK = "permtok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, dbPath, permsFile, child;
const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });
const put = (path, body, headers) => fetch(`${BASE}${path}`, { method: "PUT", headers: headers ?? auth(), body: JSON.stringify(body ?? {}) });

function raw(method, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = ""; res.on("data", (c) => { out += c; }); res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject); req.end();
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

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-perm-http-")));
  repo = join(root, "repo");
  dbPath = join(root, "data", "mission.db");
  permsFile = join(root, "x", "station-perms.json");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "mock", RUNTIME_TOOLS: "write",
      RUNTIME_REPO_ROOT: repo, RUNTIME_SEED_DIRS: "src",
      RUNTIME_DB_PATH: dbPath, RUNTIME_VAULT_DIR: join(root, "vault"), RUNTIME_SANDBOX_ROOT: join(root, "sb"),
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "", RUNTIME_PERM_MODE: "acceptEdits",
      RUNTIME_STATION_PERMS_FILE: permsFile,
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"),
      RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  await waitHealth();
});
after(async () => {
  await new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });
  if (root) rmSync(root, { recursive: true, force: true });
});

test("no token → 401", async () => {
  const r = await get("/runtime/sr-backend/perm-mode", H());
  assert.equal(r.status, 401);
});

test("evil Host → 403 (anti-DNS-rebinding)", async () => {
  const r = await raw("GET", "/runtime/sr-backend/perm-mode", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
});

test("GET with no override → effective equals the global default", async () => {
  const r = await get("/runtime/sr-backend/perm-mode");
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.permMode, null);
  assert.equal(b.global, "acceptEdits");
  assert.equal(b.effective, "acceptEdits");
});

test("PUT sets an override, GET reflects it, and it lands in the isolated file", async () => {
  const r = await put("/runtime/sr-backend/perm-mode", { permissionMode: "default" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).permMode, "default");
  const g = await (await get("/runtime/sr-backend/perm-mode")).json();
  assert.equal(g.permMode, "default");
  assert.equal(g.effective, "default");
  assert.ok(existsSync(permsFile));
  assert.equal(JSON.parse(readFileSync(permsFile, "utf8"))["sr-backend"], "default");
});

test("PUT invalid mode → 400, nothing persisted for that station", async () => {
  const r = await put("/runtime/qa-station/perm-mode", { permissionMode: "plan" });
  assert.equal(r.status, 400);
  const g = await (await get("/runtime/qa-station/perm-mode")).json();
  assert.equal(g.permMode, null);
});

test("wrong method → 405", async () => {
  const r = await fetch(`${BASE}/runtime/sr-backend/perm-mode`, { method: "DELETE", headers: auth() });
  assert.equal(r.status, 405);
});

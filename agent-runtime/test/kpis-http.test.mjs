// B5 / Command Center — GET /runtime/bos/kpis at the wire, through a REAL booted
// runtime (mock backend, ephemeral state under tmp). Proves the B5 endpoint contract:
//   viewer-readable read → honest zeros on an empty DB (never a
//   fake 0) → a written vault record moves recordsWritten, venture-scoped → a malformed
//   window is a 400 (not a silent default) → wrong method 405.
// Plus the adversarial sweep: no-token 401, evil Host 403.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3993, TOK = "kpistok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, sbRoot, dbPath, vaultDir, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });
const post = (path, body, headers) => fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body ?? {}) });

// undici rewrites Host to the connected authority, so the anti-rebinding gate can only
// be exercised through a raw node:http request.
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

async function waitHealth(ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server not healthy");
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-kpis-http-")));
  repo = join(root, "repo");
  sbRoot = join(root, "sb");
  dbPath = join(root, "data", "mission.db");
  vaultDir = join(root, "vault");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
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

// ── auth ─────────────────────────────────────────────────────────────────────
test("no token → 401", async () => {
  const r = await get("/runtime/bos/kpis", H()); // Host ok, token missing
  assert.equal(r.status, 401);
});

test("evil Host → 403 (anti-DNS-rebinding), before any KPI is computed", async () => {
  const r = await raw("GET", "/runtime/bos/kpis", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
});

// ── empty DB → honest zeros ───────────────────────────────────────────────────
test("viewer-readable: empty DB returns zeros, crossVenture labeled", async () => {
  const r = await get("/runtime/bos/kpis");
  assert.equal(r.status, 200);
  const k = await r.json();
  assert.equal(k.decisionsToday, 0);
  assert.equal(k.deliveriesApproved, 0);
  assert.equal(k.recordsWritten, 0);
  assert.equal(k.pendingDeliveries, 0);
  assert.equal(k.openFollowUps, undefined, "S0 — the leads-sourced metric is REMOVED from the payload");
  assert.equal(k.crossVenture, true);
  // migration v9 seeds the `waahyu` venture; it lists even with no records.
  assert.ok(Array.isArray(k.ventures));
  assert.ok(k.ventures.some((v) => v.id === "waahyu" && v.records === 0 && v.pending === 0));
});

// ── window validation ─────────────────────────────────────────────────────────
test("a malformed window is a 400, not a silent default", async () => {
  assert.equal((await get("/runtime/bos/kpis?window=nope")).status, 400);
  assert.equal((await get("/runtime/bos/kpis?window=5x")).status, 400);
  assert.equal((await get("/runtime/bos/kpis?window=1d")).status, 200);
  assert.equal((await get("/runtime/bos/kpis?window=24h")).status, 200);
});

test("no window param is fine (7d default)", async () => {
  const r = await get("/runtime/bos/kpis");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).windowMs, 7 * 24 * 60 * 60 * 1000);
});

// ── venture-scoped recordsWritten ─────────────────────────────────────────────
test("a written vault record moves recordsWritten, and the venture scope filters it", async () => {
  const w = await post("/runtime/vault/record", { venture: "waahyu", node: "tech", title: "kpi probe", body: "b" });
  assert.equal(w.status, 201);

  const all = await (await get("/runtime/bos/kpis")).json();
  assert.ok(all.recordsWritten >= 1, "the fresh record counts in the default window");

  const scoped = await (await get("/runtime/bos/kpis?venture=waahyu")).json();
  assert.ok(scoped.recordsWritten >= 1, "and it counts under its own venture scope");

  // A valid but non-existent venture scopes to zero — honest, not the aggregate.
  const other = await (await get("/runtime/bos/kpis?venture=doesnotexist")).json();
  assert.equal(other.recordsWritten, 0);
});

// ── method ─────────────────────────────────────────────────────────────────────
test("POST /runtime/bos/kpis → 405 (read-only)", async () => {
  const r = await post("/runtime/bos/kpis", {});
  assert.equal(r.status, 405);
});

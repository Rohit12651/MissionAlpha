// PHASE 2 TASK 2.1 — GET /runtime/engine/readiness at the wire, through a REAL booted
// runtime. The pure logic is pinned in engine-readiness.test.mjs; what this file proves is
// the part that has bitten this project twice — that the route is actually REACHABLE.
//
// Both prior wiring gaps looked exactly like a working feature: the accounts PATCH existed
// but `needsAuth` 405'd it, and bulk-decide existed but sat outside `routeNeedsApprover`.
// A handler nobody can call is not a feature, so the auth-gate line and the handler are
// tested together here, plus the adversarial sweep (no token → 401, evil Host → 403).

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
const PORT = 3981, TOK = "readytok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });
const post = (path, body, headers) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body ?? {}) });

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
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-ready-http-")));
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "mock", RUNTIME_TOOLS: "write",
      RUNTIME_REPO_ROOT: repo, RUNTIME_SEED_DIRS: "src",
      RUNTIME_DB_PATH: join(root, "data", "mission.db"),
      RUNTIME_VAULT_DIR: join(root, "vault"), RUNTIME_SANDBOX_ROOT: join(root, "sb"),
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"),
      RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"),
      RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
      RUNTIME_CRED_DIR: join(root, "x", "cred"),
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
  assert.equal((await get("/runtime/engine/readiness", H())).status, 401);
});

test("evil Host → 403 before any account metadata is read", async () => {
  const r = await raw("GET", "/runtime/engine/readiness", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
});

test("wrong method → 405", async () => {
  assert.equal((await post("/runtime/engine/readiness", {})).status, 405);
});

test("THE ROUTE IS REACHABLE — with no accounts it reports not-ready and says why", async () => {
  const r = await get("/runtime/engine/readiness");
  assert.equal(r.status, 200, "a handler behind a closed auth gate is not a feature");
  const body = await r.json();
  assert.equal(body.ready, false);
  assert.equal(body.standing, "none");
  assert.equal(body.account, null);
  assert.match(body.refusal, /no account is active/i);
});

test("an ACTIVE unprobed account reads as unmeasured, with a probe path to fix it", async () => {
  const added = await post("/runtime/accounts", {
    providerType: "custom", label: "nim", authMethod: "api_key",
    secret: "sk-test-not-a-real-key", baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    model: "nemotron",
  });
  assert.equal(added.status, 200, await added.clone().text());
  const { account } = await added.json();
  assert.equal((await post("/runtime/accounts/active", { accountId: account.id })).status, 200);

  const body = await (await get("/runtime/engine/readiness")).json();
  assert.equal(body.ready, false);
  assert.equal(body.standing, "unmeasured");
  assert.equal(body.account.label, "nim");
  assert.equal(body.probePath, `/runtime/accounts/${account.id}/probe`);
  // The spend cap must be honest BEFORE any probe has run.
  assert.match(body.spendCap, /not measured/i);
});

test("the payload carries NO secret — metadata only", async () => {
  const text = await (await get("/runtime/engine/readiness")).text();
  assert.doesNotMatch(text, /sk-test-not-a-real-key/);
  assert.doesNotMatch(text, /hasSecret/);
});

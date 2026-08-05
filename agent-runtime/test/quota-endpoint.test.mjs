// GET /quota — HTTP integration against a real booted server (mock backend, temp
// dirs). Verifies the endpoint is auth-gated (401 without token) and returns the
// quota-guard status shape. Read-only; no write path.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { makeThrowawayRepo, isolatedRuntimeEnv } from "./fixtures/throwaway-repo.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3974;
const TOKEN = "quotatok";
const BASE = `http://127.0.0.1:${PORT}`;
let root, child;

const H = (extra = {}) => ({ Host: `localhost:${PORT}`, ...extra });
const authed = (extra = {}) => H({ "x-runtime-token": TOKEN, ...extra });

async function waitHealth(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/runtime/health`, { headers: H() });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "ma-quota-ep-"));
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOKEN, RUNTIME_BACKEND: "mock",
      RUNTIME_THREADS_DIR: join(root, "threads"), RUNTIME_TOKEN_DIR: join(root, "tok"),
      RUNTIME_ENGINE_STORE: join(root, "eng"), RUNTIME_WORKTREE_ROOT: join(root, "wt"),
      // Throwaway target: with no RUNTIME_REPO_ROOT the server defaults REPO_ROOT to
      // the LIVE MissionAlpha checkout and any worktree it creates registers there.
      ...isolatedRuntimeEnv(root, makeThrowawayRepo(root)),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"), // P2: keep the real agent-runtime/data/ clean
      MA_QUOTA_MAX: "200", ANTHROPIC_API_KEY: "",
    },
    stdio: "ignore",
  });
  await waitHealth();
});

after(() => {
  try { child?.kill("SIGKILL"); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

test("GET /quota requires the token (401 without)", async () => {
  const r = await fetch(`${BASE}/runtime/quota`, { headers: H() });
  assert.equal(r.status, 401);
});

test("GET /quota returns the status shape when authed", async () => {
  const r = await fetch(`${BASE}/runtime/quota`, { headers: authed() });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(typeof body.count, "number");
  assert.equal(body.max, 200);
  assert.equal(typeof body.windowMs, "number");
  assert.equal(typeof body.paused, "boolean");
  assert.equal(body.paused, false, "fresh boot → not paused");
});

test("POST /quota is rejected (405, read-only)", async () => {
  const r = await fetch(`${BASE}/runtime/quota`, { method: "POST", headers: authed() });
  assert.equal(r.status, 405);
});

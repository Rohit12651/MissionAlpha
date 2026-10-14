// P1-F1 — POST /runtime/:agentId/stop. Boots a REAL server on an alternate port with the
// mock backend (free, deterministic). Proves: token+host gate, kill of a live mock stream,
// interrupted marker on the saved thread, and 404 when nothing is running.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { makeThrowawayRepo, isolatedRuntimeEnv } from "./fixtures/throwaway-repo.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3993, TOK = "stoptok", BASE = `http://127.0.0.1:${PORT}`;
let root, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });

// undici (global fetch) rewrites the Host header to the connected authority, so the
// DNS-rebinding gate can only be exercised through a raw node:http request.
function rawPost(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method: "POST", headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitHealth(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server not healthy");
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "ma-stop-"));
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env, RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "mock",
      ANTHROPIC_API_KEY: "", RUNTIME_TOKEN_DIR: join(root, "tok"),
      RUNTIME_THREADS_DIR: join(root, "threads"), RUNTIME_MCP_DIR: join(root, "mcp"),
      RUNTIME_ENGINE_STORE: join(root, "eng"),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"), // P2: keep the real agent-runtime/data/ clean
      // Throwaway target: with no RUNTIME_REPO_ROOT the server defaults REPO_ROOT to
      // the LIVE MissionAlpha checkout and any worktree it creates registers there.
      ...isolatedRuntimeEnv(root, makeThrowawayRepo(root)),
      FACTORY_REGISTRY_FILE: join(root, "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "agents"),
    },
    stdio: "ignore",
  });
  await waitHealth();
});
after(() => {
  try { child?.kill("SIGKILL"); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

test("stop requires a token (401)", async () => {
  const r = await fetch(`${BASE}/runtime/stopper-a/stop`, { method: "POST", headers: H() });
  assert.equal(r.status, 401);
});

test("stop rejects a foreign Host (403 — DNS-rebinding gate)", async () => {
  const r = await rawPost("/runtime/stopper-a/stop", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
});

test("stop with no active chat returns 404 {stopped:false}", async () => {
  const r = await fetch(`${BASE}/runtime/stopper-idle/stop`, { method: "POST", headers: auth() });
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { stopped: false, reason: "no active chat" });
});

test("stop kills a live mock stream in under 2s and marks the thread interrupted", async () => {
  const id = "stopper-live";
  // Start a long mock turn (the mock streamer emits one word every 45ms).
  const chat = fetch(`${BASE}/runtime/${id}/chat`, {
    method: "POST", headers: H(),
    body: JSON.stringify({ message: "build a very long thing please and explain every step" }),
  });
  // Let the stream actually start (meta + a couple of tokens).
  await new Promise((r) => setTimeout(r, 250));

  const t0 = Date.now();
  const s = await fetch(`${BASE}/runtime/${id}/stop`, { method: "POST", headers: auth() });
  assert.equal(s.status, 200);
  assert.deepEqual(await s.json(), { stopped: true });

  const body = await (await chat).text();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `stream took ${elapsed}ms to end`);
  assert.match(body, /event: done/);

  // Thread is persisted with the interrupted marker on the assistant turn.
  const rec = JSON.parse(readFileSync(join(root, "threads", `${id}.json`), "utf-8"));
  const last = rec.messages[rec.messages.length - 1];
  assert.equal(last.role, "assistant");
  assert.match(last.content, /\(interrupted\)$/);
});

test("a second stop after the turn settled is a clean 404", async () => {
  const r = await fetch(`${BASE}/runtime/stopper-live/stop`, { method: "POST", headers: auth() });
  assert.equal(r.status, 404);
});

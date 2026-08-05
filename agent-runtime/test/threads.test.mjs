// ADR-031 — chat-thread fork/resume endpoints. HTTP integration against a real
// booted server (mock backend, temp dirs). Verifies auth, resume hydration, fork
// (full + truncated), and delete. "session" = a chat thread.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { makeThrowawayRepo, isolatedRuntimeEnv } from "./fixtures/throwaway-repo.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3971;
const TOKEN = "threadtok";
const BASE = `http://127.0.0.1:${PORT}`;
let root, threadsDir, child;

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
  root = mkdtempSync(join(tmpdir(), "ma-threads-test-"));
  threadsDir = join(root, "threads");
  mkdirSync(threadsDir, { recursive: true });
  // seed a persisted thread on disk (listThreads/getThreadRecord read disk directly)
  writeFileSync(join(threadsDir, "boss.json"), JSON.stringify({
    id: "boss", tier: "sonnet", updatedAt: new Date(0).toISOString(),
    messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi boss" }, { role: "user", content: "again" }],
    usage: { totalInputTokens: 30, totalOutputTokens: 12, turns: 2, lastContextPct: 0.01, lastTier: "sonnet" },
  }));
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOKEN, RUNTIME_BACKEND: "mock",
      RUNTIME_THREADS_DIR: threadsDir, RUNTIME_TOKEN_DIR: join(root, "tok"),
      RUNTIME_ENGINE_STORE: join(root, "eng"), RUNTIME_WORKTREE_ROOT: join(root, "wt"),
      // Throwaway target: with no RUNTIME_REPO_ROOT the server defaults REPO_ROOT to
      // the LIVE MissionAlpha checkout and any worktree it creates registers there.
      ...isolatedRuntimeEnv(root, makeThrowawayRepo(root)),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"), // P2: keep the real agent-runtime/data/ clean
      ANTHROPIC_API_KEY: "",
    },
    stdio: "ignore",
  });
  await waitHealth();
});

after(() => {
  try { child?.kill("SIGKILL"); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

test("GET /runtime/threads requires the token (401 without)", async () => {
  const r = await fetch(`${BASE}/runtime/threads`, { headers: H() });
  assert.equal(r.status, 401);
});

test("GET /runtime/threads lists persisted threads (no message bodies)", async () => {
  const r = await fetch(`${BASE}/runtime/threads`, { headers: authed() });
  assert.equal(r.status, 200);
  const j = await r.json();
  const boss = j.threads.find((t) => t.id === "boss");
  assert.ok(boss, "boss thread listed");
  assert.equal(boss.messageCount, 3);
  assert.equal(boss.tier, "sonnet");
  assert.ok(boss.usage && boss.usage.turns === 2);
  assert.equal(boss.messages, undefined, "list does not leak message bodies");
});

test("GET /runtime/:id/thread hydrates messages for resume", async () => {
  const r = await fetch(`${BASE}/runtime/boss/thread`, { headers: authed() });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.messages.length, 3);
  assert.equal(j.messages[0].content, "hello");
  assert.equal(j.tier, "sonnet");
});

test("GET /runtime/:id/thread → 404 for an unknown thread", async () => {
  const r = await fetch(`${BASE}/runtime/nope/thread`, { headers: authed() });
  assert.equal(r.status, 404);
});

test("POST /runtime/:id/fork branches into a NEW thread with copied messages", async () => {
  const r = await fetch(`${BASE}/runtime/boss/fork`, { method: "POST", headers: authed({ "Content-Type": "application/json" }), body: "{}" });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  assert.match(id, /^boss__fork_[0-9a-f]{8}$/);
  const f = await (await fetch(`${BASE}/runtime/${id}/thread`, { headers: authed() })).json();
  assert.equal(f.messages.length, 3, "full conversation copied");
});

test("POST /runtime/:id/fork {upTo} truncates the branch at a point", async () => {
  const r = await fetch(`${BASE}/runtime/boss/fork`, { method: "POST", headers: authed({ "Content-Type": "application/json" }), body: JSON.stringify({ upTo: 2 }) });
  const { id } = await r.json();
  const f = await (await fetch(`${BASE}/runtime/${id}/thread`, { headers: authed() })).json();
  assert.equal(f.messages.length, 2, "branched at message 2");
});

test("DELETE /runtime/:id/thread removes a thread (clean up forks)", async () => {
  const { id } = await (await fetch(`${BASE}/runtime/boss/fork`, { method: "POST", headers: authed({ "Content-Type": "application/json" }), body: "{}" })).json();
  const d = await fetch(`${BASE}/runtime/${id}/thread`, { method: "DELETE", headers: authed() });
  assert.equal(d.status, 200);
  const g = await fetch(`${BASE}/runtime/${id}/thread`, { headers: authed() });
  assert.equal(g.status, 404, "gone after delete");
});

test("fork requires auth (401 without token)", async () => {
  const r = await fetch(`${BASE}/runtime/boss/fork`, { method: "POST", headers: H({ "Content-Type": "application/json" }), body: "{}" });
  assert.equal(r.status, 401);
});

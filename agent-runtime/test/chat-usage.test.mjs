// ADR-030 end-to-end — the SSE `usage` event actually fires on a chat turn (token +
// context, NEVER $) AND the per-thread usage rollup + history PERSIST across a real
// runtime restart (BOSS acceptance: "restart the runtime and confirm history persists").
// Uses the mock backend (deterministic, no claude) over temp dirs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3972;
const TOKEN = "chatusagetok";
const BASE = `http://127.0.0.1:${PORT}`;
let root, threadsDir;

const H = (extra = {}) => ({ Host: `localhost:${PORT}`, ...extra });

function boot() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env, RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOKEN, RUNTIME_BACKEND: "mock",
      RUNTIME_THREADS_DIR: threadsDir, RUNTIME_TOKEN_DIR: join(root, "tok"),
      RUNTIME_ENGINE_STORE: join(root, "eng"), RUNTIME_WORKTREE_ROOT: join(root, "wt"), ANTHROPIC_API_KEY: "",
    },
    stdio: "ignore",
  });
  return child;
}
async function waitHealth(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: H() })).ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server not healthy");
}
async function readSSE(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", usageEvent = null, sawDone = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() || "";
    for (const f of frames) {
      const ev = /event: (.+)/.exec(f)?.[1];
      const data = /data: ([\s\S]*)/.exec(f)?.[1];
      if (ev === "usage") usageEvent = JSON.parse(data);
      if (ev === "done") sawDone = true;
    }
  }
  return { usageEvent, sawDone };
}
let child;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "ma-chatusage-"));
  threadsDir = join(root, "threads");
  mkdirSync(threadsDir, { recursive: true });
  child = boot();
  await waitHealth();
});
after(() => {
  try { child?.kill("SIGKILL"); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

test("a chat turn emits an SSE `usage` event with tokens + context% and NO dollar field", async () => {
  const res = await fetch(`${BASE}/runtime/u1/chat`, {
    method: "POST", headers: H({ "Content-Type": "application/json" }),
    body: JSON.stringify({ message: "hello there, build me something", model: "sonnet" }),
  });
  assert.equal(res.status, 200);
  const { usageEvent, sawDone } = await readSSE(res);
  assert.ok(usageEvent, "usage event fired");
  assert.ok(sawDone, "done fired after usage");
  assert.equal(typeof usageEvent.inputTokens, "number");
  assert.equal(typeof usageEvent.outputTokens, "number");
  assert.equal(typeof usageEvent.contextPct, "number");
  assert.ok(usageEvent.contextPct >= 0 && usageEvent.contextPct <= 1);
  assert.equal(usageEvent.tier, "sonnet");
  // NO dollars on the wire, ever
  const keys = Object.keys(usageEvent).join(",").toLowerCase();
  assert.ok(!/cost|usd|dollar|price/.test(keys), "usage event carries no cost-shaped field");
});

test("per-thread usage rollup + history PERSIST across a runtime restart", async () => {
  // (the chat turn above already wrote u1 to disk) — confirm it's listed with usage
  const before = await (await fetch(`${BASE}/runtime/threads`, { headers: H({ "x-runtime-token": TOKEN }) })).json();
  const u1before = before.threads.find((t) => t.id === "u1");
  assert.ok(u1before && u1before.usage && u1before.usage.turns >= 1, "usage rolled up pre-restart");

  // restart the runtime against the SAME threads dir
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  child = boot();
  await waitHealth();

  const rec = await (await fetch(`${BASE}/runtime/u1/thread`, { headers: H({ "x-runtime-token": TOKEN }) })).json();
  assert.equal(rec.messages.length, 2, "user+assistant messages survived restart");
  assert.equal(rec.messages[0].content, "hello there, build me something");
  assert.ok(rec.usage && rec.usage.turns >= 1, "usage rollup survived restart");
});

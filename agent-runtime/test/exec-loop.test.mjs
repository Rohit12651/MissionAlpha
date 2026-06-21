// ADR-038/039 end-to-end — full tool loop through a booted runtime. Proves: SAFE
// auto-runs in the sandbox; FORBIDDEN refused; SENSITIVE → pending → approve → jailed
// run; session-grant skips re-approval; deny blocks; auth required. Docker-gated.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createSandbox } from "../sandbox.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const REPO = join(__dir, "..", "..");
const PORT = 3991, TOK = "exectok", BASE = `http://127.0.0.1:${PORT}`;
const DOCKER_UP = await createSandbox().dockerAvailable();
const skip = !DOCKER_UP;
let root, child;
const auth = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", "x-runtime-token": TOK, ...x });
const post = (path, bodyObj, headers) => fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(bodyObj || {}) });

async function waitHealth(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).ok) return; } catch { /* */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server not healthy");
}

before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), "ma-exec-"));
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env, RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "mock",
      RUNTIME_SANDBOX_IMAGE: "alpine:3", RUNTIME_EXEC_WT_ROOT: join(root, "wt"),
      RUNTIME_TOKEN_DIR: join(root, "tok"), RUNTIME_THREADS_DIR: join(root, "threads"),
      RUNTIME_MCP_DIR: join(root, "mcp"), RUNTIME_ENGINE_STORE: join(root, "eng"), ANTHROPIC_API_KEY: "",
    },
    stdio: "ignore",
  });
  await waitHealth();
});
after(() => {
  try { child?.kill("SIGKILL"); } catch { /* */ }
  // clean up exec worktree branches created off the live repo
  try { for (const b of execFileSync("git", ["-C", REPO, "branch", "--list", "ma/task/exectest*"], { encoding: "utf-8" }).split("\n").map((s) => s.trim().replace(/^\*\s*/, "")).filter(Boolean)) execFileSync("git", ["-C", REPO, "branch", "-D", b]); } catch { /* */ }
  try { execFileSync("git", ["-C", REPO, "worktree", "prune"]); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

test("exec requires auth (401 without token)", { skip }, async () => {
  const r = await post("/runtime/exectest_a/exec", { command: "ls" }, { Host: `localhost:${PORT}`, "Content-Type": "application/json" });
  assert.equal(r.status, 401);
});

test("SAFE command auto-runs in the sandbox (no approval)", { skip }, async () => {
  const r = await (await post("/runtime/exectest_a/exec", { command: "echo hello-sandbox" })).json();
  assert.equal(r.ran, true);
  assert.equal(r.klass, "safe");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hello-sandbox/);
});

test("FORBIDDEN command is refused, never runs", { skip }, async () => {
  const r = await (await post("/runtime/exectest_a/exec", { command: "sudo cat /etc/shadow" })).json();
  assert.equal(r.refused, true);
  assert.equal(r.klass, "forbidden");
});

test("SENSITIVE write → pending → approve once → runs in sandbox; write persists in the worktree", { skip }, async () => {
  const p = await (await post("/runtime/exectest_a/exec", { command: "echo agentdata > /work/made.txt" })).json();
  assert.equal(p.pending, true);
  assert.equal(p.klass, "sensitive");
  const ap = await (await post(`/runtime/exec/${p.callId}/approve`, { scope: "once" })).json();
  assert.equal(ap.ran, true);
  assert.equal(ap.exitCode, 0);
  // a follow-up SAFE read shows the write landed in the agent's worktree (same agent → same /work)
  const rd = await (await post("/runtime/exectest_a/exec", { command: "cat /work/made.txt" })).json();
  assert.match(rd.stdout, /agentdata/);
});

test("deny blocks execution", { skip }, async () => {
  const p = await (await post("/runtime/exectest_a/exec", { command: "rm -rf /work/made.txt" })).json();
  assert.equal(p.pending, true);
  const d = await (await post(`/runtime/exec/${p.callId}/approve`, { scope: "deny" })).json();
  assert.equal(d.denied, true);
});

test("allow-for-session skips re-approval for the same command", { skip }, async () => {
  const cmd = "echo session-cmd > /work/s.txt";
  const p = await (await post("/runtime/exectest_b/exec", { command: cmd })).json();
  assert.equal(p.pending, true);
  await post(`/runtime/exec/${p.callId}/approve`, { scope: "session" });
  // same command again → runs immediately, no pending
  const again = await (await post("/runtime/exectest_b/exec", { command: cmd })).json();
  assert.equal(again.ran, true, "session-granted command auto-runs");
  assert.equal(again.pending, undefined);
});

test("forbidden cannot be smuggled past via chaining", { skip }, async () => {
  const r = await (await post("/runtime/exectest_a/exec", { command: "echo ok && cat /etc/shadow" })).json();
  assert.equal(r.refused, true);
});

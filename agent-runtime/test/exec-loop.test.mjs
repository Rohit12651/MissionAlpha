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
      // Isolate the factory's repo-bound writes so the booted server never touches the
      // TRACKED factory/registry.json or .claude/agents/*.md.
      FACTORY_REGISTRY_FILE: join(root, "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "agents"),
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

// ── B2 + B3 (ADR-050) — exec capability gate + detect-gaps endpoint ───────────
// These tests DO NOT require Docker — the 403 capability gate fires before any
// sandbox call, and detect-gaps is pure read-only. Run a separate server on port 3992.
// ─────────────────────────────────────────────────────────────────────────────────
{
  const PORT2 = 3992, TOK2 = "capgatetoken", BASE2 = `http://127.0.0.1:${PORT2}`;
  const auth2 = (x = {}) => ({ Host: `localhost:${PORT2}`, "Content-Type": "application/json", "x-runtime-token": TOK2, ...x });
  const post2 = (path, bodyObj, hdrs) => fetch(`${BASE2}${path}`, { method: "POST", headers: hdrs ?? auth2(), body: JSON.stringify(bodyObj || {}) });

  let root2, child2;

  before(async () => {
    root2 = mkdtempSync(join(tmpdir(), "ma-capgate-"));
    child2 = spawn(process.execPath, [SERVER], {
      cwd: join(__dir, ".."),
      env: {
        ...process.env,
        RUNTIME_PORT: String(PORT2),
        RUNTIME_TOKEN: TOK2,
        RUNTIME_BACKEND: "mock",
        RUNTIME_TOKEN_DIR: join(root2, "tok"),
        RUNTIME_THREADS_DIR: join(root2, "threads"),
        RUNTIME_MCP_DIR: join(root2, "mcp"),
        RUNTIME_ENGINE_STORE: join(root2, "eng"),
        RUNTIME_EXEC_WT_ROOT: join(root2, "wt"),
        ANTHROPIC_API_KEY: "",
        RUNTIME_SEED_DEFAULTS: "0",
        // Isolate the factory's repo-bound writes so creating captest-*/dev agents over
        // HTTP never pollutes the TRACKED factory/registry.json or .claude/agents/*.md.
        FACTORY_REGISTRY_FILE: join(root2, "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root2, "agents"),
      },
      stdio: "ignore",
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      try {
        if ((await fetch(`${BASE2}/runtime/health`, { headers: { Host: `localhost:${PORT2}` } })).ok) break;
      } catch { /* */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  after(async () => {
    try { child2?.kill("SIGKILL"); } catch { /* */ }
    try { rmSync(root2, { recursive: true, force: true }); } catch { /* */ }
  });

  const B2_AGENT_IDS = ["captest-content-agent", "captest-dev-agent"];

  // Delete test agents if they already exist (idempotent cleanup between runs).
  // Route: DELETE /factory/:id (see server.mjs ~line 1630).
  async function deleteIfExists(id) {
    try { await fetch(`${BASE2}/factory/${id}`, { method: "DELETE", headers: auth2() }); } catch { /* */ }
  }

  // Helper: create a factory agent via the running server (idempotent — pre-cleaned).
  async function createFactoryAgent(spec) {
    await deleteIfExists(spec.id);
    const r = await post2("/factory/create", spec);
    return r.json();
  }

  // ── B2: exec-capability gate ──────────────────────────────────────────────

  test("B2: content-only factory agent → POST /exec returns 403 (no dev skill)", async () => {
    // Create a content-only agent (no dev skill).
    const created = await createFactoryAgent({
      id: "captest-content-agent",
      role: "Social writer",
      title: "Social Writer",
      persona: "You draft social posts for BOSS approval. Bus comms in /caveman full.",
      skills: ["content-writing"],
      tools: ["Read"],
      integrations: [],
    });
    assert.ok(!created.error, `createAgent failed: ${JSON.stringify(created)}`);

    const r = await post2("/runtime/captest-content-agent/exec", { command: "echo hello" });
    assert.equal(r.status, 403, `expected 403 for content agent /exec, got ${r.status}`);
    const body = await r.json();
    assert.ok(
      body.error && body.error.toLowerCase().includes("exec not permitted"),
      `expected 'exec not permitted' error, got: ${JSON.stringify(body)}`
    );
  });

  test("B2: content agent 403 fires BEFORE any sandbox call (no Docker dependency)", async () => {
    // Same agent as above — just verify the gate is the gate, not a Docker failure.
    const r = await post2("/runtime/captest-content-agent/exec", { command: "ls" });
    assert.equal(r.status, 403, "capability gate must return 403, not a sandbox error");
    const body = await r.json();
    // Must NOT be a Docker/sandbox error — must be the capability gate message.
    assert.ok(!body.refused, "must not be a 'refused' (forbidden class) response — that is a different gate");
    assert.ok(!body.error?.includes("docker") && !body.error?.includes("container"),
      "error must not mention docker/container — gate fires before sandbox");
  });

  test("B2: dev-skill factory agent → /exec is NOT blocked by capability gate (reaches classify)", async () => {
    // Create a dev agent. In mock backend exec still goes through classify before sandbox.
    const created = await createFactoryAgent({
      id: "captest-dev-agent",
      role: "Go implementer",
      title: "Go Implementer",
      persona: "You implement Go code inside the sandbox. Bus comms in /caveman full.",
      skills: ["code-implement-go"],
      tools: ["Read", "Write", "Run"],
      integrations: [],
      redirect: "golang-pro",
    });
    assert.ok(!created.error, `createAgent failed: ${JSON.stringify(created)}`);

    // The request should NOT return 403 — it passes the capability gate.
    // It may get forbidden/pending/busy (Docker not needed for this assertion).
    const r = await post2("/runtime/captest-dev-agent/exec", { command: "echo hello" });
    assert.notEqual(r.status, 403, "dev agent must NOT be blocked by the capability gate");
  });

  test("G1 (ADR-050): factory dev agent's SAFE command does NOT auto-run — returns pending", async () => {
    // `echo` is classified `safe` (a builtin auto-runs it). For an AI-authored factory
    // agent G1 forces approval even for safe — so it must come back pending, never ran.
    await createFactoryAgent({
      id: "g1test-dev-agent",
      role: "Go implementer",
      title: "Go Implementer",
      persona: "You implement Go code inside the sandbox. Bus comms in /caveman full.",
      skills: ["code-implement-go"],
      tools: ["Read", "Write", "Run"],
      integrations: [],
      redirect: "golang-pro",
    });
    const r = await post2("/runtime/g1test-dev-agent/exec", { command: "echo hi-safe" });
    const body = await r.json();
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(body)}`);
    assert.equal(body.klass, "safe", "echo must classify safe");
    assert.equal(body.pending, true, `factory safe must be pending (G1), got ${JSON.stringify(body)}`);
    assert.notEqual(body.ran, true, "factory safe command must NOT auto-run");
  });

  test("B2: builtin agent id → /exec is NOT blocked by capability gate", async () => {
    // architect is a builtin (not in factory registry) — isFactoryAgent returns false.
    // The gate must let it through.
    const r = await post2("/runtime/architect/exec", { command: "echo hi" });
    assert.notEqual(r.status, 403, "builtin agent must not be blocked by the capability gate");
  });

  test("B2: exec still requires auth (401 without token)", async () => {
    const r = await post2(
      "/runtime/captest-content-agent/exec",
      { command: "ls" },
      { Host: `localhost:${PORT2}`, "Content-Type": "application/json" }
    );
    assert.equal(r.status, 401, "exec must still require auth token");
  });

  // ── B3: detect-gaps endpoint ──────────────────────────────────────────────

  test("B3: POST /runtime/factory/detect-gaps returns {gaps, covered}", async () => {
    const r = await post2("/runtime/factory/detect-gaps", { needs: { langs: ["go"] } });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const body = await r.json();
    assert.ok(Array.isArray(body.gaps), "response must have gaps array");
    assert.ok(Array.isArray(body.covered), "response must have covered array");
  });

  test("B3: detect-gaps returns angular as a gap (no builtin angular specialist)", async () => {
    const r = await post2("/runtime/factory/detect-gaps", {
      needs: { frameworks: ["angular"] },
    });
    const body = await r.json();
    assert.ok(body.gaps.some((g) => g.value === "angular" && g.kind === "framework"),
      `angular must be a gap, got: ${JSON.stringify(body)}`);
  });

  test("B3: detect-gaps returns python as covered (senior-backend agents have python)", async () => {
    const r = await post2("/runtime/factory/detect-gaps", {
      needs: { langs: ["python"] },
    });
    const body = await r.json();
    assert.ok(body.gaps.length === 0 || !body.gaps.some((g) => g.value === "python"),
      `python must NOT be a gap, got: ${JSON.stringify(body)}`);
    assert.ok(body.covered.some((c) => c.value === "python"),
      `python must be in covered, got: ${JSON.stringify(body)}`);
  });

  test("B3: detect-gaps requires auth (401 without token)", async () => {
    const r = await fetch(`${BASE2}/runtime/factory/detect-gaps`, {
      method: "POST",
      headers: { Host: `localhost:${PORT2}`, "Content-Type": "application/json" },
      body: JSON.stringify({ needs: { langs: ["go"] } }),
    });
    assert.equal(r.status, 401, "detect-gaps must require auth token");
  });

  test("B3: detect-gaps NEVER calls createAgent (registry size unchanged)", async () => {
    // Get initial agent count.
    const listBefore = await (await fetch(`${BASE2}/factory/agents`, {
      headers: auth2(),
    })).json();
    const countBefore = listBefore.agents?.length ?? 0;

    // Call detect-gaps several times with various manifests.
    await post2("/runtime/factory/detect-gaps", { needs: { langs: ["rust", "elixir"] } });
    await post2("/runtime/factory/detect-gaps", { needs: { frameworks: ["svelte", "angular"] } });
    await post2("/runtime/factory/detect-gaps", { needs: { dbs: ["cassandra"] } });

    // Agent count must be unchanged.
    const listAfter = await (await fetch(`${BASE2}/factory/agents`, {
      headers: auth2(),
    })).json();
    const countAfter = listAfter.agents?.length ?? 0;
    assert.equal(countAfter, countBefore,
      `detect-gaps must never create agents (before=${countBefore}, after=${countAfter})`);
  });

  test("B3: detect-gaps with empty manifest returns empty gaps and covered", async () => {
    const r = await post2("/runtime/factory/detect-gaps", {});
    const body = await r.json();
    assert.deepEqual(body.gaps, [], "empty manifest must yield no gaps");
    assert.deepEqual(body.covered, [], "empty manifest must yield no covered");
  });
}

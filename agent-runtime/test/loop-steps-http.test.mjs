// CC-Primitives P2 — loop steps at the wire, through a REAL booted runtime on the cli
// backend with a fake CLAUDE_BIN. Proves the whole chain: engine spawn → stream-json
// parsed → steps persisted (v14) → secret-shaped string scrubbed at rest → replay via
// GET /runtime/engine/steps → bad taskId 400 → no-token 401.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { makeThrowawayRepo, isolatedRuntimeEnv } from "./fixtures/throwaway-repo.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3967, TOK = "looptok", BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "ghp_abcdefghijklmnopqrstuv1234";
let root, child;
const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).ok) return; } catch { /* */ }
    await sleep(120);
  }
  throw new Error("server not healthy");
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-loophttp-")));
  const repo = makeThrowawayRepo(root);
  // Fake claude: think → tool_use → tool_result (with a secret) → modify a tracked
  // file (real diff so the task settles as HELD) → result.
  const fakeJs = join(root, "fake-claude.mjs");
  writeFileSync(fakeJs, [
    'import { appendFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'try { appendFileSync(join(process.cwd(), "README.md"), "\\nloop-steps proof\\n"); } catch {}',
    'w({ type: "assistant", message: { content: [{ type: "text", text: "editing README now" }, { type: "tool_use", name: "Edit", input: { file_path: "README.md" } }] } });',
    `w({ type: "user", message: { content: [{ type: "tool_result", content: "ok, saw token ${SECRET} in env" }] } });`,
    'w({ type: "result", subtype: "success", is_error: false, result: "appended one line", usage: { input_tokens: 2, output_tokens: 2 } });',
    'process.exit(0);',
  ].join("\n"));
  const wrapper = join(root, "fake-claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  mkdirSync(join(root, "db"), { recursive: true });
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "cli", RUNTIME_TOOLS: "write",
      CLAUDE_BIN: wrapper, ANTHROPIC_API_KEY: "",
      ...isolatedRuntimeEnv(root, repo),
      RUNTIME_STATION_PERMS_FILE: join(root, "station-perms.json"),
      RUNTIME_TOKEN_DIR: join(root, "tok"), RUNTIME_THREADS_DIR: join(root, "threads"),
      RUNTIME_MCP_DIR: join(root, "mcp"), RUNTIME_ENGINE_STORE: join(root, "eng"),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"), RUNTIME_VAULT_DIR: join(root, "vault"),
      FACTORY_REGISTRY_FILE: join(root, "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "agents"),
      RUNTIME_SEED_DEFAULTS: "0",
    },
    stdio: "ignore",
  });
  await waitHealth();
  // Multi-account contract: the engine only runs when an active account is swarm-capable
  // (Claude). A fresh store now has ZERO accounts, so we add a Claude subscription account
  // (no secret, no probe) which auto-activates → capability:swarm → the cli engine runs.
  const acct = await fetch(`${BASE}/runtime/accounts`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ providerType: "claude", label: "engine", authMethod: "subscription" }),
  });
  assert.equal(acct.status, 200, "seed a swarm-capable Claude account before the engine turn");
});
after(async () => {
  await new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });
  if (root) rmSync(root, { recursive: true, force: true });
});

let taskId = "";

test("engine turn produces persisted, ordered, scrubbed loop steps", async () => {
  const enq = await fetch(`${BASE}/runtime/engine/enqueue`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ agentId: "sr-backend", tier: "sonnet", priority: "high", steps: ["Append a line to README"] }),
  });
  assert.equal(enq.status, 201);
  taskId = (await enq.json()).firstTaskId;
  assert.match(taskId, /^task_/);

  let steps = [];
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const r = await fetch(`${BASE}/runtime/engine/steps?taskId=${taskId}`, { headers: auth() });
    assert.equal(r.status, 200);
    steps = (await r.json()).steps;
    if (steps.some((s) => s.kind === "result")) break;
  }
  const kinds = steps.map((s) => s.kind);
  assert.deepEqual(kinds, ["think", "tool", "observe", "result"], "all four boundaries, in order");
  assert.equal(steps[1].tool, "Edit");
  assert.deepEqual(steps.map((s) => s.seq), [1, 2, 3, 4]);
  const observe = steps[2];
  assert.doesNotMatch(observe.summary, /ghp_/, "secret-shaped token never lands at rest");
  assert.match(observe.summary, /\[redacted-secret\]/);
  assert.ok(steps.every((s) => s.agentId === "sr-backend"));
});

test("malformed taskId → 400; missing token → 401", async () => {
  const bad = await fetch(`${BASE}/runtime/engine/steps?taskId=../etc`, { headers: auth() });
  assert.equal(bad.status, 400);
  const noTok = await fetch(`${BASE}/runtime/engine/steps?taskId=${taskId || "task_abc123"}`, { headers: H() });
  assert.equal(noTok.status, 401);
});

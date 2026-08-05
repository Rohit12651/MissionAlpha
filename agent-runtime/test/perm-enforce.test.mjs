// CC-Primitives P1 — ENFORCEMENT proof. The per-station interactive permission mode must
// actually reach the spawned `claude --permission-mode` argv on the chat (cliReply) path,
// and the AUTONOMOUS engine loop must IGNORE it (pins acceptEdits). Uses a fake CLAUDE_BIN
// that dumps its argv to a per-agent file, so no subscription tokens are spent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { makeThrowawayRepo, isolatedRuntimeEnv } from "./fixtures/throwaway-repo.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3968, TOK = "enforcetok", BASE = `http://127.0.0.1:${PORT}`;
let root, argvDir, child;
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
// Drain an SSE POST so cliReply runs to completion (the fake exits fast).
async function chat(agentId, message) {
  const r = await fetch(`${BASE}/runtime/${agentId}/chat`, { method: "POST", headers: auth(), body: JSON.stringify({ message }) });
  try { await r.text(); } catch { /* */ }
}
function argvFor(agentId) {
  // fake writes one file per spawn: <argvDir>/<agentId>.<n>.argv — return the newest.
  const files = readdirSync(argvDir).filter((f) => f.startsWith(agentId + ".")).sort();
  if (!files.length) return null;
  return readFileSync(join(argvDir, files[files.length - 1]), "utf8");
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-permenf-")));
  argvDir = join(root, "argv");
  mkdirSync(argvDir, { recursive: true });
  const repo = makeThrowawayRepo(root);
  // Fake claude: dump argv, emit a content delta + result, exit 0.
  const fakeJs = join(root, "fake-claude.mjs");
  writeFileSync(fakeJs, [
    'import { writeFileSync, existsSync } from "node:fs";',
    'import { join } from "node:path";',
    'const argv = process.argv.slice(2);',
    'let agent = "unknown";',
    'const i = argv.indexOf("--add-dir");',
    'if (i >= 0 && argv[i+1]) { const parts = argv[i+1].split("/"); agent = parts[parts.length-1] || "unknown"; }',
    'const dir = process.env.CLAUDE_ARGV_OUT;',
    'let n = 0; while (existsSync(join(dir, agent + "." + n + ".argv"))) n++;',
    'writeFileSync(join(dir, agent + "." + n + ".argv"), argv.join("\\n"));',
    'process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "ok" } } }) + "\\n");',
    'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");',
    'process.exit(0);',
  ].join("\n"));
  const wrapper = join(root, "fake-claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);

  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "cli", RUNTIME_TOOLS: "write",
      CLAUDE_BIN: wrapper, CLAUDE_ARGV_OUT: argvDir, ANTHROPIC_API_KEY: "", RUNTIME_PERM_MODE: "acceptEdits",
      ...isolatedRuntimeEnv(root, repo),
      RUNTIME_STATION_PERMS_FILE: join(root, "station-perms.json"),
      RUNTIME_TOKEN_DIR: join(root, "tok"), RUNTIME_THREADS_DIR: join(root, "threads"),
      RUNTIME_MCP_DIR: join(root, "mcp"), RUNTIME_ENGINE_STORE: join(root, "eng"),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"), RUNTIME_VAULT_DIR: join(root, "vault"),
      FACTORY_REGISTRY_FILE: join(root, "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "agents"),
      RUNTIME_SEED_DEFAULTS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitHealth();
});
after(async () => {
  await new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });
  if (root) rmSync(root, { recursive: true, force: true });
});

// Non-factory ids take the global TOOLS=write branch of cliReply, which is the path that
// pushes --permission-mode (factory Read-only agents never do). That is exactly the
// interactive write path the per-station mode governs.
test("no override → interactive spawn uses the global default (acceptEdits)", async () => {
  await chat("buildbot-a", "hi");
  await sleep(400);
  const argv = argvFor("buildbot-a");
  assert.ok(argv, "fake claude spawned + dumped argv");
  const parts = argv.split("\n");
  const i = parts.indexOf("--permission-mode");
  assert.ok(i >= 0, "argv carries --permission-mode");
  assert.equal(parts[i + 1], "acceptEdits");
});

test("override reaches the interactive spawn's --permission-mode", async () => {
  const put = await fetch(`${BASE}/runtime/buildbot-b/perm-mode`, { method: "PUT", headers: auth(), body: JSON.stringify({ permissionMode: "bypassPermissions" }) });
  assert.equal(put.status, 200);
  await chat("buildbot-b", "hi");
  await sleep(400);
  const argv = argvFor("buildbot-b");
  assert.ok(argv, "fake claude spawned for buildbot-b");
  const parts = argv.split("\n");
  const i = parts.indexOf("--permission-mode");
  assert.ok(i >= 0, "argv carries --permission-mode");
  assert.equal(parts[i + 1], "bypassPermissions", "per-station override enforced at spawn");
});

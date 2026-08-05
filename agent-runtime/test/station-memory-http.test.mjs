// CC-Primitives P4 — station memory + hooks status at the wire. Proves: REST contract,
// scrub-at-PUT (a pasted secret never lands at rest), the ENFORCEMENT chain (memory
// text reaches the next spawn's system prompt; cleared memory disappears), and the
// read-only hooks endpoint returning REAL guard state.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { makeThrowawayRepo, isolatedRuntimeEnv } from "./fixtures/throwaway-repo.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3965, TOK = "memtok", BASE = `http://127.0.0.1:${PORT}`;
let root, promptDir, child;
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
async function chat(agentId, message) {
  const r = await fetch(`${BASE}/runtime/${agentId}/chat`, { method: "POST", headers: auth(), body: JSON.stringify({ message }) });
  try { await r.text(); } catch { /* */ }
}
function promptFor(agentId) {
  const files = readdirSync(promptDir).filter((f) => f.startsWith(agentId + ".")).sort();
  return files.length ? readFileSync(join(promptDir, files[files.length - 1]), "utf8") : null;
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-memhttp-")));
  promptDir = join(root, "prompts");
  mkdirSync(promptDir, { recursive: true });
  const repo = makeThrowawayRepo(root);
  const fakeJs = join(root, "fake-claude.mjs");
  writeFileSync(fakeJs, [
    'import { writeFileSync, existsSync } from "node:fs";',
    'import { join } from "node:path";',
    'const argv = process.argv.slice(2);',
    'let agent = "unknown";',
    'const i = argv.indexOf("--add-dir");',
    'if (i >= 0 && argv[i+1]) { const parts = argv[i+1].split("/"); agent = parts[parts.length-1] || "unknown"; }',
    'let acc = "";',
    'process.stdin.on("data", (d) => { acc += d.toString(); });',
    'process.stdin.on("end", () => {',
    '  const dir = process.env.CLAUDE_PROMPT_OUT;',
    '  let n = 0; while (existsSync(join(dir, agent + "." + n))) n++;',
    '  writeFileSync(join(dir, agent + "." + n), acc);',
    '  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} }) + "\\n");',
    '  process.exit(0);',
    '});',
  ].join("\n"));
  const wrapper = join(root, "fake-claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "cli", RUNTIME_TOOLS: "write",
      CLAUDE_BIN: wrapper, CLAUDE_PROMPT_OUT: promptDir, ANTHROPIC_API_KEY: "",
      ...isolatedRuntimeEnv(root, repo),
      RUNTIME_STATION_MEMORY_FILE: join(root, "station-memory.json"),
      RUNTIME_STATION_SKILLS_FILE: join(root, "station-skills.json"),
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
});
after(async () => {
  await new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });
  if (root) rmSync(root, { recursive: true, force: true });
});

test("GET default empty; no token → 401; PUT non-string → 400", async () => {
  const g = await (await fetch(`${BASE}/runtime/buildbot-m/memory`, { headers: auth() })).json();
  assert.deepEqual([g.memory, g.size, g.max], ["", 0, 8000]);
  assert.equal((await fetch(`${BASE}/runtime/buildbot-m/memory`, { headers: H() })).status, 401);
  const bad = await fetch(`${BASE}/runtime/buildbot-m/memory`, { method: "PUT", headers: auth(), body: JSON.stringify({ memory: 42 }) });
  assert.equal(bad.status, 400);
});

test("PUT scrubs a pasted secret BEFORE it lands at rest", async () => {
  const put = await fetch(`${BASE}/runtime/buildbot-m/memory`, {
    method: "PUT", headers: auth(),
    body: JSON.stringify({ memory: "Deploy key is ghp_abcdefghijklmnopqrstuv1234 — never print it." }),
  });
  assert.equal(put.status, 200);
  const g = await (await fetch(`${BASE}/runtime/buildbot-m/memory`, { headers: auth() })).json();
  assert.doesNotMatch(g.memory, /ghp_/);
  assert.match(g.memory, /\[redacted-secret\]/);
  assert.doesNotMatch(readFileSync(join(root, "station-memory.json"), "utf8"), /ghp_/);
});

test("memory reaches the next spawn's SYSTEM PROMPT; clearing removes it", async () => {
  await fetch(`${BASE}/runtime/buildbot-m/memory`, {
    method: "PUT", headers: auth(),
    body: JSON.stringify({ memory: "Always run the regression suite before opening a PR." }),
  });
  await chat("buildbot-m", "hello");
  await sleep(400);
  let prompt = promptFor("buildbot-m");
  assert.ok(prompt, "prompt captured");
  assert.match(prompt, /STATION MEMORY/);
  assert.match(prompt, /regression suite before opening a PR/);

  await fetch(`${BASE}/runtime/buildbot-m/memory`, { method: "PUT", headers: auth(), body: JSON.stringify({ memory: "" }) });
  await chat("buildbot-m", "again");
  await sleep(400);
  prompt = promptFor("buildbot-m");
  assert.doesNotMatch(prompt, /STATION MEMORY/);
});

test("hooks endpoint returns real guard state, read-only (PUT → 405)", async () => {
  const r = await fetch(`${BASE}/runtime/buildbot-m/hooks`, { headers: auth() });
  assert.equal(r.status, 200);
  const h = (await r.json()).hooks;
  assert.equal(h.permMode.effective, "acceptEdits");
  assert.equal(h.permMode.enginePinned, "acceptEdits");
  assert.equal(h.toolsMode, "write");
  assert.equal(h.secretScrub.active, true);
  assert.ok(h.applyDeny.pattern.includes("env"));
  assert.ok(h.quota.max > 0);
  assert.equal((await fetch(`${BASE}/runtime/buildbot-m/hooks`, { method: "PUT", headers: auth(), body: "{}" })).status, 405);
});

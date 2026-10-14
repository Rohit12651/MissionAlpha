// CC-Primitives P3 — station skills at the wire: REST contract + the ENFORCEMENT proof
// that an assigned skill actually lands in the next spawn's SYSTEM PROMPT (fake
// CLAUDE_BIN dumps its stdin). cli backend, throwaway repo, no subscription tokens.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
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
const PORT = 3966, TOK = "skilltok", BASE = `http://127.0.0.1:${PORT}`;
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-skillshttp-")));
  promptDir = join(root, "prompts");
  mkdirSync(promptDir, { recursive: true });
  const repo = makeThrowawayRepo(root);
  // Fake claude: derive agent from --add-dir tail, dump STDIN (the prompt) to a file.
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

test("GET default: no skills, catalog served; no token → 401", async () => {
  const r = await fetch(`${BASE}/runtime/buildbot-s/skills`, { headers: auth() });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(b.skills, []);
  assert.ok(b.catalog.some((s) => s.id === "repo-read"));
  assert.equal((await fetch(`${BASE}/runtime/buildbot-s/skills`, { headers: H() })).status, 401);
});

test("PUT unknown skill → 400; nothing persisted", async () => {
  const r = await fetch(`${BASE}/runtime/buildbot-s/skills`, { method: "PUT", headers: auth(), body: JSON.stringify({ skills: ["evil-skill"] }) });
  assert.equal(r.status, 400);
  const g = await (await fetch(`${BASE}/runtime/buildbot-s/skills`, { headers: auth() })).json();
  assert.deepEqual(g.skills, []);
});

test("posting/dev skills are NOT attachable (sr-security P3 LOW-1) and absent from catalog", async () => {
  const r = await fetch(`${BASE}/runtime/buildbot-s/skills`, { method: "PUT", headers: auth(), body: JSON.stringify({ skills: ["social-post-twitter"] }) });
  assert.equal(r.status, 400);
  const g = await (await fetch(`${BASE}/runtime/buildbot-s/skills`, { headers: auth() })).json();
  assert.ok(!g.catalog.some((s) => s.id === "social-post-twitter"));
  assert.ok(!g.catalog.some((s) => s.id.startsWith("code-implement-")));
});

test("PUT valid skills → persisted; next spawn's SYSTEM PROMPT carries them", async () => {
  const put = await fetch(`${BASE}/runtime/buildbot-s/skills`, { method: "PUT", headers: auth(), body: JSON.stringify({ skills: ["repo-read", "research-brief"] }) });
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()).skills, ["repo-read", "research-brief"]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "station-skills.json"), "utf8"))["buildbot-s"], ["repo-read", "research-brief"]);

  await chat("buildbot-s", "hello");
  await sleep(400);
  const prompt = promptFor("buildbot-s");
  assert.ok(prompt, "fake claude captured the prompt");
  assert.match(prompt, /SKILLS LOADED/);
  assert.match(prompt, /Read Repo/);
  assert.match(prompt, /Research Brief/);
});

test("clearing skills removes the prompt note on the following spawn", async () => {
  const put = await fetch(`${BASE}/runtime/buildbot-s/skills`, { method: "PUT", headers: auth(), body: JSON.stringify({ skills: [] }) });
  assert.equal(put.status, 200);
  await chat("buildbot-s", "again");
  await sleep(400);
  const prompt = promptFor("buildbot-s");
  assert.doesNotMatch(prompt, /SKILLS LOADED/);
});

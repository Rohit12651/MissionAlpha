// Chat routing by active-account capability — proves the server.mjs handleChat branch:
// a chat-capable OpenAI-compatible active account takes the ADAPTER path (SSE meta
// mode:"api"), while a Claude/swarm (or no) active account takes the existing CLI/mock
// path (mode:"mock" under the mock backend). Hermetic: the adapter account has NO model
// set, so the adapter fails closed with a friendly message and never touches the network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3996, TOK = "chatroutetok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: auth(), body: JSON.stringify(body || {}) });
const get = (path) => fetch(`${BASE}${path}`, { headers: auth() });

async function waitHealth(ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server not healthy");
}

function boot() {
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "mock", RUNTIME_TOOLS: "none",
      RUNTIME_REPO_ROOT: repo, RUNTIME_SEED_DIRS: "src",
      RUNTIME_DB_PATH: join(root, "x", "db", "mission.db"),
      RUNTIME_SANDBOX_ROOT: join(root, "x", "sb"),
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_PROVIDER_PROBE: "stub",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"),
      RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  return waitHealth();
}
const kill = () => new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-chatroute-")));
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  await boot();
});
after(async () => { await kill(); try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

// Read a full SSE body and return the parsed `event: <name>` frames.
async function readSse(path, body) {
  const res = await post(path, body);
  const text = await res.text();
  const frames = [];
  for (const block of text.split("\n\n")) {
    const ev = /^event: (.+)$/m.exec(block);
    const da = /^data: ([\s\S]*)$/m.exec(block);
    if (ev) frames.push({ event: ev[1].trim(), data: da ? da[1] : "" });
  }
  return frames;
}
const metaOf = (frames) => JSON.parse(frames.find((f) => f.event === "meta").data);

test("chat-capable OpenAI-compatible active account → ADAPTER path (meta mode:api, fail-closed no-model)", async () => {
  const acct = (await (await post("/runtime/accounts", {
    providerType: "custom", label: "openrouter", authMethod: "api_key",
    secret: "sk-or-key", baseUrl: "https://openrouter.ai/api/v1", // no model on purpose
  })).json()).account;
  await post("/runtime/accounts/active", { accountId: acct.id });

  const frames = await readSse(`/runtime/general/chat`, { message: "hello there" });
  const meta = metaOf(frames);
  assert.equal(meta.mode, "api", "adapter path emits meta mode:api");
  assert.equal(meta.providerType, "custom");
  const tokens = frames.filter((f) => f.event === "token").map((f) => JSON.parse(f.data)).join("");
  assert.match(tokens, /model/i, "fail-closed message tells the user to set a model");
  assert.ok(frames.some((f) => f.event === "done"), "stream ends with done");

  await post("/runtime/accounts/active", { accountId: acct.id }); // keep active for cleanup
  await fetch(`${BASE}/runtime/accounts/${acct.id}`, { method: "DELETE", headers: auth() });
});

test("Claude/swarm active account → CLI path unchanged (mock backend → meta mode:mock, NOT api)", async () => {
  const acct = (await (await post("/runtime/accounts", {
    providerType: "claude", label: "sub", authMethod: "subscription",
  })).json()).account;
  await post("/runtime/accounts/active", { accountId: acct.id });

  const frames = await readSse(`/runtime/general/chat`, { message: "hello there" });
  const meta = metaOf(frames);
  assert.notEqual(meta.mode, "api", "a swarm account must NOT take the adapter path");
  assert.equal(meta.mode, "mock", "falls through to the existing CLI/mock path");

  await fetch(`${BASE}/runtime/accounts/${acct.id}`, { method: "DELETE", headers: auth() });
});

test("no active account → CLI/mock path (adapter not taken)", async () => {
  const list = await (await get("/runtime/accounts")).json();
  assert.equal(list.activeAccountId, null, "precondition: no active account");
  const frames = await readSse(`/runtime/general/chat`, { message: "hello there" });
  assert.equal(metaOf(frames).mode, "mock");
});

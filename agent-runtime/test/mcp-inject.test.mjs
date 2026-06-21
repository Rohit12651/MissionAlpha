// ADR-032/033 end-to-end injection — through a REAL booted runtime with a FAKE claude
// binary that records its argv + the injected scoped config. Proves: connector routes
// auth-gated; cred stored via AES broker; grant → scoped .mcp.json injected with
// --strict-mcp-config + --allowed-tools mcp__<name> + the DECRYPTED cred value; an
// UNGRANTED agent gets NO mcp injection; scoped config deleted after spawn; listing
// never leaks the secret value.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, chmodSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const FAKE = join(__dir, "fixtures", "fake-claude.mjs");
const PORT = 3973;
const TOKEN = "mcptok";
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "supersecret_ghp_value_123456789";
let root, mcpDir, fakeOut, child;

const auth = (extra = {}) => ({ Host: `localhost:${PORT}`, "x-runtime-token": TOKEN, "Content-Type": "application/json", ...extra });
const noauth = () => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json" });

async function waitHealth(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server not healthy");
}
async function drainChat(agentId) {
  const res = await fetch(`${BASE}/runtime/${agentId}/chat`, { method: "POST", headers: noauth(), body: JSON.stringify({ message: "hello" }) });
  await res.text(); // drain SSE to completion (fake claude finishes immediately)
  await new Promise((r) => setTimeout(r, 80)); // let close + cleanup run
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "ma-mcpinject-"));
  mcpDir = join(root, "mcpreg");
  fakeOut = join(root, "fake-out.json");
  mkdirSync(mcpDir, { recursive: true });
  chmodSync(FAKE, 0o755);
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env, RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOKEN, RUNTIME_BACKEND: "cli",
      CLAUDE_BIN: FAKE, FAKE_CLAUDE_OUT: fakeOut,
      RUNTIME_MCP_DIR: mcpDir, RUNTIME_TOKEN_DIR: join(root, "tok"),
      RUNTIME_THREADS_DIR: join(root, "threads"), RUNTIME_ENGINE_STORE: join(root, "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "wt"), ANTHROPIC_API_KEY: "",
      BROKER_KEY: "test-broker-key-32-bytes-long-xx",
      FAKE_CLAUDE_ECHO: "1", // echo injected cred values so we can assert SSE scrubbing
      RUNTIME_SEED_DEFAULTS: "0", // deterministic connector list (no pre-seeded Playwright)
    },
    stdio: "ignore",
  });
  await waitHealth();
});
after(() => {
  try { child?.kill("SIGKILL"); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

test("connector routes require auth (401 without token)", async () => {
  const r = await fetch(`${BASE}/factory/connectors`, { headers: noauth() });
  assert.equal(r.status, 401);
  const p = await fetch(`${BASE}/factory/connectors`, { method: "POST", headers: noauth(), body: "{}" });
  assert.equal(p.status, 401);
});

let credId, connectorId;
test("a secret is stored via the AES broker → credId (value never returned)", async () => {
  const r = await fetch(`${BASE}/factory/connectors/cred`, { method: "POST", headers: auth(), body: JSON.stringify({ secret: SECRET }) });
  assert.equal(r.status, 201);
  const j = await r.json();
  credId = j.credId;
  assert.match(credId, /^cred_/);
  assert.ok(!JSON.stringify(j).includes(SECRET), "cred value never echoed");
});

test("a bad launcher command is rejected (no arbitrary exec)", async () => {
  const r = await fetch(`${BASE}/factory/connectors`, { method: "POST", headers: auth(), body: JSON.stringify({ name: "evil", transport: "stdio", command: "bash", args: ["-c", "rm -rf /"] }) });
  assert.equal(r.status, 400);
});

test("add a valid stdio connector with a cred ref", async () => {
  const r = await fetch(`${BASE}/factory/connectors`, { method: "POST", headers: auth(), body: JSON.stringify({ name: "fs", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/data"], envRefs: { GH_TOKEN: credId } }) });
  assert.equal(r.status, 201);
  connectorId = (await r.json()).connector.connectorId;
  assert.match(connectorId, /^mcp_/);
});

test("GET /factory/connectors lists the connector but NEVER the secret value", async () => {
  const j = await (await fetch(`${BASE}/factory/connectors`, { headers: auth() })).json();
  assert.equal(j.connectors.length, 1);
  assert.ok(!JSON.stringify(j).includes(SECRET), "secret value absent from listing");
  assert.deepEqual(j.connectors[0].envRefNames, ["GH_TOKEN"]);
});

test("GRANTED agent: chat injects --mcp-config + --strict-mcp-config + mcp__fs + decrypted cred", async () => {
  await fetch(`${BASE}/factory/connectors/grant`, { method: "POST", headers: auth(), body: JSON.stringify({ agentId: "agent_a", connectorId }) });
  await drainChat("agent_a");
  const rec = JSON.parse(readFileSync(fakeOut, "utf-8"));
  assert.ok(rec.args.includes("--mcp-config"), "--mcp-config injected");
  assert.ok(rec.args.includes("--strict-mcp-config"), "--strict-mcp-config injected (per-agent allowlist)");
  assert.ok(rec.args.includes("mcp__fs"), "whole-server tool granted");
  assert.equal(rec.mcpConfig.mcpServers.fs.env.GH_TOKEN, SECRET, "decrypted cred value reached the scoped config");
  // scoped config file deleted after spawn
  assert.equal(readdirSync(join(root, "tok", "mcp")).length, 0, "scoped config cleaned up");
});

test("egress scrub: an injected cred echoed by the tool is REDACTED from the SSE stream", async () => {
  // agent_a is still granted (fake claude echoes the injected cred value as assistant text)
  const res = await fetch(`${BASE}/runtime/agent_a/chat`, { method: "POST", headers: noauth(), body: JSON.stringify({ message: "echo" }) });
  const body = await res.text();
  assert.ok(!body.includes(SECRET), "raw cred value must NOT appear in the SSE");
  assert.ok(body.includes("[redacted-mcp-cred]"), "cred value redacted on egress");
  await new Promise((r) => setTimeout(r, 80));
});

test("UNGRANTED agent: chat injects NO mcp config (per-agent allowlist enforced)", async () => {
  await drainChat("agent_b");
  const rec = JSON.parse(readFileSync(fakeOut, "utf-8"));
  assert.ok(!rec.args.includes("--mcp-config"), "ungranted agent gets no --mcp-config");
  assert.ok(!rec.args.includes("--strict-mcp-config"));
  assert.equal(rec.mcpConfig, null);
});

test("revoke removes injection for a previously-granted agent", async () => {
  await fetch(`${BASE}/factory/connectors/grant`, { method: "POST", headers: auth(), body: JSON.stringify({ agentId: "agent_a", connectorId, action: "revoke" }) });
  await drainChat("agent_a");
  const rec = JSON.parse(readFileSync(fakeOut, "utf-8"));
  assert.ok(!rec.args.includes("--mcp-config"), "revoked → no injection");
});

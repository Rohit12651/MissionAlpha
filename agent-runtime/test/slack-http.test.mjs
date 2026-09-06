// MUNDER-ADOPTION A7 — Slack ingress AT THE WIRE, through a REAL booted runtime:
// the host-gate exemption (evil Host + valid signature passes — the HMAC is the auth),
// fail-closed 401 on a bad signature, challenge round-trip, 201 mint into the REAL
// delivery store, idempotent redelivery, and the read-only decide refusal (403).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3983, TOK = "slacktok", BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "testsigningsecret-abc123";

let root, repo, child;
const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });

const sign = (body, ts) => `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
const eventBody = (ts = "1755600000.000100") => JSON.stringify({
  type: "event_callback",
  event: { type: "message", channel: "C0DEPLOY", user: "U1BOSS", text: "draft release notes for v1.4", ts },
});

// Raw http so we control the Host header exactly (undici rewrites it).
function raw(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const postSlack = (body, { host = "tunnel.example.com", ts = Math.floor(Date.now() / 1000), sig } = {}) =>
  raw("POST", "/runtime/ingress/slack", {
    Host: host, // NOT loopback on purpose — Slack arrives through a tunnel
    "Content-Type": "application/json",
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": sig ?? sign(body, ts),
  }, body);

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-slackhttp-")));
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  // Pre-seed an ENABLED slack adapter config with the allowlisted channel.
  const adaptersFile = join(root, "x", "adapters.json");
  mkdirSync(dirname(adaptersFile), { recursive: true });
  writeFileSync(adaptersFile, JSON.stringify({ slack: { enabled: true, channelAllowlist: ["C0DEPLOY"] } }));
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "mock", RUNTIME_TOOLS: "write",
      RUNTIME_REPO_ROOT: repo, RUNTIME_SEED_DIRS: "src",
      RUNTIME_DB_PATH: join(root, "x", "db", "mission.db"),
      RUNTIME_SANDBOX_ROOT: join(root, "x", "sb"),
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"),
      RUNTIME_ADAPTERS_FILE: adaptersFile,
      RUNTIME_WORKER_CAP_FILE: join(root, "x", "worker-caps.json"),
      SLACK_SIGNING_SECRET: SECRET,
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/runtime/health`, { headers: H() }); if (r.status) break; } catch { /* boot race */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(async () => {
  await new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

test("a NON-loopback Host with a VALID signature is accepted — the HMAC is the auth", async () => {
  const body = eventBody("1755600000.000100");
  const r = await postSlack(body);
  assert.equal(r.status, 201);
  const parsed = JSON.parse(r.body);
  assert.ok(parsed.id, "a delivery id came back");
});

test("redelivery of the SAME message dedupes onto the same row (idempotent externalKey)", async () => {
  const body = eventBody("1755600000.000100");
  const r = await postSlack(body);
  assert.equal(r.status, 201);
  assert.equal(JSON.parse(r.body).deduped, true);
});

test("a bad signature is 401 — regardless of Host", async () => {
  const body = eventBody("1755600000.000222");
  const r = await postSlack(body, { sig: "v0=deadbeef" });
  assert.equal(r.status, 401);
});

test("an OLD timestamp is 401 even with the matching signature (replay window)", async () => {
  const body = eventBody("1755600000.000333");
  const oldTs = Math.floor(Date.now() / 1000) - 4000;
  const r = await postSlack(body, { ts: oldTs });
  assert.equal(r.status, 401);
});

test("url_verification challenge round-trips", async () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "chal-http-1" });
  const r = await postSlack(body);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).challenge, "chal-http-1");
});

test("the minted slack row is READ-ONLY: decide → 403; it lists with source 'slack'", async () => {
  const list = await (await fetch(`${BASE}/inbox?limit=50`, { headers: auth() })).json();
  const row = (list.deliveries || list.items || []).find((d) => d.source === "slack");
  assert.ok(row, "slack delivery visible in the inbox");
  const dec = await fetch(`${BASE}/inbox/${row.id}/approve`, { method: "POST", headers: auth(), body: "{}" });
  assert.equal(dec.status, 403);
  assert.match(await dec.text(), /read-only/);
});

test("GET on the ingress route is 405; other routes STILL enforce the loopback Host gate", async () => {
  assert.equal((await raw("GET", "/runtime/ingress/slack", { Host: "tunnel.example.com" })).status, 405);
  const r = await raw("GET", "/inbox", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403, "the exemption is ingress-only");
});

// Multi-Provider Credentials (multi-account) — /runtime/accounts/* at the wire.
// Boots a REAL runtime (mock backend, stub probe) with all state under tmp. Mirrors
// the inbox-http harness: no-token 401, evil-Host 403, then add/list/secret/remove/
// active flows. Security invariants: NO plaintext secret ever appears in any response
// body; a probe-capable api_key only persists AFTER the probe accepts; non-probe types
// (minimax/zai/custom) persist store-and-ready. The stub probe rejects any secret that
// starts with "bad-" so probe-gating is provable without hitting a live model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3997, TOK = "provtok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const post = (path, body, headers) => fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body || {}) });
const del = (path, headers) => fetch(`${BASE}${path}`, { method: "DELETE", headers: headers ?? auth() });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });

function raw(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = ""; res.on("data", (c) => { out += c; }); res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject); req.end(body);
  });
}

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
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "mock", RUNTIME_TOOLS: "write",
      RUNTIME_REPO_ROOT: repo, RUNTIME_SEED_DIRS: "src",
      RUNTIME_DB_PATH: join(root, "x", "db", "mission.db"),
      RUNTIME_SANDBOX_ROOT: join(root, "x", "sb"),
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      // stub the connect probe so tests never hit a live model. Accepts any non-empty
      // secret, rejects any secret beginning "bad-". Prod injects the real probe.
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-acct-")));
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  await boot();
});
after(async () => { await kill(); try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

const addAccount = (body) => post("/runtime/accounts", body);

// ── auth gates ───────────────────────────────────────────────────────────────
test("GET /runtime/accounts with no token → 401", async () => {
  assert.equal((await get("/runtime/accounts", H())).status, 401);
});

test("GET /runtime/accounts with an evil Host → 403", async () => {
  const r = await raw("GET", "/runtime/accounts", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
  assert.match(r.body, /forbidden host/);
});

test("every account mutation requires the token → 401", async () => {
  assert.equal((await post("/runtime/accounts", { providerType: "claude", label: "x", authMethod: "subscription" }, H())).status, 401);
  assert.equal((await del("/runtime/accounts/11111111-1111-1111-1111-111111111111", H())).status, 401);
  assert.equal((await post("/runtime/accounts/active", { accountId: "x" }, H())).status, 401);
});

// ── list (empty) ─────────────────────────────────────────────────────────────
test("GET /runtime/accounts → empty accounts + null active + 6 providerTypes", async () => {
  const r = await get("/runtime/accounts");
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(b.accounts, []);
  assert.equal(b.activeAccountId, null);
  // 6 since Phase 13 added `jira`. Counted rather than listed here because
  // providers-credentials.test.mjs pins the exact list.
  assert.equal(b.providerTypes.length, 6);
  assert.ok(b.providerTypes.find((p) => p.type === "custom").needsBaseUrl);
});

// ── create ───────────────────────────────────────────────────────────────────
test("POST /runtime/accounts claude subscription → 200, account, no secret, auto-active swarm", async () => {
  const r = await addAccount({ providerType: "claude", label: "sub-claude", authMethod: "subscription", identifier: "me@x.co" });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true);
  assert.equal(b.account.providerType, "claude");
  assert.equal(b.account.capability, "swarm");
  assert.equal(b.account.hasSecret, false);
  const list = await (await get("/runtime/accounts")).json();
  assert.equal(list.activeAccountId, b.account.id, "first account auto-activates");
  // cleanup
  await del(`/runtime/accounts/${b.account.id}`);
});

test("POST /runtime/accounts custom api_key w/ baseUrl → 200 (store-and-ready, no probe)", async () => {
  const r = await addAccount({ providerType: "custom", label: "local", authMethod: "api_key", secret: "bad-still-ok", baseUrl: "https://llm.internal/v1" });
  assert.equal(r.status, 200, "custom is not probe-capable so a bad- secret still persists");
  const b = await r.json();
  assert.equal(b.account.baseUrl, "https://llm.internal/v1");
  assert.equal(b.account.hasSecret, true);
  assert.equal(b.account.capability, "chat_only");
  await del(`/runtime/accounts/${b.account.id}`);
});

test("POST /runtime/accounts claude api_key with a REJECTED probe → 400, nothing persisted", async () => {
  const r = await addAccount({ providerType: "claude", label: "bad", authMethod: "api_key", secret: "bad-key" });
  assert.equal(r.status, 400);
  const list = await (await get("/runtime/accounts")).json();
  assert.equal(list.accounts.length, 0, "rejected probe persisted nothing");
});

test("POST /runtime/accounts openai api_key with a REJECTED probe → 400", async () => {
  const r = await addAccount({ providerType: "openai", label: "bad", authMethod: "api_key", secret: "bad-key" });
  assert.equal(r.status, 400);
});

test("POST /runtime/accounts minimax api_key persists WITHOUT a live probe (store-and-ready)", async () => {
  const r = await addAccount({ providerType: "minimax", label: "mm", authMethod: "api_key", secret: "bad-but-stored" });
  assert.equal(r.status, 200, "minimax is not probe-capable → secret stored even if it would fail a probe");
  const b = await r.json();
  assert.equal(b.account.capability, "chat_only");
  await del(`/runtime/accounts/${b.account.id}`);
});

test("POST /runtime/accounts openai api_key with empty secret → 400 (secret required)", async () => {
  assert.equal((await addAccount({ providerType: "openai", label: "o", authMethod: "api_key", secret: "" })).status, 400);
});

test("POST /runtime/accounts unknown type → 400; bad label → 400; custom missing baseUrl → 400", async () => {
  assert.equal((await addAccount({ providerType: "bogus", label: "x", authMethod: "api_key", secret: "s" })).status, 400);
  assert.equal((await addAccount({ providerType: "claude", label: "", authMethod: "subscription" })).status, 400);
  assert.equal((await addAccount({ providerType: "custom", label: "c", authMethod: "api_key", secret: "s" })).status, 400);
});

// ── FIX A: SSRF-vetted baseUrl (hermetic — literal IPs, no external host) ─────
test("POST openai api_key with baseUrl http://169.254.169.254/ → 400, nothing persisted", async () => {
  const before = (await (await get("/runtime/accounts")).json()).accounts.length;
  // secret does NOT start with "bad-", so only the SSRF guard can reject this.
  const r = await addAccount({ providerType: "openai", label: "ssrf", authMethod: "api_key", secret: "sk-ok", baseUrl: "http://169.254.169.254/" });
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.match(b.error, /baseUrl|block/i);
  const after = (await (await get("/runtime/accounts")).json()).accounts.length;
  assert.equal(after, before, "SSRF baseUrl persisted nothing");
});

test("POST custom api_key with a private (loopback) baseUrl → 400, nothing persisted", async () => {
  const before = (await (await get("/runtime/accounts")).json()).accounts.length;
  const r = await addAccount({ providerType: "custom", label: "ssrfc", authMethod: "api_key", secret: "s", baseUrl: "http://127.0.0.1:9000/v1" });
  assert.equal(r.status, 400);
  const after = (await (await get("/runtime/accounts")).json()).accounts.length;
  assert.equal(after, before, "private custom baseUrl persisted nothing");
});

// ── two accounts of same type + active/warning/secret/delete ─────────────────
test("two claude accounts coexist; setActive a chat_only account → warning + health reflects it", async () => {
  const c1 = (await (await addAccount({ providerType: "claude", label: "personal", authMethod: "api_key", secret: "sk-ant-P" })).json()).account;
  const c2 = (await (await addAccount({ providerType: "claude", label: "work", authMethod: "api_key", secret: "sk-ant-W" })).json()).account;
  const z = (await (await addAccount({ providerType: "zai", label: "z", authMethod: "api_key", secret: "sk-zai" })).json()).account;
  const list = await (await get("/runtime/accounts")).json();
  assert.equal(list.accounts.filter((a) => a.providerType === "claude").length, 2);

  const r = await post("/runtime/accounts/active", { accountId: z.id });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true);
  // PHASE 1 — the warning no longer says "saved for chat". Under Principle 0 the reason an
  // account cannot run the engine is that it has NOT DEMONSTRATED TOOL SUPPORT, not that it
  // is the wrong brand, and the fix offered must be the probe rather than "switch to Claude".
  assert.match(b.warning, /tool support/i);
  assert.match(b.warning, /probe/i);
  assert.doesNotMatch(b.warning, /claude/i, "the refusal must not name a brand as the remedy");
  const h = await (await fetch(`${BASE}/runtime/health`, { headers: H() })).json();
  assert.equal(h.activeAccount.id, z.id);
  assert.equal(h.activeAccount.capability, "chat_only");

  // replace a secret on an api_key account → 200
  const rep = await post(`/runtime/accounts/${c1.id}/secret`, { secret: "sk-ant-P2" });
  assert.equal(rep.status, 200);

  // DELETE removes one; the rest remain
  const d = await del(`/runtime/accounts/${c2.id}`);
  assert.equal(d.status, 200);
  const after = await (await get("/runtime/accounts")).json();
  assert.ok(!after.accounts.find((a) => a.id === c2.id), "deleted account is gone");

  // reset: make a swarm account active + clean up
  await post("/runtime/accounts/active", { accountId: c1.id });
  await del(`/runtime/accounts/${c1.id}`);
  await del(`/runtime/accounts/${z.id}`);
});

test("POST /runtime/accounts/active unknown id → 400; secret endpoint bad-uuid → 400", async () => {
  assert.equal((await post("/runtime/accounts/active", { accountId: "11111111-1111-1111-1111-111111111111" })).status, 400);
  assert.equal((await post("/runtime/accounts/not-a-uuid/secret", { secret: "s" })).status, 400);
});

test("no secret string ever appears across a full add→list→health sweep", async () => {
  const b = (await (await addAccount({ providerType: "claude", label: "deep", authMethod: "api_key", secret: "sk-ant-DEEPSCAN" })).json()).account;
  const list = await (await get("/runtime/accounts")).text();
  const health = await (await fetch(`${BASE}/runtime/health`, { headers: H() })).text();
  assert.ok(!list.includes("sk-ant-DEEPSCAN"), "secret leaked into /runtime/accounts");
  assert.ok(!health.includes("sk-ant-DEEPSCAN"), "secret leaked into /runtime/health");
  await del(`/runtime/accounts/${b.id}`);
});

// ── optional model field over the wire ───────────────────────────────────────
test("POST custom api_key with a model → 200, model persisted + listed", async () => {
  const r = await addAccount({ providerType: "custom", label: "or", authMethod: "api_key", secret: "sk-or", baseUrl: "https://openrouter.ai/api/v1", model: "nvidia/nemotron:free" });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.account.model, "nvidia/nemotron:free");
  const list = await (await get("/runtime/accounts")).json();
  assert.equal(list.accounts.find((a) => a.id === b.account.id).model, "nvidia/nemotron:free");
  await del(`/runtime/accounts/${b.account.id}`);
});

test("POST custom api_key with an over-128-char model → 400, nothing persisted", async () => {
  const before = (await (await get("/runtime/accounts")).json()).accounts.length;
  const r = await addAccount({ providerType: "custom", label: "bigm", authMethod: "api_key", secret: "s", baseUrl: "https://x/v1", model: "m".repeat(129) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /model/i);
  const after = (await (await get("/runtime/accounts")).json()).accounts.length;
  assert.equal(after, before);
});

// ── legacy alias kept because src/lib/providers.ts still GETs it ──────────────
test("GET /runtime/providers alias still returns the providerTypes catalog", async () => {
  const r = await get("/runtime/providers");
  assert.equal(r.status, 200);
  const b = await r.json();
  // 6 since Phase 13 added `jira`. Counted rather than listed here because
  // providers-credentials.test.mjs pins the exact list.
  assert.equal(b.providerTypes.length, 6);
});

// ── PATCH /runtime/accounts/:id (Phase 1, excellence program) ────────────────
// The route that closes the "edit the account" defect. Invariants pinned here:
// the secret is never echoed, the SSRF guard applies to edits exactly as it does to
// creates, auth/Host gating is identical to every sibling route, and providerType
// stays immutable.
const patch = (path, body, headers) =>
  fetch(`${BASE}${path}`, { method: "PATCH", headers: headers ?? auth(), body: JSON.stringify(body || {}) });

test("PATCH sets a model and never echoes the secret", async () => {
  const created = await (await post("/runtime/accounts", {
    providerType: "custom", label: "or-patch", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "sk-or-v1-nevershown",
  })).json();
  assert.ok(created.account?.id, "setup: account created");

  const res = await patch(`/runtime/accounts/${created.account.id}`, { model: "nvidia/nemotron-nano-9b-v2:free" });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes("sk-or-v1-nevershown"), "SECURITY: secret leaked in PATCH response");
  assert.equal(JSON.parse(text).account.model, "nvidia/nemotron-nano-9b-v2:free");

  // and it persisted — a subsequent GET must show it
  const listed = await (await get("/runtime/accounts")).json();
  const found = listed.accounts.find((a) => a.id === created.account.id);
  assert.equal(found.model, "nvidia/nemotron-nano-9b-v2:free", "edit did not persist");
});

test("PATCH without a token is 401", async () => {
  const res = await patch("/runtime/accounts/00000000-0000-4000-8000-000000000000", { model: "x" }, H());
  assert.equal(res.status, 401);
});

test("PATCH from an evil Host is 403", async () => {
  // MUST use raw(): fetch() treats Host as a forbidden header and silently rewrites it,
  // so a fetch-based "evil Host" test never actually reaches the hostOk gate. The sibling
  // GET evil-Host test above uses raw() for exactly this reason.
  const r = await raw("PATCH", "/runtime/accounts/00000000-0000-4000-8000-000000000000",
    { Host: "evil.com", "Content-Type": "application/json", "x-runtime-token": TOK },
    JSON.stringify({ model: "x" }));
  assert.equal(r.status, 403);
});

test("PATCH rejects an SSRF baseUrl (link-local metadata endpoint)", async () => {
  const created = await (await post("/runtime/accounts", {
    providerType: "custom", label: "or-ssrf", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "k",
  })).json();
  const res = await patch(`/runtime/accounts/${created.account.id}`, { baseUrl: "http://169.254.169.254/latest/meta-data/" });
  assert.equal(res.status, 400, "SECURITY: SSRF guard bypassed via edit");
});

test("PATCH refuses a providerType change", async () => {
  const created = await (await post("/runtime/accounts", {
    providerType: "custom", label: "or-type", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "k",
  })).json();
  const res = await patch(`/runtime/accounts/${created.account.id}`, { providerType: "claude" });
  assert.equal(res.status, 400);
});

test("PATCH with a malformed id is 400, and an empty patch is 400", async () => {
  assert.equal((await patch("/runtime/accounts/not-a-uuid", { model: "m" })).status, 400);
  const created = await (await post("/runtime/accounts", {
    providerType: "custom", label: "or-empty", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "k",
  })).json();
  assert.equal((await patch(`/runtime/accounts/${created.account.id}`, {})).status, 400);
});

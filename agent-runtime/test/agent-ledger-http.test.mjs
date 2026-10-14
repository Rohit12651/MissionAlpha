// PHASE 6 — the agent-ledger route, over the wire, through a REAL booted runtime.
//
// agent-ledger.test.mjs proves the arithmetic. This proves the WIRING, which is where
// this project's defects have actually lived: a PATCH route that existed but was 405'd by
// the method allowlist, a bulk route that sat outside routeNeedsApprover. A correct
// aggregate nobody can reach is worth nothing.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
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
const PORT = 3986;
const TOK = "ledgertok";
const BASE = `http://127.0.0.1:${PORT}`;

let root, repo, sbRoot, dbPath, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });
const post = (path, body) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: auth(), body: JSON.stringify(body || {}) });

function raw(method, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitHealth(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).ok) return; } catch { /* boot */ }
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
      RUNTIME_DB_PATH: dbPath, RUNTIME_SANDBOX_ROOT: sbRoot,
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"),
      RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"),
      RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  return waitHealth();
}
const kill = () => new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });

const sandboxWrite = (agentId, rel, text) => {
  const f = join(sbRoot, agentId, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
};

/** Mint a delivery through the real /changes path, then decide it. */
async function mintAndDecide(agentId, rel, verb) {
  sandboxWrite(agentId, rel, `export const v = "${rel}";\n`);
  await get(`/runtime/${agentId}/changes`);
  const list = await (await get(`/inbox?agentId=${agentId}&limit=100`)).json();
  const row = list.deliveries.find((d) => d.agentId === agentId && d.status === "pending");
  assert.ok(row, `no pending delivery for ${agentId}`);
  if (verb) {
    const r = await post(`/inbox/${row.id}/${verb}`, verb === "request-changes" ? { feedback: "fix it" } : {});
    assert.ok(r.ok || r.status === 200, `decide ${verb} failed: ${r.status}`);
  }
  return row.id;
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-ledger-")));
  repo = join(root, "repo");
  sbRoot = join(root, "x", "sb");
  dbPath = join(root, "x", "db", "mission.db");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  await boot();
});
after(async () => {
  await kill();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

// ── reachability + gating ──────────────────────────────────────────────────────

test("GET /runtime/agent-ledger is REACHABLE with a token (not 404, not 405)", async () => {
  const res = await get("/runtime/agent-ledger?window=7d");
  assert.equal(res.status, 200, "the route is unreachable — check needsAuth's allowlist");
  const body = await res.json();
  assert.ok(Array.isArray(body.agents), "no agents array");
  assert.equal(body.minDecisionsForRate, 5);
});

test("SECURITY: no token → 401", async () => {
  assert.equal((await get("/runtime/agent-ledger", H())).status, 401);
});

test("SECURITY: an evil Host → 403 (DNS-rebinding gate)", async () => {
  const r = await raw("GET", "/runtime/agent-ledger", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
});

test("a non-GET verb is refused", async () => {
  assert.equal((await post("/runtime/agent-ledger", {})).status, 405);
});

test("a malformed window is a 400, not a silent default", async () => {
  for (const w of ["7", "week", "7x", "-1d", "9999999d9"]) {
    const res = await get(`/runtime/agent-ledger?window=${encodeURIComponent(w)}`);
    assert.equal(res.status, 400, `window=${w} was silently accepted`);
  }
});

test("an absent window defaults to 7d rather than erroring", async () => {
  const body = await (await get("/runtime/agent-ledger")).json();
  assert.equal(body.windowMs, 7 * 24 * 3600_000);
});

test("an out-of-range window is clamped, not rejected", async () => {
  const body = await (await get("/runtime/agent-ledger?window=9999d")).json();
  assert.equal(body.windowMs, 90 * 24 * 3600_000, "the 90d clamp did not hold");
});

// ── the numbers are REAL, end to end ───────────────────────────────────────────

test("WIRING PROOF: approving a delivery moves that agent's ledger row", async () => {
  const before = await (await get("/runtime/agent-ledger?window=7d")).json();
  const b = before.agents.find((a) => a.agentId === "ledger-a");
  assert.equal(b, undefined, "the agent already existed — the test is not measuring its own effect");

  await mintAndDecide("ledger-a", "src/one.ts", "approve");

  const after = await (await get("/runtime/agent-ledger?window=7d")).json();
  const a = after.agents.find((x) => x.agentId === "ledger-a");
  assert.ok(a, "the approved delivery never reached the ledger");
  assert.equal(a.delivered, 1);
  assert.equal(a.approved, 1);
  assert.equal(a.decisions, 1);
});

test("HONESTY RULE holds over the wire: 1 decision shows no rate", async () => {
  const body = await (await get("/runtime/agent-ledger?window=7d")).json();
  const a = body.agents.find((x) => x.agentId === "ledger-a");
  assert.equal(a.rated, false);
  assert.equal(a.approvalRate, null, "a percentage on one decision is fabricated confidence");
});

test("HONESTY RULE flips at 5 decisions, and the rate is arithmetically right", async () => {
  // 4 more approvals on the same agent → 5 decisions, all approved.
  for (const n of ["two", "three", "four", "five"]) {
    await mintAndDecide("ledger-a", `src/${n}.ts`, "approve");
  }
  const body = await (await get("/runtime/agent-ledger?window=7d")).json();
  const a = body.agents.find((x) => x.agentId === "ledger-a");
  assert.equal(a.decisions, 5);
  assert.equal(a.rated, true);
  assert.equal(a.approvalRate, 1);

  // A rejection then makes it 5 of 6 — re-derived by hand, not copied from the response.
  await mintAndDecide("ledger-a", "src/six.ts", "reject");
  const after = await (await get("/runtime/agent-ledger?window=7d")).json();
  const a2 = after.agents.find((x) => x.agentId === "ledger-a");
  assert.equal(a2.decisions, 6);
  assert.equal(a2.rejected, 1);
  assert.equal(a2.approvalRate, 5 / 6);
});

test("a pending delivery is counted as delivered but never as a decision", async () => {
  await mintAndDecide("ledger-pending", "src/p.ts", null);
  const body = await (await get("/runtime/agent-ledger?window=7d")).json();
  const a = body.agents.find((x) => x.agentId === "ledger-pending");
  assert.equal(a.delivered, 1);
  assert.equal(a.pending, 1);
  assert.equal(a.decisions, 0);
  assert.equal(a.approvalRate, null);
});

test("no ledger field ever renders NaN over the wire", async () => {
  const text = await (await get("/runtime/agent-ledger?window=7d")).text();
  assert.doesNotMatch(text, /NaN|Infinity/, "a division-by-zero leaked into the payload");
});

// ── PHASE 7 — the spend route, on the same booted runtime ─────────────────────

test("GET /runtime/spend is REACHABLE and reports nothing on a subscription runtime", async () => {
  const res = await get("/runtime/spend?window=7d");
  assert.equal(res.status, 200, "the route is unreachable — check needsAuth's allowlist");
  const body = await res.json();
  // This runtime has no api_key account configured, so nothing is metered and nothing
  // was written. `usd` MUST be null, never 0 — zero would read as "we spent nothing",
  // which is a claim about money rather than the truth ("there is no price here").
  assert.equal(body.usd, null);
  assert.equal(body.meteredTurns, 0);
  assert.equal(body.mixed, false);
  assert.equal(body.activeMetered, false);
  assert.deepEqual(body.agents, []);
});

test("SECURITY: /runtime/spend requires the token and rejects an evil Host", async () => {
  assert.equal((await get("/runtime/spend", H())).status, 401);
  const r = await raw("GET", "/runtime/spend", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
});

test("/runtime/spend refuses a non-GET verb and a malformed window", async () => {
  assert.equal((await post("/runtime/spend", {})).status, 405);
  assert.equal((await get("/runtime/spend?window=week")).status, 400);
});

test("NO FABRICATED MONEY: the spend payload never contains a 0 total or a NaN", async () => {
  const text = await (await get("/runtime/spend?window=7d")).text();
  assert.doesNotMatch(text, /NaN|Infinity/);
  assert.match(text, /"usd":null/, "an unmetered runtime must report null, not 0");
});

// B7 / outputs — the artifact registry at the wire, through a REAL booted runtime (mock backend,
// ephemeral state under tmp). Proves the B7 exit criteria:
//   viewer-readable GET /runtime/outputs (generators + produced list) → generating an audit
//   export (P8) RECORDS an artifact row + emits output.created on an open SSE stream → the
//   produced bundle then appears in the registry.
// Plus the adversarial slice BLOCKING for this phase: no-token 401, evil Host 403, method 405.
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
const PORT = 3987, TOK = "outputstok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, sbRoot, dbPath, vaultDir, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const post = (path, body, headers) => fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body ?? {}) });
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
      RUNTIME_DB_PATH: dbPath, RUNTIME_VAULT_DIR: vaultDir, RUNTIME_SANDBOX_ROOT: sbRoot,
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"), RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  return waitHealth();
}
const kill = () => new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });

async function openSse({ ticket } = {}) {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/runtime/events?ticket=${ticket}`, { headers: { Host: `localhost:${PORT}` }, signal: ac.signal });
  const frames = [];
  if (res.status !== 200) { ac.abort(); return { status: res.status, frames, close: () => {} }; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const rawFrame = buf.slice(0, i); buf = buf.slice(i + 2);
          if (rawFrame.startsWith(":")) continue;
          const f = { at: Date.now() };
          for (const line of rawFrame.split("\n")) {
            if (line.startsWith("event: ")) f.event = line.slice(7);
            else if (line.startsWith("data: ")) { try { f.data = JSON.parse(line.slice(6)); } catch { f.data = null; } }
          }
          frames.push(f);
        }
      }
    } catch { /* aborted */ }
  })();
  return { status: res.status, frames, close: () => ac.abort() };
}
async function waitFrame(sse, pred, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = sse.frames.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`no matching SSE frame within ${ms}ms (saw: ${JSON.stringify(sse.frames.map((f) => f.event))})`);
}
const newTicket = async () => (await (await post("/runtime/events/ticket", {})).json()).ticket;

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-outputshttp-")));
  repo = join(root, "repo");
  sbRoot = join(root, "x", "sb");
  dbPath = join(root, "x", "db", "mission.db");
  vaultDir = join(root, "x", "db", "vault");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  await boot();
});
after(async () => { await kill(); try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

// ── adversarial: auth gate ────────────────────────────────────────────────────
test("GET /runtime/outputs requires the token → 401", async () => {
  assert.equal((await get("/runtime/outputs", H())).status, 401);
});

test("an evil Host is refused on /runtime/outputs → 403 (raw http)", async () => {
  const r = await raw("GET", "/runtime/outputs", { Host: "evil.com", "x-runtime-token": TOK });
  assert.equal(r.status, 403);
  assert.match(r.body, /forbidden host/);
});

test("a non-GET method on /runtime/outputs → 405", async () => {
  const r = await post("/runtime/outputs", {});
  assert.equal(r.status, 405);
});

// ── viewer read starts empty, generator always present ────────────────────────
test("GET /runtime/outputs is viewer-readable, starts with the audit generator and an empty produced list", async () => {
  const r = await get("/runtime/outputs?venture=waahyu");
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(b.outputs, []);
  assert.ok(Array.isArray(b.generators));
  const audit = b.generators.find((g) => g.kind === "audit");
  assert.ok(audit, "the audit generator must always be listed");
  assert.equal(audit.ref, "/runtime/audit/export");
});

// ── the WIRE: generating an audit export records an artifact + emits output.created ──
test("generating an audit export RECORDS an artifact row and emits output.created on the bus", async () => {
  const sse = await openSse({ ticket: await newTicket() });
  assert.equal(sse.status, 200);
  try {
    const exp = await get("/runtime/audit/export?format=json");
    assert.equal(exp.status, 200);
    await exp.text(); // drain the streamed bundle so the response settles

    const f = await waitFrame(sse, (x) => x.event === "output.created");
    assert.equal(f.data.kind, "audit");
    // identity ONLY on the bus — never the label or ref
    assert.equal(f.data.label, undefined);
    assert.equal(f.data.ref, undefined);

    // the produced bundle now appears in the registry (global artifact → shows under "all")
    const reg = await (await get("/runtime/outputs")).json();
    const row = reg.outputs.find((o) => o.id === f.data.id);
    assert.ok(row, "the generated audit bundle must be recorded in the registry");
    assert.equal(row.kind, "audit");
    assert.equal(row.venture, null); // global — the audit bundle spans every venture
    assert.match(row.ref, /^\/runtime\/audit\/export/);
  } finally { sse.close(); }
});

test("re-downloading the SAME bundle is idempotent — no duplicate registry row", async () => {
  await (await get("/runtime/audit/export?format=json")).text();
  await (await get("/runtime/audit/export?format=json")).text();
  const reg = await (await get("/runtime/outputs")).json();
  const auditRows = reg.outputs.filter((o) => o.kind === "audit");
  assert.equal(auditRows.length, 1, "same-day same-range re-downloads must dedupe to one row");
});

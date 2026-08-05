// B2 / ADR-055 — the Knowledge Vault at the wire, through a REAL booted runtime
// (mock backend, ephemeral state under tmp). Proves the B2 exit criteria:
//   viewer-readable GET list/record/stats → approver-gated POST → vault.written on an
//   open SSE stream → the DECISION hook writes a `decisions` record when a Delivery is
//   approved → records survive a restart.
// Plus the adversarial sweep BLOCKING for this phase: no-token 401, evil Host 403,
// viewer POST 403, bad node / bad venture / empty title 400, traversal + malformed id
// 404, secret scrubbed out of the row, the file AND the SSE frame.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3992, TOK = "vaulttok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, sbRoot, dbPath, vaultDir, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const authCk = (cookie, x = {}) => auth(cookie ? { Cookie: cookie, ...x } : x);
const post = (path, body, headers) => fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body ?? {}) });
const del = (path, headers) => fetch(`${BASE}${path}`, { method: "DELETE", headers: headers ?? auth() });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });

function cookieFrom(res) {
  const m = (res.headers.get("set-cookie") || "").match(/ma_session=([^;]*)/);
  return m ? `ma_session=${m[1]}` : null;
}

// undici rewrites Host to the connected authority, so the DNS-rebinding gate can only
// be exercised through a raw node:http request.
function raw(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    req.end(body);
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
      RUNTIME_DB_PATH: dbPath,
      RUNTIME_VAULT_DIR: vaultDir,
      RUNTIME_SANDBOX_ROOT: sbRoot,
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"),
      RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  return waitHealth();
}
const kill = () => new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });

// ── SSE client (same shape as inbox-http.test.mjs) ──────────────────────────
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
            if (line.startsWith("id: ")) f.id = Number(line.slice(4));
            else if (line.startsWith("event: ")) f.event = line.slice(7);
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
async function run(agentId, task) {
  const r = await post(`/runtime/${agentId}/run`, { task });
  await r.text();
  return r.status;
}
const sandboxWrite = (agentId, rel, text) => {
  const f = join(sbRoot, agentId, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
};

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-vaulthttp-")));
  repo = join(root, "repo");
  sbRoot = join(root, "x", "sb");
  dbPath = join(root, "x", "db", "mission.db");
  vaultDir = join(root, "x", "db", "vault");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  await boot();
});
after(async () => {
  await kill();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

// ── adversarial: auth gates ──────────────────────────────────────────────────

test("every vault route requires the token → 401", async () => {
  assert.equal((await get("/runtime/vault", H())).status, 401);
  assert.equal((await get("/runtime/vault/stats", H())).status, 401);
  assert.equal((await get("/runtime/vault/record?id=abc", H())).status, 401);
  assert.equal((await post("/runtime/vault/record", { venture: "waahyu", node: "tech", title: "x", body: "y" }, H())).status, 401);
});

test("an evil Host is refused on every vault route → 403 (DNS-rebinding gate, raw http)", async () => {
  for (const p of ["/runtime/vault", "/runtime/vault/stats", "/runtime/vault/record?id=abc"]) {
    const r = await raw("GET", p, { Host: "evil.com", "x-runtime-token": TOK });
    assert.equal(r.status, 403, p);
    assert.match(r.body, /forbidden host/);
  }
  const w = await raw("POST", "/runtime/vault/record", { Host: "evil.com", "x-runtime-token": TOK, "Content-Type": "application/json" }, "{}");
  assert.equal(w.status, 403);
});

// ── reads ───────────────────────────────────────────────────────────────────

test("GET /runtime/vault/stats starts empty, zero-filled across the whole taxonomy", async () => {
  const r = await get("/runtime/vault/stats");
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.total, 0);
  assert.deepEqual(Object.keys(s.byNode).sort(), ["content", "decisions", "market", "pipeline", "tech", "ventures"]);
  for (const n of Object.keys(s.byNode)) assert.equal(s.byNode[n], 0, n);
  assert.deepEqual(s.byVenture, { waahyu: 0 }, "the seeded venture is listed even at zero");
});

test("GET /runtime/vault lists nothing yet", async () => {
  const r = await get("/runtime/vault");
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).records, []);
});

// ── write + bus ─────────────────────────────────────────────────────────────

let writtenId = null;

test("POST /runtime/vault/record persists a record and emits vault.written on the open stream", async () => {
  const sse = await openSse({ ticket: await newTicket() });
  assert.equal(sse.status, 200);
  try {
    const t0 = Date.now();
    const r = await post("/runtime/vault/record", {
      venture: "waahyu", node: "market", title: "Competitor sweep",
      body: "# Findings\n\nThree new entrants this week.\n",
    });
    assert.equal(r.status, 201);
    const body = await r.json();
    writtenId = body.record.id;
    assert.equal(body.record.node, "market");
    assert.equal(body.record.venture, "waahyu");
    assert.equal(body.record.title, "Competitor sweep");

    const f = await waitFrame(sse, (x) => x.event === "vault.written");
    assert.ok(f.at - t0 < 500, `vault.written ${f.at - t0}ms after the write (budget 500ms)`);
    assert.deepEqual(f.data, { id: writtenId, node: "market", venture: "waahyu", agent: f.data.agent });
    assert.ok(f.id > 0, "frame carries an id for Last-Event-ID");
    // Identity only: the bus reaches every seat, so no title/body ever rides it.
    assert.equal(f.data.title, undefined);
    assert.equal(f.data.body, undefined);
  } finally { sse.close(); }
});

test("the record is a real markdown file on disk with a provenance header", async () => {
  const f = join(vaultDir, "waahyu", "market", `${writtenId}.md`);
  assert.ok(existsSync(f), `expected ${f}; tree: ${JSON.stringify(readdirSync(vaultDir))}`);
  const text = readFileSync(f, "utf-8");
  assert.match(text, /^---\n/);
  assert.match(text, /\nventure: waahyu\n/);
  assert.match(text, /\nnode: market\n/);
  assert.match(text, /\nwritten: \d{4}-\d{2}-\d{2}T/);
  assert.ok(text.includes("Three new entrants this week."));
});

test("GET /runtime/vault + /record + /stats now reflect the write", async () => {
  const list = await (await get("/runtime/vault")).json();
  assert.equal(list.records.length, 1);
  assert.equal(list.records[0].id, writtenId);

  const rec = await (await get(`/runtime/vault/record?id=${writtenId}`)).json();
  assert.equal(rec.meta.id, writtenId);
  assert.equal(rec.body, "# Findings\n\nThree new entrants this week.\n");

  const s = await (await get("/runtime/vault/stats")).json();
  assert.equal(s.total, 1);
  assert.equal(s.byNode.market, 1);
  assert.deepEqual(s.byVenture, { waahyu: 1 });
});

test("GET /runtime/vault filters by node, by venture and by q", async () => {
  await post("/runtime/vault/record", { venture: "waahyu", node: "tech", title: "Repo health", body: "beta signal inside" });
  assert.equal((await (await get("/runtime/vault?node=market")).json()).records.length, 1);
  assert.equal((await (await get("/runtime/vault?node=tech")).json()).records.length, 1);
  assert.equal((await (await get("/runtime/vault?venture=waahyu")).json()).records.length, 2);
  assert.equal((await (await get("/runtime/vault?q=Competitor")).json()).records.length, 1, "title hit");
  assert.equal((await (await get("/runtime/vault?q=beta%20signal")).json()).records.length, 1, "excerpt hit");
  assert.deepEqual((await (await get("/runtime/vault?q=%25")).json()).records, [], "a LIKE wildcard is literal");
  assert.deepEqual((await (await get("/runtime/vault?node=..%2Fetc")).json()).records, [], "an unknown node filter is empty, never an error");
  assert.deepEqual((await (await get("/runtime/vault?venture=ghost")).json()).records, []);
});

// ── adversarial: bad input ──────────────────────────────────────────────────

test("POST with an unknown node → 400, and nothing lands on disk", async () => {
  const r = await post("/runtime/vault/record", { venture: "waahyu", node: "finance", title: "x", body: "y" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /node/);
  assert.equal(existsSync(join(vaultDir, "waahyu", "finance")), false);
});

test("POST with an unknown venture → 400 (a venture is never auto-created from a request)", async () => {
  const r = await post("/runtime/vault/record", { venture: "ghost", node: "tech", title: "x", body: "y" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /venture/);
  assert.equal(existsSync(join(vaultDir, "ghost")), false);
});

test("POST with a traversal venture / node → 400, and nothing escapes the vault root", async () => {
  for (const b of [
    { venture: "../../../etc", node: "tech" },
    { venture: "waahyu", node: "../.." },
    { venture: "/etc", node: "tech" },
    { venture: "WAAHYU", node: "tech" },      // mixed-case escape
    { venture: "waahyu", node: "MARKET" },
  ]) {
    const r = await post("/runtime/vault/record", { ...b, title: "pwned", body: "pwned" });
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  assert.equal(existsSync(join(root, "x", "db", "pwned.md")), false);
  assert.equal(existsSync(join(root, "pwned.md")), false);
  assert.deepEqual(readdirSync(vaultDir).sort(), ["waahyu"], "the vault tree still has exactly one venture dir");
});

test("POST with an empty title → 400; a caller-supplied id is IGNORED (ids are server-minted)", async () => {
  assert.equal((await post("/runtime/vault/record", { venture: "waahyu", node: "tech", title: "   ", body: "y" })).status, 400);
  const r = await post("/runtime/vault/record", { venture: "waahyu", node: "tech", title: "id attempt", body: "y", id: "../../../pwned" });
  assert.equal(r.status, 201);
  const id = (await r.json()).record.id;
  assert.notEqual(id, "../../../pwned");
  assert.match(id, /^[a-z0-9][a-z0-9-]{0,63}$/);
});

test("POST caps the title at 200 and the body at 32KB rather than refusing a long document", async () => {
  const r = await post("/runtime/vault/record", {
    venture: "waahyu", node: "tech", title: "t".repeat(500), body: "b".repeat(40_000),
  });
  assert.equal(r.status, 201);
  const id = (await r.json()).record.id;
  const rec = await (await get(`/runtime/vault/record?id=${id}`)).json();
  assert.equal(rec.meta.title.length, 200);
  assert.equal(rec.body.length, 32_768);
});

test("POST past the 64KB TRANSPORT cap is refused at the socket (memory-exhaustion guard)", async () => {
  await assert.rejects(
    () => post("/runtime/vault/record", { venture: "waahyu", node: "tech", title: "huge", body: "b".repeat(200_000) }),
    "the reader destroys the request rather than buffering an unbounded document",
  );
  assert.equal((await get("/runtime/vault")).status, 200, "and the server is still serving");
});

test("GET /runtime/vault/record with an unknown, malformed or traversal id → 404", async () => {
  assert.equal((await get("/runtime/vault/record?id=nosuchrecord")).status, 404);
  assert.equal((await get("/runtime/vault/record?id=..%2F..%2Fetc%2Fpasswd")).status, 404);
  assert.equal((await get("/runtime/vault/record?id=")).status, 404);
  assert.equal((await get("/runtime/vault/record")).status, 404);
});

test("a token-shaped secret is scrubbed out of the row, the file AND the SSE frame", async () => {
  const sse = await openSse({ ticket: await newTicket() });
  try {
    const r = await post("/runtime/vault/record", {
      venture: "waahyu", node: "tech",
      title: "leak sk-ant-DEADBEEF01 here", body: "body carries sk-ant-DEADBEEF01 too",
    });
    assert.equal(r.status, 201);
    const id = (await r.json()).record.id;
    const rec = await (await get(`/runtime/vault/record?id=${id}`)).json();
    assert.ok(!rec.meta.title.includes("sk-ant-DEADBEEF01"), "title scrubbed on egress");
    assert.ok(!rec.body.includes("sk-ant-DEADBEEF01"), "body scrubbed on egress");
    assert.match(rec.body, /\[redacted-secret\]/);
    const disk = readFileSync(join(vaultDir, "waahyu", "tech", `${id}.md`), "utf-8");
    assert.ok(!disk.includes("sk-ant-DEADBEEF01"), "NOTHING secret reached disk");
    const f = await waitFrame(sse, (x) => x.event === "vault.written" && x.data?.id === id);
    assert.ok(!JSON.stringify(f.data).includes("sk-ant-DEADBEEF01"));
  } finally { sse.close(); }
});

// ── the DECISION hook ───────────────────────────────────────────────────────

test("approving a Delivery writes a `decisions` record authored by the decider", async () => {
  const sse = await openSse({ ticket: await newTicket() });
  try {
    // Warm the copy-sandbox, then put a real change in it so /run mints a Delivery.
    assert.equal(await run("vault-a", "warm the sandbox"), 200);
    sandboxWrite("vault-a", "src/vaulted.ts", "export const v = 1;\n");
    assert.equal(await run("vault-a", "add a vaulted module"), 200);
    await waitFrame(sse, (x) => x.event === "delivery.created");

    const before = (await (await get("/runtime/vault?node=decisions")).json()).records.length;
    const id = (await (await get("/inbox?status=pending")).json()).deliveries[0].id;
    assert.equal((await post(`/inbox/${id}/approve`, { by: "BOSS" })).status, 200);

    const f = await waitFrame(sse, (x) => x.event === "vault.written" && x.data?.node === "decisions");
    assert.equal(f.data.venture, "waahyu");
    const recs = (await (await get("/runtime/vault?node=decisions")).json()).records;
    assert.equal(recs.length, before + 1);
    const rec = recs[0];
    assert.match(rec.title, /^APPROVED — /, `title was ${rec.title}`);
    assert.equal(rec.author, "boss", "the DECIDER authors the decision record, not the agent");
    const full = await (await get(`/runtime/vault/record?id=${rec.id}`)).json();
    assert.match(full.body, /vault-a/, "the body names the agent whose work was decided");
  } finally { sse.close(); }
});

test("deciding the same Delivery twice never writes a second decision record (409 changes nothing)", async () => {
  const id = (await (await get("/inbox?status=approved")).json()).deliveries[0].id;
  const before = (await (await get("/runtime/vault?node=decisions")).json()).records.length;
  assert.equal((await post(`/inbox/${id}/reject`, { by: "BOSS" })).status, 409);
  assert.equal((await (await get("/runtime/vault?node=decisions")).json()).records.length, before);
});

// ── durability ──────────────────────────────────────────────────────────────

test("records survive a restart — the index and the files are both durable", async () => {
  const before = await (await get("/runtime/vault/stats")).json();
  assert.ok(before.total > 0);
  await kill();
  await boot();
  const after = await (await get("/runtime/vault/stats")).json();
  assert.deepEqual(after, before, "same totals, same node histogram, same ventures");
  const rec = await (await get(`/runtime/vault/record?id=${writtenId}`)).json();
  assert.equal(rec.body, "# Findings\n\nThree new entrants this week.\n");
});

// ── adversarial: role enforcement (auth ACTIVE) ─────────────────────────────
// Runs LAST: activating auth (≥2 accounts) changes the gate for every route above.

let approverCk = null, viewerCk = null, aliceId = null, vicId = null;

test("activate auth: two accounts, one approver and one viewer", async () => {
  const a = await post("/runtime/users", { name: "Alice", password: "alice-passphrase", role: "approver" });
  assert.equal(a.status, 201);
  aliceId = (await a.json()).user.id;
  const v = await post("/runtime/users", { name: "Vic", password: "vic-passphrase", role: "viewer" });
  assert.equal(v.status, 201);
  vicId = (await v.json()).user.id;
  approverCk = cookieFrom(await post("/runtime/auth/login", { name: "Alice", password: "alice-passphrase" }));
  viewerCk = cookieFrom(await post("/runtime/auth/login", { name: "Vic", password: "vic-passphrase" }));
  assert.ok(approverCk && viewerCk);
});

test("auth active: the token alone no longer reads the vault → 401 (a session is required)", async () => {
  assert.equal((await get("/runtime/vault")).status, 401);
  assert.equal((await get("/runtime/vault/stats")).status, 401);
});

test("auth active: a VIEWER may READ the vault (a glance, not a decision)", async () => {
  assert.equal((await get("/runtime/vault", authCk(viewerCk))).status, 200);
  assert.equal((await get("/runtime/vault/stats", authCk(viewerCk))).status, 200);
  assert.equal((await get(`/runtime/vault/record?id=${writtenId}`, authCk(viewerCk))).status, 200);
});

test("auth active: a VIEWER writing a record → 403 via direct request, and nothing lands", async () => {
  const before = (await (await get("/runtime/vault/stats", authCk(viewerCk))).json()).total;
  const r = await post("/runtime/vault/record", { venture: "waahyu", node: "tech", title: "viewer wrote this", body: "nope" }, authCk(viewerCk));
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /approver/);
  assert.equal((await (await get("/runtime/vault/stats", authCk(viewerCk))).json()).total, before, "the viewer changed nothing");
});

test("auth active: an APPROVER writes, and the record is authored by the SESSION identity", async () => {
  const r = await post("/runtime/vault/record", { venture: "waahyu", node: "content", title: "Approver brief", body: "x" }, authCk(approverCk));
  assert.equal(r.status, 201);
  assert.equal((await r.json()).record.author, "alice", "author is the authenticated seat, not a client-supplied string");
});

test("auth active: a client cannot spoof the author through the body", async () => {
  const r = await post("/runtime/vault/record", { venture: "waahyu", node: "content", title: "Spoof attempt", body: "x", author: "someone-else" }, authCk(approverCk));
  assert.equal(r.status, 201);
  assert.equal((await r.json()).record.author, "alice");
});

test("teardown: deleting back to <2 accounts restores solo", async () => {
  assert.equal((await del(`/runtime/users/${vicId}`, authCk(approverCk))).status, 200);
  assert.equal((await del(`/runtime/users/${aliceId}`, authCk(approverCk))).status, 200);
  assert.equal((await get("/runtime/vault")).status, 200, "token-only reads work again");
});

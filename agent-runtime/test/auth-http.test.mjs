// P9 — second seat authz matrix, end-to-end through a REAL booted runtime (mock
// backend, all state under tmp). Proves the §P9 exit criteria at the wire:
//   solo (0 users) → decide works with NO login (identical to today) →
//   create 2 accounts → login sets an HttpOnly/SameSite=Strict cookie →
//   approver decides 200, viewer decides 403 (direct request), unauth 401 →
//   decidedBy is the session identity (not client-spoofable) → assignment routes to B →
//   events ticket requires a session when active → no user enumeration →
//   delete back to <2 users → zero-login solo restored.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3995, TOK = "authtok", BASE = `http://127.0.0.1:${PORT}`;

let root, repo, sbRoot, dbPath, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
// auth() + an optional session cookie.
const authCk = (cookie, x = {}) => auth(cookie ? { Cookie: cookie, ...x } : x);
const post = (path, body, headers) => fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body ?? {}) });
const del = (path, headers) => fetch(`${BASE}${path}`, { method: "DELETE", headers: headers ?? auth() });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });

// Extract the ma_session cookie value from a login response, as a Cookie header.
function cookieFrom(res) {
  const sc = res.headers.get("set-cookie") || "";
  const m = sc.match(/ma_session=([^;]*)/);
  return m ? `ma_session=${m[1]}` : null;
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
      RUNTIME_REPO_ROOT: repo, RUNTIME_SEED_DIRS: "src", RUNTIME_DB_PATH: dbPath, RUNTIME_SANDBOX_ROOT: sbRoot,
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"), RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
      // The three station stores default to TRACKED files under factory/. Without these
      // overrides the approver-PUT case below writes into the repo, and a later run reads
      // that leftover back as real state (the failure this fixes). Redirect to tmp.
      RUNTIME_STATION_PERMS_FILE: join(root, "x", "factory", "station-perms.json"),
      RUNTIME_STATION_SKILLS_FILE: join(root, "x", "factory", "station-skills.json"),
      RUNTIME_STATION_MEMORY_FILE: join(root, "x", "factory", "station-memory.json"),
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
// Mint one PENDING Delivery and return its id. Uses a UNIQUE agent per call (the
// pending-key is one-per-agent, so reuse would collide) and warms the copy-sandbox
// first (the first /run seeds it from the repo — a pre-written file is clobbered),
// then adds a change and runs again to mint. Includes a session cookie when auth is
// active (/run is session-gated then).
let mintSeq = 0;
async function mintDelivery(cookie) {
  const agentId = `mint-agent-${mintSeq++}`;
  const rel = `src/f${mintSeq}.ts`;
  await (await post(`/runtime/${agentId}/run`, { task: "warm" }, authCk(cookie))).text(); // seed sandbox
  sandboxWrite(agentId, rel, `export const x = ${mintSeq};\n`);
  await (await post(`/runtime/${agentId}/run`, { task: "change" }, authCk(cookie))).text(); // mint
  // The mint fires on the run's socket-close (async), so poll until it lands.
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const list = await (await get("/inbox?status=pending", authCk(cookie))).json();
    const rows = (list.deliveries || []).filter((d) => d.agentId === agentId);
    if (rows.length) return rows[rows.length - 1].id;
    await new Promise((r) => setTimeout(r, 40));
  }
  return undefined;
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-auth-")));
  repo = join(root, "repo");
  sbRoot = join(root, "x", "sb");
  dbPath = join(root, "x", "db", "mission.db");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  await boot();
});
after(async () => { await kill(); try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

// ── SOLO (0 users) — zero-login, identical to pre-P9 ──────────────────────────
test("solo: /auth/me reports authActive:false", async () => {
  const r = await get("/runtime/auth/me");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.authActive, false);
  assert.equal(j.user, null);
});

test("solo: a Delivery can be decided with NO login (token only), decidedBy defaults BOSS", async () => {
  const id = await mintDelivery();
  assert.ok(id, "delivery minted");
  const r = await post(`/inbox/${id}/approve`, {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).decidedBy, "BOSS");
});

test("solo: events ticket mints with token only (no session required)", async () => {
  const r = await post("/runtime/events/ticket", {});
  assert.equal(r.status, 201);
  assert.ok((await r.json()).ticket);
});

// ── activate: create two accounts (token-only bootstrap while still solo) ──────
let aliceCk, vicCk, bobCk;
test("bootstrap: first two accounts are created token-only, then auth activates", async () => {
  assert.equal((await post("/runtime/users", { name: "Alice", password: "alice-passphrase", role: "approver" })).status, 201);
  // still solo (count 1) — second create is still token-only
  assert.equal((await post("/runtime/users", { name: "Vic", password: "vic-passphrase", role: "viewer" })).status, 201);
  const me = await (await get("/runtime/auth/me")).json();
  assert.equal(me.authActive, true, "≥2 accounts → auth active");
  assert.equal(me.userCount, 2);
});

test("active: /auth/me with no cookie → 401 (authActive:true, user:null)", async () => {
  const r = await get("/runtime/auth/me");
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.authActive, true);
  assert.equal(j.user, null);
});

// ── login + cookie flags ──────────────────────────────────────────────────────
test("login: wrong password and unknown user return the SAME generic 401 (no enumeration)", async () => {
  const bad = await post("/runtime/auth/login", { name: "Vic", password: "WRONG" });
  const ghost = await post("/runtime/auth/login", { name: "Nobody", password: "whatever" });
  assert.equal(bad.status, 401);
  assert.equal(ghost.status, 401);
  assert.deepEqual(await bad.json(), await ghost.json(), "bad-user and bad-pass are indistinguishable");
});

test("login: success sets an HttpOnly, SameSite=Strict, non-Secure (loopback) cookie", async () => {
  const r = await post("/runtime/auth/login", { name: "Alice", password: "alice-passphrase" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).user.role, "approver");
  const sc = r.headers.get("set-cookie") || "";
  assert.match(sc, /ma_session=[0-9a-f]{64}/, "opaque 32-byte session id");
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Strict/i);
  assert.doesNotMatch(sc, /Secure/i, "loopback → not Secure so it sets over http");
  aliceCk = cookieFrom(r);
  assert.ok(aliceCk);
});

test("login: viewer session works; /auth/me reflects the role", async () => {
  const r = await post("/runtime/auth/login", { name: "Vic", password: "vic-passphrase" });
  vicCk = cookieFrom(r);
  const me = await (await get("/runtime/auth/me", authCk(vicCk))).json();
  assert.equal(me.user.name, "Vic");
  assert.equal(me.user.role, "viewer");
});

// ── the authz matrix on decide ────────────────────────────────────────────────
test("active: decide with NO cookie → 401 even with a valid token", async () => {
  const id = await mintDelivery(aliceCk);
  const r = await post(`/inbox/${id}/approve`, {}); // token only, no cookie
  assert.equal(r.status, 401);
});

test("active: viewer decide → 403 via direct request (not just a hidden button)", async () => {
  const id = await mintDelivery(aliceCk);
  const r = await post(`/inbox/${id}/approve`, {}, authCk(vicCk));
  assert.equal(r.status, 403);
  // and the delivery is still pending — the viewer changed nothing
  assert.equal((await (await get(`/inbox/${id}`, authCk(aliceCk))).json()).status, "pending");
});

// ── Phase B · Task 3 — the mailbox HTTP surface under ACTIVE auth ─────────────────────────
// Codex F04, reproduced: routeNeedsApprover() never listed /runtime/mail, so a valid VIEWER
// session could POST as any sender (a hire-request "from" tech-lead) and could DRAIN any
// inbox with a GET, removing completion mail before the Manager's own read. Both are
// mutations of runtime state and sit behind the approver gate; the operator GET is a glance
// and must not consume.
// Mutation proof (2026-09-17): routeNeedsApprover `/runtime/mail` → `/runtime/mail-never` →
//   ✖ MBX-HTTP-1  AssertionError: actual: 201, expected: 403. Restored, md5 matched, 31/31.
// Placement matters in this file: line ~348 deletes accounts back to solo; anything after it runs UNGATED.
test("RESUME-HTTP-1: POST /runtime/jobs/:id/resume is approver-only and in BOTH gate lists — viewer 403, approver 404 on a ghost, 409 on a job that is not blocked", async () => {
  // Phase B · Task 6. Codex F09: no resume route existed; the store allowed blocked→planned but
  // the HTTP surface fell through to 405. Addendum #20: a route must be on `needsAuth` AND, as a
  // mutation, in `routeNeedsApprover`. Mutation proof (2026-09-17): the resume gate line → `if (false)` →
  //   ✖ RESUME-HTTP-1 viewer is refused before any lookup — got 404: {"error":"no such job"}. Restored, md5 matched.
  // Run the WHOLE file: `--test-name-pattern` skips the account/login setup, auth stays inactive, and the gate is skipped by design.
  const asViewer = await post("/runtime/jobs/job_ghost/resume", {}, authCk(vicCk));
  assert.equal(asViewer.status, 403, `viewer is refused before any lookup — got ${asViewer.status}: ${await asViewer.text()}`);
  assert.equal((await post("/runtime/jobs/job_ghost/resume", {}, authCk(aliceCk))).status, 404, "approver: no such job");
  const made = await post("/runtime/jobs", { title: "resume-me", brief: "a brief long enough to be a brief" }, authCk(aliceCk));
  const madeBody = await made.text(); // read ONCE — an assertion-message `await made.text()` consumes the body before .json()
  assert.equal(made.status, 201, madeBody);
  const id = JSON.parse(madeBody).id; // POST /runtime/jobs returns the job row itself
  assert.equal((await post(`/runtime/jobs/${id}/resume`, {}, authCk(aliceCk))).status, 409, "not blocked → 409, not 405");
  assert.equal((await post(`/runtime/jobs/${id}/resume`, {})).status, 401, "no session → 401 (needsAuth)");
});

test("MBX-HTTP-1: active auth — a VIEWER cannot POST /runtime/mail (403), and no message is written", async () => {
  const r = await post("/runtime/mail", { from: "tech-lead", to: "hr", kind: "hire-request", body: "viewer-forged" }, authCk(vicCk));
  assert.equal(r.status, 403, await r.text());
  const hr = await get("/runtime/mail/hr", authCk(aliceCk));
  assert.equal(hr.status, 200);
  assert.equal((await hr.json()).messages.filter((m) => m.body === "viewer-forged").length, 0, "the refused send left nothing behind");
});

test("MBX-HTTP-2: active auth — GET /runtime/mail/:id is a GLANCE: reading twice returns the same message twice", async () => {
  const sent = await post("/runtime/mail", { from: "sr-frontend", to: "sr-backend", kind: "question", body: "still-here?" }, authCk(aliceCk));
  assert.equal(sent.status, 201, await sent.text());
  const first = await (await get("/runtime/mail/sr-backend", authCk(aliceCk))).json();
  const second = await (await get("/runtime/mail/sr-backend", authCk(aliceCk))).json();
  assert.equal(first.messages.some((m) => m.body === "still-here?"), true);
  assert.equal(second.messages.some((m) => m.body === "still-here?"), true, "the operator read must not archive — that is the Manager's drain, not the cockpit's glance");
});

test("active: approver decide → 200 and decidedBy is the SESSION identity, not client-spoofable", async () => {
  const id = await mintDelivery(aliceCk);
  // try to spoof a different decider via the body — the server must ignore it.
  const r = await post(`/inbox/${id}/approve`, { by: "Mallory" }, authCk(aliceCk));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).decidedBy, "Alice");
});

// ── sr-security P9 HIGH regression: viewers cannot reach the RAW engine mutation
//    routes (the mechanical half of approve→apply / launching agents) by direct
//    request — closing the role-gate under-scope. Reads stay allowed. ──────────────
test("active: viewer POST /runtime/:agent/apply → 403 (cannot write the repo directly)", async () => {
  const r = await post(`/runtime/senior-web-1/apply`, { paths: ["README.md"] }, authCk(vicCk));
  assert.equal(r.status, 403);
});

// ── CC-Primitives P8 (carried ticket sr-security P4 LOW-2): the three station
//    mutation routes are approver-only via routeNeedsApprover — prove the 403 with a
//    real viewer SESSION, and the 200 with the approver seat, so a regex regression
//    in routeNeedsApprover can never ship silently. ────────────────────────────────
const put = (path, body, headers) => fetch(`${BASE}${path}`, { method: "PUT", headers: headers ?? auth(), body: JSON.stringify(body ?? {}) });

test("active: viewer PUT perm-mode/skills/memory → 403; state unchanged", async () => {
  for (const [path, body] of [
    ["/runtime/sr-backend/perm-mode", { permissionMode: "bypassPermissions" }],
    ["/runtime/sr-backend/skills", { skills: ["repo-read"] }],
    ["/runtime/sr-backend/memory", { memory: "viewer should not write this" }],
  ]) {
    const r = await put(path, body, authCk(vicCk));
    assert.equal(r.status, 403, `${path} must be approver-only`);
  }
  // nothing persisted by the viewer attempts
  const pm = await (await get("/runtime/sr-backend/perm-mode", authCk(vicCk))).json();
  assert.equal(pm.permMode, null);
  const mem = await (await get("/runtime/sr-backend/memory", authCk(vicCk))).json();
  assert.equal(mem.memory, "");
});

test("active: approver PUT perm-mode → 200 (the same route, correct seat)", async () => {
  const r = await put("/runtime/sr-backend/perm-mode", { permissionMode: "default" }, authCk(aliceCk));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).permMode, "default");
});

test("active: viewer POST /runtime/:agent/run → 403 (cannot launch an agent)", async () => {
  const r = await post(`/runtime/senior-web-1/run`, { task: "x" }, authCk(vicCk));
  assert.equal(r.status, 403);
});

test("active: viewer POST /runtime/:agent/exec → 403", async () => {
  const r = await post(`/runtime/senior-web-1/exec`, { cmd: "ls" }, authCk(vicCk));
  assert.equal(r.status, 403);
});

test("active: viewer POST /runtime/engine/enqueue → 403 (engine block gates itself)", async () => {
  const r = await post(`/runtime/engine/enqueue`, { agentId: "senior-web-1", steps: ["x"] }, authCk(vicCk));
  assert.equal(r.status, 403);
});

test("active: viewer POST /runtime/:agent/stop → 403 (cannot abort an in-flight agent)", async () => {
  const r = await post(`/runtime/senior-web-1/stop`, {}, authCk(vicCk));
  assert.equal(r.status, 403, "stop is process control — approver-only; must not reach stopAgentChat");
});

test("active: viewer POST /runtime/:agent/cancel → 403 (legacy alias, same gate)", async () => {
  const r = await post(`/runtime/senior-web-1/cancel`, {}, authCk(vicCk));
  assert.equal(r.status, 403);
});

test("active: approver POST /runtime/:agent/stop → NOT 403/401 (gate does not over-block)", async () => {
  const r = await post(`/runtime/senior-web-1/stop`, {}, authCk(aliceCk));
  assert.notEqual(r.status, 403);
  assert.notEqual(r.status, 401);
});

test("active: viewer GET /runtime/:agent/changes → NOT 403 (reads stay allowed)", async () => {
  const r = await get(`/runtime/senior-web-1/changes`, authCk(vicCk));
  assert.notEqual(r.status, 403);
});

test("active: approver POST /runtime/:agent/run → NOT 403 (gate does not over-block)", async () => {
  const r = await post(`/runtime/senior-web-1/run`, { task: "x" }, authCk(aliceCk));
  assert.notEqual(r.status, 403);
  assert.notEqual(r.status, 401);
});

// ── role escalation attempts ────────────────────────────────────────────────
test("active: viewer cannot manage users (403) or write policy (403), but may read the roster (200)", async () => {
  assert.equal((await post("/runtime/users", { name: "X", password: "longenough1", role: "viewer" }, authCk(vicCk))).status, 403);
  assert.equal((await del("/runtime/users/usr_whatever", authCk(vicCk))).status, 403);
  assert.equal((await post("/runtime/policy", { autoApprove: true }, authCk(vicCk))).status, 403);
  // reading the roster is allowed for any authenticated seat (single-tenant)
  assert.equal((await get("/runtime/users", authCk(vicCk))).status, 200);
});

// PHASE 7 SECURITY REVIEW — the SECOND instance of the /inbox/bulk-decide class of bug.
// `routeNeedsApprover` gated POST /runtime/accounts, POST .../secret and DELETE .../:id,
// but NOT `PATCH /runtime/accounts/:id` — which can replace the sealed secret and rewrite
// baseUrl. A viewer could therefore point an account at a host it controls and have the
// approver's real API key sent there on the next turn: credential exfiltration from a
// role documented as read-only. The 403 must come from the ROLE gate, BEFORE the route
// resolves the id, so an unknown id is the right probe — a 404 or a 400 here would mean
// the request reached the handler and the gate is missing.
test("active: viewer PATCH /runtime/accounts/:id → 403 (a credential edit is a mutation)", async () => {
  const r = await fetch(`${BASE}/runtime/accounts/acc_does_not_exist`, {
    method: "PATCH",
    headers: authCk(vicCk),
    body: JSON.stringify({ baseUrl: "https://attacker.example.com", label: "pwned" }),
  });
  assert.equal(r.status, 403, "a viewer reached the credential-edit route");
});

// ── events ticket requires a session when active (PRECONDITION-052.1) ─────────
test("active: events ticket mint needs a session — token-only 401, viewer session 201", async () => {
  assert.equal((await post("/runtime/events/ticket", {})).status, 401);          // token only
  assert.equal((await post("/runtime/events/ticket", {}, authCk(vicCk))).status, 201); // any authenticated seat
});

// ── forged cookie ─────────────────────────────────────────────────────────────
test("active: a forged/garbage session cookie is rejected (401), same path as an expired one", async () => {
  const forged = "ma_session=" + "0".repeat(64);
  assert.equal((await get("/runtime/auth/me", authCk(forged))).status, 401);
  const id = await mintDelivery(aliceCk);
  assert.equal((await post(`/inbox/${id}/approve`, {}, authCk(forged))).status, 401);
});

// ── assignment routing: assigned to B, decided by B, audit shows B ────────────
test("active: assign to Bob (approver) → Bob decides → decidedBy=Bob, assignee=Bob", async () => {
  // Alice (approver) creates Bob and assigns the delivery to him.
  assert.equal((await post("/runtime/users", { name: "Bob", password: "bob-passphrase", role: "approver" }, authCk(aliceCk))).status, 201);
  bobCk = cookieFrom(await post("/runtime/auth/login", { name: "Bob", password: "bob-passphrase" }));
  const id = await mintDelivery(aliceCk);
  const asg = await post(`/inbox/${id}/assign`, { assignee: "Bob" }, authCk(aliceCk));
  assert.equal(asg.status, 200);
  assert.equal((await asg.json()).assignee, "Bob");
  // Bob (the assignee, a different approver than the assigner) decides.
  const dec = await post(`/inbox/${id}/approve`, {}, authCk(bobCk));
  assert.equal(dec.status, 200);
  const row = await dec.json();
  assert.equal(row.decidedBy, "Bob");
  assert.equal(row.assignee, "Bob");
});

test("active: a viewer cannot assign (403)", async () => {
  const id = await mintDelivery(aliceCk);
  assert.equal((await post(`/inbox/${id}/assign`, { assignee: "Alice" }, authCk(vicCk))).status, 403);
});

// ── delete back to <2 → zero-login solo restored ──────────────────────────────
test("delete accounts back to <2 → app returns to zero-login solo, identical to today", async () => {
  // Alice (approver) deletes Bob and Vic. Accounts now: Alice only (count 1) → inactive.
  const bobId = (await (await get("/runtime/users", authCk(aliceCk))).json()).users.find((u) => u.name === "Bob").id;
  const vicId = (await (await get("/runtime/users", authCk(aliceCk))).json()).users.find((u) => u.name === "Vic").id;
  assert.equal((await del(`/runtime/users/${bobId}`, authCk(aliceCk))).status, 200); // count 3→2, still active
  assert.equal((await del(`/runtime/users/${vicId}`, authCk(aliceCk))).status, 200); // count 2→1, now inactive
  // zero-login restored: /auth/me is authActive:false, and decide works with NO cookie.
  const me = await (await get("/runtime/auth/me")).json();
  assert.equal(me.authActive, false);
  const id = await mintDelivery(); // token only, no cookie
  assert.equal((await post(`/inbox/${id}/approve`, {})).status, 200);
});

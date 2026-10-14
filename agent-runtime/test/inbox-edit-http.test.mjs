// PHASE 4 — approve-with-edit, end to end through a REAL booted runtime.
//
// The unit tests in patch-edit.test.mjs prove the validator. These prove the WIRING,
// which is where this project's bugs have actually lived: a PATCH route that existed but
// was 405'd by the method allowlist, a bulk route that sat outside routeNeedsApprover.
// A validator nobody reaches is worth nothing, so every assertion here goes over HTTP and
// then reads the REPO FILE ON DISK.
//
// WHAT MUST BE TRUE:
//   1. An edited approve lands the EDITED bytes in the repo — not the agent's original.
//   2. The edit travels the unchanged broker: a path the broker denies still cannot land.
//   3. Edits are refused on any verb but approve, and on a delivery that is not pending.
//   4. A refused edit leaves the row PENDING and the repo untouched (fail closed).
//   5. The route is still token-gated and Host-gated — no new unauthenticated surface.
//   6. The on-disk patch record is rewritten, so the audit trail shows what was approved.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3987;
const TOK = "editok";
const BASE = `http://127.0.0.1:${PORT}`;

let root, repo, sbRoot, dbPath, child;

const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const post = (path, body, headers) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body || {}) });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });

// undici rewrites Host, so the rebinding gate needs a raw request.
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

/** Seed a sandbox change and mint the Delivery via the /changes fallback. */
async function mint(agentId, rel, text) {
  sandboxWrite(agentId, rel, text);
  await get(`/runtime/${agentId}/changes`);
  const list = await (await get(`/inbox?agentId=${agentId}`)).json();
  const row = list.deliveries.find((d) => d.agentId === agentId && d.status === "pending");
  assert.ok(row, `no pending delivery minted for ${agentId}`);
  return row.id;
}

const repoRead = (rel) => { try { return readFileSync(join(repo, rel), "utf-8"); } catch { return null; } };

before(async () => {
  // macOS tmpdir is a symlink; the broker realpaths destinations, so REPO_ROOT must
  // already be real or every apply reports "dest escapes repo".
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-edit-")));
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

// ── the headline: the EDITED bytes land ────────────────────────────────────────

test("an edited approve lands the operator's bytes, not the agent's", async () => {
  const id = await mint("edit-a", "src/greet.ts", "export const greet = 'agent version';\n");
  const edited = "export const greet = 'operator version';\n";

  const res = await post(`/inbox/${id}/approve`, { edits: [{ path: "src/greet.ts", after: edited }] });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.editedPaths, ["src/greet.ts"]);
  assert.equal(body.status, "approved");

  // The claim is about the REPO, not the response.
  assert.equal(repoRead("src/greet.ts"), edited, "the agent's original text landed instead of the edit");
});

test("the on-disk patch record is rewritten to what was approved", async () => {
  const id = await mint("edit-rec", "src/rec.ts", "export const v = 'before-edit';\n");
  await post(`/inbox/${id}/approve`, { edits: [{ path: "src/rec.ts", after: "export const v = 'after-edit';\n" }] });

  // GET /inbox/:id rebuilds `changes` from the patch files on disk. If the record still
  // showed the agent's text, the audit trail would disagree with the bytes that landed.
  const detail = await (await get(`/inbox/${id}`)).json();
  const change = detail.changes.find((c) => c.path === "src/rec.ts");
  assert.ok(change, "no change record for the edited path");
  assert.match(change.after, /after-edit/);
  assert.doesNotMatch(change.after, /before-edit/);
});

test("an unedited approve is unchanged by Phase 4", async () => {
  const id = await mint("edit-plain", "src/plain.ts", "export const plain = 1;\n");
  const res = await post(`/inbox/${id}/approve`, {});
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.editedPaths, undefined, "a plain approve must not report edits");
  assert.equal(repoRead("src/plain.ts"), "export const plain = 1;\n");
});

// ── fail closed ────────────────────────────────────────────────────────────────

test("SECURITY: an edit to a path the delivery never proposed is refused and nothing lands", async () => {
  const id = await mint("edit-scope", "src/scope.ts", "export const scope = 1;\n");
  const res = await post(`/inbox/${id}/approve`, { edits: [{ path: "src/elsewhere.ts", after: "owned\n" }] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not part of this delivery/i);

  assert.equal(repoRead("src/elsewhere.ts"), null, "a path outside the delivery was written");
  const detail = await (await get(`/inbox/${id}`)).json();
  assert.equal(detail.status, "pending", "a refused edit must leave the row undecided");
  assert.equal(repoRead("src/scope.ts"), null, "the delivery applied despite the refusal");
});

// ── the transport must not silently discard the edit ──────────────────────────
//
// CODE-REVIEW CRITICAL, reproduced before it was fixed. `readInboxBody` capped the whole
// approve request at 8,000 bytes and, on overflow, called `req.destroy()` — whose "close"
// handler resolved the body as `{}`. So an edit larger than ~8 KB became a body with NO
// `edits` key, and the route carried on into an ORDINARY approve: the agent's original
// text was written to the repo while the browser, whose socket had just been reset, showed
// the operator a generic failure. The operator's correction was discarded and the thing
// they were correcting shipped. A 250-line source file clears 8 KB easily.
//
// Two properties, and the first is the one that was broken:
//   1. an edit well inside patch-edit.mjs's own 2 MB limit must LAND;
//   2. a body past the limit must be REFUSED LOUDLY (413) with the row still pending and
//      the repo untouched — never silently downgraded to a plain approve.
test("an edit far larger than the old 8 KB body cap still lands the operator's bytes", async () => {
  const id = await mint("edit-large", "src/large.ts", "export const large = 'agent version';\n");
  // ~60 KB: over the old cap by 7x, an ordinary file, far under the 2 MB edit ceiling.
  const edited = `export const large = 'operator version';\n// ${"x".repeat(60_000)}\n`;

  const res = await post(`/inbox/${id}/approve`, { edits: [{ path: "src/large.ts", after: edited }] });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.deepEqual(body.editedPaths, ["src/large.ts"]);
  assert.equal(repoRead("src/large.ts"), edited, "the agent's original text landed instead of the edit");
});

test("SECURITY: an over-limit body is refused with 413 — never downgraded to a plain approve", async () => {
  const id = await mint("edit-huge", "src/huge.ts", "export const huge = 'agent version';\n");
  const huge = `export const huge = '${"x".repeat(3_000_000)}';\n`; // past the 2 MB edit ceiling

  const res = await post(`/inbox/${id}/approve`, { edits: [{ path: "src/huge.ts", after: huge }] });
  assert.equal(res.status, 413, "an over-limit body must fail closed, not fall through to approve");

  const detail = await (await get(`/inbox/${id}`)).json();
  assert.equal(detail.status, "pending", "an over-limit edit decided the delivery anyway");
  assert.equal(repoRead("src/huge.ts"), null, "an over-limit edit wrote the repo");
});

test("SECURITY: traversal in an edit path is refused", async () => {
  const id = await mint("edit-trav", "src/trav.ts", "export const t = 1;\n");
  const res = await post(`/inbox/${id}/approve`, {
    edits: [{ path: "../../../../../../tmp/ma-edit-pwned.txt", after: "pwned\n" }],
  });
  assert.equal(res.status, 400);
  const detail = await (await get(`/inbox/${id}`)).json();
  assert.equal(detail.status, "pending");
});

test("edits are refused on reject and request-changes", async () => {
  const id = await mint("edit-verb", "src/verb.ts", "export const v = 1;\n");
  for (const verb of ["reject", "request-changes"]) {
    const res = await post(`/inbox/${id}/${verb}`, { feedback: "no", edits: [{ path: "src/verb.ts", after: "x\n" }] });
    assert.equal(res.status, 400, `${verb} accepted edits`);
    assert.match((await res.json()).error, /only valid with approve/i);
  }
  const detail = await (await get(`/inbox/${id}`)).json();
  assert.equal(detail.status, "pending", "a refused verb+edit must not decide the row");
});

test("an empty edits array is refused rather than treated as no edits", async () => {
  const id = await mint("edit-empty", "src/empty.ts", "export const e = 1;\n");
  const res = await post(`/inbox/${id}/approve`, { edits: [] });
  assert.equal(res.status, 400);
  const detail = await (await get(`/inbox/${id}`)).json();
  assert.equal(detail.status, "pending");
});

test("a malformed edits payload is refused, not coerced", async () => {
  const id = await mint("edit-shape", "src/shape.ts", "export const s = 1;\n");
  for (const edits of ["not-an-array", 42, { path: "src/shape.ts" }, [{ path: "src/shape.ts" }], [{ after: "x" }]]) {
    const res = await post(`/inbox/${id}/approve`, { edits });
    assert.equal(res.status, 400, `payload ${JSON.stringify(edits)} was accepted`);
  }
  assert.equal((await (await get(`/inbox/${id}`)).json()).status, "pending");
});

test("editing an already-decided delivery is refused", async () => {
  const id = await mint("edit-twice", "src/twice.ts", "export const t = 1;\n");
  assert.equal((await post(`/inbox/${id}/approve`, {})).status, 200);
  const res = await post(`/inbox/${id}/approve`, { edits: [{ path: "src/twice.ts", after: "late\n" }] });
  assert.equal(res.status, 409);
  assert.equal(repoRead("src/twice.ts"), "export const t = 1;\n", "a late edit rewrote a decided delivery");
});

// ── the auth surface did not widen ─────────────────────────────────────────────

test("SECURITY: an edited approve still requires the token", async () => {
  const id = await mint("edit-auth", "src/auth.ts", "export const a = 1;\n");
  const res = await post(`/inbox/${id}/approve`, { edits: [{ path: "src/auth.ts", after: "x\n" }] }, H());
  assert.equal(res.status, 401);
  assert.equal(repoRead("src/auth.ts"), null);
});

test("SECURITY: an edited approve still fails the DNS-rebinding Host gate", async () => {
  const id = await mint("edit-host", "src/host.ts", "export const h = 1;\n");
  const r = await raw(
    "POST",
    `/inbox/${id}/approve`,
    { Host: "evil.com", "x-runtime-token": TOK, "content-type": "application/json" },
    JSON.stringify({ edits: [{ path: "src/host.ts", after: "x\n" }] }),
  );
  assert.equal(r.status, 403);
  assert.equal(repoRead("src/host.ts"), null);
});

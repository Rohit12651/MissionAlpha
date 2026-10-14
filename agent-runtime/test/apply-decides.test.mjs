// Phase 6 · task 6.6b — POST /runtime/engine/apply MUST DECIDE THE DELIVERY IT LANDS.
//
// THE DEFECT. The path-selective apply button ran the broker, advanced the engine chain,
// and then walked away: the Delivery that asked for the decision stayed `pending` forever
// and the work it described was never committed anywhere. The operator sees the file land
// in the repo AND the card still sitting in the Inbox asking to be decided. The Inbox
// count is a lie, the audit trail has no decider, and the only copy of the change is an
// uncommitted worktree that the engine's own cleanup is entitled to `git branch -D`.
//
// THE RULE: an apply IS a decision. It flips the Delivery `approved` with the operator
// named and the paths recorded, and it lands the commit through the SAME ladder
// POST /inbox/:id/approve uses — never a second, near-identical commit path.
//
// GUARDS (threat_model, phase 6): branch allow-list `^ma/task/[a-z0-9_]+$`, no push, and
// the D3 assertion — the operator's own `.git/index` is byte-identical before and after.
//
// Real booted runtime, cli backend, fake CLAUDE_BIN, throwaway repo. Nothing here touches
// the live checkout.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { makeThrowawayRepo, isolatedRuntimeEnv } from "./fixtures/throwaway-repo.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3961, TOK = "applytok", BASE = `http://127.0.0.1:${PORT}`;
const APPLIED_PATH = "README.md";

let root, repo, child;
const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf-8" });
const indexHash = () => createHash("sha1").update(readFileSync(join(repo, ".git", "index"))).digest("hex");

/**
 * The file list out of `git show --stat --format=`. Extracted and PROVEN below, because a
 * "the commit lists exactly one path" assertion that silently returns [] for every input
 * would pass on a commit containing the whole repo — the vacuous-ratchet class this repo
 * has shipped three times.
 */
function statFiles(stat) {
  return [...new Set(
    stat.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("|"))
      .map((l) => l.split("|")[0].trim()),
  )];
}

test("statFiles is not vacuous — it SEES a second file in the diffstat", () => {
  const one = " README.md | 2 ++\n 1 file changed, 2 insertions(+)\n";
  const two = " README.md   | 2 ++\n src/seed.ts | 1 +\n 2 files changed, 3 insertions(+)\n";
  assert.deepEqual(statFiles(one), ["README.md"]);
  assert.deepEqual(statFiles(two), ["README.md", "src/seed.ts"],
    "an extra path in the commit MUST be visible to the assertion below");
  assert.deepEqual(statFiles(""), [], "and an empty stat is empty, never a silent pass");
});

async function waitHealth(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).ok) return; } catch { /* */ }
    await sleep(120);
  }
  throw new Error("server not healthy");
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-applydec-")));
  repo = makeThrowawayRepo(root);
  // A fake engine that makes ONE real edit to a tracked file in its worktree, so the task
  // settles HELD with a genuine diff and a Delivery is minted from it.
  const fakeJs = join(root, "fake-claude.mjs");
  writeFileSync(fakeJs, [
    'import { appendFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'try { appendFileSync(join(process.cwd(), "README.md"), "\\napply-decides proof\\n"); } catch {}',
    'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "appended one line", usage: { input_tokens: 2, output_tokens: 2 } }) + "\\n");',
    'process.exit(0);',
  ].join("\n"));
  const wrapper = join(root, "fake-claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  mkdirSync(join(root, "db"), { recursive: true });
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "cli", RUNTIME_TOOLS: "write",
      CLAUDE_BIN: wrapper, ANTHROPIC_API_KEY: "",
      ...isolatedRuntimeEnv(root, repo),
      RUNTIME_STATION_PERMS_FILE: join(root, "station-perms.json"),
      RUNTIME_TOKEN_DIR: join(root, "tok"), RUNTIME_THREADS_DIR: join(root, "threads"),
      RUNTIME_MCP_DIR: join(root, "mcp"), RUNTIME_ENGINE_STORE: join(root, "eng"),
      RUNTIME_DB_PATH: join(root, "db", "mission.db"), RUNTIME_VAULT_DIR: join(root, "vault"),
      // auto-apply OFF (the default) — the Delivery MUST reach the operator pending.
      RUNTIME_POLICY_FILE: join(root, "policy.json"),
      RUNTIME_ADAPTERS_FILE: join(root, "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "agents"),
      RUNTIME_SEED_DEFAULTS: "0",
    },
    stdio: "ignore",
  });
  await waitHealth();
  const acct = await fetch(`${BASE}/runtime/accounts`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ providerType: "claude", label: "engine", authMethod: "subscription" }),
  });
  assert.equal(acct.status, 200, "seed a swarm-capable Claude account before the engine turn");
});

after(async () => {
  await new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });
  if (root) rmSync(root, { recursive: true, force: true });
});

test("an apply DECIDES its Delivery and lands the commit on the task branch", async () => {
  const enq = await fetch(`${BASE}/runtime/engine/enqueue`, {
    method: "POST", headers: auth(),
    // `docs-writer`, not `sr-backend`. This test is about apply DECIDING the Delivery and
    // landing the commit; it is not about scope. Phase 7 narrowed sr-backend to
    // `src/lib/**` + `agent-runtime/**`, so a README edit from that seat is now correctly
    // refused (`README.md (out-of-scope for seat sr-backend)`) and the task never reaches
    // HELD — which would make this assert a control it does not mean to assert.
    // docs-writer owns release notes and is a `station` role, so it is not narrowed.
    body: JSON.stringify({ agentId: "docs-writer", tier: "sonnet", priority: "high", steps: ["Append a line to README"] }),
  });
  assert.equal(enq.status, 201);
  const taskId = (await enq.json()).firstTaskId;
  assert.match(taskId, /^task_/);

  // Wait for HELD — the state in which the operator is being asked to decide.
  let task = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const runs = await (await fetch(`${BASE}/runtime/engine/runs`, { headers: auth() })).json();
    task = (runs.tasks || []).find((t) => t.taskId === taskId);
    if (task && (task.status === "held" || task.status === "failed")) break;
  }
  assert.equal(task?.status, "held", `the task must reach HELD with a diff (got ${JSON.stringify(task)})`);

  // ── THE RATCHET'S PRECONDITION. Without this the assertions below could pass for the
  // wrong reason (e.g. a row that was never pending). This is what is RED on the old
  // route: it applied, and left this row pending forever.
  const before = await (await fetch(`${BASE}/inbox?status=pending&limit=50`, { headers: auth() })).json();
  const row = (before.deliveries || []).find((d) => d.taskId === taskId);
  assert.ok(row, "the HELD task must have minted a pending Delivery");
  assert.equal(row.status, "pending");
  assert.deepEqual(row.changedPaths, [APPLIED_PATH], "the seat changed exactly one tracked file");
  const pendingBefore = before.counts.pending;

  const headBefore = git("rev-parse", "HEAD").trim();
  const idxBefore = indexHash();

  const res = await fetch(`${BASE}/runtime/engine/apply`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ taskId, paths: [APPLIED_PATH] }),
  });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.ok(out.results?.some((r) => r.ok && r.path === APPLIED_PATH), `the broker must have applied the path: ${JSON.stringify(out)}`);

  // 1 — the Delivery is DECIDED, by someone, with the paths named.
  assert.equal(out.delivery?.id, row.id, "the response must name the Delivery it decided");
  assert.equal(out.delivery?.status, "approved");
  const after = await (await fetch(`${BASE}/inbox/${row.id}`, { headers: auth() })).json();
  assert.equal(after.status, "approved", "an apply IS a decision — the card must not stay pending");
  assert.ok(after.decidedBy, "the decision must have a decider");
  assert.match(String(after.feedback), /path-selective apply:/, "the feedback must record that this came from apply");
  assert.match(String(after.feedback), new RegExp(APPLIED_PATH), "and must name the path applied");

  // 2 — the commit is on the task branch, through the ladder, and contains EXACTLY that path.
  assert.match(String(out.commit?.branch), /^ma\/task\/[a-z0-9_]+$/, `branch allow-list: ${JSON.stringify(out.commit)}`);
  assert.match(String(out.commit?.sha), /^[0-9a-f]{7,40}$/, "the response must carry the commit sha");
  const log = git("log", "--format=%H", `${headBefore}..${out.commit.branch}`).trim().split("\n").filter(Boolean);
  assert.equal(log.length, 1, `exactly ONE new commit on the branch, got ${log.length}`);
  const stat = git("show", "--stat", "--format=", log[0]);
  assert.deepEqual(statFiles(stat), [APPLIED_PATH],
    `the commit must list exactly the applied path; --stat was:\n${stat}`);

  // 3 — D3: the OPERATOR's index is untouched. The commit happens in the worktree's own
  // index; anything that staged in the operator's checkout would be this route reaching
  // into the human's working state.
  assert.equal(indexHash(), idxBefore, "the operator's .git/index must be byte-identical");

  // 4 — no push. A throwaway repo has no remote; assert the route did not add one.
  assert.equal(git("remote").trim(), "", "the apply path must never push or add a remote");

  // 5 — the Inbox count actually drops.
  const counts = (await (await fetch(`${BASE}/inbox?status=pending&limit=50`, { headers: auth() })).json()).counts;
  assert.equal(counts.pending, pendingBefore - 1, "the pending count must drop by exactly one");
});

test("a taskId with no pending Delivery still applies — the route degrades, never strands", async () => {
  const res = await fetch(`${BASE}/runtime/engine/apply`, {
    method: "POST", headers: auth(),
    body: JSON.stringify({ taskId: "task_deadbeef01", paths: [APPLIED_PATH] }),
  });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.ok(Array.isArray(out.results), "the broker result contract is unchanged");
  assert.equal(out.delivery, null, "no Delivery to decide is reported as null, never invented");
});

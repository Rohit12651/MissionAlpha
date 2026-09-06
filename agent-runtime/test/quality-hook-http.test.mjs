// Phase 1 / R1 — the post-edit quality gate, WIRED, against a REAL Docker jail.
//
// quality-hook.test.mjs pins the decision logic with an injected gate. This file pins the
// claim that logic is actually REACHABLE: a task whose worktree fails its own test suite
// dies inside engineDispatchTracked and NEVER MINTS A DELIVERY. That last clause is the
// whole acceptance criterion — a bad run that reaches a human has already cost the thing
// the gate exists to save.
//
// It uses the real jail on purpose. A mocked sandbox would prove the handler is correct
// (already proven elsewhere) but not that the fire point, the ctx fields, the gate object
// and the container all line up. Where Docker is absent the test SKIPS OUT LOUD — a
// silent pass on a machine that cannot run the thing under test is the vacuous-pass trap.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3986;
const TOK = "qualityhooktok";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { Host: `localhost:${PORT}`, "x-runtime-token": TOK, "content-type": "application/json" };

function dockerUp() {
  try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }); return true; }
  catch { return false; }
}
const HAVE_DOCKER = dockerUp();
const SKIP = HAVE_DOCKER ? false : "Docker daemon unreachable — the jailed quality gate cannot be exercised here";

let proc, repoDir, dbPath;

test.before(async () => {
  if (!HAVE_DOCKER) return;
  const dir = mkdtempSync(join(tmpdir(), "qhook-"));
  repoDir = mkdtempSync(join(tmpdir(), "qhook-repo-"));
  dbPath = join(dir, "mission.db");

  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "demo.ts"), "export const n = 1;\nconsole.log('debug me');\n");
  // The teeth: a test that FAILS, and (post-D1) one the SCOPER will select — it is
  // co-located with `src/demo.ts` and shares its stem, so the codemod's diff lands in a
  // worktree whose OWN related test is red. Before D1 the gate ran the whole repo suite,
  // which is why the file could be named anything; now relatedness is the contract, and a
  // fixture that ignored it would be testing a gate configuration nobody ships.
  writeFileSync(join(repoDir, "src", "demo.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("this repo is red", () => { assert.equal(1, 2); });',
    "",
  ].join("\n"));

  const git = (a) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  proc = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: {
      ...process.env,
      RUNTIME_BACKEND: "mock",
      RUNTIME_PORT: String(PORT),
      RUNTIME_TOKEN: TOK,
      RUNTIME_TOKEN_DIR: dir,
      RUNTIME_DB_PATH: dbPath,
      RUNTIME_REPO_ROOT: repoDir,
      RUNTIME_SANDBOX_DIR: join(dir, "sandbox"),
      RUNTIME_WORKTREE_DIR: join(dir, "worktrees"),
      RUNTIME_ENGINE_STORE: join(dir, "engine"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 30_000);
    proc.stdout.on("data", (b) => { if (String(b).includes(`listening :${PORT}`)) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}`)); });
  });
});

test.after(() => { try { proc?.kill(); } catch { /* already gone */ } });

async function settle(pred, ms = 180_000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    const { tasks } = await (await fetch(`${BASE}/runtime/engine/runs`, { headers: H })).json();
    last = tasks;
    const hit = tasks.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`never settled. last=${JSON.stringify(last)}`);
}

test("WIRED-1: the quality gate is REGISTERED on post-edit", { skip: SKIP }, async () => {
  const r = await fetch(`${BASE}/runtime/doctor`, { headers: H });
  assert.equal(r.status, 200);
  const body = await r.json();
  // The doctor SUMMARISES hooks (it never exposes handler functions or their names), so the
  // observable is the handler COUNT. Before this task that count was 0 and the check still
  // said "ok"; it now warns on enabled-but-empty, so a non-zero count here is the live
  // proof that a real handler is registered on the live server.
  const hooks = (body.checks || []).find((c) => c.check === "hooks" || c.id === "hooks" || /hook/i.test(c.name || ""));
  assert.ok(hooks, `no hooks check in the doctor report: ${JSON.stringify(body.checks?.map((c) => c.check ?? c.id ?? c.name))}`);
  assert.equal(hooks.status, "ok", `hooks check should be ok once a handler is registered: ${hooks.detail}`);
  const m = /(\d+) with handlers/.exec(String(hooks.detail));
  assert.ok(m, `expected a handler count in: ${hooks.detail}`);
  assert.ok(Number(m[1]) >= 1, "at least one lifecycle event must carry a registered handler");
});

test("VETO-LIVE-1: a red worktree KILLS the run before any Delivery is minted", { skip: SKIP }, async () => {
  const r = await fetch(`${BASE}/runtime/engine/enqueue`, {
    method: "POST", headers: H,
    body: JSON.stringify({ agentId: "gatebot", steps: ["remove all console.log from src/demo.ts"] }),
  });
  const enqBody = await r.text();
  assert.equal(r.status, 201, enqBody);

  // Post-D4 a hook veto is TERMINAL on the first attempt: the gate has already given its
  // final answer, and re-running it three times spent three model turns to re-derive it.
  const t = await settle((x) => x.agentId === "gatebot" && x.status === "failed" && (x.attempts ?? 0) >= 1);
  assert.equal(t.error?.kind, "gate-veto", "a gate veto is classified as itself, not as 'spawn'");
  assert.equal(t.attempts, 1, "one attempt — a settled refusal is not retried");

  // PRECONDITION: the failure must be the VETO, not some unrelated fault. Without this the
  // "no Delivery" assertion below would pass for entirely the wrong reason.
  assert.match(String(t.error?.msg), /quality gate failed/i,
    `expected a quality-gate veto, got ${JSON.stringify(t.error)}`);
  assert.match(String(t.error?.msg), /this repo is red|AssertionError|failing/i,
    "the veto reason must carry the real test output, not a generic message");

  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT kind, title FROM deliveries WHERE agentId = ?").all("gatebot");
  db.close();
  const code = rows.filter((x) => x.kind === "code");
  assert.equal(code.length, 0,
    `a vetoed run must mint NO code Delivery — found ${JSON.stringify(rows)}`);
});

test("VETO-LIVE-2: post-edit actually INVOKED the gate — loop steps are the receipt", { skip: SKIP }, async () => {
  // WIRED-1 proves a handler is registered; VETO-LIVE-1 proves a run died. Neither alone
  // proves the fire point RAN — a veto could in principle have come from elsewhere. The
  // gate records its own loop steps under the task id, so their presence is direct
  // evidence that engineDispatchTracked reached post-edit and called through.
  const t = await settle((x) => x.agentId === "gatebot" && x.status === "failed");
  const { steps } = await (await fetch(`${BASE}/runtime/engine/steps?taskId=${t.taskId}`, { headers: H })).json();
  assert.match(JSON.stringify(steps), /unit-test-gate/,
    "post-edit must have actually invoked the gate — loop steps are its receipt");
});

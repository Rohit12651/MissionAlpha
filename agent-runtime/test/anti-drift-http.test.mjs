// Phase 4 / R14 — the stall detector, WIRED to the live queue and the live delivery store.
//
// anti-drift.test.mjs pins the decision logic against an injected queue. This pins the
// claim it is REACHABLE: on a running server, a task the machine is sitting on surfaces as
// a diff-less escalation Delivery inside the window, with no human action.
//
// THE WEDGE IS MANUFACTURED HONESTLY — and its FIRST TWO VERSIONS WERE BOTH WRONG, which
// is worth recording because both failed in the same way.
//
//   v1: a burst of 12 goals to one agent (maxPerAgent = 1), stall window 2s. Depended on
//       the burst outlasting the window. It also left Docker containers running past
//       teardown and blew a neighbouring file's boot budget.
//   v2: 8 goals, stall window 1ms. Depended on the burst outlasting the 5s SLA SWEEP
//       INTERVAL. It passed once and then failed consistently — because Docker's cache
//       warmed up, turns got faster, and the whole burst began finishing before the first
//       sweep ever fired. A test whose result tracks an image cache is not a test.
//
//   v3 (this one): ONE task that names a file which does not exist. The codemod correctly
//       refuses (CODEMOD_NOOP), the engine re-enqueues it with an EXPONENTIAL BACKOFF, and
//       a task waiting on `notBefore` sits `queued` for SECONDS by construction — base
//       2000ms, doubling. The wedge is now a property of the retry policy, not of how fast
//       the machine happens to be. It also needs no Docker and no burst.
//
// THE ASSERTION IS NARROW ON PURPOSE. A retry-exhausted task ALSO mints a diff-less
// `failure` Delivery via onTerminalFailure — so "a failure row exists" would pass for
// entirely the wrong reason. anti-drift mints with kind `stalled`, giving the title
// "... is stuck — stalled"; the terminal path gives "... is stuck — spawn". The test reads
// the title.

import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3985;
const TOK = "antidrifttok";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { Host: `localhost:${PORT}`, "x-runtime-token": TOK, "content-type": "application/json" };

let proc, repoDir, dbPath;

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "adrift-"));
  repoDir = mkdtempSync(join(tmpdir(), "adrift-repo-"));
  dbPath = join(dir, "mission.db");

  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "demo.ts"), "export const n = 1;\nconsole.log('x');\n");
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
      RUNTIME_WORKER_CAP_FILE: join(dir, "worker-caps.json"),
      // 1ms window: any task the machine still owns when a sweep fires is stalled. The AGE
      // ARITHMETIC itself (threshold, `held` excluded, one-per-episode, unparseable
      // timestamps) is exhaustively pinned against a controlled clock in
      // anti-drift.test.mjs. THIS file proves only that the sweep is on the live timer,
      // reads the live queue and mints through the live store.
      RUNTIME_STALL_MS: "1",
      RUNTIME_SLA_SWEEP_MS: "5000",
      // The post-edit gate is irrelevant to a stall and only adds container load. Off.
      RUNTIME_HOOK_POSTEDIT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 30_000);
    proc.stdout.on("data", (b) => { if (String(b).includes(`listening :${PORT}`)) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}`)); });
  });
});

// DRAIN BEFORE TEARDOWN. Killing the server mid-turn orphans a running jail container,
// which keeps loading the machine after this file has "finished" — the next suite file
// then boots against a budget it should have met. Wait for the queue to go terminal first.
test.after(async () => {
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const { tasks } = await (await fetch(`${BASE}/runtime/engine/runs`, { headers: H })).json();
      if (!tasks.some((t) => t.status === "queued" || t.status === "claimed")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch { /* the server may already be gone — teardown must never fail the file */ }
  try { proc?.kill(); } catch { /* already gone */ }
});

test("E8-1: a task the machine sits on becomes a DIFF-LESS escalation Delivery", async () => {
  // src/missing.ts does not exist. The codemod refuses (CODEMOD_NOOP) rather than inventing
  // a change, the engine re-enqueues with backoff, and the retry sits `queued` on a
  // `notBefore` well past the sweep interval. That is a real wedge: the machine owns the
  // work and is not moving it.
  const r = await fetch(`${BASE}/runtime/engine/enqueue`, {
    method: "POST", headers: H,
    body: JSON.stringify({ agentId: "wedgebot", steps: ["remove all console.log from src/missing.ts"] }),
  });
  const body = await r.text();
  assert.equal(r.status, 201, body);

  const { default: Database } = await import("better-sqlite3");
  const deadline = Date.now() + 120_000;
  let sawQueued = false;
  let rows = [];
  while (Date.now() < deadline) {
    const { tasks } = await (await fetch(`${BASE}/runtime/engine/runs`, { headers: H })).json();
    if (tasks.some((t) => t.agentId === "wedgebot" && t.status === "queued")) sawQueued = true;
    const db = new Database(dbPath, { readonly: true });
    rows = db.prepare("SELECT kind, title, diffFiles, changedPaths, riskBand, status FROM deliveries WHERE agentId = ?").all("wedgebot");
    db.close();
    if (rows.some((x) => /stalled/i.test(x.title))) break;
    await new Promise((r2) => setTimeout(r2, 500));
  }
  // PRECONDITION: without this the assertion below could pass on a machine where nothing
  // ever queued and the row came from somewhere else entirely.
  assert.ok(sawQueued, "PRECONDITION: the retry must actually sit queued on its backoff");

  // NARROW: `stalled` is anti-drift's kind. The retry-exhaustion path mints "— spawn".
  const esc = rows.filter((x) => x.kind === "failure" && /stalled/i.test(x.title));
  assert.ok(esc.length >= 1, `expected a STALL escalation, got ${JSON.stringify(rows)}`);

  // LAW 3, read off the persisted row rather than trusted from a comment.
  for (const e of esc) {
    assert.equal(e.diffFiles, 0, "an escalation must be DIFF-LESS");
    assert.equal(e.changedPaths, "[]", "…with no path an approve could ever apply");
    assert.equal(e.status, "pending", "it waits for a human like everything else");
  }
});

test("E8-2: the escalation is DAILY CAPPED — a wedged queue is not a Delivery storm", async () => {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  const n = db.prepare("SELECT COUNT(*) c FROM deliveries WHERE kind='failure' AND agentId=? AND title LIKE '%stalled%'").get("wedgebot").c;
  db.close();
  // The default worker cap is 3/day and every stall escalation shares ONE budget id, so a
  // dozen wedged tasks cannot become a dozen rows.
  assert.ok(n <= 3, `stall escalations must stay inside the daily cap, saw ${n}`);
});

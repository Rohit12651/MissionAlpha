// Phase 1 / R3 — TIER ROUTING WIRED INTO THE ENGINE.
//
// The module + its table were built (tier-routing.test.mjs) and then sat DORMANT: nothing
// called classifyTier, so no task was ever routed. These tests pin the WIRING, which is a
// different claim from "the classifier is correct".
//
// The load-bearing group is TIER0-*. It proves the whole point of Tier 0 on an install
// with NO ACTIVE ACCOUNT (this one): a mechanical task completes, produces a real diff,
// and stops at the human gate — having consulted no model and spent no tokens.
//
// LAW 1 is pinned by LAW1-1: the codemod writes into the per-task WORKTREE only. The file
// in the live repo still carries its console.log after the run, because nothing has been
// applied yet. If a future edit lets a codemod reach the repo, that test fails.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { extractTargets, TARGET_SCAN_CAP } from "../router-tier.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── PURE: target extraction ──────────────────────────────────────────────────
// A codemod needs FILES. Without an explicit target the transform has nothing
// deterministic to run against, and guessing is exactly the fail-wrong this tier refuses.

test("TARGETS-1: a worktree-relative code path is extracted", () => {
  assert.deepEqual(extractTargets("remove all console.log from src/x.ts"), ["src/x.ts"]);
});

test("TARGETS-2: multiple paths extract in order and dedupe", () => {
  assert.deepEqual(
    extractTargets("strip console.log from src/a.ts and src/b.mjs and src/a.ts again"),
    ["src/a.ts", "src/b.mjs"],
  );
});

test("TARGETS-3: an ABSOLUTE path is refused — a codemod is worktree-relative only", () => {
  assert.deepEqual(extractTargets("remove console.log from /etc/evil.ts"), []);
});

test("TARGETS-4: a traversal path is refused", () => {
  assert.deepEqual(extractTargets("remove console.log from ../../outside/x.ts"), []);
});

test("TARGETS-5: non-code extensions are ignored", () => {
  assert.deepEqual(extractTargets("remove console.log from README.md and data/x.json"), []);
});

test("TARGETS-6: a non-string / empty task yields no targets, never a throw", () => {
  assert.deepEqual(extractTargets(null), []);
  assert.deepEqual(extractTargets(undefined), []);
  assert.deepEqual(extractTargets(""), []);
  assert.deepEqual(extractTargets(42), []);
  assert.deepEqual(extractTargets({ task: "src/x.ts" }), []);
});

test("TARGETS-7: the scan is bounded — a flood of paths cannot grow unboundedly", () => {
  const flood = Array.from({ length: TARGET_SCAN_CAP + 50 }, (_, i) => `src/f${i}.ts`).join(" ");
  assert.equal(extractTargets(flood).length, TARGET_SCAN_CAP);
});

// ── LIVE: the wired engine path ──────────────────────────────────────────────

const PORT = 3987;
const TOK = "tierdispatchtok";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { Host: `localhost:${PORT}`, "x-runtime-token": TOK, "content-type": "application/json" };

let proc, repoDir, dbPath;

const git = (args) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "tier-dispatch-"));
  repoDir = mkdtempSync(join(tmpdir(), "tier-repo-"));
  dbPath = join(dir, "mission.db");

  mkdirSync(join(repoDir, "src"), { recursive: true });
  // The fixture: two removable debug lines plus code that MUST survive.
  writeFileSync(join(repoDir, "src", "demo.ts"), [
    "export function run(n: number) {",
    "  console.log('entering run', n);",
    "  const doubled = n * 2;",
    "  console.log('doubled', doubled);",
    "  console.error('this one is a real diagnostic');",
    "  return doubled;",
    "}",
    "",
  ].join("\n"));
  // A second fixture under a sensitive name — used by the FORCE-FULL test.
  writeFileSync(join(repoDir, "src", "auth.ts"), "export const x = 1;\nconsole.log('hi');\n");

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

// NOTE: GET /runtime/engine/runs does NOT expose the task text, so two scenarios cannot
// be told apart by what they asked for. They are separated by agentId instead.
async function enqueue(agentId, step) {
  const r = await fetch(`${BASE}/runtime/engine/enqueue`, {
    method: "POST", headers: H,
    body: JSON.stringify({ agentId, steps: [step] }),
  });
  // NOTE: read the body EXACTLY ONCE. Putting `await r.text()` in the assert message
  // consumes it eagerly — the assert then passes and `r.json()` throws "Body is unusable".
  const body = await r.text();
  assert.equal(r.status, 201, `enqueue failed: ${body}`);
  return JSON.parse(body);
}

/** Poll /runs until this agent's task settles into a non-running state. */
async function settle(predicate, ms = 25_000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/runtime/engine/runs`, { headers: H });
    const { tasks } = await r.json();
    last = tasks;
    const hit = tasks.find(predicate);
    if (hit) return hit;
    await new Promise((r2) => setTimeout(r2, 250));
  }
  throw new Error(`never settled. last=${JSON.stringify(last)}`);
}

test("TIER0-1: a mechanical task reaches the HUMAN GATE with NO active account", async () => {
  await enqueue("tierbot", "remove all console.log from src/demo.ts");
  const t = await settle((x) => x.agentId === "tierbot" && x.status === "held");
  assert.equal(t.status, "held");
  assert.ok(t.branch, "a worktree branch must exist — the diff lives there, not in the repo");
});

test("TIER0-2: the diff removes only the debug lines and keeps console.error", async () => {
  const t = await settle((x) => x.agentId === "tierbot" && x.status === "held");
  const r = await fetch(`${BASE}/runtime/engine/changes?taskId=${t.taskId}`, { headers: H });
  const { changes } = await r.json();
  const demo = changes.find((c) => c.path === "src/demo.ts");
  assert.ok(demo, `expected src/demo.ts in the diff, got ${JSON.stringify(changes.map((c) => c.path))}`);
  const text = String(demo.after ?? demo.content ?? demo.newText ?? "");
  assert.ok(text.length, "the change must carry the post-transform text");
  assert.ok(!text.includes("console.log"), "console.log must be gone");
  assert.ok(text.includes("console.error"), "console.error is a diagnostic and must survive");
  assert.ok(text.includes("const doubled = n * 2;"), "real code must be untouched");
});

test("LAW1-1: the LIVE repo file still has its console.log — nothing was applied", async () => {
  // PRECONDITION FIRST. Asserting "the repo is untouched" proves nothing if the codemod
  // never ran — that version of this test passes on a machine where the whole feature is
  // broken. Establish that a transform DID happen in the worktree, then assert the repo
  // did not move.
  const t = await settle((x) => x.agentId === "tierbot" && x.status === "held");
  const { changes } = await (await fetch(`${BASE}/runtime/engine/changes?taskId=${t.taskId}`, { headers: H })).json();
  const demo = changes.find((c) => c.path === "src/demo.ts");
  assert.ok(demo, "PRECONDITION: the worktree must actually carry a transformed src/demo.ts");
  assert.ok(!String(demo.after ?? demo.content ?? demo.newText ?? "").includes("console.log"),
    "PRECONDITION: the worktree copy must be the POST-transform text");

  const onDisk = readFileSync(join(repoDir, "src", "demo.ts"), "utf8");
  assert.ok(onDisk.includes("console.log('entering run', n);"),
    "a codemod must NEVER write to the repo — only into the task worktree");
});

test("TIER0-3: the usage feed carries a ZERO-TOKEN codemod turn ($0 proof)", async () => {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT tier, inputTokens, outputTokens, turns FROM usage WHERE agentId = ?").all("tierbot");
  db.close();
  const codemod = rows.find((r) => r.tier === "codemod");
  assert.ok(codemod, `expected a codemod usage row, got ${JSON.stringify(rows)}`);
  assert.equal(codemod.inputTokens, 0);
  assert.equal(codemod.outputTokens, 0);
  assert.ok(codemod.turns >= 1);
});

test("FORCE-FULL-1: a sensitive-domain task never reaches the codemod path", async () => {
  await enqueue("authbot", "remove console.log from src/auth.ts");
  // FORCE_FULL sends it to tier 2, which then meets the readiness gate this install fails
  // (no active account). The observable difference from TIER0-1 is decisive: TIER0-1
  // produced a HELD diff with no account; this one produces a refusal and no diff at all.
  const t = await settle((x) => x.agentId === "authbot" && !!x.error);
  assert.notEqual(t.status, "held", "a sensitive task must never reach the human gate via a codemod");
  // The queue stores error as { kind, msg } (engine.mjs handleRetryable) — String() on it
  // yields "[object Object]" and would match nothing, so assert on the real field.
  //
  // D4: this used to read "spawn". A readiness refusal is not a spawn failure and never
  // was — the engine simply had one bucket for every dispatch error, which is why 36
  // consecutive "no active account" refusals were each retried three times and reported to
  // the operator as a spawn problem. `NOT_TOOL_CAPABLE` now classifies as itself and is
  // terminal on the first attempt.
  assert.equal(t.error.kind, "not-capable");
  assert.equal(t.attempts, 1, "a settled refusal is answered once, not three times");
  assert.match(String(t.error.msg), /account|provider|backend|tool|capab/i,
    `expected a readiness refusal, got: ${JSON.stringify(t.error)}`);
  const onDisk = readFileSync(join(repoDir, "src", "auth.ts"), "utf8");
  assert.ok(onDisk.includes("console.log"), "auth.ts must be untouched");
});

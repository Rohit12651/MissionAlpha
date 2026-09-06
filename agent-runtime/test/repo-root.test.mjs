// F5 — configurable target repo tests (R1 env-timing: env read at module load → cache-bust import).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeWorkspace } from "../workspace.mjs";

// Fresh guards module with a given env (R1: env read at load → cache-bust the import).
let _n = 0;
async function loadGuards(env) {
  for (const k of ["RUNTIME_REPO_ROOT", "RUNTIME_SEED_DIRS"]) delete process.env[k];
  // P5: guards.mjs now consults the PERSISTED workspace when the env var is unset.
  // Point every case at a guaranteed-empty config dir so these assertions describe
  // the CODE, not whatever workspace the developer happens to have configured.
  process.env.RUNTIME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "f5-cfg-"));
  Object.assign(process.env, env);
  return import(`../guards.mjs?case=${_n++}`);
}

test("unset env → REPO_ROOT defaults to MissionAlpha repo (zero change)", async () => {
  const g = await loadGuards({});
  assert.ok(g.REPO_ROOT.endsWith("/MissonAlpha") || g.REPO_ROOT.includes("MissonAlpha"));
  // #9 widened the declared default; the point of this assertion is that an UNSET env
  // yields the module's documented default rather than something derived at runtime.
  assert.deepEqual(g.SEED_DIRS, ["src", "public", "agent-runtime", "docs"]);
});

test("RUNTIME_REPO_ROOT points the root at another existing dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f5-root-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  const g = await loadGuards({ RUNTIME_REPO_ROOT: dir });
  assert.equal(g.REPO_ROOT, dir);
  // applyAllowed re-derives against the NEW root
  assert.equal(g.applyAllowed("src/app.ts"), true);
  assert.equal(g.applyAllowed("../escape.ts"), false);     // containment vs new root
  assert.equal(g.applyAllowed(".env"), false);             // APPLY_DENY vs new root
});

test("invalid RUNTIME_REPO_ROOT fails closed (throws at load)", async () => {
  await assert.rejects(loadGuards({ RUNTIME_REPO_ROOT: "/no/such/dir/xyz123" }), /does not exist|not a directory/i);
});

test("RUNTIME_SEED_DIRS csv overrides the appliable scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f5-seed-"));
  mkdirSync(join(dir, "app"), { recursive: true });
  const g = await loadGuards({ RUNTIME_REPO_ROOT: dir, RUNTIME_SEED_DIRS: "app, lib" });
  assert.equal(g.applyAllowed("app/x.ts"), true);
  assert.equal(g.applyAllowed("lib/y.ts"), true);
  assert.equal(g.applyAllowed("src/z.ts"), false); // src no longer seeded
});

import { isGitRepo } from "../worktree.mjs";
test("isGitRepo: true for a git repo, false for a plain dir", async () => {
  const plain = mkdtempSync(join(tmpdir(), "f5-nogit-"));
  assert.equal(isGitRepo(plain), false);
  assert.equal(isGitRepo(process.cwd()), true); // agent-runtime is inside a git repo
});

// ── P5 — the persisted workspace joins the precedence chain ──────────────────
test("P5: persisted workspace becomes REPO_ROOT when the env var is unset", async () => {
  const repo = mkdtempSync(join(tmpdir(), "f5-ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  const cfg = mkdtempSync(join(tmpdir(), "f5-wscfg-"));
  assert.equal(writeWorkspace(repo, { configDir: cfg }).ok, true);
  const g = await loadGuards({ RUNTIME_CONFIG_DIR: cfg });
  assert.equal(g.REPO_ROOT, realpathSync(repo));
  assert.equal(g.applyAllowed("src/app.ts"), true);
  assert.equal(g.applyAllowed("../escape.ts"), false);
});

test("P5: RUNTIME_REPO_ROOT still WINS over the persisted workspace", async () => {
  const persisted = mkdtempSync(join(tmpdir(), "f5-ws-p-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: persisted });
  const envRoot = mkdtempSync(join(tmpdir(), "f5-ws-e-"));
  const cfg = mkdtempSync(join(tmpdir(), "f5-wscfg2-"));
  assert.equal(writeWorkspace(persisted, { configDir: cfg }).ok, true);
  const g = await loadGuards({ RUNTIME_CONFIG_DIR: cfg, RUNTIME_REPO_ROOT: envRoot });
  assert.equal(g.REPO_ROOT, resolve(envRoot));
});

test("P5: a vanished persisted workspace falls back to the default root, never throws", async () => {
  const repo = mkdtempSync(join(tmpdir(), "f5-ws-gone-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const cfg = mkdtempSync(join(tmpdir(), "f5-wscfg3-"));
  writeWorkspace(repo, { configDir: cfg });
  rmSync(repo, { recursive: true, force: true });
  const g = await loadGuards({ RUNTIME_CONFIG_DIR: cfg });
  assert.ok(g.REPO_ROOT.includes("MissonAlpha"), "fell back to the built-in default");
});

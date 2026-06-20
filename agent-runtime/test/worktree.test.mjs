// ADR-026 — Git worktree isolation. Tests run against a throwaway git repo in a
// temp dir. The HARD-gate concerns: branch/path built ONLY from sanitized server-side
// parts (no flag/refname injection), worktree OUTSIDE the repo, base pinned to a SHA,
// hooks neutralized, clean removal.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorktreeMgr, safeBranchPart } from "../worktree.mjs";

let root, repoRoot, worktreeRoot;
const git = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ma-wt-test-"));
  repoRoot = join(root, "repo");
  worktreeRoot = join(root, "worktrees");
  mkdirSync(repoRoot, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "src", "App.tsx"), "export const App = () => null;\n");
  writeFileSync(join(repoRoot, "README.md"), "# repo\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

const mk = () => createWorktreeMgr({ repoRoot, worktreeRoot });

test("create() makes a real worktree checked out from a pinned base SHA", () => {
  const wt = mk();
  const headSha = git(["rev-parse", "HEAD"]);
  const r = wt.create("task_abc123");
  assert.ok(existsSync(r.path), "worktree dir exists");
  assert.ok(existsSync(join(r.path, "src", "App.tsx")), "checkout has the repo tree");
  assert.equal(r.baseRef, headSha, "base pinned to resolved SHA, not a symbolic ref");
  assert.match(r.branch, /^ma\/task\/task_abc123$/);
  // the branch really exists in the repo
  const branches = git(["branch", "--list", r.branch]);
  assert.ok(branches.includes(r.branch));
});

test("worktree path is OUTSIDE the repo root (sr-security)", () => {
  const wt = mk();
  const r = wt.create("task_xyz");
  assert.ok(!r.path.startsWith(repoRoot + "/"), "worktree must not live inside the repo");
  assert.ok(r.path.startsWith(worktreeRoot), "worktree under WORKTREE_ROOT");
});

test("pathFor() resolves the worktree dir deterministically after create", () => {
  const wt = mk();
  const r = wt.create("task_p");
  assert.equal(wt.pathFor("task_p"), r.path);
  assert.equal(wt.pathFor("never-made"), null);
});

test("branch + path are sanitized — metacharacters / flag-injection stripped", () => {
  const wt = mk();
  // a hostile key: shell metachars, flag lead, path traversal, refname-illegal
  const r = wt.create("-b --upstream=evil; rm -rf / ..\\x00");
  // branch must keep the fixed prefix and contain ONLY [a-z0-9_/-]
  assert.match(r.branch, /^ma\/task\/[a-z0-9_-]*$/i);
  assert.ok(!r.branch.includes(".."));
  assert.ok(!r.branch.includes(" "));
  assert.ok(!r.branch.includes(";"));
  // path stays under worktreeRoot, no escape
  assert.ok(r.path.startsWith(worktreeRoot));
  assert.ok(!r.path.includes(".."));
  assert.ok(existsSync(r.path));
});

test("safeBranchPart never yields a leading dash and only [a-z0-9_-]", () => {
  assert.equal(safeBranchPart("--force"), "force");
  assert.equal(safeBranchPart("a b;c|d$e"), "abcde");
  assert.equal(safeBranchPart("../../etc"), "etc");
});

test("create() is idempotent — re-creating the same key returns the same worktree", () => {
  const wt = mk();
  const a = wt.create("task_idem");
  const b = wt.create("task_idem");
  assert.equal(a.path, b.path);
  assert.equal(a.branch, b.branch);
  assert.ok(existsSync(a.path));
});

test("edits in the worktree do NOT touch the live repo working tree", () => {
  const wt = mk();
  const r = wt.create("task_iso");
  writeFileSync(join(r.path, "src", "App.tsx"), "export const App = () => 'edited';\n");
  // live repo file unchanged
  const liveStatus = git(["status", "--porcelain"]);
  assert.equal(liveStatus, "", "live repo working tree is clean — edit was isolated");
});

test("remove() tears down the worktree and deletes the branch", () => {
  const wt = mk();
  const r = wt.create("task_rm");
  assert.ok(existsSync(r.path));
  wt.remove("task_rm");
  assert.ok(!existsSync(r.path), "worktree dir gone");
  const branches = git(["branch", "--list", r.branch]);
  assert.equal(branches, "", "branch deleted");
  assert.equal(wt.pathFor("task_rm"), null);
});

test("remove() of an unknown key is a safe no-op", () => {
  const wt = mk();
  assert.doesNotThrow(() => wt.remove("never-existed"));
});

test("two concurrent keys get independent worktrees (parallel-safe)", () => {
  const wt = mk();
  const a = wt.create("task_a");
  const b = wt.create("task_b");
  assert.notEqual(a.path, b.path);
  writeFileSync(join(a.path, "src", "App.tsx"), "A\n");
  writeFileSync(join(b.path, "src", "App.tsx"), "B\n");
  assert.notEqual(
    execFileSync("cat", [join(a.path, "src", "App.tsx")], { encoding: "utf-8" }),
    execFileSync("cat", [join(b.path, "src", "App.tsx")], { encoding: "utf-8" }),
  );
});

test("git is unavailable → create throws a clear error (caller falls back)", () => {
  const wt = createWorktreeMgr({ repoRoot: join(root, "not-a-repo"), worktreeRoot });
  mkdirSync(join(root, "not-a-repo"), { recursive: true });
  assert.throws(() => wt.create("task_nogit"), /worktree|git/i);
});

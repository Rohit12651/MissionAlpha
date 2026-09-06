// D3 — THE AGENT'S BASELINE MUST BE THE OPERATOR'S BASELINE.
//
// ADR-026 pinned every task worktree to `HEAD`. On an install that works out of a dirty
// tree (this repo has run for weeks under a no-commit mandate) that makes the agent's
// checkout an arbitrary number of days STALE, and it poisons the broker: listChanges
// diffs the worktree against the LIVE repo, so every file the operator changed since
// HEAD reads as a change the AGENT proposed. A one-line docs task minted a 29-file
// Delivery whose `after` side was the old HEAD — approving it would have reverted two
// weeks of uncommitted work.
//
// The fix is a SNAPSHOT base: a commit object built from the operator's current working
// tree (tracked modifications + untracked, .gitignore respected) in a TEMPORARY index,
// so nothing about the operator's repo state moves — no staging, no HEAD move, no branch.
//
// The gates these tests hold:
//   • the worktree really carries the operator's uncommitted work
//   • the operator's index / HEAD / branches are untouched
//   • a CLEAN tree still bases on HEAD itself (byte-identical to pre-D3)
//   • the snapshot is deterministic (same tree ⇒ same sha ⇒ no object churn)
//   • secret-shaped files never enter the snapshot (the worktree is mounted into the
//     test-gate jail and read by the agent; HEAD-based worktrees never exposed them)
//   • `baseMode: "head"` restores the old behaviour exactly
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorktreeMgr, snapshotAllowed } from "../worktree.mjs";

let root, repoRoot, worktreeRoot;
const git = (args, cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ma-wt-snap-"));
  repoRoot = join(root, "repo");
  worktreeRoot = join(root, "worktrees");
  mkdirSync(repoRoot, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "src", "App.tsx"), "export const App = () => null;\n");
  writeFileSync(join(repoRoot, "README.md"), "# repo\n");
  writeFileSync(join(repoRoot, ".gitignore"), "node_modules\nsecrets.local\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

const mk = (opts = {}) => createWorktreeMgr({ repoRoot, worktreeRoot, ...opts });

/** Make the tree dirty the way the real install is: a tracked edit + an untracked file. */
function dirtyTheTree() {
  writeFileSync(join(repoRoot, "src", "App.tsx"), "export const App = () => 'v2';\n");
  writeFileSync(join(repoRoot, "src", "brandNew.ts"), "export const brandNew = 1;\n");
}

test("WS-1: the worktree carries the operator's UNCOMMITTED work, not HEAD", () => {
  dirtyTheTree();
  const r = mk().create("task_dirty");
  assert.equal(r.baseMode, "snapshot", "a dirty tree must be snapshotted");
  assert.equal(
    readFileSync(join(r.path, "src", "App.tsx"), "utf-8"),
    "export const App = () => 'v2';\n",
    "the tracked modification must be in the checkout",
  );
  assert.ok(existsSync(join(r.path, "src", "brandNew.ts")), "the untracked file must be in the checkout");
});

test("WS-2: creating a worktree does NOT touch the operator's index, HEAD or branches", () => {
  dirtyTheTree();
  const headBefore = git(["rev-parse", "HEAD"]);
  const statusBefore = git(["status", "--porcelain"]);
  const branchesBefore = git(["branch", "--list"]);
  // Hash the index CONTENT, not its mtime: `git status` legitimately refreshes the stat
  // cache, so an mtime comparison would measure this test's own probes rather than the
  // thing under test. Content is what "the operator's staging area did not move" means.
  const indexPath = join(repoRoot, ".git", "index");
  const indexBefore = createHash("sha256").update(readFileSync(indexPath)).digest("hex");

  mk().create("task_notouch");

  assert.equal(
    createHash("sha256").update(readFileSync(indexPath)).digest("hex"),
    indexBefore,
    "the operator's real index file must not be written",
  );
  assert.equal(git(["rev-parse", "HEAD"]), headBefore, "HEAD must not move");
  assert.equal(git(["status", "--porcelain"]), statusBefore, "nothing may become staged");
  // The task branch is expected; nothing else may appear.
  // `git branch --list` marks the current branch with `*` and a worktree-checked-out
  // branch with `+`; compare bare names.
  const names = (s) => s.split("\n").map((b) => b.replace(/^[*+]?\s*/, "").trim()).filter(Boolean);
  const added = names(git(["branch", "--list"])).filter((b) => !names(branchesBefore).includes(b));
  assert.deepEqual(added, ["ma/task/task_notouch"]);
});

test("WS-3: a CLEAN tree still bases on HEAD itself — no snapshot commit is minted", () => {
  const head = git(["rev-parse", "HEAD"]);
  const r = mk().create("task_clean");
  assert.equal(r.baseRef, head, "clean tree ⇒ base is HEAD, byte-identical to pre-D3");
  assert.equal(r.baseMode, "head-clean");
});

test("WS-4: the snapshot is DETERMINISTIC — an unchanged tree yields the same base sha", () => {
  dirtyTheTree();
  const wt = mk();
  const a = wt.create("task_det_a");
  const b = wt.create("task_det_b");
  assert.equal(a.baseRef, b.baseRef, "same working tree ⇒ same snapshot commit (no object churn)");
  assert.notEqual(a.baseRef, git(["rev-parse", "HEAD"]), "and it is not HEAD");
});

test("WS-5: secret-shaped files are NEVER snapshotted into the agent's checkout", () => {
  dirtyTheTree();
  writeFileSync(join(repoRoot, ".env.backup"), "ANTHROPIC_API_KEY=sk-do-not-leak\n");
  writeFileSync(join(repoRoot, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\n");
  mkdirSync(join(repoRoot, "certs"));
  writeFileSync(join(repoRoot, "certs", "server.key"), "key\n");
  const r = mk().create("task_secrets");
  assert.ok(!existsSync(join(r.path, ".env.backup")), ".env* must never reach the worktree");
  assert.ok(!existsSync(join(r.path, "deploy.pem")), "*.pem must never reach the worktree");
  assert.ok(!existsSync(join(r.path, "certs", "server.key")), "*.key must never reach the worktree");
  assert.ok(existsSync(join(r.path, "src", "brandNew.ts")), "ordinary untracked work still lands");
});

test("WS-6: gitignored files never enter the snapshot", () => {
  dirtyTheTree();
  writeFileSync(join(repoRoot, "secrets.local"), "nope\n");
  mkdirSync(join(repoRoot, "node_modules"));
  writeFileSync(join(repoRoot, "node_modules", "big.js"), "x\n");
  const r = mk().create("task_ignored");
  assert.ok(!existsSync(join(r.path, "secrets.local")));
  assert.ok(!existsSync(join(r.path, "node_modules", "big.js")));
});

test("WS-7: baseMode 'head' restores the pre-D3 behaviour exactly", () => {
  dirtyTheTree();
  const head = git(["rev-parse", "HEAD"]);
  const r = mk({ baseMode: "head" }).create("task_headmode");
  assert.equal(r.baseRef, head);
  assert.equal(r.baseMode, "head");
  assert.equal(
    readFileSync(join(r.path, "src", "App.tsx"), "utf-8"),
    "export const App = () => null;\n",
    "head mode checks out HEAD, not the working tree",
  );
  assert.ok(!existsSync(join(r.path, "src", "brandNew.ts")));
});

test("WS-8: snapshotAllowed is a closed, case-insensitive deny predicate", () => {
  assert.equal(snapshotAllowed("src/App.tsx"), true);
  assert.equal(snapshotAllowed("docs/PING.md"), true);
  assert.equal(snapshotAllowed(".env"), false);
  assert.equal(snapshotAllowed(".env.local"), false);
  assert.equal(snapshotAllowed(".ENV.Backup"), false);
  assert.equal(snapshotAllowed("config/.env.production"), false);
  assert.equal(snapshotAllowed("a/b/deploy.pem"), false);
  assert.equal(snapshotAllowed("a/b/server.KEY"), false);
  assert.equal(snapshotAllowed("bundle.p12"), false);
  assert.equal(snapshotAllowed("id_rsa"), false);
  assert.equal(snapshotAllowed("keys/id_ed25519"), false);
  assert.equal(snapshotAllowed(".git/config"), false);
  assert.equal(snapshotAllowed(".claude/settings.json"), false);
  assert.equal(snapshotAllowed("node_modules/x/index.js"), false);
});

test("WS-9: a snapshot failure falls back to HEAD and says so rather than wedging the engine", () => {
  dirtyTheTree();
  const wt = createWorktreeMgr({
    repoRoot,
    worktreeRoot,
    // Inject a snapshot step that always throws — the engine must still get a worktree.
    snapshotFn: () => { throw new Error("simulated snapshot failure"); },
  });
  const r = wt.create("task_fallback");
  assert.equal(r.baseRef, git(["rev-parse", "HEAD"]));
  assert.equal(r.baseMode, "head-fallback", "the fallback must be VISIBLE, never silent");
  assert.ok(existsSync(join(r.path, "src", "App.tsx")));
});

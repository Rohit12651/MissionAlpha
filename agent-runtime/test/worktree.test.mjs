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

// ── P5 — release(): the branch must outlive its worktree ─────────────────────
test("release() drops the worktree dir but KEEPS the branch (P5 approve→commit)", () => {
  const wt = mk();
  const r = wt.create("task_rel");
  writeFileSync(join(r.path, "src", "App.tsx"), "released\n");
  git(["add", "-A"], r.path);
  git(["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "wip"], r.path);
  const sha = git(["rev-parse", r.branch]);
  wt.release("task_rel");
  assert.ok(!existsSync(r.path), "worktree dir gone");
  assert.equal(git(["rev-parse", r.branch]), sha, "branch survives with its commit");
  assert.equal(wt.pathFor("task_rel"), null);
});

test("release() of an unknown key is a safe no-op", () => {
  const wt = mk();
  assert.doesNotThrow(() => wt.release("never-existed"));
});

// ── sr-security P5 re-review #6 — create() must not `branch -D` landed work ───
const commitInWt = (path, text) => {
  writeFileSync(join(path, "src", "App.tsx"), text);
  git(["add", "-A"], path);
  git(["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "landed"], path);
};

test("#6 create() REFUSES to delete a stale branch whose tip is not in the base", () => {
  const wt = mk();
  const r = wt.create("task_div");
  commitInWt(r.path, "approved work\n");
  const sha = git(["rev-parse", r.branch]);
  wt.release("task_div"); // P5 landing: dir dropped, ref kept — the ONLY copy of the commit
  assert.throws(() => wt.create("task_div"), /refusing to delete|not in the base/i);
  assert.equal(git(["rev-parse", r.branch]), sha, "the approved commit survives key reuse");
});

test("#6 create() still recycles a genuinely stale branch (tip == base, no work on it)", () => {
  const wt = mk();
  wt.create("task_stale");
  wt.release("task_stale"); // branch left at the base SHA, carrying nothing
  assert.doesNotThrow(() => wt.create("task_stale"));
  assert.ok(existsSync(wt.pathFor("task_stale")));
});

test("pruneOrphans() clears stale worktree metadata without touching live ones", () => {
  const wt = mk();
  const live = wt.create("task_live");
  const dead = wt.create("task_dead");
  rmSync(dead.path, { recursive: true, force: true }); // simulate a crash-orphaned dir
  wt.pruneOrphans();
  const list = git(["worktree", "list", "--porcelain"]);
  assert.ok(list.includes(live.path), "live worktree still registered");
  assert.ok(!list.includes(dead.path), "orphan metadata pruned");
});

// ── Phase C · task 9 — SHIP AS YOU GO: the next task starts from the last one's tip ──
// Probe P-F08 reversed. Every task worktree was based on the repo HEAD, so task B never saw
// task A's file even when the plan ordered A first — B either duplicated the work or wrote
// against a file that did not exist yet, and the conflict surfaced at ship with the seats gone.
test("SEQ-1: create({ baseRef }) checks out from THAT ref, so task B sees task A's work", () => {
  // Mutation proof (2026-09-17): `const wanted = ""` (ignore the caller's baseRef) →
  // ✖ SEQ-1 and ✖ SEQ-1b (fail 2); falling back to HEAD on an unresolvable ref → ✖ SEQ-1b
  // alone (fail 1), which is what proves the two are not redundant. Restored, md5 matched.
  const wt = mk();
  // Task A: a worktree, a new file, committed onto the job branch.
  const a = wt.create("task_a");
  writeFileSync(join(a.path, "src", "fromA.ts"), "export const a = 1;\n");
  const g = (args) => execFileSync("git", args, { cwd: a.path, encoding: "utf-8" }).trim();
  g(["add", "-A"]);
  g(["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "A"]);
  const jobBranch = "ma/job/j1";
  g(["branch", jobBranch]);
  const tip = g(["rev-parse", jobBranch]);

  // Task B, created AFTER A landed, based on the job branch tip.
  const b = wt.create("task_b", { baseRef: jobBranch });
  assert.equal(b.baseRef, tip, "B must be pinned to the resolved tip, not to a symbolic ref");
  assert.ok(existsSync(join(b.path, "src", "fromA.ts")),
    "B's checkout must contain A's file — this is the whole point of shipping as you go");
  assert.ok(existsSync(join(b.path, "src", "App.tsx")), "and still carry the base tree");
});

test("SEQ-1b: an unknown baseRef is refused, not silently downgraded to HEAD", () => {
  const wt = mk();
  assert.throws(() => wt.create("task_c", { baseRef: "ma/job/does-not-exist" }), /base|ref|resolve/i,
    "falling back to HEAD would reintroduce exactly the stale-base defect this closes");
});

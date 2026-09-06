// A fresh seat worktree must NOT carry the operator's committed `.claude/`.
//
// THE DEFECT, proven not reasoned about. seat-settings-guard.mjs (6.7) opens with "The
// snapshot never carries `.claude/` (SNAPSHOT_DENY)". That is FALSE on the git-worktree
// path: `.claude/` is COMMITTED here (3,081 tracked files, including `.claude/settings.json`),
// and `git worktree add` checks out whatever is committed. SNAPSHOT_DENY governs the
// copy-sandbox snapshot, not a git checkout.
//
//     $ git cat-file -e HEAD:.claude/settings.json    → present
//     $ git worktree add --detach /tmp/probe HEAD
//     $ ls /tmp/probe/.claude/settings.json           → present
//
// So the guard found a permission-bearing file in EVERY worktree, refused EVERY spawn, and
// every engine task ended `empty-diff` having authored nothing. PES addendum #9 (the probe's
// premise was wrong) underneath #21 (a guard that blocks the tool).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorktreeMgr } from "../worktree.mjs";

function repoWithCommittedClaude() {
  const repo = mkdtempSync(join(tmpdir(), "ma-wt-repo-"));
  const g = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
  g(["init", "-q", "."]);
  g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const A = 1;\n");
  // The operator's own committed config — exactly this repo's shape.
  mkdirSync(join(repo, ".claude", "skills-curated", "ui"), { recursive: true });
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: [] } }));
  writeFileSync(join(repo, ".claude", "skills-curated", "ui", "SKILL.md"), "# ui\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "seed"]);
  return repo;
}

test("WT-CLAUDE-1: the operator's committed .claude IS in a raw git checkout (the premise)", () => {
  // Non-vacuity: prove the thing the fix removes is genuinely there without it.
  const repo = repoWithCommittedClaude();
  const wt = join(tmpdir(), `ma-raw-${Date.now()}`);
  execFileSync("git", ["worktree", "add", "--detach", "-q", wt, "HEAD"], { cwd: repo });
  assert.equal(existsSync(join(wt, ".claude", "settings.json")), true,
    "a raw worktree carries it — that is why every spawn was refused");
  execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repo });
});

test("WT-CLAUDE-2: create() strips .claude, so the guard's premise is true again", () => {
  const repo = repoWithCommittedClaude();
  const mgr = createWorktreeMgr({ repoRoot: repo, worktreeRoot: mkdtempSync(join(tmpdir(), "ma-wt-")) });
  const { path } = mgr.create("task_stripclaude");
  assert.equal(existsSync(join(path, ".claude")), false,
    "the seat must never be handed the operator's .claude — the CLI would load it");
  assert.equal(existsSync(join(path, "src", "a.ts")), true, "the rest of the checkout is untouched");
});

test("WT-CLAUDE-3: the strip produces NO phantom changes or refusals in the broker", async () => {
  // What actually matters is not `git status` purity — the broker WALKS the filesystem, so a
  // path that no longer exists is never enumerated, and `.claude` is REFUSAL_NOISE besides.
  // This asserts the real invariant: a freshly created worktree yields an empty Delivery.
  const { createBroker } = await import("../broker.mjs");
  const repo = repoWithCommittedClaude();
  const mgr = createWorktreeMgr({ repoRoot: repo, worktreeRoot: mkdtempSync(join(tmpdir(), "ma-wt-")) });
  const { path } = mgr.create("task_stripclean");
  const broker = createBroker({ repoRoot: repo, workdirFor: () => path, scrub: (x) => x });
  const out = await broker.listChangesDetailed("task_stripclean");
  assert.deepEqual(out.changes, [], "a fresh worktree must propose nothing");
  assert.deepEqual(out.refused, [], "and must not report the stripped .claude as a refusal");
});

test("WT-CLAUDE-4: a REUSED worktree is stripped too", () => {
  // create() returns early on re-entry (crash recovery). If the strip only ran on the fresh
  // path, a reused checkout would still hand the seat the operator's .claude.
  const repo = repoWithCommittedClaude();
  const mgr = createWorktreeMgr({ repoRoot: repo, worktreeRoot: mkdtempSync(join(tmpdir(), "ma-wt-")) });
  const first = mgr.create("task_reuse");
  writeFileSync(join(first.path, "src", "b.ts"), "export const B = 2;\n");
  mkdirSync(join(first.path, ".claude"), { recursive: true });
  writeFileSync(join(first.path, ".claude", "settings.json"), "{}"); // as if re-checked-out
  const again = mgr.create("task_reuse");
  assert.equal(again.reused, true, "premise: this must be the re-entry path");
  assert.equal(existsSync(join(again.path, ".claude")), false, "a reused worktree must be stripped too");
  assert.equal(existsSync(join(again.path, "src", "b.ts")), true, "and the seat's own work must survive");
});

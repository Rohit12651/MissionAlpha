// ADR-026 — Git Worktree Isolation. Per-task git worktree (branch off a pinned base
// SHA) replaces the flat file copy. Gives real git-state isolation, parallel-safe
// per-task dirs, and trivial deterministic rollback (worktree remove + branch -D).
//
// EXPLICIT, NON-NEGOTIABLE: the worktree is git-state isolation ONLY — NOT an
// execution or security boundary. Bash/exec stays OFF (S1). The security boundary
// remains the apply broker (applyAllowed/CONFIG_GUARD/APPLY_DENY/symlink+realpath in
// server.mjs) — UNCHANGED. The diff/apply path reads from this worktree dir exactly
// as it read the copy; guards re-run on every apply regardless.
//
// sr-security HARD gate: branch + path are built ONLY from [a-z0-9_-] server-side
// parts with a fixed `ma/task/` prefix (can't lead with `-` → no flag injection);
// every git call is an argv array (no shell); core.hooksPath is neutralized
// per-invocation; base is a pinned SHA; worktree root is OUTSIDE the repo.

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GIT_SAFE_ARGS } from "./workspace.mjs";

// Strip everything except [a-z0-9_-]; result can never lead with '-' once the fixed
// `ma/task/` prefix is prepended. Same character class as safeId (server.mjs L346/531).
export function safeBranchPart(s) {
  return String(s).replace(/[^a-z0-9_-]/gi, "").replace(/^-+/, "").slice(0, 60);
}

export function createWorktreeMgr(opts = {}) {
  const repoRoot = opts.repoRoot;
  const worktreeRoot = opts.worktreeRoot || process.env.RUNTIME_WORKTREE_ROOT || join(tmpdir(), "missionalpha-worktrees");
  mkdirSync(worktreeRoot, { recursive: true });

  // Every git invocation: argv array (no shell), -C repo, and the FULL hardening
  // prefix (sr-security P5 re-review #8/#9) — hooks, fsmonitor, ext:: remotes,
  // credential/askpass helpers, external diff and the pager are all neutralized,
  // because a workspace can be an archive-sourced repo with a hostile .git/config.
  const git = (args, cwd = repoRoot) =>
    execFileSync("git", [...GIT_SAFE_ARGS, "-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  const safe = (key) => safeBranchPart(key) || "task";
  const pathOf = (key) => join(worktreeRoot, safe(key));
  const branchOf = (key) => `ma/task/${safe(key)}`;

  // pathFor — deterministic; returns the dir if it currently exists, else null.
  function pathFor(key) {
    const p = pathOf(key);
    return existsSync(p) ? p : null;
  }

  // create — `git worktree add --no-track -b <branch> <path> <BASE_SHA>`. Idempotent:
  // if the worktree already exists for this key (re-entry/crash recovery), return it.
  function create(key) {
    const path = pathOf(key);
    const branch = branchOf(key);
    if (existsSync(path)) {
      let baseRef = "";
      try { baseRef = git(["rev-parse", "HEAD"]); } catch { /* */ }
      return { path, branch, baseRef, reused: true };
    }
    let baseRef;
    try {
      baseRef = git(["rev-parse", "HEAD"]); // pin to a resolved SHA (ADR-026 §2)
    } catch (e) {
      throw new Error(`worktree: not a git repo or git unavailable (${e.message})`);
    }
    // If a stale branch lingers from a crashed run with this key, drop it first —
    // but ONLY when it is genuinely stale. #6: after a P5 branch landing the ref is
    // the ONLY copy of approved-but-unpushed work, and key reuse would `branch -D`
    // it out of existence. "Stale" therefore means: the tip is an ancestor of the
    // new base, i.e. it carries no commit the base does not already have. Anything
    // else is unlanded work and create() refuses rather than destroying it.
    const tip = (() => { try { return git(["rev-parse", "--verify", `refs/heads/${branch}`]); } catch { return null; } })();
    if (tip) {
      let stale = false;
      try { git(["merge-base", "--is-ancestor", tip, baseRef]); stale = true; } catch { stale = false; }
      if (!stale) {
        throw new Error(`worktree: branch ${branch} holds commits not in the base (${tip.slice(0, 8)}) — refusing to delete it; land or remove that branch first`);
      }
      try { git(["branch", "-D", branch]); } catch { /* raced away — fine */ }
    }
    try {
      git(["worktree", "add", "--no-track", "-b", branch, path, baseRef]);
    } catch (e) {
      throw new Error(`worktree add failed: ${e.message}`);
    }
    return { path, branch, baseRef, reused: false };
  }

  // remove — discard everything this task did. Never touches the live repo.
  function remove(key) {
    const path = pathOf(key);
    const branch = branchOf(key);
    if (existsSync(path)) {
      try { git(["worktree", "remove", "--force", path]); }
      catch {
        // lock / metadata issue → force-unlink the dir then prune
        try { rmSync(path, { recursive: true, force: true }); } catch { /* */ }
        try { git(["worktree", "prune"]); } catch { /* */ }
      }
    }
    try { git(["branch", "-D", branch]); } catch { /* branch already gone */ }
  }

  // release — P5. The task's work has been COMMITTED to `branch` (pr.mjs) and is
  // about to become a PR, or to stay as a local branch. The scratch checkout is no
  // longer needed, but deleting the branch would delete the commit the operator
  // just approved. So: drop the worktree dir, KEEP the ref. This is a separate verb
  // rather than a flag on remove() so no future caller can lose a commit by passing
  // the wrong boolean.
  function release(key) {
    const path = pathOf(key);
    if (!existsSync(path)) return;
    try { git(["worktree", "remove", "--force", path]); }
    catch {
      // lock / metadata issue → force-unlink the dir then prune. The branch is
      // never touched on either path.
      try { rmSync(path, { recursive: true, force: true }); } catch { /* */ }
      try { git(["worktree", "prune"]); } catch { /* */ }
    }
  }

  // Crash recovery: prune git's stale worktree metadata. The engine reconciles
  // orphan branches against run records separately (ADR-026 §6).
  function pruneOrphans() {
    try { git(["worktree", "prune"]); } catch { /* */ }
  }

  return { create, remove, release, pathFor, pruneOrphans, branchOf, worktreeRoot };
}

// F5 — cheap probe: is `dir` inside a git work tree? Used at boot to decide whether
// the engine uses worktree isolation or falls back to the copy-sandbox (non-git target).
export function isGitRepo(dir) {
  try {
    execFileSync("git", [...GIT_SAFE_ARGS, "-C", dir, "rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

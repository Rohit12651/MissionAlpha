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

// Strip everything except [a-z0-9_-]; result can never lead with '-' once the fixed
// `ma/task/` prefix is prepended. Same character class as safeId (server.mjs L346/531).
export function safeBranchPart(s) {
  return String(s).replace(/[^a-z0-9_-]/gi, "").replace(/^-+/, "").slice(0, 60);
}

export function createWorktreeMgr(opts = {}) {
  const repoRoot = opts.repoRoot;
  const worktreeRoot = opts.worktreeRoot || process.env.RUNTIME_WORKTREE_ROOT || join(tmpdir(), "missionalpha-worktrees");
  mkdirSync(worktreeRoot, { recursive: true });

  // Every git invocation: argv array (no shell), hooks neutralized (OQ-026.1), -C repo.
  const git = (args, cwd = repoRoot) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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
    // If a stale branch lingers from a crashed run with this key, drop it first.
    try { git(["branch", "-D", branch]); } catch { /* no such branch — fine */ }
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

  // Crash recovery: prune git's stale worktree metadata. The engine reconciles
  // orphan branches against run records separately (ADR-026 §6).
  function pruneOrphans() {
    try { git(["worktree", "prune"]); } catch { /* */ }
  }

  return { create, remove, pathFor, pruneOrphans, branchOf, worktreeRoot };
}

// F5 — cheap probe: is `dir` inside a git work tree? Used at boot to decide whether
// the engine uses worktree isolation or falls back to the copy-sandbox (non-git target).
export function isGitRepo(dir) {
  try {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, "rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

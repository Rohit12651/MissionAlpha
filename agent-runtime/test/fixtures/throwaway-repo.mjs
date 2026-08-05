// Test fixture — a THROWAWAY git repo in $TMPDIR for any test that boots server.mjs.
//
// Why this exists (Fable finding, P5 re-review): a spawned server with no
// RUNTIME_REPO_ROOT defaults REPO_ROOT to the LIVE MissionAlpha checkout, so every
// exec/engine worktree the test triggers is registered against the real repo and
// leaves `ma/task/*` branches and prunable worktree entries behind in the operator's
// working copy. Tests must never write to the repo they are testing.
//
// Shape mirrors the real root closely enough for SEED_DIRS/SEED_FILES (src/, public/,
// README.md, package.json) so broker + worktree behavior is representative.
import { mkdirSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// IDEMPOTENT: a restart test calls boot() twice against the same root and must get
// the same repo back, not a second `git commit` with nothing staged.
export function makeThrowawayRepo(parentDir, name = "repo") {
  const repo = join(realpathSync(parentDir), name);
  if (existsSync(join(repo, ".git"))) return repo;
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "public"), { recursive: true });
  writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
  writeFileSync(join(repo, "README.md"), "# throwaway test repo\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "throwaway", version: "0.0.0", scripts: { build: "true" } }, null, 2) + "\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

/**
 * Every RUNTIME_* path a spawned server must have isolated so it cannot touch the
 * live checkout: the repo target itself plus all worktree/state roots.
 */
export function isolatedRuntimeEnv(root, repo) {
  return {
    RUNTIME_REPO_ROOT: repo,
    RUNTIME_WORKTREE_ROOT: join(root, "iso", "wt"),
    RUNTIME_EXEC_WT_ROOT: join(root, "iso", "exwt"),
    RUNTIME_SANDBOX_ROOT: join(root, "iso", "sb"),
    RUNTIME_CONFIG_DIR: join(root, "iso", "cfg"),
  };
}

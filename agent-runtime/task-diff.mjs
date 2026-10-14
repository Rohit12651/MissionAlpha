// Phase C · task 10 — THE DIFF THE REVIEW TURN IS JUDGED ON.
//
// Lifted out of server.mjs so it can be proven against a real git repo without booting a
// listening runtime (the same reason manager-prompts.mjs and mail-env.mjs live on their own).
// server.mjs's `diffFor` is a thin call to this; SEAT-12 taught the lesson about leaving a
// ratchet pointed at an address the code has left, so DIFF-WIRED-1 pins that call site.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_SAFE_ARGS } from "./workspace.mjs";

const MAX_PATHS = 100;
const MAX_BUFFER = 8 * 1024 * 1024;

/** A pathspec git will treat as a PATH, never as an option or a NUL-split payload. */
function safePaths(paths) {
  return (Array.isArray(paths) ? paths : [])
    .map((p) => String(p))
    .filter((p) => p && !p.startsWith("-") && !p.includes("\0"))
    .slice(0, MAX_PATHS);
}

/**
 * `-c` overrides that disarm every filter and textconv the repo's config defines (GITSAFE-3).
 * A seat worktree's config can name a `filter.<x>.clean` / `.process` or `diff.<x>.textconv`
 * COMMAND that git runs while diffing any path .gitattributes maps to <x>. Reading config runs
 * nothing; an empty command is no command. Read-only diff only: on the commit paths, blanking
 * filters would break Git-LFS, so those are a separate decision.
 */
function filterNeutralizers(cwd, run) {
  const r = run("git", [...GIT_SAFE_ARGS, "-C", cwd, "config", "--get-regexp",
    "^(filter\\.[^.]+\\.(clean|smudge|process|required)|diff\\.[^.]+\\.textconv)$"], { encoding: "utf-8" });
  const out = [];
  for (const line of String(r.stdout || "").split("\n")) {
    const key = line.split(" ")[0];
    if (!key) continue;
    out.push("-c", key.endsWith(".required") ? `${key}=false` : `${key}=`);
  }
  return out;
}

/**
 * The diff for ONE task's declared paths, including files it CREATED.
 *
 * Probe P-F11: a plain `git diff -- <paths>` reports nothing for an untracked file, so a task
 * whose entire output is a new file reached the BOSS as an empty diff and was approved on
 * nothing at all. `git diff HEAD` covers staged-and-unstaged content in one read; making an
 * untracked file visible needs an intent-to-add entry.
 *
 * That entry is written to a THROWAWAY index (`GIT_INDEX_FILE`), never the worktree's own:
 * this runs against a live seat worktree, and a read must not leave state behind for the
 * commit path to trip over (DIFF-4 pins it).
 *
 * Returns "" on any failure — a diff is evidence, and a broken read must not be dressed up
 * as "nothing changed" by throwing into a caller that would swallow it anyway.
 */
export function taskDiff(cwd, paths, { run = spawnSync } = {}) {
  const safe = safePaths(paths);
  if (!cwd || !safe.length) return "";
  let idxDir = null;
  try {
    idxDir = mkdtempSync(join(tmpdir(), "ma-diffidx-"));
    const env = { ...process.env, GIT_INDEX_FILE: join(idxDir, "index") };
    const neutral = filterNeutralizers(cwd, run);
    // Seed the scratch index from HEAD so the comparison is HEAD → working tree.
    // GIT_SAFE_ARGS on every call (GITSAFE-1): this reads a SEAT worktree, whose `.git/config` may
    // name a core.fsmonitor or diff.external program that `add`/`diff` would otherwise execute.
    const seed = run("git", [...GIT_SAFE_ARGS, ...neutral, "-C", cwd, "read-tree", "HEAD"], { encoding: "utf-8", env });
    if (seed.status !== 0) return "";
    // Intent-to-add: registers the PATH so `git diff` will describe it, stages no content.
    run("git", [...GIT_SAFE_ARGS, ...neutral, "-C", cwd, "add", "-N", "--", ...safe], { encoding: "utf-8", env });
    // `--no-ext-diff`: GIT_SAFE_ARGS empties diff.external, and an EMPTY external driver makes a
    // content diff die ("cannot run"); the flag disables external drivers outright instead.
    const out = run("git", [...GIT_SAFE_ARGS, ...neutral, "-C", cwd, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", ...safe],
      { encoding: "utf-8", env, maxBuffer: MAX_BUFFER });
    return out.status === 0 ? String(out.stdout || "") : "";
  } catch {
    return "";
  } finally {
    if (idxDir) { try { rmSync(idxDir, { recursive: true, force: true }); } catch { /* scratch */ } }
  }
}

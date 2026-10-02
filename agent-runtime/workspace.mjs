// P5 — WORKSPACE CONFIG. "Point MissionAlpha at any git repo" needs exactly two
// things the runtime did not have: a VALIDATED choice, and somewhere durable and
// private to keep it. This module is both, and nothing else.
//
// SECURITY (sr-security; P5 is a BLOCKING-security phase):
//   • Every check runs on the REALPATH. A symlink to $HOME is $HOME.
//   • Refused: non-existent · not a directory · not a git work tree · $HOME ·
//     the filesystem root · anything inside a runtime-owned worktree root ·
//     anything that would CONTAIN a runtime state dir (token/sandbox/worktree),
//     because server.mjs asserts those live OUTSIDE REPO_ROOT and would refuse to
//     boot — persisting such a path would brick the runtime.
//   • `git` is invoked as an argv array (no shell) with core.hooksPath
//     neutralized, so a hostile repo's hooks cannot run during validation.
//   • The config file is 0600 in a 0700 dir OUTSIDE the repo — same posture as
//     TOKEN_FILE (server.mjs L165) and mission.db (db.mjs L149).

import { execFileSync } from "node:child_process";
import { existsSync, statSync, realpathSync, mkdirSync, chmodSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { tmpdir, homedir } from "node:os";

export const WORKSPACE_FILE_NAME = "workspace.json";

// The default config dir tracks the runtime's own out-of-repo state family, so a
// test harness that isolates RUNTIME_TOKEN_DIR isolates this too.
export function defaultConfigDir(env = process.env) {
  if (env.RUNTIME_CONFIG_DIR) return resolve(env.RUNTIME_CONFIG_DIR);
  return join(env.RUNTIME_TOKEN_DIR ? resolve(env.RUNTIME_TOKEN_DIR) : join(tmpdir(), "missionalpha-runtime"), "config");
}

// ── path identity on a case-INSENSITIVE filesystem (sr-security P5 re-review #1) ─
// realpathSync does NOT canonicalize case on APFS/NTFS: realpath("/Users/ROHIT")
// comes back as "/Users/ROHIT". A `===` or `startsWith` refusal is therefore
// bypassed by simply re-spelling the path — mixed-case $HOME pins $HOME as
// REPO_ROOT, and a differently-cased ancestor hides a state dir from the
// containment sweep. Every check in this module (and server.mjs's outside()
// assertion) goes through these two helpers instead.
export function isCaseInsensitiveFs(platform = process.platform) {
  return platform === "darwin" || platform === "win32";
}
const fold = (p, platform) => (isCaseInsensitiveFs(platform) ? p.toLowerCase() : p);

/**
 * Same directory entry? Inode identity (dev:ino) whenever BOTH sides exist — that
 * beats every string game at once (case, symlink, bind mount). Falls back to a
 * case-folded compare when either side is missing.
 */
export function samePath(a, b, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const pa = resolve(a), pb = resolve(b);
  try {
    const sa = statSync(pa), sb = statSync(pb);
    return `${sa.dev}:${sa.ino}` === `${sb.dev}:${sb.ino}`;
  } catch { /* one side does not exist — fall through to the string compare */ }
  return fold(pa, platform) === fold(pb, platform);
}

/**
 * Is `child` at or under `parent`? Case-folded on darwin/win32, exact elsewhere.
 * The trailing separator makes the boundary a real PATH boundary: `/a/bc` is NOT
 * inside `/a/b`.
 */
export function isInside(child, parent, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const p = resolve(parent), c = resolve(child);
  if (samePath(c, p, opts)) return true;
  const pfx = p.endsWith(sep) ? p : p + sep;
  return fold(c, platform).startsWith(fold(pfx, platform));
}

// ── hardened git invocation (sr-security P5 re-review #8 / #9) ────────────────
// A workspace can arrive as a downloaded archive carrying a hostile .git/config.
// Neutralizing core.hooksPath alone is not enough — these keys all execute a
// command or leak a credential during ordinary porcelain. Prepended to EVERY git
// call the runtime makes:
//   core.hooksPath=/dev/null  no hooks
//   core.fsmonitor=           no fsmonitor process (run by `git add` / `git diff`)
//   protocol.ext.allow=never  no `ext::<cmd>` remote (executed by push/fetch)
//   credential.helper=        no `!command` helper — blocks the RCE AND stops the
//                             operator's token being handed to a hostile helper
//   core.askPass=             no askpass binary
//   diff.external=            no external diff program
//   core.pager=cat            no pager process
//   core.quotePath=false      non-ASCII paths come back verbatim, so the staged-set
//                             drift check in pr.mjs can actually match them (#9)
// The credential.helper entry is a RESET, and it is total: it clears the accumulated
// helper list for every scope at once — system, global, repo-local, and the URL-scoped
// `credential.<url>.helper` form that `gh auth setup-git` actually writes.
//
// That was previously a DISCLOSED COST (no https push could authenticate, so pr.mjs
// rung (a) always demoted to rung (b)). It no longer is: pr.mjs re-adds the operator's
// GLOBAL helper entries AFTER this reset, on the PUSH call ONLY — see
// `pushCredentialArgs` there. Everything using GIT_SAFE_ARGS on its own (this module's
// probes, worktree.mjs, and pr.mjs's read-only/index/commit calls) keeps the BARE
// reset with no replay: none of them ever needs a credential.
// Still uncovered, by design: a helper configured ONLY in system scope is not replayed,
// so such a setup still demotes to rung (b). SSH remotes were never affected.
export const GIT_SAFE_ARGS = Object.freeze([
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=",
  "-c", "protocol.ext.allow=never",
  "-c", "credential.helper=",
  "-c", "core.askPass=",
  "-c", "diff.external=",
  "-c", "core.pager=cat",
  "-c", "core.quotePath=false",
]);

// The runtime state dirs that MUST stay outside the workspace (server.mjs L179-193).
function defaultStateDirs(env = process.env) {
  return [
    env.RUNTIME_SANDBOX_ROOT || join(tmpdir(), "missionalpha-sandboxes"),
    env.RUNTIME_TOKEN_DIR || join(tmpdir(), "missionalpha-runtime"),
    env.RUNTIME_WORKTREE_ROOT || join(tmpdir(), "missionalpha-worktrees"),
    ...(env.RUNTIME_EXEC_WT_ROOT ? [env.RUNTIME_EXEC_WT_ROOT] : []),
  ];
}
function defaultWorktreeRoots(env = process.env) {
  return [
    env.RUNTIME_WORKTREE_ROOT || join(tmpdir(), "missionalpha-worktrees"),
    ...(env.RUNTIME_EXEC_WT_ROOT ? [env.RUNTIME_EXEC_WT_ROOT] : []),
  ];
}

export function isGitWorkTree(dir, exec = execFileSync) {
  try {
    exec("git", [...GIT_SAFE_ARGS, "-C", dir, "rev-parse", "--git-dir"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a candidate workspace. NEVER throws — it returns a verdict so the HTTP
 * layer can 400 with a readable reason instead of 500-ing.
 * @returns {{ok:true, repoPath:string, isGit:true} | {ok:false, error:string}}
 */
export function validateWorkspace(input, opts = {}) {
  const env = opts.env || process.env;
  const exec = opts.exec || execFileSync;
  if (typeof input !== "string" || !input.trim()) return { ok: false, error: "repoPath required" };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(input)) return { ok: false, error: "repoPath contains control characters" };
  if (input.length > 4096) return { ok: false, error: "repoPath too long" };

  // A leading "~" or "~/" is the home directory, as in a shell (Setup's placeholder is
  // "~/code/my-app"); resolve() would treat it as a folder named "~" under the cwd.
  // "~user" is not expanded. Every check below runs on the expanded path.
  const trimmed = input.trim();
  const expanded = /^~(?=$|\/)/.test(trimmed) ? (opts.homedir || homedir()) + trimmed.slice(1) : trimmed;
  const raw = resolve(expanded);
  if (!existsSync(raw)) return { ok: false, error: `path does not exist: ${raw}` };
  let repoPath;
  try { repoPath = realpathSync(raw); } catch (e) { return { ok: false, error: `cannot resolve path: ${e.message}` }; }
  let st;
  try { st = statSync(repoPath); } catch (e) { return { ok: false, error: `cannot stat path: ${e.message}` }; }
  if (!st.isDirectory()) return { ok: false, error: "path is not a directory" };

  if (samePath(repoPath, sep, opts)) return { ok: false, error: "refusing the filesystem root" };
  let home;
  try { home = realpathSync(opts.homedir || homedir()); } catch { home = resolve(opts.homedir || homedir()); }
  if (samePath(repoPath, home, opts)) return { ok: false, error: "refusing your home directory — pick a project folder inside it" };
  // #10 — a directory that CONTAINS $HOME is $HOME's superset: pinning /Users as
  // REPO_ROOT hands a read-mode agent every user's ~/.ssh just as surely as pinning
  // $HOME does. Equality alone never caught that.
  if (isInside(home, repoPath, opts)) {
    return { ok: false, error: "refusing a folder that contains your home directory — pick a project folder inside it" };
  }

  for (const wt of (opts.worktreeRoots || defaultWorktreeRoots(env))) {
    if (!existsSync(wt)) continue;
    let realWt;
    try { realWt = realpathSync(wt); } catch { realWt = resolve(wt); }
    if (isInside(repoPath, realWt, opts)) {
      return { ok: false, error: "that folder is inside a runtime-owned worktree root — pick the source repo instead" };
    }
  }
  for (const sd of (opts.stateDirs || defaultStateDirs(env))) {
    // Realpath an EXISTING state dir before comparing: on macOS the tmpdir family
    // is reached through the /var → /private/var symlink, so a raw string compare
    // would silently miss a state dir that really does sit inside the workspace.
    let abs = resolve(sd);
    if (existsSync(abs)) { try { abs = realpathSync(abs); } catch { /* keep the resolved form */ } }
    if (isInside(abs, repoPath, opts)) {
      return { ok: false, error: `runtime state lives at ${abs}; it must stay OUTSIDE the workspace — pick a narrower folder` };
    }
  }
  if (!isGitWorkTree(repoPath, exec)) {
    return { ok: false, error: "not a git repo (run `git init` there first, or pick another folder)" };
  }
  return { ok: true, repoPath, isGit: true };
}

/** Persist a validated workspace. Refuses to write anything that fails validation. */
export function writeWorkspace(input, opts = {}) {
  const v = validateWorkspace(input, opts);
  if (!v.ok) return v;
  const dir = opts.configDir || defaultConfigDir(opts.env || process.env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch (e) { console.warn(`[workspace] chmod 0700 failed on ${dir}: ${e?.message}`); }
  const file = join(dir, WORKSPACE_FILE_NAME);
  writeFileSync(file, JSON.stringify({ repoPath: v.repoPath, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch (e) { console.warn(`[workspace] chmod 0600 failed on ${file}: ${e?.message}`); }
  return { ok: true, repoPath: v.repoPath, file };
}

/**
 * The persisted workspace, or null. Total: a missing, unreadable, corrupt, vanished
 * or NO-LONGER-VALID target yields null so the runtime falls back to its default
 * root rather than refusing to boot on a stale config.
 *
 * #4a — the config is RE-VALIDATED here, not merely existsSync'd. The file is 0600
 * in a 0700 dir, but "it passed validation when it was written" is not a property
 * of the file at boot: the recorded target can have been swapped for $HOME (or for
 * a tree that now swallows a runtime state dir) in between. A config that would not
 * pass writeWorkspace today does not get to pin REPO_ROOT today.
 */
export function readWorkspace(opts = {}) {
  const dir = opts.configDir || defaultConfigDir(opts.env || process.env);
  try {
    const j = JSON.parse(readFileSync(join(dir, WORKSPACE_FILE_NAME), "utf-8"));
    const p = typeof j?.repoPath === "string" ? j.repoPath : null;
    if (!p) return null;
    const v = validateWorkspace(p, opts);
    return v.ok ? v.repoPath : null;
  } catch {
    return null;
  }
}

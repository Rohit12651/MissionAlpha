// P5 — APPROVE → COMMIT → (PR | BRANCH | APPLY).
//
// The Delivery engine already decides WHETHER work lands. This module decides HOW
// it leaves the runtime, and records which rung of the ladder actually executed:
//
//   (a) 'pr'     remote exists AND `gh auth status` succeeds
//                → git push -u origin <branch> → gh pr create --fill → prUrl
//   (b) 'branch' remote missing, gh absent/unauthenticated, or push/PR failed
//                → the commit stays on the local branch, honestly reported
//   (c) 'apply'  not a git repo / no worktree / nothing staged
//                → the caller performs the pre-P5 direct broker apply
//
// NEVER FABRICATE SUCCESS: `mode` and `prUrl` are written only after the command
// that earns them returned ok. A failure DEMOTES a rung; it never invents one.
//
// SECURITY (sr-security; P5 is a BLOCKING-security phase):
//   • git and gh are argv arrays with shell:false. No interpolation anywhere.
//   • Every path is re-validated by the SAME applyAllowed the broker uses, then
//     passed after a literal `--` so a path can never be read as a flag.
//   • The staged set is verified against the approved set BEFORE committing; a
//     mismatch resets the index and aborts rather than committing something
//     nobody approved.
//   • core.hooksPath=/dev/null on every git call — a hostile repo's hooks never run.
//   • credential.helper is RESET on every git call, then — on the PUSH call ONLY —
//     the operator's GLOBAL helpers are replayed after the reset. A repo-local
//     `!command` helper is wiped; real auth survives. See the block above pushCredentialArgs.
//   • The gh token lives in gh's own keychain. This module never reads, stores,
//     logs or forwards a token, and strips *_TOKEN/*_KEY/*_SECRET from the child
//     env exactly like engineDispatch (server.mjs L1119-1123).
//   • Commit identity is a fixed, non-personal local identity passed per-invocation
//     with -c, so the operator's global git config is never read or written.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { applyAllowed, configGuardKeys, configGuardViolation } from "./guards.mjs";
import { GIT_SAFE_ARGS } from "./workspace.mjs";
import { assertCanonicalInside } from "./workdir-guard.mjs";

const EXEC_TIMEOUT_MS = Number(process.env.RUNTIME_PR_TIMEOUT_MS || 60_000);
const COMMIT_NAME = process.env.RUNTIME_COMMIT_NAME || "MissionAlpha";
const COMMIT_EMAIL = process.env.RUNTIME_COMMIT_EMAIL || "missionalpha@localhost";
const MAX_PATHS = 100;

// Child env WITHOUT credentials. gh reads its token from its own keychain/config,
// never from here, so stripping these costs nothing and removes an exfil surface.
function safeEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/(_KEY|_SECRET|_TOKEN|_TOKEN_DIR|PASSWORD|APIKEY)$/i.test(k) || k === "ANTHROPIC_API_KEY") continue;
    out[k] = v;
  }
  // Security pass (open MEDIUM) — GIT_SAFE_ARGS as ENVIRONMENT, so a git started by anything this
  // runner starts is hardened too: `gh` runs its own git without our `-c` flags, and a repo's
  // `core.fsmonitor` / hooks would otherwise execute (PR-GITENV-1/2). git reads these at
  // command-line precedence, and BEFORE any `-c`, so the push path's credential replay still wins.
  const pairs = [];
  for (let i = 0; i < GIT_SAFE_ARGS.length; i += 2) {
    const kv = GIT_SAFE_ARGS[i + 1];
    const eq = kv.indexOf("=");
    pairs.push([kv.slice(0, eq), kv.slice(eq + 1)]);
  }
  out.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${i}`] = k; out[`GIT_CONFIG_VALUE_${i}`] = v; });
  return out;
}

/** Default runner: argv array, no shell, bounded time + output. */
export function defaultRunner() {
  return {
    run: (bin, args, opts = {}) =>
      new Promise((resolve) => {
        execFile(bin, args, {
          cwd: opts.cwd,
          env: safeEnv(),
          // Per-call cap; defaults to the module budget. The credential read passes a
          // tighter one so a wedged `git config` can never own the delivery path.
          timeout: opts.timeoutMs || EXEC_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          encoding: "utf-8",
          shell: false,
        }, (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") });
        });
      }),
  };
}

// ── push-time credential replay (P5 hardening follow-up, Known Gap #1) ─────────
// GIT_SAFE_ARGS carries a blanket `-c credential.helper=`. That RESET is what kills
// a repo-local `!command` helper smuggled in by an archive-sourced .git/config — and
// it must stay. But the reset is total: it wipes the accumulated helper list for
// EVERY scope at once (system, global, repo-local, and the URL-scoped
// `credential.<url>.helper` form alike), so it also kills the operator's real auth.
// With https remotes being the common case, rung (a) PR could never fire after
// `gh auth login`; the ladder silently demoted to rung (b) branch.
//
// FIX, applied to the PUSH call ONLY: keep the reset, then replay the operator's
// GLOBAL helper entries after it. Git's list semantics — an empty value clears the
// list, later values append — mean the final effective list is EXACTLY the global
// set. A repo-local hostile helper sits BEFORE the reset and never survives it.
//
// DELIBERATELY BROADER THAN `credential.helper`: `gh auth setup-git` does not write
// the plain key. It writes the URL-scoped section
//   [credential "https://github.com"] helper = ""   /   helper = !…/gh auth git-credential
// and the blanket reset kills that too (verified). Replaying only the plain key
// would leave the headline gap open, so the read matches
// `credential.<anything>.helper` as well and replays keys verbatim, in file order.
//
// System-scope helpers are intentionally NOT replayed — global only, per the
// approved design. An operator whose ONLY helper is system-scope still demotes to
// rung (b), honestly reported.
const CRED_HELPER_KEY_RE = /^credential\.(?:.*\.)?helper$/;
const CRED_READ_TIMEOUT_MS = 5000;
// gh writes TWO entries per host (a blank reset + its own helper) and may cover both
// github.com and gist.github.com; add the plain key and there are 5 in a stock setup.
const MAX_REPLAYED_HELPERS = 8;

/**
 * Read the OPERATOR's GLOBAL credential helper entries. argv array, no shell, capped
 * time. NEVER throws: no git, no match (`--get-regexp` exits 1), or a timeout all mean
 * "no global helpers", which reproduces today's bare-reset behavior.
 * `-z` is required — a helper value may legally contain spaces, and NUL-delimited
 * records are the only parse that cannot be confused by them.
 *
 * LOW-1 (P5 re-review): this is ASYNC and goes through the module's own async runner.
 * The previous synchronous spawn blocked the single-process runtime's event loop for up
 * to CRED_READ_TIMEOUT_MS — the first PR of a session could stall every other agent, and
 * SSE with it. Bounded to one call by the memo in createPr, but once is enough.
 * @returns {Promise<{key:string, value:string}[]>}
 */
export async function readGlobalCredentialHelpers(runner = defaultRunner()) {
  let raw = "";
  try {
    const r = await runner.run("git", ["config", "--global", "-z", "--get-regexp", "^credential\\.(.*\\.)?helper$"], {
      timeoutMs: CRED_READ_TIMEOUT_MS,
      shell: false,
    });
    if (!r?.ok) return []; // no git, or --get-regexp exit 1 (no match), or timeout
    raw = String(r.stdout || "");
  } catch {
    return [];
  }
  return raw.split("\0").filter(Boolean).map((rec) => {
    const nl = rec.indexOf("\n"); // record is `key\nvalue`; a valueless key has no \n
    return nl === -1 ? { key: rec, value: "" } : { key: rec.slice(0, nl), value: rec.slice(nl + 1) };
  });
}

/**
 * LOW-2 (P5 re-review) — a URL-scoped credential key may legally embed userinfo
 * (`credential.https://user:token@host.helper`), so printing the raw key in a warn
 * writes the operator's token to the runtime log. Strip the userinfo before logging.
 */
const redactKey = (k) => String(k).replace(/\/\/[^@/]*@/, "//<redacted>@");

/**
 * Turn global helper entries into `-c key=value` tokens appended AFTER the reset.
 * Values are replayed VERBATIM as separate argv tokens — never interpolated, never
 * shell-parsed. An entry whose key or value carries NUL/newline, or starts with `-`
 * (which git would read as an option, not a value), is skipped and warned about.
 *
 * MED-1 (P5 re-review) — a KEY containing `=` is rejected too. `git -c` splits its
 * argument at the FIRST `=`, and a git config subsection may legally contain one, so
 * `credential.helper=!<cmd> #.helper` passes CRED_HELPER_KEY_RE yet lands as
 * `helper = !<cmd> #…` with the intended value commented out — a command injection
 * that bypasses every value guard below. Keys were never validated for this; now they are.
 */
export function pushCredentialArgs(entries, warn = console.warn) {
  const args = [];
  let replayed = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const key = String(e?.key ?? "");
    const value = String(e?.value ?? "");
    // NUL and newline only. A SPACE is legal and load-bearing in a helper value:
    // gh's is `!/opt/homebrew/bin/gh auth git-credential`.
    const unsafe = /[\0\r\n]/;
    if (!CRED_HELPER_KEY_RE.test(key) || unsafe.test(key) || key.includes("=") || key.startsWith("-")) {
      warn(`[pr] global credential entry skipped — unusable key ${JSON.stringify(redactKey(key)).slice(0, 120)}`);
      continue;
    }
    if (unsafe.test(value) || value.startsWith("-")) {
      warn(`[pr] global ${redactKey(key)} skipped — value starts with '-' or contains NUL/newline`);
      continue;
    }
    if (replayed >= MAX_REPLAYED_HELPERS) {
      warn(`[pr] global credential helper cap (${MAX_REPLAYED_HELPERS}) reached — ${redactKey(key)} and any later entries not replayed`);
      break;
    }
    args.push("-c", `${key}=${value}`);
    replayed++;
  }
  return args;
}

const CONVENTIONAL = { code: "feat", doc: "docs", post: "chore", command: "chore" };
const SUBJECT_CAP = 72;

/**
 * #7 — the PR URL is scraped out of `gh` subprocess stdout by regex and then
 * persisted to the DB, the audit log and the API. The renderer's isSafePrUrl is a
 * RENDER-time check, not a storage-time one; mirror it server-side so a hostile or
 * merely broken `gh` on PATH can never park `javascript:` (or someone else's host)
 * in a durable record. Same predicate as src/lib/workspaceClient.ts:isSafePrUrl and
 * electron/main.cjs's ma:open-external allowlist.
 */
export function isSafePrUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === "https:" && /^(.+\.)?github\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Commit message derived from the Delivery's own title/summary.
 * NO Claude / AI / "generated with" attribution — BOSS's global rule disables it.
 * The AGENT is credited as co-author, because the agent is who wrote the diff.
 */
export function commitMessageFor({ title, summary, agentId, kind = "code" }) {
  const prefix = CONVENTIONAL[kind] || "chore";
  const raw = String(title || "change").replace(/\s+/g, " ").trim() || "change";
  const room = SUBJECT_CAP - prefix.length - 2;
  const subject = `${prefix}: ${raw.length > room ? `${raw.slice(0, room - 1)}…` : raw}`;
  const id = String(agentId || "agent").replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "agent";
  const body = String(summary || "").replace(/\r/g, "").trim().slice(0, 2000);
  return [subject, "", body, "", `Co-authored-by: ${id} <${id}@missionalpha.local>`]
    .filter((l, i, a) => !(l === "" && a[i - 1] === "")) // collapse blank runs
    .join("\n");
}

export function createPr(deps = {}) {
  const repoRoot = deps.repoRoot;
  const worktreeMgr = deps.worktreeMgr || null;
  const gh = deps.gh || defaultRunner();
  const audit = deps.audit || (() => {});
  const scrub = deps.scrub || ((s) => s);
  const allowed = deps.applyAllowed || applyAllowed;
  // Phase E · 16 — the ship ladder narrows by the seat that PRODUCED the task, resolved from
  // the task (never from the caller), and with `strict` an unresolved seat commits nothing.
  // Both default off so a ladder built without a roster keeps its old behaviour; server.mjs
  // turns both on (GUARD-1-WIRED).
  const seatFor = typeof deps.seatFor === "function" ? deps.seatFor : () => null;
  const strict = Boolean(deps.strict);
  const allowedFor = (taskId) => {
    const opts = { seat: seatFor(taskId), strict };
    return (p) => allowed(p, opts);
  };

  // #8/#9 — the FULL hardening prefix, not just hooksPath: a worktree of an
  // archive-sourced repo can carry core.fsmonitor=<cmd> (run by add/diff) or an
  // `ext::` origin (executed by push). quotePath=false keeps non-ASCII paths
  // literal so the staged-set drift check below can match them.
  const git = (args, cwd) =>
    gh.run("git", [...GIT_SAFE_ARGS, ...args], { cwd, shell: false });

  // PUSH ONLY. Every other wrapper above keeps the BARE reset with no replay — a
  // diff/add/commit/probe never needs a credential, so it never gets one. Resolved
  // lazily and memoized: a delivery that never reaches a push never spawns the read.
  // LOW-1 — the PROMISE is memoized, not the array: the read is async now, so two
  // concurrent pushes must share one in-flight read rather than racing two spawns.
  // A rejected read degrades to the bare reset, exactly as the sync version's catch did.
  const readHelpers = deps.globalCredentialHelpers || readGlobalCredentialHelpers;
  const warn = deps.warn || ((m) => console.warn(m));
  let credReplay = null;
  const gitPush = async (args, cwd) => {
    if (credReplay === null) {
      credReplay = (async () => {
        try { return pushCredentialArgs(await readHelpers(), warn); } catch { return []; }
      })();
    }
    return gh.run("git", [...GIT_SAFE_ARGS, ...(await credReplay), ...args], { cwd, shell: false });
  };

  async function isGit(dir) {
    if (!dir || !existsSync(dir)) return false;
    return (await git(["-C", dir, "rev-parse", "--git-dir"], dir)).ok;
  }

  async function hasRemote(dir) {
    const r = await git(["-C", dir, "remote", "get-url", "origin"], dir);
    return r.ok && r.stdout.trim().length > 0;
  }

  /** Honest capability probe for the Settings indicator. Never throws. */
  async function ghStatus() {
    const auth = await gh.run("gh", ["auth", "status"], { shell: false });
    const missing = /ENOENT|not found|command not found|spawn gh/i.test(auth.stderr || "");
    return {
      installed: auth.ok || !missing,
      authenticated: !!auth.ok,
      hasRemote: (await isGit(repoRoot)) ? await hasRemote(repoRoot) : false,
    };
  }

  /**
   * Land an approved Delivery.
   * @returns {{mode:'pr'|'branch'|'apply', branch:string|null, prUrl:string|null, reason:string, refused:string[]}}
   * NEVER throws — the caller has already flipped the row to `approved`, so a fault
   * here must degrade the mode, not strand the decision.
   */
  async function deliverApproved({ taskId, paths, title, summary, agentId, kind } = {}) {
    const out = { mode: "apply", branch: null, prUrl: null, reason: "", refused: [] };
    try {
      if (!worktreeMgr || !taskId) { out.reason = "no worktree manager or task key"; return out; }
      const wtPath = worktreeMgr.pathFor(taskId);
      if (!wtPath) { out.reason = "no worktree for this task"; return out; }
      if (!(await isGit(wtPath))) { out.reason = "worktree is not a git work tree"; return out; }

      // Re-run the SAME predicate the broker uses. A path the broker would refuse
      // must not reach a commit either — one rule, two exits.
      const approved = [];
      const mayWrite = allowedFor(taskId);
      for (const p of (Array.isArray(paths) ? paths : []).slice(0, MAX_PATHS)) {
        if (mayWrite(p)) approved.push(p);
        else out.refused.push(String(p).slice(0, 200));
      }
      // CONFIG GUARD — one rule, two exits. broker.mjs L87-101 refuses an apply that
      // changes an exec/supply-chain key; this path bypassed it entirely, and
      // package.json is in SEED_FILES, so agent-authored `scripts`/`dependencies`
      // could ride a commit to a remote branch where CI runs them with repo
      // credentials. Same helper, same verdict, BEFORE `git add`.
      const guarded = [];
      for (const p of approved) {
        const relNorm = relative(wtPath, resolve(wtPath, p)); // "./package.json" → "package.json"
        if (!configGuardKeys(relNorm)) { guarded.push(p); continue; }
        // MED-2 (P5 re-review) — FAIL CLOSED, like broker.mjs L85/L120 already does.
        // An unreadable guarded file used to be waved through to `git add`, which then
        // happily staged the DELETION, or a 100644→120000 symlink swap: the protected
        // keys change through the exact path this guard exists to block. There is no
        // legitimate "absent" case — the worktree is a full checkout of the repo.
        let wtAfter;
        try {
          if (lstatSync(join(wtPath, relNorm)).isSymbolicLink()) {
            out.refused.push(`${relNorm} (guarded file is a symlink in the worktree)`.slice(0, 200));
            continue;
          }
          wtAfter = readFileSync(join(wtPath, relNorm), "utf-8");
        } catch {
          out.refused.push(`${relNorm} (guarded file unreadable in worktree)`.slice(0, 200));
          continue;
        }
        let repoBefore = null;
        if (repoRoot) { try { repoBefore = readFileSync(join(repoRoot, relNorm), "utf-8"); } catch { /* new file */ } }
        const bad = configGuardViolation(relNorm, repoBefore, wtAfter);
        if (bad) out.refused.push(`${relNorm} (protected key changed: ${bad})`.slice(0, 200));
        else guarded.push(p);
      }
      approved.length = 0;
      approved.push(...guarded);
      if (!approved.length) { out.reason = "no allowed paths to commit"; return out; }

      const branch = worktreeMgr.branchOf(taskId);
      out.branch = branch;

      // `--` then pathspecs: an approved path can never be parsed as a flag.
      const add = await git(["-C", wtPath, "add", "--", ...approved], wtPath);
      if (!add.ok) { out.reason = `git add failed: ${scrub(add.stderr).slice(0, 300)}`; return out; }

      // Verify the staged set IS the approved set. Anything else aborts.
      const staged = await git(["-C", wtPath, "diff", "--cached", "--name-only"], wtPath);
      const stagedList = staged.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!stagedList.length) { out.reason = "nothing to commit (no staged changes)"; return out; }
      const extra = stagedList.filter((p) => !approved.includes(p));
      if (extra.length) {
        await git(["-C", wtPath, "reset", "-q"], wtPath);
        out.reason = `staged set drifted from the approved set: ${extra.slice(0, 5).join(", ")}`;
        return out;
      }

      const msg = commitMessageFor({ title, summary, agentId, kind });
      const commit = await git(
        ["-C", wtPath, "-c", `user.name=${COMMIT_NAME}`, "-c", `user.email=${COMMIT_EMAIL}`, "commit", "-m", msg],
        wtPath,
      );
      if (!commit.ok) { out.reason = `git commit failed: ${scrub(commit.stderr).slice(0, 300)}`; return out; }
      out.mode = "branch"; // the commit exists — this is the floor from here on
      audit("delivery.committed", { taskId, branch, paths: approved });

      if (!(await hasRemote(wtPath))) {
        out.reason = "no remote configured — the commit stays on the local branch";
        return out;
      }
      const auth = await gh.run("gh", ["auth", "status"], { cwd: wtPath, shell: false });
      if (!auth.ok) {
        out.reason = "gh unavailable or unauthenticated — the commit stays on the local branch";
        return out;
      }

      const push = await gitPush(["-C", wtPath, "push", "-u", "origin", branch], wtPath);
      if (!push.ok) { out.reason = `git push failed: ${scrub(push.stderr).slice(0, 300)}`; return out; }

      const pr = await gh.run("gh", ["pr", "create", "--fill", "--head", branch], { cwd: wtPath, shell: false });
      if (!pr.ok) { out.reason = `gh pr create failed: ${scrub(pr.stderr).slice(0, 300)}`; return out; }
      const url = (pr.stdout.match(/https:\/\/[^\s]+/) || [])[0] || null;
      if (!url) { out.reason = "gh pr create returned no URL"; return out; }
      // #7 — validate before it becomes a durable record. Anything that is not an
      // https github.com origin leaves mode at 'branch' (the commit IS pushed —
      // that stays true) and says so, rather than storing an unvetted URL.
      if (!isSafePrUrl(url)) { out.reason = "gh pr create returned a non-GitHub URL — refusing to store it"; return out; }

      out.mode = "pr";
      out.prUrl = url;
      out.reason = "";
      audit("delivery.pr", { taskId, branch, prUrl: url });
      return out;
    } catch (e) {
      out.reason = scrub(String(e?.message || e)).slice(0, 300);
      return out;
    }
  }

  // ── Phase 11 / task 11.3 — SHIP A JOB ────────────────────────────────────────
  // BOSS-approved 2026-09-05 (.planning/phases/11-review-ship/PR-LADDER-EDITS.md, Option A).
  //
  // `deliverApproved` above is the PER-TASK ladder and is untouched. This is the per-JOB one:
  // one branch, one commit per task, one PR. It runs in a worktree of its OWN and never writes
  // to the operator's tree or index — the measured reason being that broker.applyChanges copies
  // into repoRoot and never stages, which is exactly why `write-tree == HEAD^{tree}` holds. A
  // ship that applied-then-committed would have had to stage, and would have dirtied the tree
  // the operator is sitting in. Pinned by PJB-6.

  /** The ONLY ref shape ship may ever write. Anything else is refused before git runs. */
  const JOB_BRANCH_RE = /^ma\/job\/[a-z0-9_]+$/;

  /**
   * Create `ma/job/<jobId>` at `baseSha`, in a throwaway worktree.
   * Refuses a jobId outside the allow-list, and refuses an existing branch — no reuse, no
   * force: a second ship onto the same branch would rewrite the first.
   */
  async function createJobBranch(jobId, baseSha) {
    const out = { ok: false, branch: null, worktree: null, reason: "" };
    const branch = `ma/job/${String(jobId ?? "")}`;
    if (!JOB_BRANCH_RE.test(branch)) { out.reason = `refused branch name: ${branch}`; return out; }
    if (!worktreeMgr || !repoRoot) { out.reason = "no worktree manager"; return out; }
    const sha = String(baseSha ?? "").trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) { out.reason = `refused base sha: ${sha.slice(0, 40)}`; return out; }

    const exists = await git(["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
    if (exists.ok && exists.stdout.trim()) { out.reason = `branch ${branch} already exists — refusing to reuse or force it`; return out; }

    // The job checkout goes under the SAME root the task worktrees use. The first version
    // fell back to `dirname(repoRoot)` when the manager exposed no accessor — and it exposes
    // `worktreeRoot` as a VALUE, not a function, so the live run put a git worktree at
    // `~/Downloads/WaahyuFOLDER/job_<id>`: outside the repo, beside the operator's other
    // projects, where nobody would look for it or clean it up. Refuse rather than guess.
    const root = worktreeMgr.worktreeRoot;
    if (!root || typeof root !== "string") { out.reason = "no worktree root to create the job checkout in"; return out; }
    const dir = join(root, `job_${String(jobId)}`);
    const add = await git(["-C", repoRoot, "worktree", "add", "-b", branch, dir, sha], repoRoot);
    if (!add.ok) { out.reason = `git worktree add failed: ${scrub(add.stderr).slice(0, 300)}`; return out; }
    audit("job.branch", { jobId, branch, baseSha: sha });
    return { ok: true, branch, worktree: dir, reason: "" };
  }

  /**
   * Copy ONE task's approved paths from its own worktree into the job worktree and commit them.
   * Every guard `deliverApproved` runs, runs here: the broker's own `allowed` predicate, the
   * CONFIG_GUARD on protected keys, the symlink and unreadable refusals, and the staged-set ==
   * approved-set assertion. One rule, two exits.
   */
  /**
   * Phase C · task 10 — the TREE a ref points at. What the BOSS approves is a specific tree on
   * `ma/job/<id>`; ship re-reads this and refuses if it moved (DIFF-3). Returns "" when the ref
   * cannot be read — an unreadable tree must not be mistaken for an unchanged one, so the
   * caller treats "" as "cannot check" rather than as a match.
   */
  async function treeOf(ref) {
    const safe = String(ref ?? "").trim();
    if (!safe || safe.startsWith("-")) return "";
    const r = await git(["-C", repoRoot, "rev-parse", `${safe}^{tree}`], repoRoot);
    return r.ok ? String(r.stdout || "").trim() : "";
  }

  async function commitTask({ jobWorktree, taskId, paths, message } = {}) {
    const out = { ok: false, sha: null, refused: [], reason: "" };
    try {
      if (!jobWorktree || !(await isGit(jobWorktree))) { out.reason = "no job worktree"; return out; }
      const src = worktreeMgr?.pathFor?.(taskId);
      if (!src) { out.reason = `no worktree for task ${taskId}`; return out; }

      const approved = [];
      const mayWrite = allowedFor(taskId);
      for (const pth of (Array.isArray(paths) ? paths : []).slice(0, MAX_PATHS)) {
        if (!mayWrite(pth)) { out.refused.push(String(pth).slice(0, 200)); continue; }
        const relNorm = relative(jobWorktree, resolve(jobWorktree, pth));
        if (relNorm.startsWith("..") || isAbsolute(relNorm)) { out.refused.push(`${pth} (escapes the job worktree)`.slice(0, 200)); continue; }
        let body;
        try {
          if (lstatSync(join(src, relNorm)).isSymbolicLink()) { out.refused.push(`${relNorm} (symlink in the task worktree)`.slice(0, 200)); continue; }
          body = readFileSync(join(src, relNorm), "utf-8");
        } catch { out.refused.push(`${relNorm} (unreadable in the task worktree)`.slice(0, 200)); continue; }
        if (configGuardKeys(relNorm)) {
          let before = null;
          try { before = readFileSync(join(jobWorktree, relNorm), "utf-8"); } catch { /* new file */ }
          const bad = configGuardViolation(relNorm, before, body);
          if (bad) { out.refused.push(`${relNorm} (protected key changed: ${bad})`.slice(0, 200)); continue; }
        }
        // Phase C · task 11 — the DESTINATION is canonicalised too. The source symlink check
        // above only covers the task worktree; `jobWorktree/src/alias -> ../docs` redirected an
        // approved src/** commit into docs/ (CANON-2). Refusal happens before any mkdir.
        const canon = await assertCanonicalInside(jobWorktree, relNorm, { create: true });
        if (!canon.ok) { out.refused.push(`${relNorm} (${canon.error})`.slice(0, 200)); continue; }
        writeFileSync(canon.dest, body, "utf-8");
        approved.push(relNorm);
      }
      if (!approved.length) { out.reason = "no allowed paths to commit"; return out; }

      const add = await git(["-C", jobWorktree, "add", "--", ...approved], jobWorktree);
      if (!add.ok) { out.reason = `git add failed: ${scrub(add.stderr).slice(0, 300)}`; return out; }

      const staged = await git(["-C", jobWorktree, "diff", "--cached", "--name-only"], jobWorktree);
      const stagedList = staged.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
      if (!stagedList.length) { out.reason = "nothing to commit (no staged changes)"; return out; }
      const extra = stagedList.filter((x) => !approved.includes(x));
      if (extra.length) {
        await git(["-C", jobWorktree, "reset", "-q"], jobWorktree);
        out.reason = `staged set drifted from the approved set: ${extra.slice(0, 5).join(", ")}`;
        return out;
      }

      const commit = await git(
        ["-C", jobWorktree, "-c", `user.name=${COMMIT_NAME}`, "-c", `user.email=${COMMIT_EMAIL}`, "commit", "-m", String(message || "chore: task")],
        jobWorktree,
      );
      if (!commit.ok) { out.reason = `git commit failed: ${scrub(commit.stderr).slice(0, 300)}`; return out; }
      const head = await git(["-C", jobWorktree, "rev-parse", "HEAD"], jobWorktree);
      out.ok = true;
      out.sha = head.stdout.trim();
      audit("job.commit", { taskId, sha: out.sha, paths: approved });
      return out;
    } catch (e) {
      out.reason = scrub(String(e?.message || e)).slice(0, 300);
      return out;
    }
  }

  /** Push the job branch and open its PR. `gh` absent ⇒ the branch stands, and says so. */
  async function openJobPr({ jobWorktree, branch, title, body } = {}) {
    const out = { mode: "branch", prUrl: null, reason: "" };
    try {
      if (!JOB_BRANCH_RE.test(String(branch ?? ""))) { out.reason = `refused branch name: ${branch}`; return out; }
      if (!(await hasRemote(jobWorktree))) { out.reason = "no remote configured — the commits stay on the local branch"; return out; }
      const auth = await gh.run("gh", ["auth", "status"], { cwd: jobWorktree, shell: false });
      if (!auth.ok) { out.reason = "gh unavailable or unauthenticated — the commits stay on the local branch"; return out; }

      const push = await gitPush(["-C", jobWorktree, "push", "-u", "origin", branch], jobWorktree);
      if (!push.ok) { out.reason = `git push failed: ${scrub(push.stderr).slice(0, 300)}`; return out; }
      // `pushed` is REPORTED SEPARATELY from `mode`, and the distinction is not cosmetic.
      // `mode: "branch"` is returned by four different outcomes — no remote, no gh, a failed
      // push, and a push that SUCCEEDED before `gh pr create` failed. In the first three the
      // commits are local; in the fourth they are on the operator's remote and anyone can see
      // them. Measured live: with a real authenticated gh and a non-GitHub remote, the branch
      // reached origin at the same sha and the result still read `mode: "branch"` — the same
      // word the never-left-this-machine cases use.
      out.pushed = true;

      const args = ["pr", "create", "--head", branch, "--title", String(title || branch).slice(0, 200), "--body", scrub(String(body || "")).slice(0, 60_000)];
      const pr = await gh.run("gh", args, { cwd: jobWorktree, shell: false });
      if (!pr.ok) { out.reason = `gh pr create failed: ${scrub(pr.stderr).slice(0, 300)}`; return out; }
      const url = (pr.stdout.match(/https:\/\/[^\s]+/) || [])[0] || null;
      if (!url) { out.reason = "gh pr create returned no URL"; return out; }
      if (!isSafePrUrl(url)) { out.reason = "gh pr create returned a non-GitHub URL — refusing to store it"; return out; }
      audit("job.pr", { branch, prUrl: url });
      return { mode: "pr", prUrl: url, pushed: true, reason: "" };
    } catch (e) {
      out.reason = scrub(String(e?.message || e)).slice(0, 300);
      return out;
    }
  }

  return { deliverApproved, ghStatus, commitMessageFor, createJobBranch, commitTask, openJobPr, treeOf };
}

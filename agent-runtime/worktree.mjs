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
import { mkdirSync, existsSync, rmSync, unlinkSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { GIT_SAFE_ARGS } from "./workspace.mjs";

// Strip everything except [a-z0-9_-]; result can never lead with '-' once the fixed
// `ma/task/` prefix is prepended. Same character class as safeId (server.mjs L346/531).
export function safeBranchPart(s) {
  return String(s).replace(/[^a-z0-9_-]/gi, "").replace(/^-+/, "").slice(0, 60);
}

// ── D3 — THE SNAPSHOT BASE ────────────────────────────────────────────────────
//
// ADR-026 pinned every worktree to HEAD. That is correct for a repo whose work is
// committed and WRONG for one that is not: the broker diffs the worktree against the
// LIVE tree, so on a dirty repo every operator-modified file reads as a change the
// AGENT proposed, and approving a Delivery would REVERT uncommitted work. Measured on
// this install: a one-line docs task minted a 29-file, +445/-368 "revert to HEAD".
//
// So the base becomes a commit built from the operator's CURRENT working tree. Three
// invariants make that safe:
//   1. It is assembled in a TEMPORARY index (GIT_INDEX_FILE). The operator's own
//      `.git/index`, HEAD, branches and staging area never move.
//   2. It is DETERMINISTIC — fixed identity and fixed dates — so an unchanged tree
//      yields the same commit sha and the object store does not churn per task.
//   3. A CLEAN tree short-circuits to HEAD itself, so the pre-D3 behaviour is
//      byte-identical whenever there is nothing to snapshot.
//
// SECURITY (this is the one new exposure, and it is closed here): a HEAD-based
// worktree could only ever contain COMMITTED files, so a secret sitting untracked in
// the operator's tree was invisible to the agent. A snapshot would carry it in — and
// the worktree is bind-mounted into the test-gate Docker jail where AGENT-AUTHORED
// test code runs. `snapshotAllowed` is therefore applied to every candidate path
// BEFORE it is staged (never staged-then-removed), and it is deliberately WIDER than
// broker.APPLY_DENY: APPLY_DENY matches `.env` exactly and would let `.env.backup`
// through. .gitignore is honoured for free — the candidate list comes from
// `git status`, which never lists an ignored path.
const SNAPSHOT_DENY = [
  /(^|\/)\.env(\.|$)/i,                       // .env, .env.local, .env.backup, config/.env.prod
  /(^|\/)(\.git|\.claude|node_modules)(\/|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  // 6.1 — the DOTFILE spelling, which SECRET_NAME_DENY below cannot match (there is no
  // `^` or `/` immediately before the name) and which was therefore allowed by accident.
  // A dotfile is never source code, so this row is unconditional.
  /(^|\/)\.credentials(\.|$)/i,
  // 6.7 (security review, HIGH) — auth-bearing dotfiles and key material the previous rows
  // let through. None are source code; every one is a credential store by convention.
  /(^|\/)\.(npmrc|netrc|envrc|pypirc|dockercfg|docker\/config\.json|git-credentials)$/i,
  /(^|\/)\.(aws|ssh|gnupg|azure|kube|config\/gh|config\/gcloud)(\/|$)/i,
  /\.(p8|ppk|asc|gpg|kdbx)$/i,
];

// ── 6.1 — A SECRET-SHAPED NAME IS NOT A SECRET WHEN IT IS SOURCE CODE ─────────
//
// This row used to sit in SNAPSHOT_DENY unconditionally, and it did not catch a secret:
// it caught `agent-runtime/providers/credentials.mjs`, a 16,610-byte MODULE the operator
// had uncommitted. Refusing it meant every worktree carried HEAD's 8,302-byte copy — the
// agent read stale code, and the broker (diffing worktree → LIVE tree) then reported the
// operator's own 8kB as a change the AGENT proposed. Approving that Delivery would have
// reverted it. One deny row cost both the agent's context and the operator's work.
//
// ONE RULE, STATED ONCE: this row applies only to paths that are NOT source code, where
// source code = under a source root AND ending in a source extension. Both halves are
// required — `secrets.js` at the repo root stays denied (no source root), and
// `src/credentials.json` stays denied (no source extension).
//
// Why that line is safe (PLAN threat_model): a `.ts`/`.mjs` under a source root is
// git-tracked code a human reviews in a diff; a real secret does not live as
// `src/lib/secrets.ts`. The roots are matched CASE-SENSITIVELY on purpose — an oddly
// spelled `SRC/` is not one of this repo's source roots, so it fails closed and stays
// denied. Every other SNAPSHOT_DENY row is unconditional and applies to source code too.
const SECRET_NAME_DENY = /(^|\/)(credentials|secrets?)(\.|$)/i;
const SOURCE_ROOT = /^(agent-runtime|src|scripts|electron)\//;
const SOURCE_EXT = /\.(mjs|js|ts|tsx)$/i;

/** True when `p` (already slash-normalised) is reviewable source code, not a data file. */
export function isSourceCodePath(p) {
  const s = String(p ?? "").replace(/\\/g, "/");
  return SOURCE_ROOT.test(s) && SOURCE_EXT.test(s);
}

/** True when `rel` may be carried into an agent's worktree snapshot. Never throws. */
export function snapshotAllowed(rel) {
  const p = String(rel ?? "").replace(/\\/g, "/");
  if (!p || p.includes("..")) return false;
  if (SNAPSHOT_DENY.some((re) => re.test(p))) return false;
  if (SECRET_NAME_DENY.test(p) && !isSourceCodePath(p)) return false;
  return true;
}

// Deterministic authorship for the snapshot commit. Not the operator's identity: this
// object is machinery, never authorship, and a fixed date is what makes the sha stable
// for an unchanged tree.
const SNAPSHOT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: "MissionAlpha", GIT_AUTHOR_EMAIL: "runtime@missionalpha.local",
  GIT_COMMITTER_NAME: "MissionAlpha", GIT_COMMITTER_EMAIL: "runtime@missionalpha.local",
  GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000",
});
const SNAPSHOT_MSG = "missionalpha: worktree base snapshot (working tree, uncommitted)";
// One `git add` call per chunk — bounded so a very dirty tree cannot blow the argv limit.
const ADD_CHUNK = 200;

// ── 6.2 — THE SNAPSHOT MANIFEST ───────────────────────────────────────────────
//
// The base a worktree was built from is not enough on its own to tell the operator's work
// from the agent's. Two facts are needed and both were previously discarded the instant
// the base commit was made:
//   • WHICH paths `snapshotAllowed` refused — those sit in the checkout at HEAD's content
//     while the live tree holds something newer, so a naive diff reads them as the agent
//     proposing to revert the operator;
//   • WHEN the base was taken — anything the operator edits after that instant is theirs,
//     not the seat's.
// So create() persists {sha, refusedPaths, snapshotAt} next to the scratch index, and
// broker.listChangesDetailed reads it. It is a plain JSON file, 0600, one per task key,
// and it lives OUTSIDE the worktree dir — the agent's checkout is what gets mounted into
// the test-gate jail, so a seat can never reach its own manifest.
const MANIFEST_PREFIX = ".ma-manifest.";
// A base ref is interpolated into an argv for `git diff <sha>`. It is written by this
// module, but it is read back off disk, so it is re-validated as a bare hex object name
// on the way out — a value that can never be read as a flag or a revision expression.
const SHA_RE = /^[0-9a-f]{7,64}$/;

/** Where the manifest for `key` lives, given the worktree ROOT. Deterministic. */
export function manifestPathFor(worktreeRoot, key) {
  return join(worktreeRoot, `${MANIFEST_PREFIX}${safeBranchPart(key) || "task"}.json`);
}

/** Parse + VALIDATE a manifest body. Anything unexpected ⇒ null (caller degrades). */
function parseManifest(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== "object") return null;
  if (typeof m.sha !== "string" || !SHA_RE.test(m.sha)) return null;
  if (!Array.isArray(m.refusedPaths) || m.refusedPaths.some((p) => typeof p !== "string")) return null;
  if (typeof m.snapshotAt !== "number" || !Number.isFinite(m.snapshotAt) || m.snapshotAt <= 0) return null;
  return { sha: m.sha, refusedPaths: [...m.refusedPaths], snapshotAt: m.snapshotAt };
}

/**
 * The manifest for the worktree CHECKED OUT AT `workdir`, or null.
 *
 * Derived from the checkout's own path (`<worktreeRoot>/<safeKey>`) rather than from a
 * root the caller has to be told about: the broker is handed a workdir and nothing else,
 * and a second copy of "where the worktree root is" is a second place to get it wrong.
 * A copy-sandbox workdir simply has no manifest beside it ⇒ null ⇒ historical behaviour.
 */
export function readSnapshotManifestAt(workdir) {
  if (!workdir || typeof workdir !== "string") return null;
  try {
    return parseManifest(readFileSync(manifestPathFor(dirname(workdir), basename(workdir)), "utf-8"));
  } catch { return null; }
}

/**
 * Which worktree keys are still CLAIMED, given the queue and the Inbox.
 *
 * Pure, and separate from the sweep on purpose: the bug this closes was never in the
 * collector, it was in the caller's idea of "live". A task can be TERMINAL in the queue
 * while its Delivery is still pending a human decision, and `applyChanges` reads that
 * decision's diff out of the very checkout the collector was about to remove. Two
 * claimants, one predicate, one place to get it wrong.
 */
export function liveWorktreeKeys({ tasks = [], pendingDeliveries = [] } = {}) {
  const TERMINAL_STATUS = new Set(["done", "failed", "cancelled"]);
  const live = new Set();
  for (const t of tasks || []) {
    if (t && t.taskId && !TERMINAL_STATUS.has(t.status)) live.add(t.taskId);
  }
  for (const d of pendingDeliveries || []) {
    if (d && d.taskId) live.add(d.taskId);
  }
  return live;
}

export function createWorktreeMgr(opts = {}) {
  const repoRoot = opts.repoRoot;
  const worktreeRoot = opts.worktreeRoot || process.env.RUNTIME_WORKTREE_ROOT || join(tmpdir(), "missionalpha-worktrees");
  mkdirSync(worktreeRoot, { recursive: true });

  // Every git invocation: argv array (no shell), -C repo, and the FULL hardening
  // prefix (sr-security P5 re-review #8/#9) — hooks, fsmonitor, ext:: remotes,
  // credential/askpass helpers, external diff and the pager are all neutralized,
  // because a workspace can be an archive-sourced repo with a hostile .git/config.
  const gitRaw = (args, cwd = repoRoot, env) =>
    execFileSync("git", [...GIT_SAFE_ARGS, "-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
  const git = (args, cwd = repoRoot, env) => gitRaw(args, cwd, env).trim();

  // D3 — how the base commit for a new worktree is chosen.
  //   "snapshot" (default) — the operator's working tree, assembled in a temp index
  //   "head"               — pre-D3 behaviour, pinned to the last commit
  const baseMode = opts.baseMode || process.env.RUNTIME_WORKTREE_BASE || "snapshot";
  // The scratch index for snapshot building. Outside the repo, per worktree-root, and
  // NEVER the operator's `.git/index`. Keyed by the worktree root so two runtimes
  // pointed at different targets cannot share a stat cache for different trees.
  const indexFile = join(worktreeRoot, ".ma-snapshot.index");
  // Which HEAD that index was seeded from. Persisted next to it so a RESTART inherits the
  // warm stat cache instead of re-seeding and paying the full re-hash again — measured at
  // 4.8s vs 0.4s on this repo, and the runtime creates a worktree per task.
  const seededHeadFile = join(worktreeRoot, ".ma-snapshot.head");
  const readSeededHead = () => { try { return readFileSync(seededHeadFile, "utf-8").trim() || null; } catch { return null; } };
  let lastSeededHead = readSeededHead();
  const log = typeof opts.log === "function" ? opts.log : (m) => console.warn(m);

  /**
   * Build a commit object from the CURRENT working tree without touching the operator's
   * repo state. Returns the commit sha, or `null` when the tree is clean (caller then
   * uses HEAD, which is the pre-D3 path exactly). Throws on git failure — create()
   * catches and falls back to HEAD so a snapshot fault can never wedge the engine.
   */
  // What the LAST buildSnapshot() call refused. Set inside the builder rather than
  // returned, so buildSnapshot keeps its exact `sha | null` contract for the injected
  // `opts.snapshotFn` seam (a foreign builder simply reports nothing — see snapshotFor).
  let lastBuildRefused = [];
  function buildSnapshot(head) {
    const env = { ...SNAPSHOT_ENV, GIT_INDEX_FILE: indexFile };
    try {
      // Seed the scratch index from HEAD so `git status` reports exactly "changes vs HEAD".
      //
      // PERFORMANCE, and it is load-bearing: a FRESH index has no stat cache, so `git
      // status` must re-hash every tracked file to decide what changed. Measured on this
      // repo (3,676 tracked files, 216 dirty): 1.97s per call, and a worktree is created
      // for every single task. The index therefore PERSISTS between snapshots and is
      // re-seeded only when HEAD actually moves — after which git's stat cache makes the
      // same probe near-instant. It lives outside the repo and is never the operator's
      // own `.git/index`, so nothing about their staging area is involved either way.
      if (lastSeededHead !== head || !existsSync(indexFile)) {
        git(["read-tree", head], repoRoot, env);
        lastSeededHead = head;
        try { writeFileSync(seededHeadFile, head, { mode: 0o600 }); } catch { /* cache hint only */ }
      }
      // -uall lists individual untracked FILES (not just dirs) so each one can be judged
      // by snapshotAllowed; ignored paths are never listed, so .gitignore is honoured.
      // NOT trimmed: a modified-but-unstaged record starts with a SPACE (" M path"),
      // and trimming the stream would shift the first record's path by one character.
      const raw = gitRaw(["status", "--porcelain=v1", "-z", "-uall"], repoRoot, env);
      const candidates = [];
      const refused = [];
      for (const rec of raw.split("\0")) {
        // Every record is exactly "XY <path>". Anything else (an empty trailing field,
        // or a shape this parser was not written for) is SKIPPED rather than guessed at.
        if (rec.length < 4 || rec[2] !== " ") continue;
        const path = rec.slice(3);
        // 6.2 — a refusal is now REPORTED, not just acted on. It is the operator's work
        // sitting at HEAD's content inside the checkout, and the broker has to know that
        // before it can decide whose change it is looking at.
        if (snapshotAllowed(path)) candidates.push(path);
        else refused.push(path);
      }
      lastBuildRefused = refused;
      if (candidates.length) {
        for (let i = 0; i < candidates.length; i += ADD_CHUNK) {
          // -A on an explicit pathspec stages adds, edits AND deletions for those paths.
          git(["add", "-A", "--", ...candidates.slice(i, i + ADD_CHUNK)], repoRoot, env);
        }
      }
      const tree = git(["write-tree"], repoRoot, env);
      if (tree === git(["rev-parse", `${head}^{tree}`])) return null; // nothing to snapshot
      return git(["commit-tree", tree, "-p", head, "-m", SNAPSHOT_MSG], repoRoot, env);
    } catch (e) {
      // A poisoned scratch index must never become permanent. Drop it so the next call
      // re-seeds from HEAD, then let the caller's fallback report the fault.
      try { unlinkSync(indexFile); } catch { /* already gone */ }
      try { unlinkSync(seededHeadFile); } catch { /* already gone */ }
      lastSeededHead = null;
      throw e;
    }
  }
  const snapshotFn = typeof opts.snapshotFn === "function" ? opts.snapshotFn : buildSnapshot;

  // A short-lived memo on top of the persistent index. The engine can create several
  // worktrees inside a second (a fanned-out plan enqueues one goal per seat), and the
  // operator's tree does not change between them. TTL, not "forever": a snapshot older
  // than this is refused so an edit made mid-burst is never silently missed.
  const SNAPSHOT_TTL_MS = Math.max(0, Number(process.env.RUNTIME_SNAPSHOT_TTL_MS ?? 1500));
  let memo = null; // { head, sha, at, refused }
  function snapshotFor(head) {
    const t = Date.now();
    if (memo && memo.head === head && t - memo.at < SNAPSHOT_TTL_MS) return memo;
    lastBuildRefused = [];
    const sha = snapshotFn(head);
    // An INJECTED builder reports no refusals — `[]` means "nothing to attribute away",
    // which is the historical answer, never a guess dressed up as a fact.
    memo = { head, sha, at: t, refused: snapshotFn === buildSnapshot ? lastBuildRefused : [] };
    return memo;
  }

  /** Resolve the base commit + the MODE that produced it. The mode is never hidden. */
  function resolveBase() {
    const head = git(["rev-parse", "HEAD"]); // throws → caller reports "not a git repo"
    if (baseMode === "head") return { baseRef: head, baseMode: "head", refusedPaths: [], snapshotAt: Date.now() };
    try {
      const snap = snapshotFor(head);
      // head-clean is not "nothing happened": the tree can be dirty in refused paths ONLY,
      // in which case there is no snapshot commit and there ARE refusals to report.
      return snap.sha
        ? { baseRef: snap.sha, baseMode: "snapshot", refusedPaths: snap.refused, snapshotAt: snap.at }
        : { baseRef: head, baseMode: "head-clean", refusedPaths: snap.refused, snapshotAt: snap.at };
    } catch (e) {
      // FAIL OPEN, LOUDLY. A snapshot fault says nothing about the task; refusing to
      // create a worktree would turn it into a total autonomy outage. But the fallback
      // reintroduces the stale-baseline defect, so it must never be silent.
      log(`[worktree] snapshot base failed (${e?.message || e}) — falling back to HEAD; the agent's checkout will NOT include uncommitted work`);
      return { baseRef: head, baseMode: "head-fallback", refusedPaths: [], snapshotAt: Date.now() };
    }
  }

  const safe = (key) => safeBranchPart(key) || "task";
  const pathOf = (key) => join(worktreeRoot, safe(key));
  const branchOf = (key) => `ma/task/${safe(key)}`;
  const manifestOf = (key) => manifestPathFor(worktreeRoot, key);

  // 6.2 — record the baseline this checkout was built from. Best-effort by design: a
  // manifest that cannot be written must not cost the operator a worktree, and its
  // absence degrades the broker to the historical (pre-6.2) answer rather than to a
  // wrong one.
  function writeManifest(key, { baseRef, refusedPaths, snapshotAt }) {
    try {
      writeFileSync(
        manifestOf(key),
        JSON.stringify({ sha: baseRef, refusedPaths: refusedPaths || [], snapshotAt: snapshotAt || Date.now() }),
        { mode: 0o600 },
      );
    } catch (e) { log(`[worktree] could not record the snapshot manifest for ${safe(key)} (${e?.message || e})`); }
  }

  /** The recorded baseline for `key`: {sha, refusedPaths[], snapshotAt} | null. Never throws. */
  function snapshotManifest(key) {
    try { return parseManifest(readFileSync(manifestOf(key), "utf-8")); } catch { return null; }
  }

  // pathFor — deterministic; returns the dir if it currently exists, else null.
  function pathFor(key) {
    const p = pathOf(key);
    return existsSync(p) ? p : null;
  }

  // create — `git worktree add --no-track -b <branch> <path> <BASE_SHA>`. Idempotent:
  // if the worktree already exists for this key (re-entry/crash recovery), return it.
  // See the note at the call sites: `.claude/` is COMMITTED in this repo, so `git worktree
  // add` hands every seat the operator's own configuration — which is precisely what 6.7
  // exists to keep out of a seat's reach. Removed on BOTH the fresh and the re-entry path.
  function stripOperatorClaude(path) {
    try { rmSync(join(path, ".claude"), { recursive: true, force: true }); }
    catch { /* best effort — seat-settings-guard still sweeps before every spawn */ }
  }

  /**
   * @param {string} key
   * @param {{baseRef?: string}} [opts] Phase C · task 9 — an EXPLICIT base. Shipping as you go
   *   commits each HELD task onto `ma/job/<id>`, and the next task's checkout must start from
   *   that tip or it cannot see the work that came before it (probe P-F08). Omitted, the base
   *   is resolved exactly as it always was.
   */
  function create(key, opts = {}) {
    const path = pathOf(key);
    const branch = branchOf(key);
    if (existsSync(path)) {
      // Re-entry / crash recovery. Report the base the EXISTING checkout actually sits
      // on — reading it from the repo's current HEAD would describe a different commit
      // than the one this worktree holds (and, post-D3, a different tree entirely).
      let baseRef = "";
      try { baseRef = git(["rev-parse", "HEAD"], path); } catch { /* */ }
      stripOperatorClaude(path);
      return { path, branch, baseRef, baseMode: "reused", reused: true };
    }
    let baseRef, resolvedMode, refusedPaths, snapshotAt;
    const wanted = String(opts?.baseRef ?? "").trim();
    if (wanted) {
      // Pin the CALLER's ref to a SHA here. A symbolic ref handed to `git worktree add` would
      // be re-resolved later against a branch that may have moved; and a ref that does not
      // resolve must THROW rather than fall back to HEAD — a silent downgrade is the stale-base
      // defect this option exists to close (SEQ-1b).
      try { baseRef = git(["rev-parse", "--verify", `${wanted}^{commit}`]); }
      catch (e) { throw new Error(`worktree: base ref ${wanted} does not resolve (${e.message})`); }
      resolvedMode = "explicit";
      refusedPaths = [];
      snapshotAt = Date.now();
    } else {
      try {
        ({ baseRef, baseMode: resolvedMode, refusedPaths, snapshotAt } = resolveBase()); // pin to a resolved SHA (ADR-026 §2)
      } catch (e) {
        throw new Error(`worktree: not a git repo or git unavailable (${e.message})`);
      }
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
    // 2026-09-05 — STRIP THE OPERATOR'S COMMITTED `.claude/` FROM THE CHECKOUT.
    //
    // `.claude/` is TRACKED in this repo (3,081 files, including `.claude/settings.json`), so
    // `git worktree add` checks it out into every seat worktree. seat-settings-guard.mjs
    // (6.7) then found a permission-bearing file in EVERY worktree and refused EVERY spawn —
    // every engine task ended `empty-diff` having authored nothing. 6.7's own header says
    // "the snapshot never carries .claude/ (SNAPSHOT_DENY)", which is true of the copy-sandbox
    // snapshot and FALSE of a git checkout. Verified: `git cat-file -e HEAD:.claude/settings.json`.
    //
    // Removing it here, ONCE, is the fix at the source: the seat must not be handed the
    // operator's configuration (that is exactly what 6.7 exists to prevent), and stripping it
    // makes 6.7's premise true again — anything found at spawn time really was written by the
    // seat. The broker walks the filesystem, so a path that no longer exists is never
    // enumerated, and `.claude` is REFUSAL_NOISE regardless: no phantom diff (WT-CLAUDE-3).
    stripOperatorClaude(path);
    // AFTER the checkout exists, never before: a manifest describing a worktree that was
    // not created would be read later as a baseline for someone else's directory.
    writeManifest(key, { baseRef, refusedPaths, snapshotAt });
    return { path, branch, baseRef, baseMode: resolvedMode, reused: false };
  }

  // remove — discard everything this task did. Never touches the live repo.
  function remove(key) {
    const path = pathOf(key);
    const branch = branchOf(key);
    // The manifest describes THIS checkout; once the checkout is gone it describes
    // nothing, and a stale one keyed by a REUSED task id would describe the wrong base.
    try { unlinkSync(manifestOf(key)); } catch { /* never written, or already gone */ }
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
    try { unlinkSync(manifestOf(key)); } catch { /* never written, or already gone */ }
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

  // ── #10 — COLLECT WORKTREE DIRS NO TASK CLAIMS ──────────────────────────────
  //
  // `git worktree prune` clears metadata for dirs that are GONE. Nothing cleared dirs
  // whose metadata is gone, which is what a SIGKILL between create() and remove() leaves
  // behind: measured on the live install as 164 directories, ONE of them still claimed.
  // Post-D3 a checkout is the whole working tree rather than a stub, so the leak is no
  // longer free.
  //
  // TWO THINGS IT MUST NEVER DO:
  //   • Collect a dir a task still claims. A HELD task's worktree is the operator's only
  //     copy of the diff they are being asked to approve.
  //   • Delete a branch. release() drops the checkout and KEEPS the ref, because after an
  //     approve that ref is the only copy of a commit the operator accepted. remove() —
  //     which ends in `branch -D` — must never be on this path.
  //
  // And if the liveness probe throws, nothing is reaped: a collector that reads "I could
  // not tell" as "delete it" is worse than the leak it is fixing.
  function reapOrphans(isLive) {
    const out = { reaped: [], kept: 0, error: false };
    if (typeof isLive !== "function") { out.error = true; return out; }
    let entries = [];
    try { entries = readdirSync(worktreeRoot, { withFileTypes: true }); }
    catch { return out; } // no root yet ⇒ nothing to collect
    for (const e of entries) {
      if (!e.isDirectory()) continue; // the scratch index + its head marker are files
      const key = e.name;
      let live;
      try { live = isLive(key); }
      catch (err) {
        log(`[worktree] orphan sweep aborted — could not tell what is live (${err?.message || err})`);
        out.error = true;
        return { ...out, reaped: [] };
      }
      if (live) { out.kept += 1; continue; }
      try { release(key); out.reaped.push(key); }
      catch (err) { log(`[worktree] could not collect ${key}: ${err?.message || err}`); }
    }
    if (out.reaped.length) {
      pruneOrphans();
      log(`[worktree] collected ${out.reaped.length} orphaned checkout(s); ${out.kept} still claimed by a task`);
    }
    return out;
  }

  return { create, remove, release, pathFor, snapshotManifest, pruneOrphans, reapOrphans, branchOf, worktreeRoot };
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

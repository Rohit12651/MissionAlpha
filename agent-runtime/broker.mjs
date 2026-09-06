// F2b PERMISSION BROKER — walk + listChanges + applyChanges, moved VERBATIM from
// server.mjs and parameterized by `workdirFor(id)` + `repoRoot` + `scrub` so the
// engine (ADR-024, worktree-backed) and server (copy-sandbox-backed) share the SAME
// proven broker. LOGIC IS UNCHANGED — only the working-dir source is now injected.
//
// sr-security: this is the sole write path to the live repo. Every path is re-validated
// by applyAllowed + CONFIG_GUARD + configGuardViolation + symlink/realpath — IDENTICAL
// to the original. Auto-apply (engine) and operator-apply (route) both call applyChanges
// here, so the guards run the same regardless of trigger.

import { readdir, readFile, writeFile, mkdir, lstat, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, relative, dirname, sep } from "node:path";
import { REPO_ROOT as DEFAULT_REPO_ROOT, applyAllowed, CONFIG_GUARD, configGuardViolation } from "./guards.mjs";
import { readSnapshotManifestAt } from "./worktree.mjs";
import { GIT_SAFE_ARGS } from "./workspace.mjs";

const trunc = (s, n = 4000) => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);

// Repo machinery, never agent work. A git WORKTREE carries a `.git` FILE (a gitdir
// pointer) that differs from the main repo's by construction, so without this every
// refusal report would open with ".git" — noise that buries the one path the operator
// actually needs to see, and a needless mention of an internal at that.
const REFUSAL_NOISE = /(^|\/)(\.git|\.claude|node_modules|\.DS_Store)(\/|$)/i;

// ── 6.2 — WHOSE CHANGE IS IT? ─────────────────────────────────────────────────
//
// Everything below exists to answer one question the broker used to guess at. It diffed
// the worktree against the LIVE operator tree, so any path that differed for a reason
// unrelated to the agent — a path `snapshotAllowed` refused (the checkout holds HEAD's
// copy, the operator holds something newer), or one the operator edited after the base
// was taken — read as "the agent proposes to replace your file with an older one".
// Approving that REVERTS uncommitted work: measured live as a 29-file, +445/-368
// "revert to HEAD" minted by a one-line docs task.
//
// The baseline is now read from the snapshot manifest the worktree manager wrote, and the
// agent's OWN writes are asked of git inside the checkout (`diff` against the snapshot
// commit, plus untracked). No manifest — a copy-sandbox workdir, or a checkout made
// before this change — means the historical answer, verbatim, and `notAttributed: []`.
// Degrading to the old behaviour is a decision, not an accident: it can only ever say
// MORE is the agent's, which is the direction the human approval gate already covers.

/** The set of paths the SEAT itself wrote, per git, or null when it cannot be known. */
function agentWrittenPaths(workdir, sha) {
  const run = (args) =>
    execFileSync("git", [...GIT_SAFE_ARGS, "-C", workdir, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const out = new Set();
    // Worktree vs the SNAPSHOT COMMIT — covers unstaged, staged and already-committed
    // work on the task branch alike. `--` terminates the revision list so a path can
    // never be read as a revision.
    for (const p of run(["diff", "--name-only", "-z", "--no-renames", sha, "--"]).split("\0")) {
      if (p) out.add(p);
    }
    // …plus files git has never seen. Same record shape as worktree.mjs's parser:
    // "XY <path>", anything else skipped rather than guessed at.
    for (const rec of run(["status", "--porcelain=v1", "-z", "-uall"]).split("\0")) {
      if (rec.length < 4 || rec[2] !== " ") continue;
      if (rec.slice(0, 2) === "??") out.add(rec.slice(3));
    }
    return out;
  } catch {
    return null; // not a git checkout, or a base that no longer resolves ⇒ degrade
  }
}

// Recursively list relative file paths under a dir. Skips symlinks (no link
// following — closes cycle/escape vectors). Bounded depth + file count (DoS guard).
export async function walk(root, base = root, depth = 0, acc = { n: 0 }) {
  const out = [];
  if (depth > 24 || acc.n > 5000) return out;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // never follow links
    const full = join(root, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base, depth + 1, acc)));
    else if (e.isFile()) {
      acc.n++;
      out.push(relative(base, full));
      if (acc.n > 5000) break;
    }
  }
  return out;
}

export function createBroker({
  repoRoot = DEFAULT_REPO_ROOT,
  workdirFor,
  scrub = (s) => s,
  // 6.2 — the baseline seam. Default: read the manifest that sits beside the checkout,
  // which is derived from the workdir itself, so nothing has to be wired anywhere for
  // this to be live. Injectable for tests and for a future non-worktree backend.
  snapshotManifestFor = readSnapshotManifestAt,
  // Phase 7 / 7.2 (BOSS-approved 2026-09-04) — resolve the roster seat for a TASK.
  // The seat comes from the TASK, never from the caller, so a ship-time apply runs as the
  // worker that produced the diff rather than as whoever pressed the button.
  // ABSENT ⇒ every applyAllowed call below is single-argument ⇒ LEGACY behaviour, which is
  // what keeps every existing caller (and every existing test) untouched.
  seatFor = null,
} = {}) {
  // ONE place decides seat-scoped allowance, so listChanges and applyChanges can never
  // disagree about what a seat may write. Returns the verdict AND why it was refused, so a
  // path blocked by writeScope reads differently from one blocked by the floor.
  //
  // A path the seat wrote but may not write is reported under `refused` — NEVER moved into
  // `changes` (PES addendum #17: the reviewer's proposed fall-through would have routed
  // `src/secrets.yaml` into changes, because applyAllowed accepts it; BA-5 caught that).
  function seatVerdict(rel, seat) {
    if (applyAllowed(rel, { seat })) return { ok: true, why: null };
    // Distinguish "the floor refused it" from "this seat may not touch it".
    if (seat && seat.role === "worker" && applyAllowed(rel)) {
      return { ok: false, why: `out-of-scope for seat ${seat.id}` };
    }
    return { ok: false, why: null };
  }

  // Diff the workdir against the live repo → list of proposed changes, PLUS the paths the
  // guards refused.
  //
  // Why the second list exists: an agent told to create `docs/PING.md` did exactly that, and
  // the operator was told `empty-diff — no diff produced`. Both statements were true and
  // together they were a lie by omission — `docs/` is outside SEED_DIRS, so the work was
  // blocked, not absent. The operator re-queued the identical task three times on a live
  // model. `changes` keeps its exact contract (nothing new can ever be applied through it);
  // `refused` is reporting only, so the caller can tell "did nothing" from "was not allowed".
  async function listChangesDetailed(id) {
    const sb = workdirFor(id);
    if (!sb || !existsSync(sb)) return { changes: [], refused: [], notAttributed: [] };
    const files = await walk(sb);
    // 7.2 — the seat is resolved ONCE per listing, from the TASK.
    const seat = seatFor?.(id) ?? null;
    const changes = [];
    const refused = [];
    // 6.2 — paths that are IN the checkout and DIFFER from the live tree, but are not the
    // seat's work. Reported, never silently dropped: "the diff is shorter than you expect"
    // is exactly the kind of omission that sent an operator round the same task three times.
    const notAttributed = [];
    let manifest = null;
    try { manifest = snapshotManifestFor(sb) || null; } catch { manifest = null; }
    // Both facts are needed together. A manifest whose base no longer resolves inside the
    // checkout tells us nothing, and half an answer here is a wrong attribution.
    const written = manifest ? agentWrittenPaths(sb, manifest.sha) : null;
    const attributing = Boolean(manifest && written);
    const snapshotRefused = new Set(attributing ? manifest.refusedPaths : []);
    for (const rel of files) {
      // FIRST, before the guards: a path the snapshot refused is not the agent's under any
      // reading — not as a change, and not as "the agent wrote outside the appliable
      // scope" either. It is the operator's own file, sitting at HEAD's content because
      // this checkout was never allowed to carry the newer one.
      // 6.7 — a path the seat ACTUALLY wrote is the seat's, even if the snapshot refused it;
      // it must fall through to the guard/refused path, never be laundered as operator-owned.
      if (snapshotRefused.has(rel) && attributing && written.has(rel)) {
        // 6.7 — the SEAT wrote a path the snapshot refused. That is the seat writing where it may
        // not (the broker will never apply it), so it is reported under `refused` like any other
        // out-of-scope write — never laundered into `notAttributed` as the operator's own edit.
        if (!REFUSAL_NOISE.test(rel)) refused.push(rel);
        continue;
      }
      if (snapshotRefused.has(rel)) {
        try {
          const after = await readFile(join(sb, rel), "utf-8");
          let before = null;
          try { before = await readFile(join(repoRoot, rel), "utf-8"); } catch { before = null; }
          if (before !== after) notAttributed.push({ path: rel, reason: "snapshot-refused" });
        } catch { /* unreadable ⇒ nothing to report */ }
        continue;
      }
      const verdict = seatVerdict(rel, seat);
      if (!verdict.ok) {
        // Only work that actually DIFFERS from the repo counts as blocked; an untouched
        // file the guards happen to refuse is not something the agent was trying to do.
        try {
          const after = await readFile(join(sb, rel), "utf-8");
          let before = null;
          try { before = await readFile(join(repoRoot, rel), "utf-8"); } catch { before = null; }
          // The reason is annotated onto the path the way pr.mjs already annotates its
          // refusals, so no consumer's `refused: string[]` shape changes.
          if (before !== after && !REFUSAL_NOISE.test(rel)) {
            refused.push(verdict.why ? `${rel} (${verdict.why})` : rel);
          }
        } catch { /* unreadable ⇒ nothing to report */ }
        continue;
      }
      let after = "";
      try {
        after = await readFile(join(sb, rel), "utf-8");
      } catch {
        continue;
      }
      let before = null;
      try {
        before = await readFile(join(repoRoot, rel), "utf-8");
      } catch {
        before = null; // new file
      }
      if (before === after) continue; // unchanged
      // 6.2 — it differs from the live tree, but did the SEAT write it? git, inside the
      // checkout, against the snapshot commit, is the only honest answer. If it did not,
      // the difference is the operator's: either an edit made after the base was taken
      // (mtime, or the file being gone entirely), or a path that never made it into the
      // base for some other reason — which is reported as itself, not as the nearest
      // reason to hand.
      if (attributing && !written.has(rel)) {
        let liveAfterSnapshot = true; // a live file we cannot stat (deleted) is the operator's move
        try { liveAfterSnapshot = (await stat(join(repoRoot, rel))).mtimeMs > manifest.snapshotAt; } catch { /* deleted */ }
        notAttributed.push({
          path: rel,
          reason: liveAfterSnapshot ? "operator-edited-after-snapshot" : "not-in-agent-diff",
        });
        continue;
      }
      changes.push({
        path: rel,
        status: before === null ? "new" : "modified",
        before: before === null ? null : scrub(trunc(before)),
        after: scrub(trunc(after)),
      });
    }
    return { changes, refused, notAttributed };
  }

  /** The historical surface, unchanged: the appliable diff and nothing else. */
  async function listChanges(id) {
    return (await listChangesDetailed(id)).changes;
  }

  // Apply operator-confirmed paths from workdir → live repo. Re-validates every path.
  async function applyChanges(id, paths) {
    const sb = workdirFor(id);
    const results = [];
    if (!sb || !existsSync(sb)) return paths.map((p) => ({ path: p, ok: false, error: "workdir missing" }));
    const seat = seatFor?.(id) ?? null;
    for (const rel of paths) {
      const verdict = seatVerdict(rel, seat);
      if (!verdict.ok) {
        results.push({ path: rel, ok: false, error: verdict.why ? `path not allowed — ${verdict.why}` : "path not allowed" });
        continue;
      }
      try {
        const content = await readFile(join(sb, rel), "utf-8");
        const dest = resolve(repoRoot, rel);
        // CONFIG GUARD — refuse if a protected exec/supply-chain key changed.
        const relNorm = relative(repoRoot, dest);
        if (CONFIG_GUARD[relNorm]) {
          let repoBefore = null;
          try {
            repoBefore = await readFile(dest, "utf-8");
          } catch {
            /* new file */
          }
          const bad = configGuardViolation(relNorm, repoBefore, content);
          if (bad) {
            results.push({ path: rel, ok: false, error: `protected key changed: ${bad}` });
            continue;
          }
        }
        await mkdir(dirname(dest), { recursive: true });
        // refuse symlink destination (no write-through to a link target)
        try {
          if ((await lstat(dest)).isSymbolicLink()) {
            results.push({ path: rel, ok: false, error: "dest is a symlink" });
            continue;
          }
        } catch {
          /* dest doesn't exist yet — fine */
        }
        // realpath the parent + assert it stays inside the repo (no symlinked dir escape)
        const realParent = await realpath(dirname(dest));
        if (!(realParent + sep).startsWith(resolve(repoRoot) + sep)) {
          results.push({ path: rel, ok: false, error: "dest escapes repo" });
          continue;
        }
        await writeFile(dest, content, "utf-8");
        results.push({ path: rel, ok: true });
      } catch (e) {
        results.push({ path: rel, ok: false, error: e.message });
      }
    }
    return results;
  }

  return { listChanges, listChangesDetailed, applyChanges };
}

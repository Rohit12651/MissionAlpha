// PHASE 4 — approve-with-edit: validate and stage a human-revised proposal.
//
// WHAT THIS IS. Today a decision is binary: approve the agent's diff or send it back for
// a full round trip. This module lets an approver fix a line first. The edited content is
// staged into the agent's OWN workdir and then goes through the COMPLETELY UNCHANGED
// broker path (applyAllowed → CONFIG_GUARD → symlink/realpath → writeFile). There is no
// second write path to the repo, and this module never touches REPO_ROOT.
//
// SECURITY POSTURE — this is the trust boundary, so it is spelled out:
//
//   * The edit body is UNTRUSTED. It arrives over HTTP; an approver's authenticated
//     session is exactly what a hostile page would try to drive.
//   * `allowedPaths` is the delivery's own changedPaths. An edit may REVISE a proposal,
//     never EXTEND it. Without that rule the edit channel is a write-anywhere primitive
//     bounded only by the seed dirs.
//   * applyAllowed() is re-run here even though the broker will run it again. The row's
//     changedPaths were authored by an agent; trusting them once is one trust too many.
//   * Staging is ALL-OR-NOTHING. A half-staged edit set is a proposal no human reviewed.
//   * A file that is not already in the workdir cannot be created. An edit revises what
//     was shown in the diff; inventing a new file would land content outside the review
//     record entirely.
//
// THE NON-ATTACK FAILURE THAT MATTERS MOST. broker.mjs `trunc()`s before/after at 4000
// chars and `scrub()`s secrets out before the reviewer ever sees them. So the text on
// screen is not always the text on disk. Writing back what the human saw would silently
// truncate a real file or bake a redaction placeholder into source. `reviewedMatchesDisk`
// exists so the caller can FAIL CLOSED in that case instead of quietly destroying work.

import { readFile, writeFile, realpath, stat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { applyAllowed } from "./guards.mjs";
import { resolveWorkdirDest } from "./workdir-guard.mjs";

/** 256 KB per file. Larger than any hand edit, smaller than a memory problem. */
export const MAX_EDIT_BYTES = 256 * 1024;
/** Mirrors the 100-path cap the server already applies to a broker apply. */
export const MAX_EDIT_FILES = 100;
/** Total across the whole batch, so 100 × 256KB cannot be used as an amplifier. */
export const MAX_EDIT_TOTAL_BYTES = 2 * 1024 * 1024;

// `path` is optional and present whenever the failure is attributable to ONE file, so
// the caller can bind the message to that field in the UI instead of shipping a
// pane-level banner the operator has to map back to a filename themselves.
const fail = (code, error, path = null) => ({ ok: false, code, error, path });

/**
 * Validate an edit batch against the delivery that produced it.
 *
 * @param {unknown} edits            - untrusted `[{ path, after }]`
 * @param {{allowedPaths: string[]}} ctx - the delivery's own changedPaths
 * @returns {{ok:true, edits:{path:string,after:string}[]} | {ok:false, code:number, error:string}}
 */
export function validateEdits(edits, { allowedPaths = [] } = {}) {
  if (!Array.isArray(edits)) return fail(400, "edits must be an array");
  if (edits.length === 0) return fail(400, "no edits supplied");
  if (edits.length > MAX_EDIT_FILES) return fail(413, `too many edited files (max ${MAX_EDIT_FILES})`);

  const allowed = new Set(allowedPaths.map(String));
  const seen = new Set();
  const out = [];
  let total = 0;

  for (const raw of edits) {
    if (!raw || typeof raw !== "object") return fail(400, "each edit must be an object");
    const path = raw.path;
    const after = raw.after;
    if (typeof path !== "string" || !path) return fail(400, "edit.path must be a non-empty string");
    if (typeof after !== "string") return fail(400, `edit.after must be a string (${path})`, path);

    if (seen.has(path)) return fail(400, `duplicate edit for ${path}`, path);
    seen.add(path);

    // Scope BEFORE shape: the clearest error for the commonest mistake.
    if (!allowed.has(path)) return fail(400, `${path} is not part of this delivery`, path);
    // Re-derive safety from the path itself — never from the row that named it.
    if (!applyAllowed(path)) return fail(400, `${path} is not an appliable path`, path);

    // A source file never contains NUL; its presence means a binary body or a
    // truncation attack against a downstream C-string consumer.
    if (after.includes(String.fromCharCode(0))) return fail(400, `${path} contains a NUL byte`, path);
    const bytes = Buffer.byteLength(after, "utf-8");
    if (bytes > MAX_EDIT_BYTES) return fail(413, `${path} is too large (${bytes} > ${MAX_EDIT_BYTES} bytes)`, path);
    total += bytes;
    if (total > MAX_EDIT_TOTAL_BYTES) return fail(413, `edit batch too large (> ${MAX_EDIT_TOTAL_BYTES} bytes)`);

    out.push({ path, after });
  }
  return { ok: true, edits: out };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Structural validation of a unified diff. Used to verify the patch REGENERATED from an
 * edited file before it is persisted, so a malformed patch can never be written to the
 * delivery's on-disk record (which `get()` later reconstructs `before`/`after` from —
 * a corrupt patch there silently corrupts every future review of that delivery).
 */
export function validateUnifiedDiff(patch, { path } = {}) {
  if (typeof patch !== "string" || !patch) return fail(400, "patch must be a non-empty string");
  if (Buffer.byteLength(patch, "utf-8") > MAX_EDIT_BYTES) return fail(413, "patch too large");

  const body = patch.split("\n");
  if (!body[0]?.startsWith("--- ")) return fail(400, "patch must start with a --- header");
  if (!body[1]?.startsWith("+++ ")) return fail(400, "patch must carry a +++ header");

  // Header paths: strip the a/ b/ prefix, then demand they name THIS file and nothing
  // above it. A traversal here would aim a future write at an arbitrary destination.
  const headerPath = (line) => line.slice(4).replace(/^[ab]\//, "").trim();
  const minus = headerPath(body[0]);
  const plus = headerPath(body[1]);
  for (const p of [minus, plus]) {
    if (p === "/dev/null") continue;
    if (p.split(/[\\/]/).includes("..")) return fail(400, `patch header path escapes the tree: ${p}`);
    if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return fail(400, `patch header path is absolute: ${p}`);
  }
  if (path && plus !== "/dev/null" && plus !== path) {
    return fail(400, `patch header path ${plus} does not match ${path}`);
  }

  // Hunk arithmetic: the declared counts must equal the lines actually present.
  let i = 2;
  let hunks = 0;
  while (i < body.length) {
    const line = body[i];
    if (line === "" && i === body.length - 1) break; // trailing newline
    const m = HUNK_RE.exec(line ?? "");
    if (!m) return fail(400, `expected a hunk header at line ${i + 1}`);
    hunks += 1;
    const wantMinus = m[2] === undefined ? 1 : Number(m[2]);
    const wantPlus = m[4] === undefined ? 1 : Number(m[4]);
    let sawMinus = 0;
    let sawPlus = 0;
    i += 1;
    while (i < body.length && !HUNK_RE.test(body[i] ?? "")) {
      const l = body[i];
      if (l === "" && i === body.length - 1) { i += 1; break; } // trailing newline
      if (l.startsWith("-")) sawMinus += 1;
      else if (l.startsWith("+")) sawPlus += 1;
      else if (l.startsWith(" ")) { sawMinus += 1; sawPlus += 1; }
      else return fail(400, `unexpected line in hunk at line ${i + 1}`);
      i += 1;
    }
    if (sawMinus !== wantMinus || sawPlus !== wantPlus) {
      return fail(400, `hunk counts disagree with the body (declared -${wantMinus},+${wantPlus}; found -${sawMinus},+${sawPlus})`);
    }
  }
  if (!hunks) return fail(400, "patch contains no hunks");
  return { ok: true };
}

/**
 * The unified-diff round trip drops EXACTLY ONE trailing newline: a file's final "\n" is
 * a line terminator, not a line, so `lines()` pops it on the way into the patch and
 * `readChanges()` never puts it back. That single byte is the only difference the format
 * is permitted to introduce between disk and review.
 */
function canonicalForReview(onDisk) {
  return onDisk.endsWith("\n") ? onDisk.slice(0, -1) : onDisk;
}

/**
 * True only when the text the human reviewed is a FAITHFUL rendering of what is on disk —
 * equal modulo the one-byte terminator convention above, and nothing else.
 *
 * False means the review was of a scrubbed or truncated rendering. Writing that back
 * would bake "[redacted]" into source or silently delete everything past 4000 chars.
 * Callers MUST fail closed on false. This is not a strictness knob: it is the difference
 * between "the operator corrected a line" and "the operator destroyed a file they were
 * never shown".
 */
export function reviewedMatchesDisk(reviewed, onDisk) {
  if (typeof reviewed !== "string" || typeof onDisk !== "string") return false;
  return reviewed === canonicalForReview(onDisk);
}

/**
 * Give the edited body back the terminator convention the file already had. The editor
 * works on the reviewed text, which by definition has no trailing newline — writing it
 * verbatim would strip the final newline from every file an operator touches.
 */
export function restoreTerminator(edited, onDisk) {
  if (typeof onDisk === "string" && onDisk.endsWith("\n") && !edited.endsWith("\n")) return `${edited}\n`;
  return edited;
}

/**
 * Resolve an edit destination inside the workdir.
 *
 * EXTRACTED to agent-runtime/workdir-guard.mjs in Phase 1 so the agent tool loop and this
 * operator-edit path share ONE containment implementation instead of two that can drift.
 * The logic is unchanged; `allowCreate` stays false here because an operator may only
 * REVISE a file the agent already proposed, never introduce a new one.
 */
async function safeDest(workdir, realRoot, rel) {
  return resolveWorkdirDest({ workdir, realRoot, rel, allowCreate: false });
}

/**
 * Write an edit batch into the agent's workdir. ALL-OR-NOTHING: every destination is
 * resolved and checked first, and nothing is written unless every one passed.
 *
 * The repo is not touched here. Landing remains the broker's job, with its own guards.
 */
export async function stageEdits({ workdir, edits }) {
  if (!workdir || typeof workdir !== "string") return fail(400, "no workdir for this delivery");
  try {
    if (!(await stat(workdir)).isDirectory()) return fail(409, "workdir is not a directory");
  } catch {
    return fail(409, "workdir missing — the agent's work has been cleaned up");
  }

  let realRoot;
  try {
    realRoot = await realpath(workdir);
  } catch {
    return fail(409, "workdir missing — the agent's work has been cleaned up");
  }

  const planned = [];
  for (const e of edits) {
    const r = await safeDest(workdir, realRoot, e.path);
    if (!r.ok) return r;
    planned.push({ dest: r.dest, after: e.after, path: e.path });
  }

  // WRITE TO A SCRATCH FILE FIRST, THEN RENAME. Two review findings share this fix.
  //
  // TOCTOU (HIGH). The old loop lstat'd every destination and then writeFile'd every
  // destination, so nothing pinned the inode across the gap — and for a batch, one file's
  // gap spans every other file's write. An agent's own tool loop can write into this same
  // workdir (the manual-run sandbox is keyed by agentId and reused across runs), so a
  // destination validated as a regular file could be a symlink by the time it was
  // written, and the operator's bytes would land wherever it pointed. rename(2) does NOT
  // follow a symlink at the destination — it replaces the link itself — so the swap wins
  // nothing. The scratch file is created with "wx" (fail if it exists), inside the parent
  // that safeDest already resolved, so it cannot clobber or follow anything either.
  //
  // ATOMICITY (MEDIUM). "ALL-OR-NOTHING" previously held only for failures caught during
  // VALIDATION. A failure during the write loop (disk full, a permission race) left every
  // earlier file already rewritten — bytes nobody approved, which a later plain approve
  // would then apply. Every scratch file is now written first; the renames happen only
  // once all of them succeeded, and on any failure the scratch files are removed and not
  // one destination has been touched.
  const scratch = [];
  const cleanup = async () => {
    for (const t of scratch) { try { await unlink(t.tmp); } catch { /* already gone */ } }
  };
  let n = 0;
  for (const p of planned) {
    n += 1;
    const tmp = `${p.dest}.stage-${process.pid}-${n}.tmp`;
    try {
      await writeFile(tmp, p.after, { encoding: "utf-8", flag: "wx" });
      scratch.push({ tmp, dest: p.dest, path: p.path });
    } catch (err) {
      await cleanup();
      return fail(500, `failed to stage ${p.path}: ${err?.message ?? err} (staged: none)`);
    }
  }

  const written = [];
  for (const t of scratch) {
    try {
      await rename(t.tmp, t.dest);
      written.push(t.path);
    } catch (err) {
      // A rename within one directory is metadata-only and effectively never fails after
      // the write succeeded — but if it does, say exactly which paths already moved. A
      // partial batch reported as a clean failure is how unreviewed bytes go unnoticed.
      await cleanup();
      return fail(
        500,
        `failed to stage ${t.path}: ${err?.message ?? err} (already staged: ${written.join(", ") || "none"})`,
      );
    }
  }
  return { ok: true, staged: written };
}

/** Read a workdir file for the pre-edit corruption check. Returns null when unreadable. */
export async function readWorkdirFile(workdir, rel) {
  try {
    return await readFile(join(workdir, rel), "utf-8");
  } catch {
    return null;
  }
}

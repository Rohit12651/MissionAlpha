// Phase 1 / R3 — TIER-0 CODEMODS. Deterministic source transforms that cost zero tokens.
//
// LAW 1, restated because this is the module most likely to tempt someone into breaking
// it: a codemod NEVER writes to the live repo. It writes into the per-task git WORKTREE
// (the same dir a model would have written into), and the resulting diff then flows
// through the identical machinery — broker.listChanges → risk classify → band → policy →
// Inbox → human decision → broker.applyChanges. There is no cheap path to the repo. If a
// future edit makes this module call anything that writes outside `workdir`, that is a
// security regression, and `codemod.test.mjs` fails on it.
//
// WHY STRING-LEVEL, NOT AST: the two implemented transforms are line-local and
// syntactically unambiguous when guarded correctly (see below). Pulling the TypeScript
// compiler in to delete a console.log would add a heavy dependency to the one path whose
// entire value proposition is "costs nothing and finishes in milliseconds". When a
// transform arrives that genuinely needs scope analysis, it gets an AST — and that is a
// deliberate, reviewed addition, not a default.
//
// SAFETY GUARDS (all test-pinned):
//   • Only files under the worktree, only allow-listed extensions, never a symlink.
//   • A file the transform does not change is not rewritten (no empty-diff churn).
//   • Strings and comments containing the target text are NOT mangled: each transform
//     documents exactly what it refuses to touch and the tests pin those refusals.
//   • A transform that would change more than MAX_FILE_CHANGES files aborts. A runaway
//     mechanical edit across a whole repo is not a "small task"; it is a human decision.

import { readFile, writeFile, lstat } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";

/** Extensions a codemod may touch. Closed set. */
export const CODEMOD_EXTS = Object.freeze(new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]));
/** Abort threshold — beyond this it is not a mechanical task any more. */
export const MAX_FILE_CHANGES = 25;

/**
 * remove-console — delete standalone console.log/debug/info statement lines.
 *
 * REFUSES (pinned by tests):
 *   • console.error / console.warn — those are deliberate diagnostics, not debug noise.
 *   • any line where the call is not the whole statement (assignments, arguments,
 *     returns, chained expressions) — removing those changes program meaning.
 *   • occurrences inside a string literal or a comment.
 * A multi-line console.log( ... ) spanning lines is left alone: detecting its extent
 * correctly needs a parser, and a half-deleted call is a syntax error.
 */
export function removeConsole(source) {
  const lines = String(source).split("\n");
  const out = [];
  let removed = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track block comments so a commented-out console.log is never "removed".
    if (inBlockComment) {
      out.push(line);
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      out.push(line);
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//")) { out.push(line); continue; }

    // The whole line must BE the call: optional `await`, then console.<lvl>( ... ) ;
    // Balanced-paren check keeps a multi-line call from being half-eaten.
    const m = /^(?:await\s+)?console\.(log|debug|info)\s*\((.*)\)\s*;?$/.exec(trimmed);
    if (m) {
      const inner = m[2];
      let depth = 0, balanced = true;
      for (const ch of inner) {
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (depth < 0) { balanced = false; break; } }
      }
      if (balanced && depth === 0) { removed++; continue; }
    }
    out.push(line);
  }
  return { text: out.join("\n"), changes: removed };
}

/**
 * var-to-const — rewrite `var x = ...` declarations to `const`.
 *
 * REFUSES: any `var` whose binding is reassigned later in the file (that needs `let`, and
 * deciding between const and let per-binding without scope analysis is exactly the kind
 * of guess that produces a confidently-wrong cheap edit). Also refuses vars inside
 * comments/strings, and loop headers (`for (var i = ...)`), which are almost always
 * mutated.
 */
export function varToConst(source) {
  const text = String(source);
  const lines = text.split("\n");
  const out = [];
  let changes = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlockComment) { out.push(line); if (trimmed.includes("*/")) inBlockComment = false; continue; }
    if (trimmed.startsWith("/*")) { out.push(line); if (!trimmed.includes("*/")) inBlockComment = true; continue; }
    if (trimmed.startsWith("//")) { out.push(line); continue; }
    if (/\bfor\s*\(\s*var\b/.test(line)) { out.push(line); continue; }

    const m = /^(\s*)var\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (!m) { out.push(line); continue; }

    const name = m[2];
    // Reassignment anywhere else in the file → not a const. `name =` but not `name ==`
    // and not the declaration itself.
    const reassign = new RegExp(`(^|[^\\w$.])${name}\\s*(=[^=]|\\+\\+|--|[-+*/%]=)`, "g");
    let hits = 0;
    while (reassign.exec(text) !== null) hits++;
    if (hits > 1) { out.push(line); continue; }

    out.push(line.replace(/^(\s*)var\b/, "$1const"));
    changes++;
  }
  return { text: out.join("\n"), changes };
}

/** The closed transform registry. Intent → pure (source) => {text, changes}. */
export const TRANSFORMS = Object.freeze({
  "remove-console": removeConsole,
  "var-to-const": varToConst,
});

/** Is this intent actually implemented as a $0 transform? */
export function isCodemodIntent(intent) {
  return Object.prototype.hasOwnProperty.call(TRANSFORMS, intent);
}

function insideWorktree(workdir, file) {
  const root = resolve(workdir);
  const target = resolve(root, file);
  const rel = relative(root, target);
  // Containment: never empty (that is the root itself), never climbing out, never absolute.
  return rel !== "" && !rel.startsWith("..") && !/^([A-Za-z]:)?[\\/]/.test(rel) ? target : null;
}

/**
 * Apply a codemod across the given worktree-relative files.
 *
 * Returns { ok, intent, filesChanged, totalChanges, skipped[] } and NEVER touches
 * anything outside `workdir`.
 */
export async function applyCodemod({ workdir, intent, files, io = {} }) {
  const read = io.readFile || readFile;
  const write = io.writeFile || writeFile;
  const stat = io.lstat || lstat;

  if (!workdir) return { ok: false, error: "no workdir" };
  const fn = TRANSFORMS[intent];
  if (!fn) return { ok: false, error: `unknown codemod intent '${intent}'` };
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return { ok: false, error: "no files" };
  if (list.length > MAX_FILE_CHANGES) {
    return { ok: false, error: `refusing ${list.length} files (> ${MAX_FILE_CHANGES}) — not a mechanical task` };
  }

  const skipped = [];
  let filesChanged = 0;
  let totalChanges = 0;

  for (const rel of list) {
    const abs = insideWorktree(workdir, rel);
    if (!abs) { skipped.push({ file: rel, why: "outside worktree" }); continue; }
    if (!CODEMOD_EXTS.has(extname(abs))) { skipped.push({ file: rel, why: "extension not allowed" }); continue; }
    let st;
    try { st = await stat(abs); } catch { skipped.push({ file: rel, why: "unreadable" }); continue; }
    if (st.isSymbolicLink && st.isSymbolicLink()) { skipped.push({ file: rel, why: "symlink" }); continue; }

    let src;
    try { src = String(await read(abs, "utf8")); } catch { skipped.push({ file: rel, why: "unreadable" }); continue; }

    const result = fn(src);
    if (!result.changes || result.text === src) { skipped.push({ file: rel, why: "no change" }); continue; }

    await write(abs, result.text, "utf8");
    filesChanged++;
    totalChanges += result.changes;
  }

  return { ok: true, intent, filesChanged, totalChanges, skipped };
}

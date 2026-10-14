// PHASE 1 TASK 1.2 — workdir containment, shared by every path that writes into an
// agent's working directory.
//
// PROVENANCE: this is `safeDest` lifted VERBATIM out of patch-edit.mjs, where it guarded
// an operator's edit of a delivery. Phase 1 gives a third-party model a tool loop that
// writes files, and the plan's rule is "the SAME workdir and the SAME guards — no second
// write path". Had the executor grown its own copy, the two would drift, and the copy
// guarding the untrusted-model path is the worse one to let drift. patch-edit.mjs now
// imports this, so its existing tests are the proof the extraction changed nothing.
//
// THE REPO IS NEVER TOUCHED HERE. This resolves a destination inside the workdir only;
// landing anything in the actual repository remains broker.applyChanges, behind
// applyAllowed + CONFIG_GUARD + its own symlink/realpath checks. That is still the single
// write path into the repo, exactly as before.
//
// THE ONE PARAMETER: `allowCreate`. An operator may only REVISE a file the agent already
// proposed (a missing path is a refusal). An agent must be able to CREATE one. Every
// containment rule below applies identically either way — creation does not relax them,
// it only changes whether a missing destination is an error.

import { lstat, realpath, mkdir } from "node:fs/promises";
import { resolve, dirname, join, relative, sep } from "node:path";

const fail = (code, error, path = null) => ({ ok: false, code, error, path });

/**
 * Resolve `rel` to an absolute destination inside `workdir`, or refuse and say why.
 *
 * `realRoot` is the workdir ALREADY passed through realpath. Containment is compared in
 * real-path space on both sides: on macOS the sandbox lives under /var/folders, which is
 * itself a symlink to /private/var/folders, so comparing a realpath'd parent against a
 * merely-resolved root would reject every legitimate write.
 *
 * @returns {{ok:true,dest:string} | {ok:false,code:number,error:string,path:string|null}}
 */
export async function resolveWorkdirDest({ workdir, realRoot, rel, allowCreate = false }) {
  if (typeof rel !== "string" || rel === "") return fail(400, "no path given", rel ?? null);

  const dest = resolve(workdir, rel);
  // Checked on the LITERAL resolved path first, before anything is created. With
  // allowCreate this is the only defence available for a parent that does not exist yet,
  // so it has to come before any mkdir.
  if (!dest.startsWith(resolve(workdir) + sep)) return fail(400, `${rel} escapes the workdir`, rel);

  const parent = dirname(dest);

  // With allowCreate, the parent chain may legitimately not exist. Walk UP to the nearest
  // existing ancestor and containment-check THAT in real-path space before creating
  // anything, so a symlinked ancestor cannot be used to plant directories outside.
  if (allowCreate) {
    let probe = parent;
    let realProbe = null;
    for (;;) {
      try {
        realProbe = await realpath(probe);
        break;
      } catch {
        const up = dirname(probe);
        // Ran out of path without finding an existing ancestor: nothing sane to check.
        if (up === probe) return fail(400, `${rel} is not in the workdir`, rel);
        probe = up;
      }
    }
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
      return fail(400, `${rel} escapes the workdir through a symlinked directory`, rel);
    }
    try {
      await mkdir(parent, { recursive: true });
    } catch (err) {
      return fail(400, `${rel} could not be created: ${err?.message ?? err}`, rel);
    }
  }

  // The parent must resolve INSIDE the workdir — a symlinked directory is an escape
  // even when the literal path looks contained.
  let realParent;
  try {
    realParent = await realpath(parent);
  } catch {
    return fail(400, `${rel} is not in the workdir`, rel);
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    return fail(400, `${rel} escapes the workdir through a symlinked directory`, rel);
  }

  // Never write THROUGH a link.
  let info;
  try {
    info = await lstat(dest);
  } catch {
    // Missing. Creation is the caller's decision; revision of a non-existent file is not.
    if (allowCreate) return { ok: true, dest, created: true };
    return fail(400, `${rel} is not in the workdir`, rel);
  }
  if (info.isSymbolicLink()) return fail(400, `${rel} is a symlink`, rel);
  if (!info.isFile()) return fail(400, `${rel} is not a regular file`, rel);
  return { ok: true, dest, created: false };
}

/**
 * Phase C · task 11 — THE CANONICAL DESTINATION IS THE ONE THE SCOPE WAS CHECKED AGAINST.
 *
 * Every writer here already refused a symlink pointing OUTSIDE the repo, and already
 * realpath'd the parent to confirm it was still inside. Codex probes P2/P3 showed that is the
 * wrong claim: `src/alias -> ../docs` resolves to <repo>/docs, which IS inside, so the
 * containment test passes and the write lands in docs/ — while writeScope, checked against the
 * LEXICAL path `src/alias/out.txt`, said `src/**`. Containment was never what protected scope.
 *
 * So: the real parent must EQUAL the lexical parent (mapped through the root's own realpath,
 * because on macOS a temp root under /var is itself a link to /private/var). Any symlink
 * anywhere in the chain makes the two differ, and the write is refused.
 *
 * REFUSAL BEFORE SIDE-EFFECT. When the parent chain does not exist, the nearest EXISTING
 * ancestor is checked before anything is created — otherwise `mkdir -p src/alias/new` would
 * plant a real directory in docs/ on the way to discovering the redirect.
 *
 * @returns {{ok:true,dest:string} | {ok:false,error:string}}
 */
export async function assertCanonicalInside(root, rel, { create = false } = {}) {
  if (typeof rel !== "string" || rel === "") return { ok: false, error: "no path given" };
  const rootAbs = resolve(root);
  let realRoot;
  try { realRoot = await realpath(rootAbs); } catch { return { ok: false, error: "root does not exist" }; }

  const dest = resolve(rootAbs, rel);
  if (dest !== rootAbs && !dest.startsWith(rootAbs + sep)) return { ok: false, error: `${rel} escapes the root` };

  const expectedFor = (p) => {
    const r = relative(rootAbs, p);
    return r ? join(realRoot, r) : realRoot;
  };

  // Nearest existing ancestor, checked BEFORE any mkdir.
  const parent = dirname(dest);
  let probe = parent;
  let realProbe = null;
  for (;;) {
    try { realProbe = await realpath(probe); break; } catch {
      const up = dirname(probe);
      if (up === probe) return { ok: false, error: `${rel} is not inside the root` };
      probe = up;
    }
  }
  if (realProbe !== expectedFor(probe)) {
    return { ok: false, error: `${rel} is redirected by a symlinked directory — the canonical destination is outside the checked scope` };
  }

  if (create && probe !== parent) {
    try { await mkdir(parent, { recursive: true }); } catch (err) { return { ok: false, error: `${rel} could not be created: ${err?.message ?? err}` }; }
  }
  if (probe === parent) {
    // parent existed: realProbe already proved it is canonical
  } else if (!create) {
    return { ok: false, error: `${rel} is not inside the root` };
  }

  // Never write THROUGH a link at the leaf either.
  try {
    if ((await lstat(dest)).isSymbolicLink()) return { ok: false, error: `${rel} is a symlink` };
  } catch { /* missing leaf is fine — the caller decides */ }
  return { ok: true, dest };
}

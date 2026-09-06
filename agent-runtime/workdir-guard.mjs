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
import { resolve, dirname, sep } from "node:path";

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

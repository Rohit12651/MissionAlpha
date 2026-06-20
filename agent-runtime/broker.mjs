// F2b PERMISSION BROKER — walk + listChanges + applyChanges, moved VERBATIM from
// server.mjs and parameterized by `workdirFor(id)` + `repoRoot` + `scrub` so the
// engine (ADR-024, worktree-backed) and server (copy-sandbox-backed) share the SAME
// proven broker. LOGIC IS UNCHANGED — only the working-dir source is now injected.
//
// sr-security: this is the sole write path to the live repo. Every path is re-validated
// by applyAllowed + CONFIG_GUARD + configGuardViolation + symlink/realpath — IDENTICAL
// to the original. Auto-apply (engine) and operator-apply (route) both call applyChanges
// here, so the guards run the same regardless of trigger.

import { readdir, readFile, writeFile, mkdir, lstat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";
import { REPO_ROOT as DEFAULT_REPO_ROOT, applyAllowed, CONFIG_GUARD, configGuardViolation } from "./guards.mjs";

const trunc = (s, n = 4000) => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);

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

export function createBroker({ repoRoot = DEFAULT_REPO_ROOT, workdirFor, scrub = (s) => s } = {}) {
  // Diff the workdir against the live repo → list of proposed changes.
  async function listChanges(id) {
    const sb = workdirFor(id);
    if (!sb || !existsSync(sb)) return [];
    const files = await walk(sb);
    const changes = [];
    for (const rel of files) {
      if (!applyAllowed(rel)) continue;
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
      changes.push({
        path: rel,
        status: before === null ? "new" : "modified",
        before: before === null ? null : scrub(trunc(before)),
        after: scrub(trunc(after)),
      });
    }
    return changes;
  }

  // Apply operator-confirmed paths from workdir → live repo. Re-validates every path.
  async function applyChanges(id, paths) {
    const sb = workdirFor(id);
    const results = [];
    if (!sb || !existsSync(sb)) return paths.map((p) => ({ path: p, ok: false, error: "workdir missing" }));
    for (const rel of paths) {
      if (!applyAllowed(rel)) {
        results.push({ path: rel, ok: false, error: "path not allowed" });
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

  return { listChanges, applyChanges };
}

// PHASE 0 TASK 0.4 (autonomy program) — THE BUILD-IDENTITY STAMP.
//
// WHY THIS EXISTS. `npm run test:visual` drives the PRODUCTION build on :3007 via
// Playwright's `webServer`, with `reuseExistingServer: false`.
//
// That flag is stronger than the first draft of this note claimed, and the claim was
// narrowed after independent verification: a squatter already holding :3007 when the suite
// STARTS makes Playwright refuse to run ("...is already used" — observed on 1.62.1), not
// silently reuse it. The remaining window is the ~1 minute the `npm run build` half of the
// webServer command takes: a process that grabs the port inside that window makes
// `vite preview --strictPort` exit, and the run continues against the squatter. One stale
// preview was found and killed during this program's triage.
//
// A suite that silently photographs an old bundle and compares it to old baselines passes
// forever while certifying nothing, which is the exact class of lie the harness exists to
// stop — so the window is worth closing even though it is narrow.
//
// (It was NOT the cause of the blind 30/30 run — that was pixelmatch's `threshold`, see
// test/visual/strict.mjs. This guard is still owed: the plan asks for it regardless of the
// cause, and the stale-server mechanism is real and unguarded.)
//
// THE MECHANISM. A hash over every build INPUT that can change a pixel is stamped into
// index.html at build time as `<meta name="ma-build-id">`. The visual harness recomputes
// the same hash from the working tree and refuses to capture unless they match. So a
// served bundle that is not this tree's build fails loudly, naming both hashes, instead of
// producing a green run.
//
// WHAT IS HASHED, and why it is the right set: every file under src/ (components, theme
// CSS, fonts), plus index.html and the tailwind/postcss configs — the four inputs that
// determine what the browser paints. Deliberately NOT hashed: node_modules (a dependency
// change lands in the lockfile and would make every stamp churn without changing pixels
// in the cases this guards) and vite.config.ts's server/proxy blocks. The guard answers
// "is the served page built from THIS source tree", not "is every byte of the toolchain
// identical".
//
// DETERMINISM MATTERS HERE: the stamp is embedded in a page the suite screenshots. It is
// content-derived, never a timestamp or a random id, so two builds of the same tree
// produce the same stamp and the meta tag can never itself become a source of pixel churn.
// (A <meta> in <head> renders nothing either way; the rule holds for the next person who
// moves it.)

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Roots hashed in full, recursively. */
export const HASHED_DIRS = ["src"];

/** Individual files hashed when present. Absent ones are recorded as absent, not skipped
 *  silently — deleting tailwind.config.ts must change the stamp. */
export const HASHED_FILES = ["index.html", "tailwind.config.ts", "postcss.config.js"];

/**
 * Every hashed file under `dir`, relative to `root`, in a stable order.
 * Sorted so directory-iteration order (which is filesystem-dependent) cannot change the
 * hash of an unchanged tree.
 */
export function listSourceFiles(root, dirs = HASHED_DIRS) {
  const out = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // a missing root is reported by the caller's absent-marker, not thrown here
    }
    for (const e of entries) {
      const child = join(abs, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.push(relative(root, child).split(sep).join("/"));
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out.sort();
}

/**
 * A content hash of the build inputs under `root`.
 *
 * Each entry is fed in as `path\0<sha256 of bytes>\n`, so a RENAME changes the digest even
 * when the bytes do not — otherwise moving a component between files would be invisible to
 * the guard. Returns the first 16 hex chars: 64 bits of collision resistance against
 * accidental (not adversarial) collision, short enough to read in an error message.
 */
export function computeSourceId(root) {
  const h = createHash("sha256");
  for (const rel of listSourceFiles(root)) {
    h.update(rel);
    h.update("\0");
    h.update(createHash("sha256").update(readFileSync(join(root, rel))).digest("hex"));
    h.update("\n");
  }
  for (const rel of HASHED_FILES) {
    const abs = join(root, rel);
    h.update(rel);
    h.update("\0");
    // ABSENT is a real state and must hash differently from an empty file.
    h.update(
      existsSync(abs) && statSync(abs).isFile()
        ? createHash("sha256").update(readFileSync(abs)).digest("hex")
        : "ABSENT",
    );
    h.update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

/** The meta name carrying the stamp in index.html. */
export const BUILD_ID_META = "ma-build-id";

/** The exact tag injected at build time. */
export function buildIdMetaTag(id) {
  return `<meta name="${BUILD_ID_META}" content="${id}" />`;
}

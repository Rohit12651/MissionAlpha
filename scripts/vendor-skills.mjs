// scripts/vendor-skills.mjs
// Vendor ~/.claude/{skills,commands} into local .claude/ — PRUNED (md only),
// skip symlinks, path-safe, deterministic. Writes .claude/VENDOR_MANIFEST.json.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isVendoredFile, safeJoin, familyRootFor, isInsideRoot } from "./lib/vendor.mjs";

const SRC_HOME = path.join(os.homedir(), ".claude");
const DEST = path.resolve(process.cwd(), ".claude");
const SOURCES = ["skills", "commands"];

let copied = 0;
let skippedSymlinks = 0;
let followedSymlinks = 0;
let prunedFiles = 0;
const perSource = {};

/** Recursively walk src dir, copying vendored files into dest, skipping symlinks. */
function walk(srcDir, destRoot, relBase) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const ent of entries) {
    const srcPath = path.join(srcDir, ent.name);
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    const lst = fs.lstatSync(srcPath);
    if (lst.isSymbolicLink()) {
      // Follow ONLY md-file symlinks whose realpath stays inside the source root.
      // Anything else (escape, dir-symlink, non-md) is skipped — escape-safe, loop-safe.
      let real;
      try { real = fs.realpathSync(srcPath); } catch { skippedSymlinks++; continue; }
      if (!isInsideRoot(real, SRC_HOME)) { skippedSymlinks++; continue; }
      const rst = fs.statSync(real);
      if (!rst.isFile() || !isVendoredFile(rel)) { skippedSymlinks++; continue; }
      const dest = safeJoin(destRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(real, dest);
      copied++; followedSymlinks++;
      continue;
    }
    if (lst.isDirectory()) { walk(srcPath, destRoot, rel); continue; }
    if (!isVendoredFile(rel)) { prunedFiles++; continue; }
    const dest = safeJoin(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(srcPath, dest);
    copied++;
  }
}

for (const sourceKind of SOURCES) {
  const srcRoot = path.join(SRC_HOME, sourceKind);
  const destRoot = path.join(DEST, familyRootFor(sourceKind));
  if (!fs.existsSync(srcRoot)) {
    console.warn(`[vendor] source missing, skipping: ${srcRoot}`);
    perSource[sourceKind] = 0;
    continue;
  }
  // Clean replace: remove existing dest tree so output is deterministic.
  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.mkdirSync(destRoot, { recursive: true });
  const before = copied;
  walk(srcRoot, destRoot, "");
  perSource[sourceKind] = copied - before;
}

// Compute total vendored size.
let bytes = 0;
function sizeOf(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) sizeOf(p);
    else bytes += fs.statSync(p).size;
  }
}
for (const s of SOURCES) sizeOf(path.join(DEST, familyRootFor(s)));

const manifest = {
  generatedFrom: SRC_HOME,
  sources: perSource,
  copied,
  prunedFiles,
  skippedSymlinks,
  followedSymlinks,
  totalBytes: bytes,
  totalMB: +(bytes / 1048576).toFixed(2),
};
fs.writeFileSync(path.join(DEST, "VENDOR_MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`[vendor] copied=${copied} pruned=${prunedFiles} followedSymlinks=${followedSymlinks} skippedSymlinks=${skippedSymlinks} size=${manifest.totalMB}MB`);
console.log(`[vendor] per-source: ${JSON.stringify(perSource)}`);

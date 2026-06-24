// Pure helpers for the C1 skill-catalog vendoring script.
// No filesystem side effects — unit-tested in scripts/lib/__tests__/vendor.test.mjs.
import path from "node:path";

/** Prune rule: vendor markdown only (SKILL.md + any *.md). Strip all heavy/binary assets. */
export function isVendoredFile(relPath) {
  return path.extname(relPath).toLowerCase() === ".md";
}

/** Join + resolve `rel` under `root`, throwing if the result escapes `root`. */
export function safeJoin(root, rel) {
  const resolvedRoot = path.resolve(root);
  const dest = path.resolve(resolvedRoot, rel);
  if (dest !== resolvedRoot && !dest.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`path escape blocked: ${rel} -> ${dest}`);
  }
  return dest;
}

/** True if `realPath` (already resolved) is inside `root` — used to allow only intra-root symlinks. */
export function isInsideRoot(realPath, root) {
  const resolvedRoot = path.resolve(root);
  const p = path.resolve(realPath);
  return p === resolvedRoot || p.startsWith(resolvedRoot + path.sep);
}

/** Map a source kind ("skills"|"commands") to its dest subdir under .claude/. */
export function familyRootFor(sourceKind) {
  if (sourceKind === "skills" || sourceKind === "commands") return sourceKind;
  throw new Error(`unknown source kind: ${sourceKind}`);
}

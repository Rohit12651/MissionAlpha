// fs walk for the P1 roster. Roots are passed in explicitly (never discovered inside the
// walker) so tests can point it at a fixture tree. Missing roots are skipped silently —
// a machine without ~/.claude or WaahyuTools must still generate a valid catalog.
import fs from "node:fs";
import path from "node:path";
import { familyOf, hintFrom } from "./skills-gen.mjs";

// Depth cap: real skill trees are ≤8 levels once plugin cache versions are counted; the
// cap stops a pathological generated tree from turning the scan into a hang.
const MAX_DEPTH = 10;
const SEMVER_RE = /^v?\d+\.\d+\.\d+/;

/** A packaged skill's id is its path BELOW the nearest enclosing `skills/` directory.
 *  Plugin and tool-repo roots are repo roots, so their relative paths carry a packaging
 *  prefix (`plugins/<x>/skills/`, `cache/<mp>/<plugin>/<ver>/skills/`) that is not identity.
 *  `~/.claude/skills` IS the skills dir, so those roots pass `strip:false` and keep their
 *  nesting (`ecc/agent-sort`, `gstack/browse`) — that nesting drives familyOf. */
export function skillIdFromRel(rel) {
  const parts = rel.split("/").filter(Boolean);
  const last = parts.lastIndexOf("skills");
  const tail = last === -1 ? parts : parts.slice(last + 1);
  return (tail.length ? tail : parts).join("/");
}

/** Derive `plugin:<name>` from a path under ~/.claude/plugins. The plugin is the last
 *  non-version segment before the enclosing `skills/` dir. Falls back to "plugin:local". */
export function pluginNameFromRel(rel) {
  const parts = rel.split("/").filter(Boolean);
  const last = parts.lastIndexOf("skills");
  const head = last === -1 ? parts.slice(0, -1) : parts.slice(0, last);
  for (let i = head.length - 1; i >= 0; i--) {
    if (!SEMVER_RE.test(head[i])) return head[i];
  }
  return "local";
}

function walk(root, dir, out, seen, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const skillFile = path.join(dir, "SKILL.md");
  if (fs.existsSync(skillFile)) {
    const rel = path.relative(root.dir, dir).split(path.sep).join("/");
    const id = (root.strip === false ? rel : skillIdFromRel(rel)) || path.basename(dir);
    const source = root.sourceFn ? root.sourceFn(rel) : root.source;
    const key = `${source} ${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      let raw = "";
      try { raw = fs.readFileSync(skillFile, "utf8"); } catch { /* unreadable → id-only row */ }
      out.push({ id, name: id, source, family: familyOf(id, "skills"), description: hintFrom(raw, id) });
    }
  }
  for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    // Skip hidden dirs (harness mirrors like .agents/.cursor duplicate every skill) and
    // never follow symlinks (loop-safe, escape-safe).
    if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name === "node_modules") continue;
    const child = path.join(dir, ent.name);
    try { if (fs.lstatSync(child).isSymbolicLink()) continue; } catch { continue; }
    walk(root, child, out, seen, depth + 1);
  }
}

/** Scan a list of roots. Each root is {dir, source|sourceFn, strip?}. Missing dirs skipped. */
export function scanRoots(roots) {
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    if (!root.dir || !fs.existsSync(root.dir)) continue;
    walk(root, root.dir, out, seen, 0);
  }
  return out;
}

/** Build the root list for a machine. Every root is optional. */
export function discoverRoots({ homeDir, toolsDir, repoDir, toolRepos = [] }) {
  return [
    // 1. In-repo curated skills win on id collision (scanned first).
    { dir: path.join(repoDir, ".claude", "skills-curated"), source: "curated", strip: false },
    // 2. The operator's own skill tree — the dir IS the skills root, so keep the nesting.
    { dir: path.join(homeDir, ".claude", "skills"), source: "user", strip: false },
    // 3. Installed plugins — one source per plugin, derived from the path.
    { dir: path.join(homeDir, ".claude", "plugins"), sourceFn: (rel) => `plugin:${pluginNameFromRel(rel)}` },
    // 4. WaahyuTools skill repos named in ~/.claude/CLAUDE.md.
    ...toolRepos.map((repo) => ({ dir: path.join(toolsDir, repo), source: `tools:${repo}` })),
    // 5. Fallback: the repo-vendored tree keeps CI reproducible when the roots above are absent.
    { dir: path.join(repoDir, ".claude", "skills"), source: "user", strip: false },
  ];
}

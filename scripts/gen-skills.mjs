// scripts/gen-skills.mjs — scan local .claude/, emit src/lib/missionSkills.ts.
import fs from "node:fs";
import path from "node:path";
import { entryFor, renderModule } from "./lib/skills-gen.mjs";

const ROOT = process.cwd();
const SKILLS_DIR = path.join(ROOT, ".claude", "skills");
// Curated, in-repo skills that vendor:skills must NOT wipe (caveman, headroom, …). Scanned in
// addition to the auto-vendored .claude/skills; curated wins on id collision (scanned first).
const CURATED_DIR = path.join(ROOT, ".claude", "skills-curated");
const COMMANDS_DIR = path.join(ROOT, ".claude", "commands");
const OUT = path.join(ROOT, "src", "lib", "missionSkills.ts");

const entries = [];
const seen = new Set(); // `${kind}/${id}` dedup

/** Recurse: any dir holding SKILL.md is a skill; id = path relative to `baseRoot`.
 *  A dir can be BOTH a skill AND a parent of sub-skills (e.g. gstack/, ecc/), so we
 *  emit-then-descend rather than early-returning. Hidden dirs (".agents", ".cursor", …)
 *  are skipped — gstack ships harness-mirror copies that would otherwise dupe entries. */
function walkSkills(dir, baseRoot) {
  if (fs.existsSync(path.join(dir, "SKILL.md"))) {
    const id = path.relative(baseRoot, dir).split(path.sep).join("/");
    const key = `skill/${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(entryFor(id, "skills", fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")));
    }
  }
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (ent.isDirectory() && !ent.name.startsWith(".")) walkSkills(path.join(dir, ent.name), baseRoot);
  }
}

function walkCommands() {
  if (!fs.existsSync(COMMANDS_DIR)) return;
  for (const f of fs.readdirSync(COMMANDS_DIR).sort()) {
    if (!f.endsWith(".md")) continue;
    const id = f.slice(0, -3);
    const key = `command/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entryFor(id, "commands", fs.readFileSync(path.join(COMMANDS_DIR, f), "utf8")));
  }
}

// Curated first so it wins on any id collision, then the auto-vendored tree.
if (fs.existsSync(CURATED_DIR)) walkSkills(CURATED_DIR, CURATED_DIR);
if (fs.existsSync(SKILLS_DIR)) walkSkills(SKILLS_DIR, SKILLS_DIR);
walkCommands();

fs.writeFileSync(OUT, renderModule(entries));
const byKind = entries.reduce((m, e) => ((m[e.kind] = (m[e.kind] || 0) + 1), m), {});
console.log(`[gen-skills] wrote ${OUT} — ${entries.length} generated (${JSON.stringify(byKind)}) + 4 prompts`);

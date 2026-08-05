// scripts/gen-skills.mjs — scan the WIDE skill roster (curated → ~/.claude/skills →
// ~/.claude/plugins → WaahyuTools repos → vendored fallback) and emit two views of the
// same scan: src/data/skills.gen.json (the roster artifact) and src/lib/missionSkills.ts
// (what the app imports). Every root is optional; a machine with none of them still
// generates from the repo-vendored .claude/skills tree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryFor, renderModule } from "./lib/skills-gen.mjs";
import { parseToolRepos, dedupeRoster, rosterJson, countBySource } from "./lib/skills-roster.mjs";
import { scanRoots, discoverRoots } from "./lib/skills-scan.mjs";

const ROOT = process.cwd();
const HOME = os.homedir();
const TOOLS_DIR = process.env.MA_TOOLS_DIR || path.join(HOME, "Downloads", "WaahyuFOLDER", "WaahyuTools");
const COMMANDS_DIR = path.join(ROOT, ".claude", "commands");
const OUT_TS = path.join(ROOT, "src", "lib", "missionSkills.ts");
const OUT_JSON = path.join(ROOT, "src", "data", "skills.gen.json");

// 1. WaahyuTools repo roster comes from ~/.claude/CLAUDE.md (single source of truth).
let claudeMd = "";
try { claudeMd = fs.readFileSync(path.join(HOME, ".claude", "CLAUDE.md"), "utf8"); } catch { /* optional */ }
const toolRepos = parseToolRepos(claudeMd);

// 2. Scan every root, then collapse to one row per skill id (first source wins).
const roster = dedupeRoster(scanRoots(discoverRoots({ homeDir: HOME, toolsDir: TOOLS_DIR, repoDir: ROOT, toolRepos })));

// 3. Commands stay repo-local (they are vendored markdown files, not skill dirs).
const commands = [];
if (fs.existsSync(COMMANDS_DIR)) {
  for (const f of fs.readdirSync(COMMANDS_DIR).sort()) {
    if (!f.endsWith(".md")) continue;
    commands.push(entryFor(f.slice(0, -3), "commands", fs.readFileSync(path.join(COMMANDS_DIR, f), "utf8")));
  }
}

// 4. Emit both views.
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, rosterJson(roster));

const skillEntries = roster.map((r) => ({
  id: r.id, kind: "skill", family: r.family, source: r.source,
  title: `/${r.id}`, hint: r.description || r.id, prompt: `Use the ${r.id} skill. `,
}));
fs.writeFileSync(OUT_TS, renderModule([...skillEntries, ...commands]));

const bySource = countBySource(roster);
console.log(`[gen-skills] ${OUT_JSON} — ${roster.length} skills across ${Object.keys(bySource).length} sources`);
console.log(`[gen-skills] ${OUT_TS} — ${skillEntries.length} skills + ${commands.length} commands + 4 prompts`);
console.log(`[gen-skills] per-source: ${JSON.stringify(bySource)}`);
if (roster.length < 1800) console.warn(`[gen-skills] WARNING: only ${roster.length} skills found — check ~/.claude and ${TOOLS_DIR}`);

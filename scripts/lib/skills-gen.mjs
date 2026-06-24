// Pure helpers for the C2 catalog generator. No fs side effects — unit-tested in
// scripts/lib/__tests__/skills-gen.test.mjs.

const UIUX_EXACT = new Set([
  "impeccable", "hallmark", "soft-skill", "minimalist-skill", "brutalist-skill",
  "frontend-design", "web-artifacts-builder", "canvas-design", "algorithmic-art",
  "imagegen-frontend-mobile", "imagegen-frontend-web", "brandkit", "brand-guidelines",
  "applying-brand-guidelines", "output-skill", "stitch-skill", "redesign-skill",
  "image-to-code-skill", "theme-factory",
]);
const HYPERFRAMES_EXACT = new Set([
  "gsap", "animejs", "lottie", "three", "typegpu", "waapi", "css-animations", "tailwind", "contribute-catalog",
]);
const PLUGINDEV_EXACT = new Set([
  "plugin-structure", "plugin-settings", "command-development", "hook-development",
  "skill-development", "skill-creator", "agent-development", "example-command", "example-skill",
]);
const DOCS_EXACT = new Set(["pdf", "docx", "pptx", "xlsx"]);
const CLAUDEMEM_EXACT = new Set([
  "babysit", "do", "how-it-works", "knowledge-agent", "learn-codebase", "make-plan",
  "mem-search", "pathfinder", "smart-explore", "timeline-report", "version-bump", "wowerpoint",
]);
const MAX_HINT = 80;

/** Pure: assign a CLAUDE.md family from an id + its source dir. Prefix rules win over sourceDir. */
export function familyOf(id, sourceDir) {
  if (id.startsWith("sp-")) return "sp · workflow";
  if (id.startsWith("ecc/")) return "ecc";
  if (id.startsWith("composio-")) return "integrations";
  if (id.startsWith("legal-")) return "legal";
  if (id.startsWith("fs-")) return "finance";
  if (id.startsWith("kw-engineering-")) return "engineering";
  if (id.startsWith("kw-data-")) return "data";
  if (id.startsWith("kw-sales-")) return "sales";
  if (id.startsWith("kw-marketing-")) return "marketing";
  if (id.startsWith("kw-finance-")) return "finance";
  if (id.startsWith("kw-human-resources-")) return "hr";
  if (id.startsWith("kw-product-management-")) return "product";
  if (id.startsWith("kw-customer-support-")) return "support";
  if (id.startsWith("kw-operations-")) return "operations";
  if (id.startsWith("kw-design-")) return "ui/ux";
  if (id.startsWith("kw-legal-")) return "legal";
  if (id.startsWith("kw-")) return "knowledge-work";
  if (id.startsWith("acs-")) return "community";
  if (id === "gstack" || id.startsWith("gstack/") || id.startsWith("gstack-")) return "gstack";
  if (id.startsWith("hyperframes") || id.startsWith("website-to-") || id.startsWith("remotion-to-")) return "hyperframes";
  if (HYPERFRAMES_EXACT.has(id)) return "hyperframes";
  if (id.startsWith("build-mcp") || id === "mcp-builder" || id === "mcp-integration") return "mcp";
  if (PLUGINDEV_EXACT.has(id)) return "plugin-dev";
  if (DOCS_EXACT.has(id)) return "documents";
  if (CLAUDEMEM_EXACT.has(id)) return "claude-mem";
  if (id.startsWith("discord-") || id.startsWith("imessage-") || id.startsWith("telegram-") || id === "slack" || id === "slack-gif-creator") return "integrations";
  if (id.startsWith("emil-") || id.startsWith("taste") || id.startsWith("gpt-taste")) return "ui/ux";
  if (UIUX_EXACT.has(id)) return "ui/ux";
  if (id === "caveman" || id === "cavecrew" || id.startsWith("caveman-")) return "caveman";
  if (id === "headroom") return "headroom";
  if (id === "graphify") return "graphify";
  if (sourceDir === "commands") return "commands";
  return "misc";
}

/** Pure: parse a leading YAML frontmatter block into a flat {key:value} map. Handles single-line
 *  values and folded/literal block scalars (`key: >` / `key: |` followed by indented lines). */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(lines[i]);
    if (!kv || kv[1] in out) continue;
    let val = kv[2].trim();
    if (val === ">" || val === "|" || val === ">-" || val === "|-") {
      // Block scalar: collect subsequent indented lines until a dedent / next key.
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        block.push(lines[++i].trim());
      }
      val = block.join(" ").trim();
    }
    out[kv[1]] = val.replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/** Pure: derive a short hint from a skill/command's description; fall back to id. */
export function hintFrom(text, id) {
  const desc = parseFrontmatter(text).description || "";
  if (!desc) return id;
  const firstSentence = desc.split(/\.(\s|$)/)[0].trim();
  const h = firstSentence.length > MAX_HINT ? firstSentence.slice(0, MAX_HINT - 1).trimEnd() + "…" : firstSentence;
  return h || id;
}

/** Pure: assemble a MissionSkill from an id, source dir, and raw md text. */
export function entryFor(id, sourceDir, rawMd) {
  const kind = sourceDir === "commands" ? "command" : "skill";
  const family = familyOf(id, sourceDir);
  const hint = hintFrom(rawMd, id);
  const prompt = kind === "command" ? `/${id} ` : `Use the ${id} skill. `;
  return { id, kind, family, title: `/${id}`, hint, prompt };
}

const PROMPTS = [
  { id: "standup", family: "prompts", hint: "what each agent did + blockers", prompt: "Give me a standup: for each agent, one line on what it did this cycle and its current state. List anything blocked and who/what it's waiting on. Be terse." },
  { id: "review", family: "prompts", hint: "review current diffs + risks", prompt: "Review the current proposed changes across the agents' worktrees. Flag correctness bugs, security issues, and anything risky before I apply. Be specific (file + why)." },
  { id: "unblock", family: "prompts", hint: "find blocked agents + fix", prompt: "Which agents are blocked or stale right now? For each, give the root cause and the single next action to unblock it." },
  { id: "ship", family: "prompts", hint: "run build + tests, report", prompt: "Run the build and the test suite. Report green/red with the exact failing tests if any, and whether it's safe to ship. Do not commit." },
];

const j = (v) => JSON.stringify(v);

/** Pure: render the full missionSkills.ts source from generated entries. Deterministic (sort family→id). */
export function renderModule(generated) {
  const sorted = [...generated].sort((a, b) =>
    a.family < b.family ? -1 : a.family > b.family ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const promptLines = PROMPTS.map((p) =>
    `  { id: ${j(p.id)}, kind: "prompt", family: ${j(p.family)}, title: ${j("/" + p.id)}, hint: ${j(p.hint)}, prompt: ${j(p.prompt)} },`,
  ).join("\n");
  const genLines = sorted.map((e) =>
    `  { id: ${j(e.id)}, kind: ${j(e.kind)}, family: ${j(e.family)}, title: ${j(e.title)}, hint: ${j(e.hint)}, prompt: ${j(e.prompt)} },`,
  ).join("\n");
  return `// AUTO-GENERATED by scripts/gen-skills.mjs — DO NOT EDIT BY HAND.
// Run \`npm run gen:skills\` to regenerate from the local .claude/ catalog.
import { fuzzyScore } from "./paletteCommands.ts";

export type SkillKind = "prompt" | "skill" | "command";

export interface MissionSkill {
  id: string;
  title: string;
  hint: string;
  prompt: string;
  kind: SkillKind;
  family: string;
}

// Hand-curated app prompt templates (preserved across regenerations).
const PROMPT_SKILLS: MissionSkill[] = [
${promptLines}
];

// Generated from .claude/skills + .claude/commands (sorted family→id).
const GENERATED: MissionSkill[] = [
${genLines}
];

export const MISSION_SKILLS: readonly MissionSkill[] = [...PROMPT_SKILLS, ...GENERATED];

export const KIND_LABEL: Record<SkillKind, string> = { prompt: "Prompts", command: "Commands", skill: "Skills" };
const KINDS: SkillKind[] = ["prompt", "command", "skill"];

export function filterSkills(query: string): MissionSkill[] {
  const q = query.trim();
  if (!q) return [...MISSION_SKILLS];
  const scored = MISSION_SKILLS
    .map((s) => ({ s, score: Math.max(fuzzyScore(q, s.id), fuzzyScore(q, s.title), fuzzyScore(q, s.hint)) }))
    .filter((x) => x.score >= 0);
  const groups = KINDS
    .map((k) => scored.filter((x) => x.s.kind === k).sort((a, b) => b.score - a.score))
    .filter((g) => g.length > 0);
  groups.sort((a, b) => b[0].score - a[0].score);
  return groups.flatMap((g) => g.map((x) => x.s));
}
`;
}

// MissionAlpha's "/" skills — two kinds, one menu:
//  • kind "prompt"  — app prompt templates (Cursor-style custom commands).
//  • kind "skill"   — the curated Claude skills installed in .claude/skills/ that the
//                     swarm auto-invokes; the "/" entry is a manual nudge to apply one.
// Picking either drops its prompt into the composer; the BOSS edits, then sends.

import { fuzzyScore } from "./paletteCommands.ts";

export type SkillKind = "prompt" | "skill" | "command";

export interface MissionSkill {
  id: string; // the "/name"
  title: string;
  hint: string;
  prompt: string;
  kind: SkillKind;
}

// App prompt templates (do not depend on any installed skill). (/plan lives as an
// installed command instead — richer.)
const PROMPT_SKILLS: MissionSkill[] = [
  { id: "standup", kind: "prompt", title: "/standup", hint: "what each agent did + blockers", prompt: "Give me a standup: for each agent, one line on what it did this cycle and its current state. List anything blocked and who/what it's waiting on. Be terse." },
  { id: "review", kind: "prompt", title: "/review", hint: "review current diffs + risks", prompt: "Review the current proposed changes across the agents' worktrees. Flag correctness bugs, security issues, and anything risky before I apply. Be specific (file + why)." },
  { id: "unblock", kind: "prompt", title: "/unblock", hint: "find blocked agents + fix", prompt: "Which agents are blocked or stale right now? For each, give the root cause and the single next action to unblock it." },
  { id: "ship", kind: "prompt", title: "/ship", hint: "run build + tests, report", prompt: "Run the build and the test suite. Report green/red with the exact failing tests if any, and whether it's safe to ship. Do not commit." },
];

// Installed Claude Code slash commands in .claude/commands/ — picking sends the
// literal "/cmd" so the swarm's claude run invokes it. (git ones write — BOSS-only.)
const COMMAND_PAIRS: [string, string][] = [
  ["plan", "implementation plan (wait for confirm)"],
  ["code-review", "quality code review"],
  ["build-fix", "fix build/type errors"],
  ["quality-gate", "quality gate check"],
  ["refactor-clean", "behavior-preserving refactor"],
  ["feature-dev", "feature dev end-to-end"],
  ["test-coverage", "test coverage report"],
  ["security-scan", "security scan"],
  ["checkpoint", "create/verify checkpoint"],
  ["save-session", "save session"],
  ["resume-session", "resume session"],
  ["learn", "extract patterns from session"],
  ["learn-eval", "evaluate a learning"],
  ["skill-create", "generate a skill"],
  ["hookify", "configure hooks"],
  ["hookify-configure", "hooks config"],
  ["hookify-list", "list hooks"],
  ["model-route", "recommend model tier"],
  ["model-check", "check Claude model names"],
  // React (this app's stack)
  ["react-build", "fix React build"],
  ["react-test", "React TDD tests"],
  ["react-review", "React code review"],
  ["vue-review", "Vue review"],
  ["fastapi-review", "FastAPI review"],
  ["python-review", "Python review"],
  // other languages (not this app's stack — installed on request)
  ["go-build", "Go build"], ["go-test", "Go test"], ["go-review", "Go review"],
  ["rust-build", "Rust build"], ["rust-test", "Rust test"], ["rust-review", "Rust review"],
  ["kotlin-build", "Kotlin build"], ["kotlin-test", "Kotlin test"],
  ["flutter-build", "Flutter build"], ["flutter-test", "Flutter test"],
  ["cpp-build", "C++ build"], ["cpp-test", "C++ test"],
  // orchestration / multi-model / GAN / loops
  ["orch-build-mvp", "orchestrate MVP build"],
  ["orch-add-feature", "orchestrate feature add"],
  ["orch-fix-defect", "orchestrate bug fix"],
  ["orch-change-feature", "orchestrate feature change"],
  ["orch-refine-code", "orchestrate refactor"],
  ["multi-plan", "multi-model plan"],
  ["multi-execute", "multi-model execute"],
  ["multi-frontend", "multi-model frontend"],
  ["multi-backend", "multi-model backend"],
  ["multi-workflow", "multi-model workflow"],
  ["gan-build", "GAN generator/evaluator build"],
  ["gan-design", "GAN design loop"],
  ["loop-start", "start autonomous loop"],
  ["loop-status", "loop status"],
  ["santa-loop", "santa loop"],
  // git (these WRITE — BOSS-only)
  ["pr", "create GitHub PR (writes)"],
  ["review-pr", "review a PR"],
  ["commit", "git commit (writes)"],
  ["commit-push-pr", "commit + push + PR (writes)"],
  // finance (not this app's domain — installed on request)
  ["dcf", "DCF model"], ["lbo", "LBO model"], ["comps", "comps analysis"],
  ["earnings", "earnings analysis"], ["ic-memo", "IC memo"],
];
const COMMAND_SKILLS: MissionSkill[] = COMMAND_PAIRS.map(([id, hint]) => ({
  id, kind: "command" as const, title: `/${id}`, hint, prompt: `/${id} `,
}));

// Curated skills installed in .claude/skills/ (kept in sync with what was installed).
// Picking one nudges the swarm to apply that skill to the work in hand.
// Superpowers pipeline (14) — exact sp-* names matching CLAUDE.md.
const SP_SKILLS: MissionSkill[] = ([
  ["sp-using-superpowers", "start of every coding task"],
  ["sp-brainstorming", "new feature / build X / add X"],
  ["sp-writing-plans", "have spec → before code"],
  ["sp-executing-plans", "have plan → implement"],
  ["sp-test-driven-development", "before writing impl code"],
  ["sp-dispatching-parallel-agents", "2+ independent tasks"],
  ["sp-subagent-driven-development", "independent tasks in session"],
  ["sp-systematic-debugging", "bug / error / not working"],
  ["sp-using-git-worktrees", "isolate before execution"],
  ["sp-verification-before-completion", "before claiming done"],
  ["sp-finishing-a-development-branch", "impl complete, tests pass"],
  ["sp-requesting-code-review", "before merge / review this"],
  ["sp-receiving-code-review", "got review feedback"],
  ["sp-writing-skills", "creating / editing skills"],
] as [string, string][]).map(([id, hint]) => ({ id, kind: "skill" as const, title: `/${id}`, hint, prompt: `Use the ${id.replace(/^sp-/, "")} skill. ` }));

// Dev / design / quality skills (curated, kept on short aliases).
const DEV_SKILLS: MissionSkill[] = [
  { id: "impeccable", kind: "skill", title: "/impeccable", hint: "impeccable (UI craft)", prompt: "Apply the impeccable skill: design/build this UI to a high craft + polish bar (typography, spacing, motion, a11y)." },
  { id: "hallmark", kind: "skill", title: "/hallmark", hint: "hallmark (anti-slop UI)", prompt: "Apply the hallmark skill: make this UI look made, not generated — structural variety, no template/AI-default look." },
  { id: "taste", kind: "skill", title: "/taste", hint: "design-taste-frontend", prompt: "Apply the design-taste-frontend skill: ship an anti-slop, intentional interface (real design direction, no template look)." },
  { id: "coding-standards", kind: "skill", title: "/coding-standards", hint: "coding-standards", prompt: "Apply the coding-standards skill: enforce KISS/DRY/immutability, small files/functions, clear errors. Flag violations." },
  { id: "api-design", kind: "skill", title: "/api-design", hint: "api-design", prompt: "Use the api-design skill to design/review this API (REST/contract, versioning, errors, DX)." },
  { id: "e2e", kind: "skill", title: "/e2e", hint: "e2e-testing", prompt: "Use the e2e-testing skill: generate and run end-to-end tests for the critical user flow." },
  { id: "error-handling", kind: "skill", title: "/error-handling", hint: "error-handling", prompt: "Apply the error-handling skill: handle errors explicitly at every level — no silent failures or swallowed errors." },
  { id: "security-review", kind: "skill", title: "/security-review", hint: "security-review", prompt: "Run the security-review skill over the current changes: OWASP, injection, secrets, authz. Report findings by severity." },
  { id: "introspect", kind: "skill", title: "/introspect", hint: "agent-introspection-debugging", prompt: "Use agent-introspection-debugging to inspect why an agent is behaving unexpectedly and report the cause." },
  { id: "verify-loop", kind: "skill", title: "/verify-loop", hint: "verification-loop", prompt: "Use the verification-loop skill: validate the implementation against the requirements in a tight check loop." },
  { id: "tdd-workflow", kind: "skill", title: "/tdd-workflow", hint: "tdd-workflow", prompt: "Use the tdd-workflow skill to drive this feature red→green→refactor with coverage." },
];

// Agent authoring skills.
const AGENT_SKILLS: MissionSkill[] = ([
  ["agent-development", "create / edit a subagent"],
  ["agent-development-plugindev", "plugin-dev agent authoring"],
] as [string, string][]).map(([id, hint]) => ({ id, kind: "skill" as const, title: `/${id}`, hint, prompt: `Use the ${id} skill. ` }));

// Anthropic official skills (17) installed in .claude/skills/ — auto-trigger by topic.
const ANTHROPIC_SKILLS: MissionSkill[] = ([
  ["frontend-design", "UI / React / landing page"],
  ["web-artifacts-builder", "complex HTML / shadcn artifact"],
  ["webapp-testing", "test a web app (Playwright)"],
  ["claude-api", "Anthropic SDK / model migration"],
  ["mcp-builder", "build an MCP server"],
  ["skill-creator", "create / edit a skill"],
  ["doc-coauthoring", "write docs / spec / proposal"],
  ["theme-factory", "apply a theme to an artifact"],
  ["canvas-design", "poster / PNG-PDF graphic"],
  ["brand-guidelines", "Anthropic brand styling"],
  ["algorithmic-art", "p5.js / generative art"],
  ["internal-comms", "status report / newsletter"],
  ["docx", "Word .docx"],
  ["pdf", "create / read / fill PDF"],
  ["pptx", "PowerPoint deck"],
  ["xlsx", "Excel / CSV / tabular data"],
  ["slack-gif-creator", "animated GIF for Slack"],
] as [string, string][]).map(([id, hint]) => ({ id, kind: "skill" as const, title: `/${id}`, hint, prompt: `Use the ${id} skill. ` }));

export const MISSION_SKILLS: readonly MissionSkill[] = [
  ...PROMPT_SKILLS, ...COMMAND_SKILLS, ...SP_SKILLS, ...DEV_SKILLS, ...ANTHROPIC_SKILLS, ...AGENT_SKILLS,
];

export const KIND_LABEL: Record<SkillKind, string> = { prompt: "Prompts", command: "Commands", skill: "Skills" };
const KINDS: SkillKind[] = ["prompt", "command", "skill"];

/**
 * Filter skills against the text typed after "/" (case-insensitive fuzzy). Results
 * stay grouped by kind (so the menu can render section headers), but the GROUP with
 * the strongest match floats to the top, and within a group it's best-match-first —
 * so an exact match always wins regardless of kind.
 */
export function filterSkills(query: string): MissionSkill[] {
  const q = query.trim();
  if (!q) return [...MISSION_SKILLS]; // already in prompt→command→skill order
  const scored = MISSION_SKILLS
    .map((s) => ({ s, score: Math.max(fuzzyScore(q, s.id), fuzzyScore(q, s.title), fuzzyScore(q, s.hint)) }))
    .filter((x) => x.score >= 0);
  const groups = KINDS
    .map((k) => scored.filter((x) => x.s.kind === k).sort((a, b) => b.score - a.score))
    .filter((g) => g.length > 0);
  groups.sort((a, b) => b[0].score - a[0].score); // strongest group first
  return groups.flatMap((g) => g.map((x) => x.s));
}

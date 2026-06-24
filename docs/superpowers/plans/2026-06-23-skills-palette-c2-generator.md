# C2 — Catalog Generator → `missionSkills.ts` (+ `family`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development /
> superpowers:executing-plans. Steps use `- [ ]`. TDD: RED → GREEN → commit.

**Goal:** A re-runnable generator (`scripts/gen-skills.mjs`, `npm run gen:skills`) scans the LOCAL
`.claude/skills` + `.claude/commands`, and rewrites `src/lib/missionSkills.ts` with one entry per
skill/command — `{ id, kind, family, title:"/id", hint, prompt }` — adding a `family` field to
`MissionSkill`, preserving the 4 hand-curated prompt entries, deterministic (sort family→id).

**Architecture:** Pure, unit-tested helpers in `scripts/lib/skills-gen.mjs`
(`familyOf`, `parseFrontmatter`, `hintFrom`, `entryFor`, `renderModule`) drive a thin fs walk in
`scripts/gen-skills.mjs`. The emitted `missionSkills.ts` keeps the existing public API
(`MissionSkill`, `MISSION_SKILLS`, `KIND_LABEL`, `filterSkills`) and ADDS `family`. The 4 prompt
entries are embedded as a constant in the generated file (single source of truth = generator).

**Tech Stack:** Node 22 ESM (`.mjs`), `node:fs/path`, `node:test`. Emitted file is TypeScript.

---

## Recon facts (measured 2026-06-23)

- A "skill" = any directory containing `SKILL.md` at any depth under `.claude/skills` (e.g. `ecc/` is a
  container with **198** sub-skills `ecc/<name>/SKILL.md`; it has no top-level SKILL.md).
- `.claude/commands` = 178 flat `*.md`; id = basename without `.md`.
- Frontmatter `description:` present in 1438/1439 skills + 177/178 commands → `hint` source (fallback: id).
- id = **directory path relative to skills root** (NOT frontmatter `name`, which can differ —
  `kw-engineering-code-review`'s frontmatter `name` is `code-review`).
- Cross-kind id collisions = **2** (`learn`, `example-command`) → uniqueness invariant is `${kind}/${id}`,
  NOT bare id. C3 React key = `${kind}:${id}`.
- Family prefixes: composio 832, legal 151, kw 141, fs 117, ecc 198(sub), sp 14, acs 28.
- ⚠ Existing `missionSkills.test.ts` hardcodes `4+61+44=109` + unique bare ids → both rewritten in Task 6.

---

## File Structure

- Create: `scripts/lib/skills-gen.mjs` — pure helpers (familyOf, parseFrontmatter, hintFrom, entryFor, renderModule).
- Create: `scripts/lib/__tests__/skills-gen.test.mjs` — unit tests for the pure helpers.
- Create: `scripts/gen-skills.mjs` — fs walk + write `src/lib/missionSkills.ts`.
- Modify: `package.json` — add `"gen:skills"`.
- Rewrite (generated): `src/lib/missionSkills.ts` — adds `family`, full catalog, keeps public API.
- Rewrite: `src/lib/__tests__/missionSkills.test.ts` — new invariants (family non-empty, prompts
  preserved, `${kind}/${id}` unique, deterministic, count ≈ source).

---

## Task 1: `familyOf(id, sourceDir)` — pure family mapping

**Files:** Create `scripts/lib/skills-gen.mjs`; Test `scripts/lib/__tests__/skills-gen.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/lib/__tests__/skills-gen.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { familyOf } from "../skills-gen.mjs";

test("familyOf maps the PRD-named families", () => {
  assert.equal(familyOf("sp-writing-plans", "skills"), "sp · workflow");
  assert.equal(familyOf("kw-engineering-code-review", "skills"), "engineering");
  assert.equal(familyOf("kw-design-accessibility-review", "skills"), "ui/ux");
  assert.equal(familyOf("impeccable", "skills"), "ui/ux");
  assert.equal(familyOf("hallmark", "skills"), "ui/ux");
  assert.equal(familyOf("emil-design-eng", "skills"), "ui/ux");
  assert.equal(familyOf("taste-skill", "skills"), "ui/ux");
  assert.equal(familyOf("legal-commercial-legal-review", "skills"), "legal");
  assert.equal(familyOf("fs-pitch-agent-dcf-model", "skills"), "finance");
  assert.equal(familyOf("composio-slack-automation", "skills"), "integrations");
  assert.equal(familyOf("ecc/agent-sort", "skills"), "ecc");
  assert.equal(familyOf("totally-unknown-thing", "skills"), "misc");
});

test("familyOf maps extended kw sub-families", () => {
  assert.equal(familyOf("kw-data-write-query", "skills"), "data");
  assert.equal(familyOf("kw-sales-call-prep", "skills"), "sales");
  assert.equal(familyOf("kw-marketing-seo-audit", "skills"), "marketing");
  assert.equal(familyOf("kw-finance-journal-entry", "skills"), "finance");
  assert.equal(familyOf("kw-human-resources-onboarding", "skills"), "hr");
  assert.equal(familyOf("kw-product-management-write-spec", "skills"), "product");
  assert.equal(familyOf("kw-customer-support-draft-response", "skills"), "support");
  assert.equal(familyOf("kw-operations-runbook", "skills"), "operations");
  assert.equal(familyOf("kw-legal-brief", "skills"), "legal");
  assert.equal(familyOf("acs-artifacts-builder", "skills"), "community");
  assert.equal(familyOf("kw-bio-research-start", "skills"), "knowledge-work");
});

test("familyOf groups commands without a known prefix under 'commands'", () => {
  assert.equal(familyOf("build-fix", "commands"), "commands");
  assert.equal(familyOf("dcf", "commands"), "finance"); // prefix-less but mapped? no -> commands
  assert.equal(familyOf("sp-writing-plans", "commands"), "sp · workflow"); // prefix wins over sourceDir
});
```

> Note: `dcf` has no mapped prefix → expected `commands`. Fix that assertion to
> `assert.equal(familyOf("dcf", "commands"), "commands");` before running (kept here to flag the rule:
> **prefix rules win; otherwise commands→"commands", skills→"misc"**).

- [ ] **Step 2: Run → FAIL** (`familyOf is not a function`)

Run: `cd ~/Downloads/WaahyuFOLDER/MissonAlpha && node --test scripts/lib/__tests__/skills-gen.test.mjs`

- [ ] **Step 3: Implement**

```js
// scripts/lib/skills-gen.mjs
const UIUX_EXACT = new Set(["impeccable", "hallmark", "soft-skill", "minimalist-skill", "brutalist-skill"]);

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
  if (id.startsWith("emil-") || id.startsWith("taste") || id.startsWith("gpt-taste")) return "ui/ux";
  if (UIUX_EXACT.has(id)) return "ui/ux";
  if (sourceDir === "commands") return "commands";
  return "misc";
}
```

- [ ] **Step 4: Fix the `dcf` assertion to expect `"commands"`, run → PASS**

Run: `node --test scripts/lib/__tests__/skills-gen.test.mjs`  → Expected PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/skills-gen.mjs scripts/lib/__tests__/skills-gen.test.mjs
git commit -m "feat(c2): add pure familyOf mapping with unit tests"
```

---

## Task 2: `parseFrontmatter` + `hintFrom` — extract description

**Files:** Modify `scripts/lib/skills-gen.mjs`; append tests

- [ ] **Step 1: Failing test** (append)

```js
import { parseFrontmatter, hintFrom } from "../skills-gen.mjs";

const FM = `---
name: impeccable
description: Use when the user wants to design, redesign, or polish a UI. Covers websites and dashboards.
version: 3.1.1
---
Body text here.`;

test("parseFrontmatter reads key/values from YAML block", () => {
  const fm = parseFrontmatter(FM);
  assert.equal(fm.name, "impeccable");
  assert.match(fm.description, /^Use when the user wants to design/);
});

test("parseFrontmatter returns {} when no frontmatter", () => {
  assert.deepEqual(parseFrontmatter("# Just a heading\nno fm"), {});
});

test("hintFrom prefers description first sentence, truncated, falls back to id", () => {
  assert.equal(hintFrom(FM, "impeccable"), "Use when the user wants to design, redesign, or polish a UI");
  assert.equal(hintFrom("# no fm", "my-skill"), "my-skill");
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** (append to `skills-gen.mjs`)

```js
const MAX_HINT = 80;

/** Pure: parse a leading YAML frontmatter block into a flat {key:value} map (single-line values). */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (kv && !(kv[1] in out)) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
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
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/skills-gen.mjs scripts/lib/__tests__/skills-gen.test.mjs
git commit -m "feat(c2): add frontmatter parser + hint extraction with unit tests"
```

---

## Task 3: `entryFor` — build one MissionSkill record

**Files:** Modify `scripts/lib/skills-gen.mjs`; append tests

- [ ] **Step 1: Failing test** (append)

```js
import { entryFor } from "../skills-gen.mjs";

test("entryFor builds a skill record (prompt = Use the <id> skill.)", () => {
  const e = entryFor("impeccable", "skills", "---\ndescription: Polish the UI well.\n---\n");
  assert.deepEqual(e, {
    id: "impeccable", kind: "skill", family: "ui/ux",
    title: "/impeccable", hint: "Polish the UI well", prompt: "Use the impeccable skill. ",
  });
});

test("entryFor builds a command record (prompt = literal /id)", () => {
  const e = entryFor("build-fix", "commands", "---\ndescription: Fix build errors.\n---\n");
  assert.equal(e.kind, "command");
  assert.equal(e.family, "commands");
  assert.equal(e.prompt, "/build-fix ");
  assert.equal(e.title, "/build-fix");
});

test("entryFor keeps nested ecc id + family", () => {
  const e = entryFor("ecc/agent-sort", "skills", "---\ndescription: Sort agents.\n---\n");
  assert.equal(e.family, "ecc");
  assert.equal(e.title, "/ecc/agent-sort");
  assert.equal(e.prompt, "Use the ecc/agent-sort skill. ");
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** (append)

```js
/** Pure: assemble a MissionSkill from an id, source dir, and raw md text. */
export function entryFor(id, sourceDir, rawMd) {
  const kind = sourceDir === "commands" ? "command" : "skill";
  const family = familyOf(id, sourceDir);
  const hint = hintFrom(rawMd, id);
  const prompt = kind === "command" ? `/${id} ` : `Use the ${id} skill. `;
  return { id, kind, family, title: `/${id}`, hint, prompt };
}
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/skills-gen.mjs scripts/lib/__tests__/skills-gen.test.mjs
git commit -m "feat(c2): add entryFor record builder with unit tests"
```

---

## Task 4: `renderModule` — emit deterministic TypeScript

**Files:** Modify `scripts/lib/skills-gen.mjs`; append tests

- [ ] **Step 1: Failing test** (append)

```js
import { renderModule } from "../skills-gen.mjs";

test("renderModule emits sorted (family→id) catalog + keeps prompts first", () => {
  const generated = [
    { id: "zebra", kind: "skill", family: "misc", title: "/zebra", hint: "z", prompt: "Use the zebra skill. " },
    { id: "alpha", kind: "skill", family: "misc", title: "/alpha", hint: "a", prompt: "Use the alpha skill. " },
    { id: "code-review", kind: "command", family: "commands", title: "/code-review", hint: "cr", prompt: "/code-review " },
  ];
  const ts = renderModule(generated);
  assert.match(ts, /export interface MissionSkill/);
  assert.match(ts, /family: string;/);
  assert.match(ts, /family: "prompts"/);            // hand-curated prompts preserved
  assert.match(ts, /export function filterSkills/);  // public API preserved
  // deterministic: alpha before zebra within family misc
  assert.ok(ts.indexOf('"alpha"') < ts.indexOf('"zebra"'));
  // running twice = identical
  assert.equal(renderModule(generated), ts);
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** (append). `renderModule` returns the full file text: the 4 prompt
constants, the sorted generated array, the `MissionSkill` interface WITH `family`, `KIND_LABEL`,
and an UNCHANGED `filterSkills` (copied verbatim from the current file).

```js
const PROMPTS = [
  { id: "standup", family: "prompts", hint: "what each agent did + blockers", prompt: "Give me a standup: for each agent, one line on what it did this cycle and its current state. List anything blocked and who/what it's waiting on. Be terse." },
  { id: "review", family: "prompts", hint: "review current diffs + risks", prompt: "Review the current proposed changes across the agents' worktrees. Flag correctness bugs, security issues, and anything risky before I apply. Be specific (file + why)." },
  { id: "unblock", family: "prompts", hint: "find blocked agents + fix", prompt: "Which agents are blocked or stale right now? For each, give the root cause and the single next action to unblock it." },
  { id: "ship", family: "prompts", hint: "run build + tests, report", prompt: "Run the build and the test suite. Report green/red with the exact failing tests if any, and whether it's safe to ship. Do not commit." },
];

const j = (v) => JSON.stringify(v);

/** Pure: render the full missionSkills.ts source from generated entries. Deterministic. */
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
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/skills-gen.mjs scripts/lib/__tests__/skills-gen.test.mjs
git commit -m "feat(c2): add deterministic renderModule emitter with unit test"
```

---

## Task 5: `scripts/gen-skills.mjs` — fs walk + write

**Files:** Create `scripts/gen-skills.mjs`; Modify `package.json`

- [ ] **Step 1: Write the script**

```js
// scripts/gen-skills.mjs — scan local .claude/, emit src/lib/missionSkills.ts.
import fs from "node:fs";
import path from "node:path";
import { entryFor, renderModule } from "./lib/skills-gen.mjs";

const ROOT = process.cwd();
const SKILLS_DIR = path.join(ROOT, ".claude", "skills");
const COMMANDS_DIR = path.join(ROOT, ".claude", "commands");
const OUT = path.join(ROOT, "src", "lib", "missionSkills.ts");

const entries = [];
const seen = new Set(); // `${kind}/${id}` dedup

/** Recurse: any dir holding SKILL.md is a skill; id = path relative to skills root. */
function walkSkills(dir) {
  if (fs.existsSync(path.join(dir, "SKILL.md"))) {
    const id = path.relative(SKILLS_DIR, dir).split(path.sep).join("/");
    const key = `skill/${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(entryFor(id, "skills", fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")));
    }
    return; // do not descend into a skill's own subdirs
  }
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (ent.isDirectory()) walkSkills(path.join(dir, ent.name));
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

if (fs.existsSync(SKILLS_DIR)) walkSkills(SKILLS_DIR);
walkCommands();

fs.writeFileSync(OUT, renderModule(entries));
const byKind = entries.reduce((m, e) => ((m[e.kind] = (m[e.kind] || 0) + 1), m), {});
console.log(`[gen-skills] wrote ${OUT} — ${entries.length} generated (${JSON.stringify(byKind)}) + 4 prompts`);
```

- [ ] **Step 2: Add npm script** in `package.json` `"scripts"`:

```json
"gen:skills": "node scripts/gen-skills.mjs",
```

- [ ] **Step 3: Run the generator**

Run: `cd ~/Downloads/WaahyuFOLDER/MissonAlpha && npm run gen:skills`
Expected: `~1636 skill + 178 command generated + 4 prompts`.

- [ ] **Step 4: Determinism check (byte-identical on re-run)**

```bash
cp src/lib/missionSkills.ts /tmp/ms1.ts && npm run gen:skills && diff -q /tmp/ms1.ts src/lib/missionSkills.ts && echo "DETERMINISTIC OK"
```

Expected: `DETERMINISTIC OK`.

- [ ] **Step 5: Commit (generator only; generated file in Task 6)**

```bash
git add scripts/gen-skills.mjs package.json
git commit -m "feat(c2): add gen-skills generator + npm script"
```

---

## Task 6: Rewrite `missionSkills.test.ts` for the generated catalog + typecheck

**Files:** Rewrite `src/lib/__tests__/missionSkills.test.ts`

- [ ] **Step 1: Replace the test file** (new invariants — no brittle exact counts)

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MISSION_SKILLS, filterSkills, KIND_LABEL } from "../missionSkills.ts";

test("every entry has id, title '/<id>', hint, prompt, valid kind, non-empty family", () => {
  for (const s of MISSION_SKILLS) {
    assert.equal(s.title, `/${s.id}`);
    assert.ok(s.hint.length > 0, `empty hint: ${s.id}`);
    assert.ok(s.prompt.length > 0, `empty prompt: ${s.id}`);
    assert.ok(["prompt", "skill", "command"].includes(s.kind));
    assert.ok(s.family.length > 0, `empty family: ${s.id}`);
  }
});

test("catalog is the full vendored set (≈1,600+ entries)", () => {
  assert.ok(MISSION_SKILLS.length > 1500, `too few: ${MISSION_SKILLS.length}`);
  assert.equal(MISSION_SKILLS.filter((s) => s.kind === "prompt").length, 4);
  assert.ok(MISSION_SKILLS.filter((s) => s.kind === "skill").length > 1400);
  assert.ok(MISSION_SKILLS.filter((s) => s.kind === "command").length > 150);
});

test("hand-curated prompts preserved (family 'prompts')", () => {
  for (const id of ["standup", "review", "unblock", "ship"]) {
    const p = MISSION_SKILLS.find((s) => s.id === id && s.kind === "prompt");
    assert.ok(p, `missing prompt: ${id}`);
    assert.equal(p.family, "prompts");
  }
});

test("families assigned correctly for representative ids", () => {
  const fam = (id) => MISSION_SKILLS.find((s) => s.id === id)?.family;
  assert.equal(fam("sp-writing-plans"), "sp · workflow");
  assert.equal(fam("impeccable"), "ui/ux");
  assert.equal(fam("kw-engineering-code-review"), "engineering");
});

test("entries are unique by kind/id (cross-kind dupes like 'learn' allowed)", () => {
  const keys = MISSION_SKILLS.map((s) => `${s.kind}/${s.id}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("command entries inject the literal /cmd", () => {
  const cr = MISSION_SKILLS.find((s) => s.id === "code-review" && s.kind === "command");
  assert.equal(cr?.prompt, "/code-review ");
});

test("filterSkills returns all on empty query and ranks obvious matches", () => {
  assert.equal(filterSkills("").length, MISSION_SKILLS.length);
  assert.equal(filterSkills("standup")[0].id, "standup");
  assert.equal(filterSkills("zzzzznotreal").length, 0);
});

test("KIND_LABEL covers all kinds", () => {
  assert.ok(KIND_LABEL.prompt && KIND_LABEL.command && KIND_LABEL.skill);
});
```

- [ ] **Step 2: Run the unit tests**

Run: `npm run test:unit 2>&1 | tail -20`
Expected: all GREEN (this file + auditModel/paletteCommands/settings/swarmGraph unaffected).

- [ ] **Step 3: Typecheck the emitted module**

Run: `npm run typecheck`
Expected: exit 0 (generated `missionSkills.ts` typechecks; `family: string` added cleanly).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit the regenerated catalog + test**

```bash
git add src/lib/missionSkills.ts src/lib/__tests__/missionSkills.test.ts
git commit -m "feat(c2): regenerate missionSkills.ts as full family-tagged catalog + update tests"
```

---

## Task 7: Reviewer gates + verification

- [ ] **Step 1: `typescript-reviewer`** — emitted `missionSkills.ts` must typecheck + match the public API
  (`MissionSkill` now has `family`; `MISSION_SKILLS`, `KIND_LABEL`, `filterSkills` unchanged signatures).
- [ ] **Step 2: `data-engineer`** — catalog shape/dedup at ~1,600 scale: confirm `${kind}/${id}`
  uniqueness, every `family` non-empty, family distribution sane (no giant "misc" tail), counts ≈ source.
- [ ] **Step 3: agent-runtime suite unaffected** — `cd agent-runtime && npm test` → 297 pass.
- [ ] **Step 4: `sp-verification-before-completion`** — all C2 acceptance bullets green.

---

## Self-Review (plan vs C2 spec)

- **Acceptance: generator rewrites missionSkills.ts, one entry per skill/command, `{id,kind,family,title,hint,prompt}`** → Tasks 3,4,5. ✔
- **Acceptance: PURE `familyOf(id, sourceDir)`, RED→GREEN** → Task 1. ✔
- **Acceptance: kind correct (command/skill); hint from description first line** → Tasks 2,3. ✔
- **Acceptance: deterministic (sort family→id), byte-identical re-run** → Task 4 + 5.4. ✔
- **Acceptance: hand-curated prompts preserved (family "prompts")** → Task 4 PROMPTS + Task 6 test. ✔
- **`family` field added to MissionSkill** → Task 4 interface. ✔
- **Agents: node-specialist (generator), typescript-reviewer (typecheck), data-engineer (dedup/scale)** → Task 7. ✔
- **No runtime fs-scan — app reads generated file only** → generator is build-time; app imports `missionSkills.ts`. ✔
- **Placeholder scan / type consistency:** helper names (`familyOf`/`parseFrontmatter`/`hintFrom`/`entryFor`/`renderModule`) consistent across tasks; `family` is `string` everywhere. ✔

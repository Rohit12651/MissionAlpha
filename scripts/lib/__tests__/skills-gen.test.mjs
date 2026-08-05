import { test } from "node:test";
import assert from "node:assert/strict";
import {
  familyOf,
  parseFrontmatter,
  hintFrom,
  entryFor,
  renderModule,
} from "../skills-gen.mjs";

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

test("familyOf: prefix rules win; otherwise commands→'commands', skills→'misc'", () => {
  assert.equal(familyOf("build-fix", "commands"), "commands");
  assert.equal(familyOf("dcf", "commands"), "commands");
  assert.equal(familyOf("sp-writing-plans", "commands"), "sp · workflow");
});

test("familyOf maps enrichment clusters (shrinks the misc tail)", () => {
  assert.equal(familyOf("gstack", "skills"), "gstack");
  assert.equal(familyOf("gstack/browse", "skills"), "gstack");
  assert.equal(familyOf("hyperframes", "skills"), "hyperframes");
  assert.equal(familyOf("gsap", "skills"), "hyperframes");
  assert.equal(familyOf("build-mcp-server", "skills"), "mcp");
  assert.equal(familyOf("mcp-builder", "skills"), "mcp");
  assert.equal(familyOf("hook-development", "skills"), "plugin-dev");
  assert.equal(familyOf("pdf", "skills"), "documents");
  assert.equal(familyOf("xlsx", "skills"), "documents");
  assert.equal(familyOf("mem-search", "skills"), "claude-mem");
  assert.equal(familyOf("discord-access", "skills"), "integrations");
  assert.equal(familyOf("slack", "skills"), "integrations");
  assert.equal(familyOf("frontend-design", "skills"), "ui/ux");
  assert.equal(familyOf("canvas-design", "skills"), "ui/ux");
  // ecc/gstack nesting precedence: ecc still wins for ecc/*
  assert.equal(familyOf("ecc/agent-sort", "skills"), "ecc");
});

test("familyOf maps curated WaahyuTools skill families", () => {
  assert.equal(familyOf("caveman", "skills"), "caveman");
  assert.equal(familyOf("cavecrew", "skills"), "caveman");
  assert.equal(familyOf("caveman-commit", "skills"), "caveman");
  assert.equal(familyOf("headroom", "skills"), "headroom");
  assert.equal(familyOf("graphify", "skills"), "graphify");
});

test("parseFrontmatter reads folded (>) block scalars", () => {
  const fm = `---
name: caveman
description: >
  Ultra-compressed communication mode. Cuts token usage ~75%
  while keeping technical accuracy.
version: 1.0.0
---
body`;
  const p = parseFrontmatter(fm);
  assert.equal(p.name, "caveman");
  assert.match(p.description, /^Ultra-compressed communication mode/);
  assert.match(p.description, /keeping technical accuracy/); // continuation joined
  assert.equal(p.version, "1.0.0"); // next key still parsed
});

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

test("entryFor builds a skill record (prompt = Use the <id> skill.)", () => {
  const e = entryFor("impeccable", "skills", "---\ndescription: Polish the UI well.\n---\n", "user");
  assert.deepEqual(e, {
    id: "impeccable", kind: "skill", family: "ui/ux", source: "user",
    title: "/impeccable", hint: "Polish the UI well", prompt: "Use the impeccable skill. ",
  });
});

test("entryFor builds a command record (prompt = literal /id)", () => {
  const e = entryFor("build-fix", "commands", "---\ndescription: Fix build errors.\n---\n");
  assert.equal(e.kind, "command");
  assert.equal(e.family, "commands");
  assert.equal(e.source, "commands");
  assert.equal(e.prompt, "/build-fix ");
  assert.equal(e.title, "/build-fix");
});

test("entryFor keeps nested ecc id + family", () => {
  const e = entryFor("ecc/agent-sort", "skills", "---\ndescription: Sort agents.\n---\n");
  assert.equal(e.family, "ecc");
  assert.equal(e.source, "user");
  assert.equal(e.title, "/ecc/agent-sort");
  assert.equal(e.prompt, "Use the ecc/agent-sort skill. ");
});

test("renderModule emits sorted (family→id) catalog + keeps prompts + public API", () => {
  const generated = [
    { id: "zebra", kind: "skill", family: "misc", source: "user", title: "/zebra", hint: "z", prompt: "Use the zebra skill. " },
    { id: "alpha", kind: "skill", family: "misc", source: "user", title: "/alpha", hint: "a", prompt: "Use the alpha skill. " },
    { id: "code-review", kind: "command", family: "commands", source: "commands", title: "/code-review", hint: "cr", prompt: "/code-review " },
  ];
  const ts = renderModule(generated);
  assert.match(ts, /export interface MissionSkill/);
  assert.match(ts, /family: string;/);
  assert.match(ts, /source: string;/);
  assert.match(ts, /family: "prompts"/);
  assert.match(ts, /export function filterSkills/);
  assert.ok(ts.indexOf('"alpha"') < ts.indexOf('"zebra"'));
  assert.equal(renderModule(generated), ts); // deterministic
});

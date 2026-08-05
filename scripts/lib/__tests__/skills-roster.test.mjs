// P1-F3 — roster generator. Pure helpers + an fs scan over a FIXTURE tree, so the test
// never depends on the developer's ~/.claude or WaahyuTools checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseToolRepos, dedupeRoster, rosterJson } from "../skills-roster.mjs";
import { scanRoots, skillIdFromRel, pluginNameFromRel } from "../skills-scan.mjs";

test("parseToolRepos reads the backticked repo roster out of CLAUDE.md", () => {
  const md = [
    "Some prose about tools.",
    "Repos (re-pulled Jul 20, 2026, 2nd sync):",
    "`taste-skill, superpowers, skills, skill, hallmark, gstack`",
    "More prose.",
  ].join("\n");
  assert.deepEqual(parseToolRepos(md), ["gstack", "hallmark", "skill", "skills", "superpowers", "taste-skill"]);
});

test("parseToolRepos returns [] when no roster line is present", () => {
  assert.deepEqual(parseToolRepos("# no roster here\njust text"), []);
});

test("parseToolRepos ignores backtick spans that are not repo lists", () => {
  assert.deepEqual(parseToolRepos("run `npm run dev` first"), []);
});

test("dedupeRoster keeps the first source per id and sorts source→id", () => {
  const rows = [
    { id: "b", name: "b", source: "user", family: "misc", description: "B" },
    { id: "a", name: "a", source: "user", family: "misc", description: "A" },
    { id: "a", name: "a", source: "tools:gstack", family: "misc", description: "dupe" },
    { id: "c", name: "c", source: "plugin:caveman", family: "caveman", description: "C" },
  ];
  const out = dedupeRoster(rows);
  // Rank order is curated → user → plugin:* → other → tools:* (see SOURCE_RANK).
  assert.deepEqual(out.map((r) => `${r.source}/${r.id}`), ["user/a", "user/b", "plugin:caveman/c"]);
});

test("rosterJson is deterministic and drops description when it equals the id", () => {
  const rows = [{ id: "x", name: "x", source: "user", family: "misc", description: "x" }];
  const a = rosterJson(rows);
  assert.equal(a, rosterJson(rows));
  assert.deepEqual(JSON.parse(a), [{ id: "x", name: "x", source: "user", family: "misc" }]);
});

test("scanRoots walks a fixture tree and labels each row with its source", () => {
  const root = mkdtempSync(join(tmpdir(), "ma-roster-"));
  try {
    const mk = (p, body) => { mkdirSync(join(root, p), { recursive: true }); writeFileSync(join(root, p, "SKILL.md"), body); };
    mk("home/skills/impeccable", "---\ndescription: Polish the UI well.\n---\n");
    mk("home/skills/nested/deep-skill", "---\ndescription: Deep one.\n---\n");
    mk("home/skills/.hidden/ignored", "---\ndescription: Should not appear.\n---\n");
    mk("plugins/caveman/skills/caveman", "---\ndescription: Compress output.\n---\n");
    mk("tools/gstack/skills/browse", "---\ndescription: Browse the web.\n---\n");

    const rows = scanRoots([
      { dir: join(root, "home", "skills"), source: "user", strip: false },
      { dir: join(root, "plugins"), sourceFn: (rel) => `plugin:${pluginNameFromRel(rel)}` },
      { dir: join(root, "tools", "gstack"), source: "tools:gstack" },
      { dir: join(root, "does", "not", "exist"), source: "tools:missing" },
    ]);

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(rows.length, 4); // the .hidden one is skipped
    assert.equal(byId["impeccable"].source, "user");
    assert.equal(byId["impeccable"].description, "Polish the UI well");
    assert.equal(byId["impeccable"].family, "ui/ux");
    assert.equal(byId["nested/deep-skill"].source, "user");
    assert.equal(byId["caveman"].source, "plugin:caveman");
    assert.equal(byId["browse"].source, "tools:gstack");
    assert.ok(!("ignored" in byId), "hidden dirs must be skipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skillIdFromRel strips packaging prefixes up to the nearest skills/ dir", () => {
  assert.equal(skillIdFromRel("impeccable"), "impeccable");
  assert.equal(skillIdFromRel("nested/deep-skill"), "nested/deep-skill");
  assert.equal(skillIdFromRel("skills/caveman"), "caveman");
  assert.equal(skillIdFromRel("plugins/superpowers/skills/sp-writing-plans"), "sp-writing-plans");
  assert.equal(skillIdFromRel("skills/ecc/agent-sort"), "ecc/agent-sort");
});

test("pluginNameFromRel picks the plugin dir, skipping the version segment", () => {
  assert.equal(pluginNameFromRel("cache/claude-code-workflows/incident-response/1.3.2/skills/postmortem-writing"), "incident-response");
  assert.equal(pluginNameFromRel("marketplaces/caveman/caveman/skills/cavecrew"), "caveman");
  assert.equal(pluginNameFromRel("skills/loose-skill"), "local");
});

test("strip:false keeps the nesting that drives familyOf (ecc/gstack taxonomy)", () => {
  const root = mkdtempSync(join(tmpdir(), "ma-roster-nest-"));
  try {
    const mk = (p) => { mkdirSync(join(root, p), { recursive: true }); writeFileSync(join(root, p, "SKILL.md"), "---\ndescription: X.\n---\n"); };
    mk("skills/ecc/agent-sort");
    mk("skills/gstack/browse");
    const rows = scanRoots([{ dir: join(root, "skills"), source: "user", strip: false }]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId["ecc/agent-sort"].family, "ecc");
    assert.equal(byId["gstack/browse"].family, "gstack");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

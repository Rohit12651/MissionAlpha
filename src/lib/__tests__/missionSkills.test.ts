import { test } from "node:test";
import assert from "node:assert/strict";
import { MISSION_SKILLS, filterSkills } from "../missionSkills.ts";

test("every skill has id, title '/<id>', hint, prompt, and a valid kind", () => {
  for (const s of MISSION_SKILLS) {
    assert.equal(s.title, `/${s.id}`);
    assert.ok(s.hint.length > 0);
    assert.ok(s.prompt.length > 0);
    assert.ok(["prompt", "skill", "command"].includes(s.kind));
  }
});

test("4 prompts + 61 commands + 44 skills = 109", () => {
  assert.equal(MISSION_SKILLS.filter((s) => s.kind === "prompt").length, 4);
  assert.equal(MISSION_SKILLS.filter((s) => s.kind === "command").length, 61);
  assert.equal(MISSION_SKILLS.filter((s) => s.kind === "skill").length, 44);
  assert.equal(MISSION_SKILLS.length, 109);
});

test("superpowers skills use exact sp-* names", () => {
  const sp = MISSION_SKILLS.filter((s) => s.id.startsWith("sp-"));
  assert.equal(sp.length, 14);
  assert.ok(sp.some((s) => s.id === "sp-test-driven-development"));
  assert.ok(sp.some((s) => s.id === "sp-finishing-a-development-branch"));
});

test("command entries inject the literal /cmd", () => {
  const cr = MISSION_SKILLS.find((s) => s.id === "code-review");
  assert.equal(cr?.kind, "command");
  assert.equal(cr?.prompt, "/code-review ");
});

test("filterSkills returns all on empty query", () => {
  assert.equal(filterSkills("").length, 109);
  assert.equal(filterSkills("   ").length, 109);
});

test("filterSkills ranks obvious matches first (all kinds)", () => {
  assert.equal(filterSkills("stand")[0].id, "standup");
  assert.equal(filterSkills("security-review")[0].id, "security-review");
  assert.equal(filterSkills("tdd-workflow")[0].id, "tdd-workflow");
  assert.equal(filterSkills("build-fix")[0].id, "build-fix");
});

test("filterSkills excludes non-matches", () => {
  assert.equal(filterSkills("zzzzz").length, 0);
});

test("ids are unique", () => {
  const ids = MISSION_SKILLS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

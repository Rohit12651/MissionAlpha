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
    assert.equal(p!.family, "prompts");
  }
});

test("families assigned correctly for representative ids", () => {
  const fam = (id: string) => MISSION_SKILLS.find((s) => s.id === id)?.family;
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

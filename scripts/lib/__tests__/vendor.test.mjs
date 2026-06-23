import { test } from "node:test";
import assert from "node:assert/strict";
import { isVendoredFile, safeJoin, familyRootFor, isInsideRoot } from "../vendor.mjs";

test("isInsideRoot allows intra-root targets, rejects escapes", () => {
  const root = "/home/u/.claude";
  assert.equal(isInsideRoot("/home/u/.claude/skills/gstack/ship/SKILL.md", root), true);
  assert.equal(isInsideRoot("/home/u/.claude", root), true);
  assert.equal(isInsideRoot("/etc/passwd", root), false);
  assert.equal(isInsideRoot("/home/u/.claude-evil/x", root), false); // prefix-trap
});

test("isVendoredFile keeps markdown, prunes everything else", () => {
  assert.equal(isVendoredFile("SKILL.md"), true);
  assert.equal(isVendoredFile("reference/usage.md"), true);
  assert.equal(isVendoredFile("README.MD"), true); // case-insensitive
  assert.equal(isVendoredFile("index.ts"), false);
  assert.equal(isVendoredFile("bundle.js"), false);
  assert.equal(isVendoredFile("bundle.js.map"), false);
  assert.equal(isVendoredFile("font.ttf"), false);
  assert.equal(isVendoredFile("data.json"), false);
  assert.equal(isVendoredFile("script.py"), false);
  assert.equal(isVendoredFile("notes"), false); // no extension
});

test("safeJoin returns a path inside root for normal names", () => {
  const root = "/repo/.claude/skills";
  assert.equal(safeJoin(root, "impeccable/SKILL.md"), "/repo/.claude/skills/impeccable/SKILL.md");
});

test("safeJoin throws on traversal escape", () => {
  const root = "/repo/.claude/skills";
  assert.throws(() => safeJoin(root, "../../etc/passwd"), /escape/i);
  assert.throws(() => safeJoin(root, "a/../../../outside.md"), /escape/i);
});

test("safeJoin allows '..' that stays inside root", () => {
  const root = "/repo/.claude/skills";
  assert.equal(safeJoin(root, "a/b/../c.md"), "/repo/.claude/skills/a/c.md");
});

test("familyRootFor maps source kind to dest subdir", () => {
  assert.equal(familyRootFor("skills"), "skills");
  assert.equal(familyRootFor("commands"), "commands");
  assert.throws(() => familyRootFor("nope"), /unknown source/i);
});

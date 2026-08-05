import { test } from "node:test";
import assert from "node:assert/strict";
import { searchSkills, buildAttachSuffix, ATTACH_CAP, type AttachSkill } from "../skillAttach.ts";

const SKILLS: AttachSkill[] = [
  { id: "review", title: "/review", hint: "review diffs", family: "prompts", prompt: "Review the diffs." },
  { id: "ship", title: "/ship", hint: "build + test", family: "prompts", prompt: "Run build and tests." },
  { id: "seo-audit", title: "/seo-audit", hint: "seo", family: "marketing", prompt: "Audit SEO." },
];

// ── searchSkills ──────────────────────────────────────────────────────────────
test("searchSkills returns all (capped) when query empty", () => {
  const r = searchSkills(SKILLS, "", 10);
  assert.equal(r.length, 3);
});
test("searchSkills matches id, title, hint, family (case-insensitive)", () => {
  assert.deepEqual(searchSkills(SKILLS, "SEO", 10).map((s) => s.id), ["seo-audit"]);
  assert.deepEqual(searchSkills(SKILLS, "build", 10).map((s) => s.id), ["ship"]); // hint match
  assert.deepEqual(searchSkills(SKILLS, "marketing", 10).map((s) => s.id), ["seo-audit"]); // family
});
test("searchSkills caps results", () => {
  assert.equal(searchSkills(SKILLS, "", 2).length, 2);
});

// ── buildAttachSuffix ─────────────────────────────────────────────────────────
test("buildAttachSuffix returns empty string for no skills", () => {
  assert.equal(buildAttachSuffix([]), "");
});
test("buildAttachSuffix lists the selected skill prompts", () => {
  const s = buildAttachSuffix([SKILLS[0], SKILLS[1]]);
  assert.ok(s.includes("/review"));
  assert.ok(s.includes("Review the diffs."));
  assert.ok(s.includes("/ship"));
  assert.ok(s.startsWith("\n\n"), "separated from base persona");
});
test("buildAttachSuffix dedups by id", () => {
  const s = buildAttachSuffix([SKILLS[0], SKILLS[0]]);
  assert.equal(s.split("/review").length - 1, 1); // appears once
});
test("buildAttachSuffix caps total length at ATTACH_CAP", () => {
  const big: AttachSkill[] = Array.from({ length: 200 }, (_, i) => ({
    id: `s${i}`, title: `/s${i}`, hint: "", family: "x", prompt: "x".repeat(100),
  }));
  const s = buildAttachSuffix(big);
  assert.ok(s.length <= ATTACH_CAP, `len ${s.length} <= ${ATTACH_CAP}`);
});
test("buildAttachSuffix is safe with weird prompt content (no crash)", () => {
  const s = buildAttachSuffix([{ id: "x", title: "/x", hint: "", family: "y", prompt: "line1\nline2\t`backtick`" }]);
  assert.ok(s.includes("/x"));
});

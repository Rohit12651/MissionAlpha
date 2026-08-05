import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTeamBlock, teamMemberToSpec, TEAM_MAX } from "../teamBlock.ts";

const KNOWN = new Set(["content-writing", "repo-read", "repo-edit", "research-brief", "data-summary"]);

test("parses a fenced team block into members and strips it from the prose", () => {
  const reply = [
    "Here is the team I would stand up.",
    "```team",
    "launch-writer Launch Copywriter | content-writing, research-brief",
    "repo-scout Repo Scout | repo-read",
    "```",
  ].join("\n");
  const { clean, members } = parseTeamBlock(reply, KNOWN);
  assert.equal(clean, "Here is the team I would stand up.");
  assert.equal(members.length, 2);
  assert.deepEqual(members[0], { id: "launch-writer", role: "Launch Copywriter", skills: ["content-writing", "research-brief"] });
  assert.deepEqual(members[1], { id: "repo-scout", role: "Repo Scout", skills: ["repo-read"] });
});

test("returns no members when there is no team block", () => {
  const { clean, members } = parseTeamBlock("just prose", KNOWN);
  assert.equal(clean, "just prose");
  assert.deepEqual(members, []);
});

test("drops lines with an invalid id, a missing role, or an unknown skill", () => {
  const reply = [
    "```team",
    "Bad_ID Some Role | repo-read", // uppercase + underscore → invalid id
    "ok-agent | repo-read", // missing role
    "ghost-agent Ghost | not-a-real-skill", // unknown skill
    "good-agent Good Agent | repo-read",
    "```",
  ].join("\n");
  const { members } = parseTeamBlock(reply, KNOWN);
  assert.deepEqual(members.map((m) => m.id), ["good-agent"]);
});

test("drops a duplicate id and caps the team size", () => {
  const lines = ["```team"];
  for (let i = 0; i < TEAM_MAX + 3; i++) lines.push(`agent-${i} Role ${i} | repo-read`);
  lines.push("agent-0 Duplicate | repo-read");
  lines.push("```");
  const { members } = parseTeamBlock(lines.join("\n"), KNOWN);
  assert.equal(members.length, TEAM_MAX);
  assert.equal(new Set(members.map((m) => m.id)).size, TEAM_MAX);
});

test("a member with no skills section is allowed (empty skill list)", () => {
  const { members } = parseTeamBlock("```team\nplain-agent Plain Agent\n```", KNOWN);
  assert.deepEqual(members, [{ id: "plain-agent", role: "Plain Agent", skills: [] }]);
});

test("teamMemberToSpec builds a create payload the factory will accept", () => {
  const spec = teamMemberToSpec({ id: "launch-writer", role: "Launch Copywriter", skills: ["content-writing"] }, "ship the v2 launch");
  assert.equal(spec.id, "launch-writer");
  assert.equal(spec.role, "Launch Copywriter");
  assert.equal(spec.title, "Launch Copywriter");
  assert.deepEqual(spec.skills, ["content-writing"]);
  assert.deepEqual(spec.integrations, []);
  assert.ok(spec.persona.length >= 20, "persona must clear the factory's 20-char floor");
  assert.match(spec.persona, /ship the v2 launch/);
  assert.ok(spec.persona.length <= 6000);
});

test("teamMemberToSpec truncates a very long job description", () => {
  const spec = teamMemberToSpec({ id: "a-agent", role: "A", skills: [] }, "x".repeat(9000));
  assert.ok(spec.persona.length <= 6000);
});

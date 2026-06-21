import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore, filterCommands, type PaletteCommand } from "../paletteCommands.ts";

const noop = () => {};
const CMDS: PaletteCommand[] = [
  { id: "new-chat", title: "New chat", group: "Navigate", run: noop },
  { id: "open-settings", title: "Open Settings", group: "Settings", keywords: "theme tier policy", run: noop },
  { id: "open-connectors", title: "Open Connectors", group: "Connectors", keywords: "mcp", run: noop },
  { id: "model-opus", title: "Switch model: Opus", group: "Model", keywords: "tier smartest", run: noop },
  { id: "dispatch", title: "Dispatch a goal", group: "Goal", run: noop },
  { id: "jump-qa", title: "Jump to senior-qa", group: "Agents", run: noop },
];

test("fuzzyScore: subsequence match, -1 on miss", () => {
  assert.ok(fuzzyScore("oc", "Open Connectors") >= 0);
  assert.equal(fuzzyScore("zzz", "Open Connectors"), -1);
  assert.equal(fuzzyScore("", "anything"), 0);
});

test("fuzzyScore rewards word-start + contiguous matches", () => {
  // "set" contiguous + word-start in "Settings" beats scattered match
  assert.ok(fuzzyScore("set", "Settings") > fuzzyScore("set", "Subset entry test"));
});

test("filterCommands returns all on empty query", () => {
  assert.equal(filterCommands(CMDS, "").length, CMDS.length);
});

test("filterCommands ranks the obvious match first", () => {
  const r = filterCommands(CMDS, "settings");
  assert.equal(r[0].id, "open-settings");
  const r2 = filterCommands(CMDS, "opus");
  assert.equal(r2[0].id, "model-opus");
  const r3 = filterCommands(CMDS, "mcp"); // keyword match
  assert.equal(r3[0].id, "open-connectors");
});

test("filterCommands excludes non-matches", () => {
  const r = filterCommands(CMDS, "qa");
  assert.ok(r.some((c) => c.id === "jump-qa"));
  assert.ok(!r.some((c) => c.id === "model-opus"));
});

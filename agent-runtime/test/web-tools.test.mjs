// agent-runtime/test/web-tools.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { webToolArgs, WEB_RESEARCH_AGENTS } from "../agent-tools.mjs";

const EXPECTED = ["--allowed-tools", "WebSearch", "--allowed-tools", "WebFetch"];

test("boss + ceo get WebSearch and WebFetch appended", () => {
  assert.deepEqual(webToolArgs("boss"), EXPECTED);
  assert.deepEqual(webToolArgs("ceo"), EXPECTED);
});

test("scope-leak guard: no other agent gets web tools", () => {
  for (const id of ["architect", "senior-web-1", "qa", "factory-abc123", "", undefined, "BOSS", "Ceo"]) {
    assert.deepEqual(webToolArgs(id), [], `web tools must NOT leak to ${String(id)}`);
  }
});

test("WEB_RESEARCH_AGENTS is exactly {boss, ceo}", () => {
  assert.deepEqual([...WEB_RESEARCH_AGENTS].sort(), ["boss", "ceo"]);
});

test("returned array is a fresh copy (no shared mutable state)", () => {
  const a = webToolArgs("boss");
  a.push("X");
  assert.deepEqual(webToolArgs("boss"), EXPECTED); // not mutated by caller
});

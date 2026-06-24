import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgents, fullIndex } from "../router.mjs";

const mintedGo = { id: "go-impl-x", skills: ["code-implement-go"] };
const mintedNg = { id: "ng-impl-x", skills: ["code-implement-angular"] };

test("python resolves to a built-in agent (source=builtin)", () => {
  const r = resolveAgents({ langs: ["python"] }, []);
  assert.equal(r.unresolved.length, 0);
  assert.equal(r.assignments.length, 1);
  assert.equal(r.assignments[0].source, "builtin");
  assert.equal(r.assignments[0].kind, "lang");
  assert.equal(r.assignments[0].value, "python");
  assert.ok(r.assignments[0].agentId, "must name an owning built-in");
});

test("go with NO minted agent → unresolved (no built-in builds Go)", () => {
  const r = resolveAgents({ langs: ["go"] }, []);
  assert.equal(r.assignments.length, 0);
  assert.deepEqual(r.unresolved, [{ kind: "lang", value: "go" }]);
});

test("go WITH a minted code-implement-go agent → routes to the minted agent (source=minted)", () => {
  const r = resolveAgents({ langs: ["go"] }, [mintedGo]);
  assert.equal(r.unresolved.length, 0);
  assert.equal(r.assignments.length, 1);
  assert.deepEqual(r.assignments[0], { kind: "lang", value: "go", agentId: "go-impl-x", source: "minted" });
});

test("angular framework with a minted angular agent → minted", () => {
  const r = resolveAgents({ frameworks: ["angular"] }, [mintedNg]);
  assert.equal(r.assignments.length, 1);
  assert.equal(r.assignments[0].agentId, "ng-impl-x");
  assert.equal(r.assignments[0].source, "minted");
});

test("mixed needs: python→builtin, go→minted, cobol→unresolved", () => {
  const r = resolveAgents({ langs: ["python", "go", "cobol"] }, [mintedGo]);
  const byVal = Object.fromEntries(r.assignments.map((a) => [a.value, a]));
  assert.equal(byVal.python.source, "builtin");
  assert.equal(byVal.go.source, "minted");
  assert.equal(byVal.go.agentId, "go-impl-x");
  assert.deepEqual(r.unresolved, [{ kind: "lang", value: "cobol" }]);
});

test("needs are deduped + case-insensitive", () => {
  const r = resolveAgents({ langs: ["GO", "go", " Go "] }, [mintedGo]);
  assert.equal(r.assignments.length, 1, "duplicate/case variants collapse to one");
  assert.equal(r.assignments[0].value, "go");
});

test("fullIndex merges built-ins + minted; minted ids tagged", () => {
  const { index, mintedIds } = fullIndex([mintedGo, mintedNg]);
  assert.ok(index.has("go-impl-x") && index.has("ng-impl-x"));
  assert.ok(index.size > 16, "built-ins present alongside minted");
  assert.ok(mintedIds.has("go-impl-x") && mintedIds.has("ng-impl-x"));
  assert.equal(index.get("go-impl-x").langs.includes("go"), true);
});

test("empty needs → empty assignments + unresolved", () => {
  const r = resolveAgents({}, []);
  assert.deepEqual(r, { assignments: [], unresolved: [] });
});

// D1 — A GATE THAT CAN ACTUALLY PASS.
//
// The post-edit quality gate ran the target repo's WHOLE suite (`node --test`, ~2,500
// tests here) under a 120s deadline, in a container, on every task. Measured live: it
// reached test 328 and was killed. So every autonomous run died at the gate — 42 failed,
// 0 done, the model's work discarded before the diff was even computed.
//
// The fix is to run the tests that RELATE to what the agent touched. This module is the
// pure half: given the paths that changed and the files that exist, which test files
// should run. No I/O, no git, no globbing — the caller injects both lists, so every rule
// below is provable without a repo.
//
// The one judgement encoded here: when a change has NO related tests, that is an honest
// `scope-empty`, not a failure and not a silent pass. A docs edit has no unit tests; a
// gate that vetoes it is the defect this file exists to remove. The caller records the
// reason so "my gate has not run" stays answerable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCOPE, validateScope, isTestPath, relatedTests } from "../test-scope.mjs";

const REPO_FILES = [
  "agent-runtime/pipeline.mjs",
  "agent-runtime/queue.mjs",
  "agent-runtime/providers/engine-exec.mjs",
  "agent-runtime/test/pipeline.test.mjs",
  "agent-runtime/test/pipeline-http.test.mjs",
  "agent-runtime/test/pipeline-attribution.test.mjs",
  "agent-runtime/test/queue.test.mjs",
  "agent-runtime/test/engine-exec.test.mjs",
  "src/lib/queueModel.ts",
  "src/lib/__tests__/queueModel.test.ts",
  "src/components/inbox/QueueStrip.tsx",
  "docs/README.md",
  "README.md",
];

const scopeOf = (over = {}) => validateScope({ ...DEFAULT_SCOPE, ...over }).scope;

test("TS-1: a changed source file selects every test file named after it", () => {
  const r = relatedTests({ changed: ["agent-runtime/pipeline.mjs"], repoFiles: REPO_FILES, scope: scopeOf() });
  assert.deepEqual(r.targets, [
    "agent-runtime/test/pipeline-attribution.test.mjs",
    "agent-runtime/test/pipeline-http.test.mjs",
    "agent-runtime/test/pipeline.test.mjs",
  ]);
  assert.equal(r.reason, null);
});

test("TS-2: the prefix match is on a WHOLE stem — 'queue' never drags in 'queueModel'", () => {
  const r = relatedTests({ changed: ["agent-runtime/queue.mjs"], repoFiles: REPO_FILES, scope: scopeOf() });
  assert.deepEqual(r.targets, ["agent-runtime/test/queue.test.mjs"]);
});

test("TS-3: a changed TEST file is its own target", () => {
  const r = relatedTests({ changed: ["agent-runtime/test/queue.test.mjs"], repoFiles: REPO_FILES, scope: scopeOf() });
  assert.deepEqual(r.targets, ["agent-runtime/test/queue.test.mjs"]);
});

test("TS-4: __tests__ layout resolves too (src/lib/x.ts → src/lib/__tests__/x.test.ts)", () => {
  const r = relatedTests({ changed: ["src/lib/queueModel.ts"], repoFiles: REPO_FILES, scope: scopeOf() });
  assert.deepEqual(r.targets, ["src/lib/__tests__/queueModel.test.ts"]);
});

test("TS-5: a change with no related tests is scope-empty, NOT a failure", () => {
  const r = relatedTests({ changed: ["docs/README.md"], repoFiles: REPO_FILES, scope: scopeOf() });
  assert.deepEqual(r.targets, []);
  assert.equal(r.reason, "scope-empty");
});

test("TS-6: no changed paths at all ⇒ 'unknown' — the caller must NOT scope on a blind list", () => {
  const r = relatedTests({ changed: [], repoFiles: REPO_FILES, scope: scopeOf() });
  assert.deepEqual(r.targets, []);
  assert.equal(r.reason, "scope-unknown");
});

test("TS-7: several changed files union their targets, deduped and stable-sorted", () => {
  const r = relatedTests({
    changed: ["agent-runtime/queue.mjs", "src/lib/queueModel.ts", "agent-runtime/queue.mjs"],
    repoFiles: REPO_FILES,
    scope: scopeOf(),
  });
  assert.deepEqual(r.targets, ["agent-runtime/test/queue.test.mjs", "src/lib/__tests__/queueModel.test.ts"]);
});

test("TS-8: the target list is CAPPED and truncation is reported, never silent", () => {
  const many = Array.from({ length: 30 }, (_, i) => `agent-runtime/test/pipeline-${i}.test.mjs`);
  const r = relatedTests({
    changed: ["agent-runtime/pipeline.mjs"],
    repoFiles: [...REPO_FILES, ...many],
    scope: scopeOf({ maxTargets: 5 }),
  });
  assert.equal(r.targets.length, 5);
  assert.equal(r.truncated, true);
});

test("TS-9: a path outside the configured test dirs can never become a target", () => {
  const r = relatedTests({
    changed: ["agent-runtime/pipeline.mjs"],
    repoFiles: ["agent-runtime/pipeline.mjs", "evil/pipeline.test.mjs"],
    scope: scopeOf({ testDirs: ["agent-runtime/test"] }),
  });
  assert.deepEqual(r.targets, []);
  assert.equal(r.reason, "scope-empty");
});

test("TS-10: traversal-shaped and absolute paths are dropped before they can reach argv", () => {
  const r = relatedTests({
    changed: ["agent-runtime/pipeline.mjs"],
    repoFiles: ["../outside/pipeline.test.mjs", "/etc/pipeline.test.mjs", "agent-runtime/test/pipeline.test.mjs"],
    scope: scopeOf(),
  });
  assert.deepEqual(r.targets, ["agent-runtime/test/pipeline.test.mjs"]);
});

test("TS-11: isTestPath recognises both layouts and refuses ordinary source", () => {
  assert.equal(isTestPath("agent-runtime/test/x.test.mjs"), true);
  assert.equal(isTestPath("src/lib/__tests__/x.test.ts"), true);
  assert.equal(isTestPath("src/lib/x.spec.tsx"), true);
  assert.equal(isTestPath("src/lib/x.ts"), false);
  assert.equal(isTestPath("README.md"), false);
});

test("TS-12: validateScope is fail-closed on a malformed block", () => {
  assert.ok(validateScope({ enabled: true, testDirs: "nope", maxTargets: 4 }).error);
  assert.ok(validateScope({ enabled: true, testDirs: ["ok"], maxTargets: 0 }).error);
  assert.ok(validateScope({ enabled: true, testDirs: ["../escape"], maxTargets: 4 }).error);
  assert.ok(validateScope({ enabled: true, testDirs: ["a b;rm"], maxTargets: 4 }).error);
  assert.equal(validateScope(undefined).scope.enabled, DEFAULT_SCOPE.enabled, "absent ⇒ the safe default");
  assert.equal(validateScope({ enabled: false }).scope.enabled, false, "an operator may turn scoping off");
});

// ── quality.json integration: the scope block travels with the rest of the config and
// obeys the SAME fail-closed rule (a malformed block is never quietly ignored).
test("TS-13: validateQuality carries a scope block through, and fails closed on a bad one", async () => {
  const { validateQuality } = await import("../quality.mjs");
  const ok = validateQuality({
    testCmd: ["node", "--test"],
    scope: { enabled: true, testDirs: ["agent-runtime/test"], maxTargets: 6 },
  });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.config.scope, { enabled: true, testDirs: ["agent-runtime/test"], maxTargets: 6 });

  const missing = validateQuality({ testCmd: ["node", "--test"] });
  assert.equal(missing.config.scope.enabled, true, "absent ⇒ scoping ON by default");

  const bad = validateQuality({ testCmd: ["node", "--test"], scope: { testDirs: ["../escape"] } });
  assert.match(String(bad.error), /scope\.testDirs/);
});

// ── Co-located tests. Plenty of repos keep `foo.ts` next to `foo.test.ts` with no
// dedicated test directory at all, and a scoper that only honours `testDirs` would find
// nothing there and skip the gate on EVERY change — a silent-pass by omission. A test
// file sitting in the SAME directory as the changed file is related by construction, so
// it qualifies without needing to be listed in testDirs. It still has to be a real test
// path, repo-relative and traversal-free, and it still passes the argv validator later.
test("TS-14: a test file co-located with the changed file is related even outside testDirs", () => {
  const r = relatedTests({
    changed: ["src/demo.ts"],
    repoFiles: ["src/demo.ts", "src/demo.test.mjs", "other/demo.test.mjs"],
    scope: scopeOf({ testDirs: ["agent-runtime/test"] }),
  });
  assert.deepEqual(r.targets, ["src/demo.test.mjs"], "the sibling qualifies; the far-away namesake does not");
});

test("TS-15: the sibling rule does not relax the whole-stem or traversal rules", () => {
  const r = relatedTests({
    changed: ["src/demo.ts"],
    repoFiles: ["src/demoModel.test.mjs", "../src/demo.test.mjs"],
    scope: scopeOf({ testDirs: [] }),
  });
  assert.deepEqual(r.targets, []);
});

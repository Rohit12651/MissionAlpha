// D1 — the quality gate, SCOPED. These tests pin the wiring between test-scope.mjs and
// the jailed runner: what actually gets executed, what verdict comes back, and the one
// distinction the post-edit hook depends on — whether a timeout is EVIDENCE about the
// diff or an artefact of an oversized command.
//
// Live failure this replaces: `node --test` (whole repo) reached test 328 of ~2,500 and
// was killed at 120s, on every single autonomous task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestGate } from "../test-gate.mjs";

function fakeLoopSteps() {
  const rows = [];
  return { rows, record: (agentId, taskId, obj) => { rows.push({ agentId, taskId, obj }); return 1; } };
}
function fakeSandbox({ result, dockerUp = true } = {}) {
  const calls = [];
  return {
    calls,
    dockerAvailable: async () => dockerUp,
    runInSandbox: async (worktreeDir, command, opts) => { calls.push({ worktreeDir, command, opts }); return result ?? { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }; },
  };
}
const idRealpath = (p) => p;

const CONFIG = (over = {}) => ({
  config: {
    testCmd: ["node", "--test"], e2eCmd: null, timeoutMs: 1000, workdir: null,
    scope: { enabled: true, testDirs: ["test", "__tests__"], maxTargets: 12 },
    ...over,
  },
});

const REPO_FILES = [
  "agent-runtime/pipeline.mjs",
  "agent-runtime/test/pipeline.test.mjs",
  "agent-runtime/test/queue.test.mjs",
  "docs/PING.md",
];

const gateWith = (deps = {}) => createTestGate({
  sandbox: deps.sandbox ?? fakeSandbox(),
  realpath: idRealpath,
  loopSteps: deps.loopSteps,
  loadConfig: deps.loadConfig ?? (() => CONFIG()),
  scrub: (s) => s,
  listFilesFn: deps.listFilesFn ?? (() => REPO_FILES),
  changedPathsFn: deps.changedPathsFn ?? (() => ["agent-runtime/pipeline.mjs"]),
});

test("TG-1: the gate runs ONLY the tests related to what the agent touched", async () => {
  const sb = fakeSandbox();
  const v = await gateWith({ sandbox: sb }).run({ task: { taskId: "t1", agentId: "sr-backend" }, workdir: "/wt" });
  assert.equal(v.pass, true);
  assert.equal(v.scoped, true);
  assert.equal(sb.calls[0].command, "node --test agent-runtime/test/pipeline.test.mjs");
});

test("TG-2: a change with no related tests PASSES as scope-empty and leaves a receipt", async () => {
  const sb = fakeSandbox();
  const ls = fakeLoopSteps();
  const v = await gateWith({ sandbox: sb, loopSteps: ls, changedPathsFn: () => ["docs/PING.md"] })
    .run({ task: { taskId: "t2", agentId: "sr-backend" }, workdir: "/wt" });
  assert.equal(v.pass, true, "a docs-only change must not be vetoed by a unit-test gate");
  assert.equal(v.reason, "scope-empty");
  assert.equal(sb.calls.length, 0, "nothing was executed");
  assert.ok(ls.rows.length > 0, "the skip is RECORDED — never silent");
  const text = JSON.stringify(ls.rows);
  assert.match(text, /scope-empty|no related tests/i);
});

test("TG-3: when git cannot say what changed, the gate falls back to the FULL command", async () => {
  const sb = fakeSandbox();
  const v = await gateWith({ sandbox: sb, changedPathsFn: () => [] })
    .run({ task: { taskId: "t3", agentId: "a" }, workdir: "/wt" });
  assert.equal(sb.calls[0].command, "node --test", "never scope on a blind list");
  assert.equal(v.scoped, false);
});

test("TG-4: scope disabled ⇒ the configured command runs verbatim", async () => {
  const sb = fakeSandbox();
  const v = await gateWith({ sandbox: sb, loadConfig: () => CONFIG({ scope: { enabled: false, testDirs: ["test"], maxTargets: 4 } }) })
    .run({ task: { taskId: "t4", agentId: "a" }, workdir: "/wt" });
  assert.equal(sb.calls[0].command, "node --test");
  assert.equal(v.scoped, false);
});

test("TG-5: a SCOPED run that times out is EVIDENCE — it fails, with no infra excuse", async () => {
  const sb = fakeSandbox({ result: { stdout: "", stderr: "", exitCode: -1, timedOut: true } });
  const v = await gateWith({ sandbox: sb }).run({ task: { taskId: "t5", agentId: "a" }, workdir: "/wt" });
  assert.equal(v.pass, false);
  assert.equal(v.timedOut, true);
  assert.equal(v.scoped, true);
  assert.equal(v.reason, undefined, "a scoped timeout is about the diff, not the infrastructure");
});

test("TG-6: an UNSCOPED run that times out is INFRA — the diff is unverified, not condemned", async () => {
  const sb = fakeSandbox({ result: { stdout: "", stderr: "", exitCode: -1, timedOut: true } });
  const v = await gateWith({ sandbox: sb, changedPathsFn: () => [] })
    .run({ task: { taskId: "t6", agentId: "a" }, workdir: "/wt" });
  assert.equal(v.pass, false);
  assert.equal(v.scoped, false);
  assert.equal(v.reason, "gate-timeout-unscoped");
});

test("TG-7: a target that would poison the argv can never be executed", async () => {
  // A hostile filename the stem rule DOES select (`pipeline` + `-`), so the last line of
  // defence has to be the argv validator itself.
  const sb = fakeSandbox();
  const v = await gateWith({
    sandbox: sb,
    listFilesFn: () => ["agent-runtime/test/pipeline-x;rm -rf ~.test.mjs"],
  }).run({ task: { taskId: "t7", agentId: "a" }, workdir: "/wt" });
  assert.equal(sb.calls.length, 1);
  assert.equal(sb.calls[0].command, "node --test", "the configured command runs; the poisoned target does not");
  assert.equal(v.scoped, false, "an unsafe scope falls back rather than narrowing");
});

test("TG-7b: the whole-stem rule already refuses a name that only LOOKS related", async () => {
  const sb = fakeSandbox();
  const v = await gateWith({
    sandbox: sb,
    listFilesFn: () => ["agent-runtime/test/pipeline;rm -rf ~.test.mjs"],
  }).run({ task: { taskId: "t7b", agentId: "a" }, workdir: "/wt" });
  assert.equal(sb.calls.length, 0, "nothing ran");
  assert.equal(v.reason, "scope-empty");
});

test("TG-8: the truncation of a large target set is reported, never silent", async () => {
  const many = Array.from({ length: 20 }, (_, i) => `agent-runtime/test/pipeline-${i}.test.mjs`);
  const ls = fakeLoopSteps();
  const sb = fakeSandbox();
  await gateWith({
    sandbox: sb, loopSteps: ls,
    listFilesFn: () => many,
    loadConfig: () => CONFIG({ scope: { enabled: true, testDirs: ["test"], maxTargets: 3 } }),
  }).run({ task: { taskId: "t8", agentId: "a" }, workdir: "/wt" });
  assert.equal(sb.calls[0].command.split(" ").length, 2 + 3, "exactly maxTargets targets");
  assert.match(JSON.stringify(ls.rows), /truncat/i);
});

test("TG-9: scoping never weakens the jail — network stays off and the mount is the worktree", async () => {
  const sb = fakeSandbox();
  await gateWith({ sandbox: sb }).run({ task: { taskId: "t9", agentId: "a" }, workdir: "/wt" });
  assert.equal(sb.calls[0].opts.network, false);
  assert.equal(sb.calls[0].worktreeDir, "/wt");
});

test("TG-10: a missing Docker daemon is still fail-closed infra, unchanged by scoping", async () => {
  const sb = fakeSandbox({ dockerUp: false });
  const v = await gateWith({ sandbox: sb }).run({ task: { taskId: "t10", agentId: "a" }, workdir: "/wt" });
  assert.equal(v.pass, false);
  assert.equal(v.reason, "sandbox-unavailable");
  assert.equal(sb.calls.length, 0);
});

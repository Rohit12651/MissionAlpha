// Story-Pipeline S4 — the unit-test gate over the INJECTED Docker sandbox (ADR-055).
// Proves: the gate routes agent-authored test code through `runInSandbox` with `network:false`
// (no exfil), fails CLOSED when the Docker daemon is unavailable (no un-jailed host fallback),
// and realpath-guards the worktree subdir so a symlink cannot widen the mount scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestGate } from "../test-gate.mjs";

function fakeLoopSteps() {
  const rows = [];
  return { rows, record: (agentId, taskId, obj) => { rows.push({ agentId, taskId, obj }); return 1; } };
}

// A sandbox spy that captures the runInSandbox call and returns a canned container result.
// `dockerUp` toggles the fail-closed preflight; identity realpath keeps tests hermetic.
function fakeSandbox({ result, dockerUp = true } = {}) {
  const calls = [];
  return {
    calls,
    dockerAvailable: async () => dockerUp,
    runInSandbox: async (worktreeDir, command, opts) => { calls.push({ worktreeDir, command, opts }); return result ?? { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }; },
  };
}
const idRealpath = (p) => p; // hermetic: /wt need not exist on disk

test("gate ROUTES agent test code through the sandbox with network:false", async () => {
  const ls = fakeLoopSteps();
  const sb = fakeSandbox({ result: { stdout: "1..3\nok", stderr: "", exitCode: 0, timedOut: false } });
  const gate = createTestGate({
    sandbox: sb, realpath: idRealpath, loopSteps: ls,
    loadConfig: () => ({ config: { testCmd: ["node", "--test"], e2eCmd: null, timeoutMs: 1000, workdir: null } }),
  });
  const v = await gate.run({ task: { taskId: "task_1", agentId: "sr-backend" }, workdir: "/wt" });
  assert.equal(v.pass, true);
  assert.equal(sb.calls.length, 1, "ran in the sandbox exactly once");
  assert.equal(sb.calls[0].worktreeDir, "/wt", "mounted the worktree");
  assert.equal(sb.calls[0].command, "node --test", "validated argv joined to a clean command");
  assert.equal(sb.calls[0].opts.network, false, "network is OFF — no exfil");
  assert.ok(ls.rows.length >= 2, "loop steps recorded");
});

test("gate fails when the container exits non-zero and returns the scrubbed tail", async () => {
  const sb = fakeSandbox({ result: { stdout: "", stderr: "AssertionError: expected 2 to equal 3", exitCode: 1, timedOut: false } });
  const gate = createTestGate({
    sandbox: sb, realpath: idRealpath,
    loadConfig: () => ({ config: { testCmd: ["node", "--test"], e2eCmd: null, timeoutMs: 1000, workdir: null } }),
    scrub: (s) => s,
  });
  const v = await gate.run({ task: { taskId: "t", agentId: "a" }, workdir: "/wt" });
  assert.equal(v.pass, false);
  assert.match(v.tail, /AssertionError/);
  assert.equal(v.exitCode, 1);
});

test("gate scrubs a secret from the captured tail", async () => {
  const sb = fakeSandbox({ result: { stdout: "leaked sk-ant-SECRETVALUE here", stderr: "", exitCode: 1, timedOut: false } });
  const gate = createTestGate({
    sandbox: sb, realpath: idRealpath,
    loadConfig: () => ({ config: { testCmd: ["node", "--test"], timeoutMs: 1000, workdir: null } }),
    scrub: (s) => s.split("sk-ant-SECRETVALUE").join("[redacted]"),
  });
  const v = await gate.run({ task: { taskId: "t", agentId: "a" }, workdir: "/wt" });
  assert.ok(!v.tail.includes("sk-ant-SECRETVALUE"), "secret must be scrubbed from feedback");
  assert.match(v.tail, /\[redacted\]/);
});

test("gate FAILS CLOSED when the config is poisoned/unavailable (never a silent pass)", async () => {
  const sb = fakeSandbox();
  const gate = createTestGate({ sandbox: sb, realpath: idRealpath, loadConfig: () => ({ error: "quality.json parse error" }) });
  const v = await gate.run({ task: { taskId: "t", agentId: "a" }, workdir: "/wt" });
  assert.equal(v.pass, false);
  assert.equal(v.reason, "config");
  assert.equal(sb.calls.length, 0, "a poisoned config must NOT run a command");
});

test("gate FAILS CLOSED when Docker is unavailable — NO un-jailed host fallback", async () => {
  const sb = fakeSandbox({ dockerUp: false });
  const gate = createTestGate({
    sandbox: sb, realpath: idRealpath,
    loadConfig: () => ({ config: { testCmd: ["node", "--test"], timeoutMs: 1000, workdir: null } }),
  });
  const v = await gate.run({ task: { taskId: "t", agentId: "a" }, workdir: "/wt" });
  assert.equal(v.pass, false, "no daemon must never pass");
  assert.equal(v.reason, "sandbox-unavailable");
  assert.equal(sb.calls.length, 0, "the un-jailed sandbox path must NOT run");
});

test("gate flags a container timeout as a failure", async () => {
  const sb = fakeSandbox({ result: { stdout: "", stderr: "", exitCode: 124, timedOut: true, killed: true } });
  const gate = createTestGate({
    sandbox: sb, realpath: idRealpath,
    loadConfig: () => ({ config: { testCmd: ["node", "--test"], timeoutMs: 1000, workdir: null } }),
  });
  const v = await gate.run({ task: { taskId: "t", agentId: "a" }, workdir: "/wt" });
  assert.equal(v.pass, false);
  assert.equal(v.timedOut, true);
});

test("gate applies a validated workdir subdir as the mount source", async () => {
  const sb = fakeSandbox();
  const gate = createTestGate({
    sandbox: sb, realpath: idRealpath,
    loadConfig: () => ({ config: { testCmd: ["npm", "test"], timeoutMs: 1000, workdir: "packages/api" } }),
  });
  await gate.run({ task: { taskId: "t", agentId: "a" }, workdir: "/wt" });
  assert.equal(sb.calls[0].worktreeDir, "/wt/packages/api", "subdir joined + guarded is the mount");
});

test("gate FAILS CLOSED when the workdir realpath escapes the worktree (symlink widen)", async () => {
  const sb = fakeSandbox();
  // realpath maps the joined subdir OUT of the worktree (as a planted symlink would).
  const escapingRealpath = (p) => (p.includes("packages/api") ? "/etc" : p);
  const gate = createTestGate({
    sandbox: sb, realpath: escapingRealpath,
    loadConfig: () => ({ config: { testCmd: ["npm", "test"], timeoutMs: 1000, workdir: "packages/api" } }),
  });
  const v = await gate.run({ task: { taskId: "t", agentId: "a" }, workdir: "/wt" });
  assert.equal(v.pass, false);
  assert.equal(v.reason, "workdir-escape");
  assert.equal(sb.calls.length, 0, "an out-of-tree cwd must NOT reach the sandbox");
});

test("gate fails closed with no worktree", async () => {
  const sb = fakeSandbox();
  const gate = createTestGate({ sandbox: sb, realpath: idRealpath, loadConfig: () => ({ config: { testCmd: ["node"], timeoutMs: 1000, workdir: null } }) });
  const v = await gate.run({ task: { taskId: "t", agentId: "a" }, workdir: null });
  assert.equal(v.pass, false);
  assert.equal(sb.calls.length, 0);
});

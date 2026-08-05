// Story-Pipeline S5 — the DEPLOY EXECUTOR over the INJECTED Docker sandbox (the #1 surface).
// Proves: the deploy runs ONLY through runInSandbox with cfg.network (default false), fails
// CLOSED with no daemon (no un-jailed host fallback), realpath-locks the cwd inside the deploy
// root, scrubs output, surfaces the network flag, and gates advance on a healthy health-check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeployExecutor } from "../deploy.mjs";

// A sandbox spy: captures the runInSandbox call, returns a canned container result. dockerUp
// toggles the fail-closed preflight; identity realpath keeps tests hermetic.
function fakeSandbox({ result, dockerUp = true } = {}) {
  const calls = [];
  return {
    calls,
    dockerAvailable: async () => dockerUp,
    runInSandbox: async (cwd, command, opts) => { calls.push({ cwd, command, opts }); return result ?? { stdout: "built", stderr: "", exitCode: 0, timedOut: false }; },
  };
}
const idRealpath = (p) => p;
const cfg = (over = {}) => ({ config: { deployCmd: ["npm", "run", "build"], healthUrl: null, timeoutMs: 1000, network: false, cwd: null, ...over } });

test("deploy RUNS through the sandbox with cfg.network=false by default (no exfil)", async () => {
  const sb = fakeSandbox({ result: { stdout: "build ok", stderr: "", exitCode: 0, timedOut: false } });
  const ex = createDeployExecutor({ sandbox: sb, realpath: idRealpath, loadConfig: () => cfg() });
  const v = await ex.run({ storyId: "story_a", deployRoot: "/repo" });
  assert.equal(v.deployed, true);
  assert.equal(v.network, false);
  assert.equal(sb.calls.length, 1, "ran in the sandbox exactly once");
  assert.equal(sb.calls[0].cwd, "/repo", "mounted the deploy root");
  assert.equal(sb.calls[0].command, "npm run build", "validated argv joined to a clean command");
  assert.equal(sb.calls[0].opts.network, false, "network OFF by default");
});

test("deploy passes cfg.network=true THROUGH to the jail (explicit opt-in)", async () => {
  const sb = fakeSandbox();
  const ex = createDeployExecutor({ sandbox: sb, realpath: idRealpath, loadConfig: () => cfg({ network: true }) });
  const v = await ex.run({ storyId: "s", deployRoot: "/repo" });
  assert.equal(v.network, true, "the network flag is surfaced on the result");
  assert.equal(sb.calls[0].opts.network, true, "cfg.network flows to the sandbox");
});

test("deploy FAILS CLOSED when Docker is unavailable — NO un-jailed host fallback", async () => {
  const sb = fakeSandbox({ dockerUp: false });
  const ex = createDeployExecutor({ sandbox: sb, realpath: idRealpath, loadConfig: () => cfg() });
  const v = await ex.run({ storyId: "s", deployRoot: "/repo" });
  assert.equal(v.deployed, false);
  assert.equal(v.reason, "sandbox-unavailable");
  assert.equal(sb.calls.length, 0, "no daemon must NEVER run a host command");
});

test("deploy FAILS CLOSED on a poisoned/unavailable config (never runs a command)", async () => {
  const sb = fakeSandbox();
  const ex = createDeployExecutor({ sandbox: sb, realpath: idRealpath, loadConfig: () => ({ error: "deploy.json parse error" }) });
  const v = await ex.run({ storyId: "s", deployRoot: "/repo" });
  assert.equal(v.deployed, false);
  assert.equal(v.reason, "config");
  assert.equal(sb.calls.length, 0);
});

test("deploy FAILS CLOSED when the cwd realpath escapes the deploy root (symlink widen)", async () => {
  const sb = fakeSandbox();
  const escaping = (p) => (p.includes("sub") ? "/etc" : p);
  const ex = createDeployExecutor({ sandbox: sb, realpath: escaping, loadConfig: () => cfg({ cwd: "sub" }) });
  const v = await ex.run({ storyId: "s", deployRoot: "/repo" });
  assert.equal(v.deployed, false);
  assert.equal(v.reason, "cwd-escape");
  assert.equal(sb.calls.length, 0, "an out-of-root cwd must NOT reach the sandbox");
});

test("deploy fails when the container exits non-zero, with scrubbed tail", async () => {
  const sb = fakeSandbox({ result: { stdout: "", stderr: "npm ERR! sk-ant-SECRET leaked", exitCode: 1, timedOut: false } });
  const ex = createDeployExecutor({ sandbox: sb, realpath: idRealpath, loadConfig: () => cfg(), scrub: (s) => s.split("sk-ant-SECRET").join("[redacted]") });
  const v = await ex.run({ storyId: "s", deployRoot: "/repo" });
  assert.equal(v.deployed, false);
  assert.equal(v.reason, "deploy-failed");
  assert.ok(!v.tail.includes("sk-ant-SECRET"), "secret scrubbed from output");
  assert.match(v.tail, /\[redacted\]/);
});

test("deploy fails on container timeout", async () => {
  const sb = fakeSandbox({ result: { stdout: "", stderr: "", exitCode: 124, timedOut: true, killed: true } });
  const ex = createDeployExecutor({ sandbox: sb, realpath: idRealpath, loadConfig: () => cfg() });
  const v = await ex.run({ storyId: "s", deployRoot: "/repo" });
  assert.equal(v.deployed, false);
  assert.equal(v.timedOut, true);
  assert.equal(v.reason, "deploy-timeout");
});

// ── health check ─────────────────────────────────────────────────────────────
test("HEALTHY deploy: deploy ok + health 200 → deployed+healthy", async () => {
  const sb = fakeSandbox();
  const ex = createDeployExecutor({
    sandbox: sb, realpath: idRealpath, loadConfig: () => cfg({ healthUrl: "http://127.0.0.1:3016/health" }),
    fetchFn: async () => ({ status: 200 }),
  });
  const v = await ex.run({ storyId: "s", deployRoot: "/repo" });
  assert.equal(v.deployed, true);
  assert.equal(v.healthy, true);
});

test("UNHEALTHY deploy: deploy ok but health never 2xx → deployed but unhealthy (block)", async () => {
  const sb = fakeSandbox();
  let n = 0;
  const ex = createDeployExecutor({
    sandbox: sb, realpath: idRealpath, loadConfig: () => cfg({ healthUrl: "http://localhost:3016/health" }),
    fetchFn: async () => { n++; return { status: 503 }; }, healthRetries: 3, healthRetryMs: 0,
  });
  const v = await ex.run({ storyId: "s", deployRoot: "/repo" });
  assert.equal(v.deployed, true);
  assert.equal(v.healthy, false);
  assert.equal(v.reason, "health-failed");
  assert.equal(n, 3, "retried the configured number of times, then gave up");
});

test("health check REFUSES a non-loopback URL even if it slips past (defense-in-depth)", async () => {
  const sb = fakeSandbox();
  let fetched = false;
  const ex = createDeployExecutor({ sandbox: sb, realpath: idRealpath, loadConfig: () => cfg(), fetchFn: async () => { fetched = true; return { status: 200 }; } });
  const h = await ex.checkHealth("http://169.254.169.254/latest/meta-data");
  assert.equal(h.healthy, false, "SSRF target never reports healthy");
  assert.equal(fetched, false, "the fetch is NEVER issued to a non-loopback host");
});

test("no healthUrl configured → deployed with healthy=null (no probe)", async () => {
  const sb = fakeSandbox();
  let fetched = false;
  const ex = createDeployExecutor({ sandbox: sb, realpath: idRealpath, loadConfig: () => cfg({ healthUrl: null }), fetchFn: async () => { fetched = true; return { status: 200 }; } });
  const v = await ex.run({ storyId: "s", deployRoot: "/repo" });
  assert.equal(v.deployed, true);
  assert.equal(v.healthy, null);
  assert.equal(fetched, false, "no URL ⇒ no probe");
});

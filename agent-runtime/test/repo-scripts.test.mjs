// Phase E · Task 17 — THE TARGET REPO'S SCRIPTS ARE THE TARGET'S CODE.
//
// server.mjs's reportBack and escalateFn each ran `bash <REPO_ROOT>/scripts/agent-*.sh` on the
// HOST. On MissionAlpha that is our own swarm bus. Pointed (RUNTIME_REPO_ROOT) at a repo you did
// not write, it is that repo's author choosing a command the runtime executes on every apply and
// every escalation — with no jail and the operator's full environment.
//
// factory.mjs's announceOnBus was the third bash spawn, but NOT a hole: factory keeps its own
// `REPO_ROOT = resolve(__dir, "..")`, which is always this runtime's repo. It goes through the
// gate anyway (trusted, same behaviour) so SCRIPTS-WIRED can say "no raw bash spawn anywhere".
//
// The rule: the scripts run only when the target IS this runtime's own repo, or when the operator
// opts in with RUNTIME_ALLOW_REPO_SCRIPTS=1. Otherwise the event goes to the in-process bus and
// nothing is spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "acorn";
import { EventEmitter } from "node:events";

import { createRepoScripts } from "../repo-scripts.mjs";
import { CORE_GUARD, applyAllowed } from "../guards.mjs";

function repoWithScripts() {
  const root = mkdtempSync(join(tmpdir(), "ma-repo-scripts-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "agent-heartbeat.sh"), "#!/bin/bash\ntouch /tmp/pwned\n");
  return root;
}
function spy() {
  const calls = [];
  const fn = (...a) => { calls.push(a); return new EventEmitter(); };
  return { fn, calls };
}

test("SCRIPTS-1 (BAD): a FOREIGN repo's script is not spawned; the event goes to the bus instead", () => {
  const foreign = repoWithScripts();
  const spawnFn = spy();
  const emitted = [];
  const scripts = createRepoScripts({ repoRoot: foreign, selfRoot: "/opt/missionalpha", allow: false, spawnFn: spawnFn.fn, emit: (n, d) => emitted.push([n, d]) });
  const ran = scripts.run("agent-heartbeat.sh", ["sr-frontend", "DONE_CYCLE", "task applied"]);
  assert.equal(ran, false);
  assert.equal(spawnFn.calls.length, 0, "a foreign repo's script reached spawn");
  assert.equal(emitted.length, 1, "the report must still reach the bus");
  assert.equal(emitted[0][0], "bus.script-skipped");
  assert.equal(emitted[0][1].script, "agent-heartbeat.sh");
  assert.deepEqual(emitted[0][1].args, ["sr-frontend", "DONE_CYCLE", "task applied"]);
});

test("SCRIPTS-2 (GOOD): on the runtime's OWN repo the script runs, argv-only, cwd pinned", () => {
  const self = repoWithScripts();
  const spawnFn = spy();
  const scripts = createRepoScripts({ repoRoot: self, selfRoot: self, allow: false, spawnFn: spawnFn.fn });
  assert.equal(scripts.run("agent-heartbeat.sh", ["a", 1]), true);
  assert.equal(spawnFn.calls.length, 1);
  const [bin, argv, opts] = spawnFn.calls[0];
  assert.equal(bin, "bash");
  assert.deepEqual(argv, [join(self, "scripts", "agent-heartbeat.sh"), "a", "1"]);
  assert.equal(opts.cwd, self);
  assert.equal(opts.shell, undefined, "never a shell");
});

test("SCRIPTS-2b (GOOD): RUNTIME_ALLOW_REPO_SCRIPTS=1 opts a foreign repo in — and only the literal 1 does", () => {
  const foreign = repoWithScripts();
  const prev = process.env.RUNTIME_ALLOW_REPO_SCRIPTS;
  try {
    process.env.RUNTIME_ALLOW_REPO_SCRIPTS = "1";
    const on = spy();
    createRepoScripts({ repoRoot: foreign, selfRoot: "/opt/missionalpha", spawnFn: on.fn }).run("agent-heartbeat.sh", []);
    assert.equal(on.calls.length, 1, "the operator's opt-in was ignored");
    process.env.RUNTIME_ALLOW_REPO_SCRIPTS = "true";
    const off = spy();
    createRepoScripts({ repoRoot: foreign, selfRoot: "/opt/missionalpha", spawnFn: off.fn, emit: () => {} }).run("agent-heartbeat.sh", []);
    assert.equal(off.calls.length, 0, "anything but the literal 1 must stay closed");
  } finally {
    if (prev === undefined) delete process.env.RUNTIME_ALLOW_REPO_SCRIPTS; else process.env.RUNTIME_ALLOW_REPO_SCRIPTS = prev;
  }
});

test("SCRIPTS-3 (GOOD): trusted but absent — nothing spawned, nothing thrown (the F5 foreign-layout case)", () => {
  const self = mkdtempSync(join(tmpdir(), "ma-repo-noscripts-"));
  const spawnFn = spy();
  const scripts = createRepoScripts({ repoRoot: self, selfRoot: self, spawnFn: spawnFn.fn });
  assert.equal(scripts.run("agent-heartbeat.sh", []), false);
  assert.equal(spawnFn.calls.length, 0);
});

test("SCRIPTS-4: a spawn that throws is reported on the bus, never swallowed and never thrown", () => {
  const self = repoWithScripts();
  const emitted = [];
  const scripts = createRepoScripts({ repoRoot: self, selfRoot: self, spawnFn: () => { throw new Error("ENOENT bash"); }, emit: (n, d) => emitted.push([n, d]) });
  assert.equal(scripts.run("agent-heartbeat.sh", []), false);
  assert.equal(emitted[0]?.[0], "bus.script-failed");
  assert.match(emitted[0][1].error, /ENOENT/);
});

test("SCRIPTS-4b: an ASYNC spawn failure (bash missing → 'error' event) is reported, not an unhandled crash", () => {
  // spawn() reports ENOENT as an 'error' EVENT after it returns — the try/catch never sees it,
  // and an EventEmitter with no 'error' listener throws, which would take the server down.
  const self = repoWithScripts();
  const emitted = [];
  const child = new EventEmitter();
  const scripts = createRepoScripts({ repoRoot: self, selfRoot: self, spawnFn: () => child, emit: (n, d) => emitted.push([n, d]) });
  assert.equal(scripts.run("agent-heartbeat.sh", []), true);
  assert.doesNotThrow(() => child.emit("error", new Error("spawn bash ENOENT")));
  assert.equal(emitted[0]?.[0], "bus.script-failed");
  assert.match(emitted[0][1].error, /ENOENT/);
});

// ── the wiring: SCRIPTS-1 passes against a server that never calls the gate ──────
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit));
    else if (v && typeof v === "object" && typeof v.type === "string") walk(v, visit);
  }
}

test("SCRIPTS-WIRED: no runtime module spawns bash directly — every repo script goes through the gate", () => {
  const offenders = [];
  for (const f of ["server.mjs", "factory.mjs", "self-heal.mjs"]) {
    const ast = parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), { ecmaVersion: "latest", sourceType: "module", locations: true });
    walk(ast, (n) => {
      if (n.type === "CallExpression" && n.callee?.name === "spawn" && n.arguments[0]?.type === "Literal" && n.arguments[0].value === "bash") {
        offenders.push(`${f}:${n.loc?.start?.line ?? n.start}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "a raw bash spawn bypasses the repo-scripts gate");
  for (const f of ["server.mjs", "factory.mjs"]) {
    assert.match(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), /createRepoScripts\(/, `${f} must build its scripts through the gate`);
  }
});

test("SCRIPTS-BUS-WIRED: server.mjs's gate emits a skipped script to the runtime bus, not into a no-op", () => {
  const ast = parse(readFileSync(new URL("../server.mjs", import.meta.url), "utf8"), { ecmaVersion: "latest", sourceType: "module" });
  let emitProp = null;
  walk(ast, (n) => {
    if (n.type === "CallExpression" && n.callee?.name === "createRepoScripts") {
      emitProp = n.arguments[0]?.properties?.find((p) => p.key?.name === "emit") ?? emitProp;
    }
  });
  assert.ok(emitProp, "the server's gate has no emit — a foreign repo's report would vanish");
  let reachesBus = false;
  walk(emitProp.value, (n) => {
    if (n.type === "CallExpression" && n.callee?.object?.name === "events" && n.callee?.property?.name === "emit") reachesBus = true;
  });
  assert.ok(reachesBus, "emit must call events.emit");
});

test("SCRIPTS-GUARD: the gate is itself behind the floor", () => {
  assert.equal(CORE_GUARD.test("agent-runtime/repo-scripts.mjs"), true);
  assert.equal(applyAllowed("agent-runtime/repo-scripts.mjs"), false);
});

test("SCRIPTS-SELF (GOOD): the default selfRoot is this runtime's own repo root", () => {
  const spawnFn = spy();
  const self = resolve(new URL("../..", import.meta.url).pathname);
  createRepoScripts({ repoRoot: self, allow: false, spawnFn: spawnFn.fn, exists: () => true }).run("agent-heartbeat.sh", []);
  assert.equal(spawnFn.calls.length, 1, "on MissionAlpha itself the swarm bus must keep working");
});

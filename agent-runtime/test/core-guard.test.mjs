// #9 — THE SWARM MAY WORK ON ITSELF, BUT NEVER ON THE THING THAT DECIDES WHAT IT MAY DO.
//
// The appliable scope was `["src","public"]` plus README and package.json. On a repo whose
// own product IS `agent-runtime/`, that means most self-directed work is unappliable by
// construction — observed live, `sr-frontend` produced a correct file under
// `agent-runtime/providers/` four times and every one was dropped as "no appliable diff".
//
// Widening it is the requested change. Widening it WITHOUT a floor would be a mistake of a
// different order: an agent that can edit `guards.mjs` can delete the check that stopped
// it, an agent that can edit `broker.mjs` can add a second write path, and an agent that
// can edit `quality.json` chooses what gets EXECUTED in the jail. The human approval gate
// is not a sufficient answer either — a diff that quietly relaxes a predicate is exactly
// the kind a tired reviewer waves through.
//
// So: CORE_GUARD is checked BEFORE the allow-list and is not configurable. `RUNTIME_SEED_DIRS`
// can widen or narrow everything else; it can never reach these. The broker must never be
// the tool that edits the broker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAllowed, CORE_GUARD, RUNTIME_FLOOR, SEED_DIRS } from "../guards.mjs";

test("CG-1: the swarm can apply work under agent-runtime's test dirs and docs/", () => {
  // Phase E · 16 CHANGED THIS EXAMPLE. It was `agent-runtime/providers/credentials.mjs` — the
  // credential store — cited as ordinary work. providers/ is now a CORE_GUARD directory clause
  // (GUARD-3), so the example is an ordinary runtime file instead.
  // 2026-09-24: engine.mjs joined the floor; kpis.mjs (pure KPI arithmetic) is the ordinary example now.
  // Decision #1 (2026-09-27): agent-runtime/ is deny-by-default — its modules are no longer ordinary
  // work, only its test dirs are (runtime-floor.test.mjs RTF-1..7 pins the whole tree).
  assert.equal(applyAllowed("agent-runtime/kpis.mjs"), false);
  assert.equal(applyAllowed("agent-runtime/adapters/slack.mjs"), false);
  assert.equal(applyAllowed("agent-runtime/test/queue.test.mjs"), true);
  assert.equal(applyAllowed("docs/adr/ADR-099-something.md"), true);
  // …and everything that was appliable before still is.
  assert.equal(applyAllowed("src/lib/queueModel.ts"), true);
  assert.equal(applyAllowed("public/billsplit.html"), true);
  assert.equal(applyAllowed("README.md"), true);
});

test("CG-2: the files that DEFINE the boundary are refused, and cannot be un-refused", () => {
  for (const p of [
    "agent-runtime/guards.mjs",        // applyAllowed itself
    "agent-runtime/broker.mjs",        // the only write path
    "agent-runtime/workspace.mjs",     // path containment + hardened git args
    "agent-runtime/worktree.mjs",      // isolation + the snapshot deny-list
    "agent-runtime/sandbox.mjs",       // the jail
    "agent-runtime/quality.mjs",       // what may be EXECUTED
    "agent-runtime/test-gate.mjs",
    "agent-runtime/test-scope.mjs",
    "agent-runtime/quality-hook.mjs",  // the veto handler
    "agent-runtime/hooks.mjs",         // the veto MECHANISM — a fire() that never vetoes kills every gate
    "agent-runtime/policy.mjs",        // deny-by-default auto-apply
    "agent-runtime/secret-scrub.mjs",  // egress
    "agent-runtime/pr.mjs",            // push / PR ladder
    "agent-runtime/server.mjs",        // auth gates + the route table
    "factory/quality.json",            // the command the jail runs
    "factory/deploy.json",             // the command a deploy runs
  ]) {
    assert.equal(applyAllowed(p), false, `${p} must never be appliable`);
    assert.equal(CORE_GUARD.test(p), true, `${p} must be matched by CORE_GUARD, not by an accident of scope`);
  }
});

test("CG-3: CORE_GUARD beats a widened seed list — it is a floor, not a default", () => {
  // Whatever an operator sets RUNTIME_SEED_DIRS to, these paths stay refused. The check
  // runs BEFORE the seed comparison, so there is no configuration that reaches them.
  assert.equal(CORE_GUARD.test("agent-runtime/guards.mjs"), true);
  assert.equal(CORE_GUARD.test("scripts/doctor.mjs"), false, "CORE_GUARD is narrow — it guards the boundary, not the repo");
});

test("CG-4: the guard is case-insensitive and cannot be dodged by path shape", () => {
  assert.equal(applyAllowed("agent-runtime/GUARDS.mjs"), false);
  assert.equal(applyAllowed("agent-runtime/./guards.mjs"), false);
  assert.equal(applyAllowed("agent-runtime/providers/../guards.mjs"), false);
  assert.equal(applyAllowed("./agent-runtime/broker.mjs"), false);
});

test("CG-5: a neighbouring name is NOT swept up — the guard is exact, not a prefix", () => {
  // `guards.mjs` is guarded; a file that merely starts the same way is not CORE_GUARD. The regex
  // must stay exact because fatalScopeProblem uses it to reject a LITERAL scope entry.
  // Decision #1 (2026-09-27): those neighbours are still refused by applyAllowed — by RUNTIME_FLOOR,
  // not by CORE_GUARD — so the exactness is asserted on the regex itself.
  for (const p of ["agent-runtime/guardsHelper.mjs", "agent-runtime/broker-notes.md", "agent-runtime/providers-legacy/pr-helpers.mjs"]) {
    assert.equal(CORE_GUARD.test(p), false, p);
    assert.equal(RUNTIME_FLOOR.test(p), true, p);
    assert.equal(applyAllowed(p), false, p);
  }
});

test("CG-6: exec and secret surfaces stay out of scope entirely", () => {
  // scripts/ runs on the HOST via npm; .github/ is CI. Neither is widened, and the
  // pre-existing APPLY_DENY still covers secrets and vcs internals.
  assert.equal(applyAllowed("scripts/doctor.mjs"), false);
  assert.equal(applyAllowed(".github/workflows/ci.yml"), false);
  assert.equal(applyAllowed(".env"), false);
  assert.equal(applyAllowed("agent-runtime/.env.local"), false);
  assert.equal(applyAllowed("agent-runtime/data/mission.db"), false);
  assert.equal(applyAllowed("node_modules/evil/index.js"), false);
});

test("CG-7: the default scope is explicit, so a silent widening shows up as a test failure", () => {
  assert.deepEqual(SEED_DIRS, ["src", "public", "agent-runtime", "docs"]);
});

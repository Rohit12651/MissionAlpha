// Phase 14 · task 14.1 — the deterministic harness writes INSIDE the seat's writeScope.
//
// FOUND BY THE LOOP TEST, and it had been true since Phase 7. The harness always wrote
// `src/build-<seat>.txt`; `sr-backend` is scoped to `src/lib/**`. The broker therefore filtered
// the entire canned diff away, the seat reported an empty diff, and the task terminal-failed —
// so the "whole SDLC with no model" could not reach `held` for ANY seat with a narrow scope.
// The harness was green and was proving a system nobody runs.
//
// These are the FAST guards. The end-to-end proof is loop-paste-to-shipped.test.mjs; a
// hundred-second integration test is a poor place for the only assertion about a path.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createDeterministicSpawner } from "../engine-spawner.mjs";

/** Capture what the spawner would write, without touching a disk. */
function capture(writeScopeFor) {
  const wrote = [];
  const spawner = createDeterministicSpawner({
    writeScopeFor,
    mkdir: async () => {},
    writeFile: async (abs) => { wrote.push(String(abs)); },
  });
  return { spawner, wrote };
}

const relOf = (abs, workdir) => String(abs).slice(workdir.length + 1);

test("SPAWN-1: a scoped seat is written INSIDE its scope, not at the old src/ root", async () => {
  const { spawner, wrote } = capture((id) => (id === "sr-backend" ? ["src/lib/**", "agent-runtime/**"] : []));
  await spawner.dispatch({ agentId: "sr-backend", workdir: "/tmp/wt", task: "build it" });
  assert.equal(relOf(wrote[0], "/tmp/wt"), "src/lib/build-sr-backend.txt",
    "the canned diff landed outside the seat's writeScope — the broker will drop all of it");
});

test("SPAWN-2: a DEEP scope is honoured too — this is what a fresh HIRE gets", async () => {
  // HR derives a hire's scope from the work, e.g. `src/lib/notifications/**`. A harness that
  // ignores it makes every hired seat fail on its first task.
  const { spawner, wrote } = capture(() => ["src/lib/notifications/**"]);
  await spawner.dispatch({ agentId: "notifications-engineer", workdir: "/tmp/wt", task: "build it" });
  assert.equal(relOf(wrote[0], "/tmp/wt"), "src/lib/notifications/build-notifications-engineer.txt");
});

test("SPAWN-3: a scope with NO literal prefix falls back to src/ — the original behaviour", async () => {
  for (const scope of [[], ["**/*.test.*"], ["**"], [""]]) {
    const { spawner, wrote } = capture(() => scope);
    await spawner.dispatch({ agentId: "qa", workdir: "/tmp/wt", task: "t" });
    assert.equal(relOf(wrote[0], "/tmp/wt"), "src/build-qa.txt", `scope ${JSON.stringify(scope)} did not fall back`);
  }
});

test("SPAWN-4: a hostile scope cannot traverse out of the worktree", async () => {
  // The scope comes from roster.json, which the operator owns — but it reaches a filesystem
  // path, so it is treated as input rather than trusted.
  for (const scope of [["../../etc/**"], ["/etc/**"], ["src/../../**"], ["src/.."]]) {
    const { spawner, wrote } = capture(() => scope);
    await spawner.dispatch({ agentId: "seat", workdir: "/tmp/wt", task: "t" });
    // ASSERT ON THE ABSOLUTE PATH. The first cut of this checked the RELATIVE one, computed by
    // slicing the workdir prefix off — but `join()` normalises `../..` away first, so an escape
    // to `/etc/build-seat.txt` sliced into `c/build-seat.txt`: no "..", no leading "/", test
    // green. The mutation proof is what showed it. Containment is a question about where the
    // path ENDS UP, never about the characters it was written with.
    const abs = wrote[0];
    assert.ok(abs.startsWith("/tmp/wt/"), `scope ${JSON.stringify(scope)} escaped the worktree: ${abs}`);
  }
});

test("SPAWN-5: with NO writeScopeFor injected the behaviour is exactly pre-Phase-7", async () => {
  const wrote = [];
  const spawner = createDeterministicSpawner({ mkdir: async () => {}, writeFile: async (abs) => { wrote.push(String(abs)); } });
  await spawner.dispatch({ agentId: "sr-backend", workdir: "/tmp/wt", task: "t" });
  assert.equal(relOf(wrote[0], "/tmp/wt"), "src/build-sr-backend.txt");
});

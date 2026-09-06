// Phase 1 / R1 — the POST-EDIT QUALITY-GATE HANDLER.
//
// The hook DISPATCHER shipped wired (hooks.mjs, engineDispatchTracked) but NOTHING was
// registered on it, so the veto path was live and unreachable — a safety mechanism with
// no user. This is its first real user.
//
// THE CENTRAL DESIGN JUDGEMENT, pinned by INFRA-*: "the gate could not run" is NOT "the
// code is bad". A missing Docker daemon, an unreadable quality config, a gate that throws
// — none of those are evidence about the diff, and vetoing on them would make every
// autonomous run on a machine without Docker die at the same place forever. That is
// precisely ruflo's dead-daemon failure: a guard whose own unavailability wedges the
// system it was meant to protect. So the handler fails OPEN on infrastructure and fails
// CLOSED on an actual test failure, and the two are distinguished by the gate's own
// `reason` field rather than by guesswork.
//
// This is a QUALITY control, not a containment control. Failing open loses a signal; it
// does not widen what a run can reach. Worktree isolation, the broker, the risk band and
// the human decision are all downstream and unaffected.
//
// STORY-1 pins the other half: a story-build task ALREADY runs this exact gate inside
// engine.runStep (post-diff, pre-mint). Firing it again here would run the container
// twice per story turn for one verdict.

import test from "node:test";
import assert from "node:assert/strict";
import { createQualityGateHook } from "../quality-hook.mjs";

const ctxOf = (over = {}) => ({ agentId: "a1", taskId: "task_abc123", workdir: "/wt/task_abc123", ...over });

function fakeGate(verdict) {
  const calls = [];
  return {
    calls,
    run: async (args) => { calls.push(args); return typeof verdict === "function" ? verdict(args) : verdict; },
  };
}

test("QH-1: a PASSING gate does not veto", async () => {
  const gate = fakeGate({ pass: true, tail: "ok", exitCode: 0, timedOut: false });
  const hook = createQualityGateHook({ gate });
  assert.equal(await hook(ctxOf()), undefined);
  assert.equal(gate.calls.length, 1);
  assert.equal(gate.calls[0].workdir, "/wt/task_abc123");
});

test("QH-2: a FAILING gate VETOES and the reason carries the test tail", async () => {
  const gate = fakeGate({ pass: false, tail: "1 failing\nAssertionError: expected 2", exitCode: 1, timedOut: false });
  const out = await createQualityGateHook({ gate })(ctxOf());
  assert.equal(out.abort, true);
  assert.match(out.reason, /quality gate/i);
  assert.match(out.reason, /AssertionError/);
});

test("QH-3: a TIMED-OUT gate vetoes and says so — a hung test is a failed gate", async () => {
  const gate = fakeGate({ pass: false, tail: "", exitCode: -1, timedOut: true });
  const out = await createQualityGateHook({ gate })(ctxOf());
  assert.equal(out.abort, true);
  assert.match(out.reason, /timed out/i);
});

test("STORY-1: a story task is SKIPPED — engine.runStep already gates it, once is enough", async () => {
  const gate = fakeGate({ pass: false, tail: "would have vetoed", exitCode: 1 });
  const out = await createQualityGateHook({ gate })(ctxOf({ storyId: "story_1" }));
  assert.equal(out, undefined);
  assert.equal(gate.calls.length, 0, "the container must not run a second time for one verdict");
});

test("QH-4: no workdir → nothing to test, no veto, gate never invoked", async () => {
  const gate = fakeGate({ pass: false, tail: "x", exitCode: 1 });
  assert.equal(await createQualityGateHook({ gate })(ctxOf({ workdir: null })), undefined);
  assert.equal(gate.calls.length, 0);
});

test("INFRA-1: sandbox-unavailable does NOT veto — a missing daemon is not a code failure", async () => {
  const logs = [];
  const gate = fakeGate({ pass: false, tail: "Docker daemon not reachable", exitCode: -1, reason: "sandbox-unavailable" });
  const out = await createQualityGateHook({ gate, log: (m) => logs.push(m) })(ctxOf());
  assert.equal(out, undefined, "an unavailable gate must never wedge every autonomous run");
  assert.ok(logs.some((l) => /sandbox-unavailable/.test(l)), "and it must be LOUD — a silent skip is the outage class this program kills");
});

test("INFRA-2: every infrastructure reason fails OPEN, and the set is closed", async () => {
  for (const reason of ["sandbox-unavailable", "sandbox-error", "config", "no-worktree", "workdir-escape"]) {
    const gate = fakeGate({ pass: false, tail: reason, exitCode: -1, reason });
    assert.equal(await createQualityGateHook({ gate })(ctxOf()), undefined, `${reason} must fail open`);
  }
  // …but a failure with NO infrastructure reason is a real verdict and still vetoes.
  const real = fakeGate({ pass: false, tail: "tests failed", exitCode: 1 });
  assert.equal((await createQualityGateHook({ gate: real })(ctxOf())).abort, true);
});

test("INFRA-3: a gate that THROWS fails open and is logged", async () => {
  const logs = [];
  const gate = { run: async () => { throw new Error("boom"); } };
  assert.equal(await createQualityGateHook({ gate, log: (m) => logs.push(m) })(ctxOf()), undefined);
  assert.ok(logs.some((l) => /boom/.test(l)));
});

test("INFRA-4: an unusable gate verdict (null) fails open rather than guessing", async () => {
  const gate = fakeGate(null);
  assert.equal(await createQualityGateHook({ gate })(ctxOf()), undefined);
});

test("QH-5: the veto reason is BOUNDED — test output never floods the failure path", async () => {
  const gate = fakeGate({ pass: false, tail: "x".repeat(50_000), exitCode: 1 });
  const out = await createQualityGateHook({ gate })(ctxOf());
  assert.equal(out.abort, true);
  assert.ok(out.reason.length <= 600, `reason was ${out.reason.length} chars`);
});

test("QH-6: the gate is handed the identifiers it records loop steps under", async () => {
  const gate = fakeGate({ pass: true });
  await createQualityGateHook({ gate })(ctxOf());
  assert.equal(gate.calls[0].task.taskId, "task_abc123");
  assert.equal(gate.calls[0].task.agentId, "a1");
});

test("QH-7: a missing gate seam is inert, never a throw — an unregistered dep cannot veto", async () => {
  assert.equal(await createQualityGateHook({})(ctxOf()), undefined);
});

// ── D1 — a timeout is only EVIDENCE when we chose the command ────────────────────
// The gate ran the whole repo suite under a 120s deadline and vetoed every task on the
// timeout. A suite that could not finish says nothing about the diff; a THREE-file run
// that could not finish says a great deal. The gate reports which one it was.
test("QH-D1a: an UNSCOPED timeout is infrastructure — no veto, proceed unverified", async () => {
  const logs = [];
  const hook = createQualityGateHook({
    gate: { run: async () => ({ pass: false, timedOut: true, scoped: false, reason: "gate-timeout-unscoped", tail: "killed" }) },
    log: (m) => logs.push(m),
  });
  const r = await hook({ taskId: "t", agentId: "a", workdir: "/wt" });
  assert.equal(r, undefined, "a command we did not choose must not condemn the diff");
  assert.match(logs.join("\n"), /gate-timeout-unscoped/);
});

test("QH-D1b: a SCOPED timeout still vetoes — that one IS about the diff", async () => {
  const hook = createQualityGateHook({
    gate: { run: async () => ({ pass: false, timedOut: true, scoped: true, tail: "" }) },
    log: () => {},
  });
  const r = await hook({ taskId: "t", agentId: "a", workdir: "/wt" });
  assert.equal(r?.abort, true);
  assert.match(r.reason, /timed out/);
});

test("QH-D1c: scope-empty is a PASS and never reaches the veto path", async () => {
  const hook = createQualityGateHook({
    gate: { run: async () => ({ pass: true, reason: "scope-empty", scoped: true, tail: "no related tests" }) },
    log: () => {},
  });
  assert.equal(await hook({ taskId: "t", agentId: "a", workdir: "/wt" }), undefined);
});

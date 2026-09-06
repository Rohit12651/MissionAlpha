// BOSS dispatch — what the operator is TOLD happened, vs what happened.
//
// THE BUG THIS PINS. `fireDispatch` did two independent things per directive: recorded it
// on the audit bus, then POSTed /runtime/<agent>/run to actually start the agent. It then
// reported success counted from the FIRST one only, and never read the second's response:
//
//     ).catch(() => {}),                       // a 400 RESOLVES — this catches nothing
//     setDispatchMsg(`dispatched ${ok}/… · ${taskDirs.length} agent(s) running`)
//
// So with RUNTIME_TOOLS unset every run POST answered 400 "runtime not in write mode",
// and the console still said "dispatched 2/2 · 2 agent(s) running". The operator watched
// for agent chatter that could never come, and no surface anywhere said why.
//
// A report derived from the wrong signal is worse than no report: it spends the operator's
// trust on a claim the system never checked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeDispatch, type RunOutcome } from "../dispatchOutcome.ts";

const ok = (target: string): RunOutcome => ({ target, ok: true });
const bad = (target: string, error: string): RunOutcome => ({ target, ok: false, error });

test("ALL-OK: every run started → says so, names no failure", () => {
  const s = summarizeDispatch({ recorded: 2, total: 2, runs: [ok("architect"), ok("sre")] });
  assert.equal(s.tone, "ok");
  assert.match(s.message, /2\s*\/\s*2/);
  assert.match(s.message, /running/i);
  assert.doesNotMatch(s.message, /fail/i);
});

test("BUG-1: a run that returned 400 is NOT counted as running", () => {
  // The exact regression: recorded=2 (audit fine), but both runs refused.
  const s = summarizeDispatch({
    recorded: 2, total: 2,
    runs: [bad("architect", "runtime not in write mode (RUNTIME_TOOLS=write)"),
           bad("sre", "runtime not in write mode (RUNTIME_TOOLS=write)")],
  });
  assert.notEqual(s.tone, "ok");
  assert.doesNotMatch(s.message, /2 agent\(s\) running/,
    "must never claim agents are running when every run was refused");
  assert.match(s.message, /0\s*\/\s*2|none/i);
});

test("BUG-2: the REASON is surfaced — a silent failure is the whole defect", () => {
  const s = summarizeDispatch({
    recorded: 1, total: 1,
    runs: [bad("architect", "runtime not in write mode (RUNTIME_TOOLS=write)")],
  });
  assert.match(s.message, /write mode/i, `reason missing from: ${s.message}`);
});

test("PARTIAL: mixed results report BOTH halves honestly", () => {
  const s = summarizeDispatch({
    recorded: 2, total: 2,
    runs: [ok("architect"), bad("sre", "HTTP 500")],
  });
  assert.equal(s.tone, "warn");
  assert.match(s.message, /1\s*\/\s*2/);
  assert.match(s.message, /sre/);
});

test("AUDIT-FAIL: a directive that never even recorded is reported too", () => {
  const s = summarizeDispatch({ recorded: 1, total: 2, runs: [ok("architect")] });
  assert.notEqual(s.tone, "ok");
  assert.match(s.message, /1\s*\/\s*2/);
});

test("NO-TASKS: ack/respawn only — no run POSTs, so no 'running' claim", () => {
  const s = summarizeDispatch({ recorded: 2, total: 2, runs: [] });
  assert.equal(s.tone, "ok");
  assert.doesNotMatch(s.message, /running/i);
});

test("ROBUST: malformed input never throws and never claims success", () => {
  for (const bad2 of [undefined, null, {}, { recorded: "x", total: "y", runs: "z" }]) {
    const s = summarizeDispatch(bad2 as never);
    assert.ok(typeof s.message === "string" && s.message.length > 0);
    assert.doesNotMatch(s.message, /\d+ agent\(s\) running/);
  }
});

test("BOUNDED: a flood of failures cannot produce an unbounded banner", () => {
  const runs = Array.from({ length: 50 }, (_, i) => bad(`agent-${i}`, "x".repeat(500)));
  const s = summarizeDispatch({ recorded: 50, total: 50, runs });
  assert.ok(s.message.length <= 300, `message was ${s.message.length} chars`);
});

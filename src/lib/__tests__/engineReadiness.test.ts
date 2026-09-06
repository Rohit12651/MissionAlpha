// PHASE 2 TASK 2.1 — the readiness client's pure surface.
//
// What these pin is the honesty of the LABELS, because that is where this program keeps
// finding defects: "never measured" collapsed into "cannot", or a refusal that names a
// BRAND as the remedy for a missing measurement. Both were real, and both shipped green.

import test from "node:test";
import assert from "node:assert/strict";

import {
  standingLabel,
  standingTone,
  probeWouldHelp,
  READINESS_PATH,
  type EngineReadiness,
  type EngineStandingState,
} from "../engineReadiness.ts";

const ALL: EngineStandingState[] = ["runs", "cannot", "unmeasured", "none", "backend", "deterministic"];

const readiness = (over: Partial<EngineReadiness>): EngineReadiness => ({
  ready: false,
  standing: "unmeasured",
  capability: "chat_only",
  account: { id: "a1", label: "nim", providerType: "custom", model: "nemotron", authMethod: "api_key" },
  explanation: "this model has not been probed for tool support yet",
  spendCap: "Spend cap: not measured.",
  refusal: "…cannot run the autonomous engine…",
  probePath: "/runtime/accounts/a1/probe",
  ...over,
});

test("every standing has a label, and none of them names a brand", () => {
  for (const s of ALL) {
    const label = standingLabel(s);
    assert.ok(label.length > 0, `${s} has no label`);
    assert.doesNotMatch(label, /claude|openai|gpt|nvidia/i, `${s} names a brand`);
  }
});

test("only 'runs' and the soak harness read as OK", () => {
  assert.equal(standingTone("runs"), "ok");
  assert.equal(standingTone("deterministic"), "ok");
  assert.equal(standingTone("cannot"), "error");
  assert.equal(standingTone("none"), "error");
  assert.equal(standingTone("backend"), "error");
});

test("UNMEASURED is a warning, not an error — nobody has asked the model yet", () => {
  assert.equal(standingTone("unmeasured"), "warn");
  assert.notEqual(standingLabel("unmeasured"), standingLabel("cannot"));
});

test("the probe is offered exactly when it is the real next step", () => {
  assert.equal(probeWouldHelp(readiness({ standing: "unmeasured" })), true);
  assert.equal(probeWouldHelp(readiness({ standing: "cannot" })), true);
  // A ready engine needs no probe, and there is nothing to probe without an account.
  assert.equal(probeWouldHelp(readiness({ standing: "runs", ready: true })), false);
  assert.equal(probeWouldHelp(readiness({ standing: "none", probePath: null })), false);
  // A disabled transport is not fixed by re-asking the model — offering the probe there
  // would be a control that cannot succeed, which is the defect this task exists to kill.
  assert.equal(probeWouldHelp(readiness({ standing: "backend" })), false);
});

test("the path is the engine namespace, which is where the runtime enumerates it", () => {
  assert.equal(READINESS_PATH, "/runtime/engine/readiness");
});

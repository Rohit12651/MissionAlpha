// PHASE 2 TASK 2.1 — READINESS, STATED HONESTLY.
//
// The defect this closes: the Command Center rendered its controls as if the engine could
// always dispatch. When the active account had not demonstrated tool support, queueing work
// produced a refusal deep in the loop — a task that failed for a reason the operator was
// never shown. "A control that cannot succeed must not be rendered as if it could" is the
// Phase 4 lesson; this is the measurement that lets the UI obey it.
//
// ONE PREDICATE. engineDispatch's refusal and the readiness surface must be computed from
// the same function, or they drift and the UI eventually promises something the loop
// refuses — which is precisely how the deleted capability table survived so long.

import { test } from "node:test";
import assert from "node:assert/strict";

import { engineReadiness } from "../engine-readiness.mjs";

const claudeCli = { id: "a1", label: "work", providerType: "claude", authMethod: "subscription", capability: "swarm" };
const probed = {
  id: "a2", label: "nim", providerType: "custom", authMethod: "api_key", capability: "swarm", model: "nemotron",
  toolProbe: { capability: "swarm", capable: true, model: "nemotron", reason: "the model returned a well-formed tool call", reportsCost: false, probedAt: 1 },
};
const refused = {
  id: "a3", label: "tiny", providerType: "openai", authMethod: "api_key", capability: "chat_only", model: "tiny",
  toolProbe: { capability: "chat_only", capable: false, model: "tiny", reason: "the model answered without calling the tool it was given", reportsCost: null, probedAt: 1 },
};
const unprobed = { id: "a4", label: "fresh", providerType: "custom", authMethod: "api_key", capability: "chat_only", model: "m" };

test("NO ACTIVE ACCOUNT is not ready, and says so without naming a brand", () => {
  const r = engineReadiness(null, { backend: "cli" });
  assert.equal(r.ready, false);
  assert.equal(r.standing, "none");
  assert.equal(r.account, null);
  assert.match(r.refusal, /no active account/i);
  assert.doesNotMatch(r.refusal, /claude/i, "the remedy is an account, not a brand");
});

test("a Claude account on a real backend is ready", () => {
  const r = engineReadiness(claudeCli, { backend: "cli" });
  assert.equal(r.ready, true);
  assert.equal(r.standing, "runs");
  assert.equal(r.refusal, null);
  assert.equal(r.account.label, "work");
  assert.equal(r.account.id, "a1");
});

test("a PROBED non-Claude account is ready on exactly the same terms", () => {
  const r = engineReadiness(probed, { backend: "cli" });
  assert.equal(r.ready, true);
  assert.equal(r.standing, "runs");
  assert.match(r.explanation, /well-formed tool call/);
});

test("a model that REFUSED the probe is not ready, and the reason is the measurement", () => {
  const r = engineReadiness(refused, { backend: "cli" });
  assert.equal(r.ready, false);
  assert.equal(r.standing, "cannot");
  assert.match(r.refusal, /answered without calling the tool/);
  assert.doesNotMatch(r.refusal, /switch to a claude account/i);
  assert.equal(r.probePath, "/runtime/accounts/a3/probe", "the fix must be one click away");
});

test("an UNMEASURED account is its own state — not 'cannot'", () => {
  const r = engineReadiness(unprobed, { backend: "cli" });
  assert.equal(r.ready, false);
  assert.equal(r.standing, "unmeasured");
  assert.match(r.explanation, /not been probed/);
  assert.equal(r.probePath, "/runtime/accounts/a4/probe");
});

test("a stale probe (the model changed) reverts to unmeasured, never to a stale yes", () => {
  const moved = { ...probed, model: "nemotron-v2" };
  const r = engineReadiness(moved, { backend: "cli" });
  assert.equal(r.ready, false);
  assert.equal(r.standing, "unmeasured");
  assert.match(r.explanation, /model changed/);
});

test("a Claude account on the MOCK backend is honestly NOT ready — no model exists to run", () => {
  const r = engineReadiness(claudeCli, { backend: "mock" });
  assert.equal(r.ready, false);
  assert.equal(r.standing, "backend");
  assert.match(r.refusal, /mock/i);
});

test("the mock backend does NOT block a probed non-Claude account — it drives its own HTTP endpoint", () => {
  // BACKEND names the CLAUDE transport. An OpenAI-compatible account never spawns the CLI,
  // so gating it on that env var would refuse a provider for a reason that is not about it.
  const r = engineReadiness(probed, { backend: "mock" });
  assert.equal(r.ready, true);
});

test("the spend-cap sentence rides along, so the operator sees what the $ ceiling really binds", () => {
  assert.match(engineReadiness(probed, { backend: "cli" }).spendCap, /NOT enforceable/);
  assert.match(engineReadiness(claudeCli, { backend: "cli" }).spendCap, /Claude CLI/);
});

test("the deterministic soak spawner makes the engine ready regardless of the account", () => {
  // The autonomy soak substitutes the model's diff-authoring step with a canned diff. If
  // readiness ignored that, the Command Center would report "cannot dispatch" while the
  // engine was demonstrably dispatching — a surface disagreeing with the loop it describes.
  const r = engineReadiness(null, { backend: "mock", deterministic: true });
  assert.equal(r.ready, true);
  assert.equal(r.standing, "deterministic");
  assert.match(r.explanation, /deterministic/i);
});

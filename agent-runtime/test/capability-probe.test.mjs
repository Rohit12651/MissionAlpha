// PHASE 1 TASK 1.3 — capability is a MEASUREMENT, not a table entry.
//
// The defect being deleted: five hardcoded `capability: "chat_only"` literals that never
// asked a model anything, refusing GPT/Nemotron/MiniMax/Z.ai from autonomous work all of
// them can do. These tests pin the replacement, including the part that matters most —
// the probe FAILS CLOSED on anything it could not verify.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  probeToolCapability,
  resolveCapability,
  probeIsStale,
  capabilityExplanation,
  spendCapExplanation,
  CAPABILITY,
  PROBE_TOOL,
} from "../providers/capability-probe.mjs";

const sse = (frames) => ({
  ok: true,
  status: 200,
  body: (async function* () {
    for (const f of frames) yield `data: ${JSON.stringify(f)}\n`;
    yield "data: [DONE]\n";
  })(),
});
const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj, body: null });

const toolFrame = (name, args) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id: "p1", type: "function", function: { name, arguments: args } }] } }],
});
const textFrame = (t) => ({ choices: [{ delta: { content: t } }] });

const stub = (responses) => async () => {
  const n = responses.shift();
  if (!n) throw new Error("stub exhausted");
  if (typeof n === "function") return n();
  return n;
};
const base = { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "some-model", now: () => 1000 };

test("a model that calls the probe tool IS swarm-capable, whatever its brand", async () => {
  const r = await probeToolCapability({
    ...base,
    fetchImpl: stub([sse([toolFrame(PROBE_TOOL.function.name, '{"ok":true}')])]),
  });
  assert.equal(r.capable, true);
  assert.equal(r.capability, CAPABILITY.SWARM);
  assert.equal(r.model, "some-model");
  assert.equal(r.probedAt, 1000);
});

test("a model that only answers with TEXT is not capable", async () => {
  const r = await probeToolCapability({
    ...base,
    fetchImpl: stub([sse([textFrame("Sure, I can call tools!")]), sse([textFrame("still text")])]),
  });
  assert.equal(r.capable, false);
  assert.equal(r.capability, CAPABILITY.CHAT_ONLY);
  assert.match(r.reason, /without calling the tool/i);
});

test("FAIL CLOSED — a transport error is never reported as capable", async () => {
  const r = await probeToolCapability({
    ...base,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(r.capable, false);
  assert.match(r.reason, /could not be reached/i);
});

test("FAIL CLOSED — a malformed tool call is not capability", async () => {
  const r = await probeToolCapability({
    ...base,
    fetchImpl: stub([sse([toolFrame(PROBE_TOOL.function.name, '{"ok":')])]),
  });
  assert.equal(r.capable, false);
  assert.match(r.reason, /could not be parsed/i);
});

test("FAIL CLOSED — no endpoint or key means no claim either way", async () => {
  const r = await probeToolCapability({ baseUrl: "", apiKey: "", model: "m" });
  assert.equal(r.capable, false);
  assert.match(r.reason, /no endpoint or key/i);
});

test("a streamed probe that drops the calls is retried non-streamed before concluding", async () => {
  // The distinction the old table erased: "this model cannot call tools" versus "this
  // server streams them badly". Only the first is a statement about the model.
  const r = await probeToolCapability({
    ...base,
    fetchImpl: stub([
      sse([textFrame("")]),
      jsonRes({
        choices: [{ message: { content: "", tool_calls: [{ id: "p", type: "function", function: { name: PROBE_TOOL.function.name, arguments: '{"ok":true}' } }] } }],
      }),
    ]),
  });
  assert.equal(r.capable, true);
  assert.match(r.reason, /non-streamed/i);
});

test("a streaming-hostile server is retried non-streamed rather than judged", async () => {
  const r = await probeToolCapability({
    ...base,
    fetchImpl: stub([
      () => { throw new Error("stream_options unsupported"); },
      jsonRes({
        choices: [{ message: { content: "", tool_calls: [{ id: "p", type: "function", function: { name: PROBE_TOOL.function.name, arguments: '{"ok":true}' } }] } }],
      }),
    ]),
  });
  assert.equal(r.capable, true);
});

// ── resolveCapability: which answer is actually in force ─────────────────────

test("a PROBE for the current model beats any preset", () => {
  const acct = {
    providerType: "custom",
    model: "nemotron",
    toolProbe: { capability: CAPABILITY.SWARM, model: "nemotron", reason: "ok" },
  };
  assert.equal(resolveCapability(acct), CAPABILITY.SWARM, "a probed custom provider must run the engine");
});

test("A PROBE AGAINST A DIFFERENT MODEL IS IGNORED — switching the model changes the subject", () => {
  const acct = {
    providerType: "custom",
    model: "new-model",
    toolProbe: { capability: CAPABILITY.SWARM, model: "old-model", reason: "ok" },
  };
  assert.equal(resolveCapability(acct), CAPABILITY.CHAT_ONLY);
  assert.equal(probeIsStale(acct), true);
});

test("an unprobed non-Claude account fails closed", () => {
  assert.equal(resolveCapability({ providerType: "openai", model: "gpt" }), CAPABILITY.CHAT_ONLY);
  assert.equal(probeIsStale({ providerType: "openai", model: "gpt" }), true);
});

test("Claude stays swarm without an HTTP probe — a TRANSPORT fact, not a brand privilege", () => {
  // Claude accounts drive the engine through the Claude CLI, which is a different
  // transport with no endpoint to probe. Any provider that passes the probe gets exactly
  // the same standing, which is the whole point of Principle 0.
  const acct = { providerType: "claude", authMethod: "subscription" };
  assert.equal(resolveCapability(acct), CAPABILITY.SWARM);
  assert.equal(probeIsStale(acct), false);
});

test("a probe recording chat_only is honoured — a real negative is a real answer", () => {
  const acct = {
    providerType: "openai",
    model: "tiny",
    toolProbe: { capability: CAPABILITY.CHAT_ONLY, model: "tiny", reason: "answered with text" },
  };
  assert.equal(resolveCapability(acct), CAPABILITY.CHAT_ONLY);
});

test("no account resolves to chat_only, never to a permissive default", () => {
  assert.equal(resolveCapability(null), CAPABILITY.CHAT_ONLY);
  assert.equal(resolveCapability(undefined), CAPABILITY.CHAT_ONLY);
});

test("the explanation names WHY, so the operator never meets a silent refusal", () => {
  assert.match(capabilityExplanation({ providerType: "claude" }), /Claude CLI/);
  assert.match(capabilityExplanation({ providerType: "openai", model: "m" }), /not been probed/);
  assert.match(
    capabilityExplanation({ providerType: "openai", model: "b", toolProbe: { capability: "swarm", model: "a" } }),
    /model changed/,
  );
  assert.match(
    capabilityExplanation({ providerType: "openai", model: "a", toolProbe: { capability: "chat_only", model: "a", reason: "answered with text" } }),
    /answered with text/,
  );
});

// ── PHASE 1 CLOSEOUT (P1-D) — the spend cap is only real when the provider REPORTS cost ──
//
// `maxUsd` is enforced from `usage.cost`, which in practice only OpenRouter sends. For a
// self-hosted vLLM / NIM / MiniMax / Z.ai endpoint `usdSpent` stays 0 and the ceiling never
// trips. That was disclosed in code and in Known Gaps but NOT surfaced to the operator, who
// therefore reads a $2 budget that does not exist. The honest fix is a MEASUREMENT taken on
// the same real call the probe already makes: did this endpoint report a cost?
//
// Three states, not two. `null` means "not measured" — reporting an unmeasured endpoint as
// "does not report cost" would be the same class of unearned claim the capability table was.

test("the probe MEASURES whether the endpoint reports a cost — true when it does", async () => {
  const r = await probeToolCapability({
    ...base,
    fetchImpl: stub([
      sse([
        toolFrame(PROBE_TOOL.function.name, '{"ok":true}'),
        { choices: [{ delta: {} }], usage: { total_tokens: 9, cost: 0.0004 } },
      ]),
    ]),
  });
  assert.equal(r.capable, true);
  assert.equal(r.reportsCost, true);
});

test("an endpoint that returns usage WITHOUT a cost reports false — the cap cannot bind it", async () => {
  const r = await probeToolCapability({
    ...base,
    fetchImpl: stub([
      sse([
        toolFrame(PROBE_TOOL.function.name, '{"ok":true}'),
        { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      ]),
    ]),
  });
  assert.equal(r.capable, true);
  assert.equal(r.reportsCost, false);
});

test("UNMEASURED stays null — a transport failure never becomes a claim about billing", async () => {
  const r = await probeToolCapability({
    ...base,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(r.capable, false);
  assert.equal(r.reportsCost, null);
});

test("a zero cost is still a REPORTED cost — the endpoint answered the question", async () => {
  const r = await probeToolCapability({
    ...base,
    fetchImpl: stub([
      sse([
        toolFrame(PROBE_TOOL.function.name, '{"ok":true}'),
        { choices: [{ delta: {} }], usage: { total_tokens: 9, cost: 0 } },
      ]),
    ]),
  });
  assert.equal(r.reportsCost, true);
});

// The operator-facing sentence for the spend cap. It must never say "capped" for an
// endpoint that reports nothing, and must not say "uncapped" for one nobody measured.
test("spendCapExplanation says which of the three states an account is in", () => {
  assert.match(
    spendCapExplanation({ providerType: "openai", model: "m", toolProbe: { model: "m", reportsCost: true } }),
    /enforce/i,
  );
  const unenforceable = spendCapExplanation({ providerType: "openai", model: "m", toolProbe: { model: "m", reportsCost: false } });
  assert.match(unenforceable, /does not report/i);
  assert.match(unenforceable, /step|wall|time/i, "must name the bounds that DO hold");
  assert.match(
    spendCapExplanation({ providerType: "openai", model: "m", toolProbe: { model: "m" } }),
    /not measured/i,
  );
  assert.match(spendCapExplanation({ providerType: "openai", model: "m" }), /not measured/i);
  // A probe of a DIFFERENT model tells you nothing about this one.
  assert.match(
    spendCapExplanation({ providerType: "openai", model: "b", toolProbe: { model: "a", reportsCost: true } }),
    /not measured/i,
  );
  // Claude runs through the CLI on a subscription — there is no per-call USD ceiling to enforce.
  assert.match(spendCapExplanation({ providerType: "claude" }), /Claude CLI/);
});

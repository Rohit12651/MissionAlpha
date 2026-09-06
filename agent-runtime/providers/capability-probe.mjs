// PHASE 1 TASK 1.3 — CAPABILITY BY PROBE, NOT BY TABLE.
//
// PRINCIPLE 0: the operator chooses the model; the app never chooses for them.
//
// What this replaces: `capability: "chat_only"` was stamped on openai/minimax/zai/custom in
// a hardcoded literal in registry.mjs, and only claude got "swarm". Those five literals
// never asked a model anything. They were a statement about OUR ADAPTER — which yielded
// text deltas and could not call a tool — written onto the PROVIDER, and they refused
// Nemotron, GPT, MiniMax and Z.ai from autonomous work that all of them can actually do.
//
// The honest test is behavioural: send a trivial tool and see whether the model calls it.
// A model that returns a well-formed tool_call can drive the executor. One that does not,
// cannot — regardless of who makes it.
//
// FAIL CLOSED. Anything short of a well-formed tool call — a refusal, a text answer, a
// transport error, a timeout, a malformed call — is NOT capability. The probe never
// reports capable on the strength of something it could not verify, for the same reason
// `dockerAvailable()` must not (a security predicate that guesses "yes" is worse than one
// that says "unknown").
//
// The probe is a REAL request that costs a few tokens. It is cached on the account and
// re-run when the model changes, so it is paid once per account/model, not per turn.

import { completeWithTools, completeWithToolsNonStreaming, costFromUsage } from "./adapters/openai-compat.mjs";

/** The one-off tool used to ask "can you call a tool?". Deliberately trivial. */
export const PROBE_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "report_capability",
    description: "Report that you are able to call tools. Call this immediately with ok set to true.",
    parameters: {
      type: "object",
      properties: { ok: { type: "boolean", description: "Always true" } },
      required: ["ok"],
    },
  },
});

const PROBE_PROMPT =
  "Call the report_capability tool right now with ok set to true. Do not reply with text.";

export const CAPABILITY = Object.freeze({ SWARM: "swarm", CHAT_ONLY: "chat_only" });

/**
 * Ask a model whether it can call a tool, and believe only a well-formed call.
 *
 * Returns `{ capable, capability, reason, model, probedAt }`. Never throws — a transport
 * failure is a NEGATIVE result with the reason attached, because the operator needs to see
 * WHY a provider cannot run the engine instead of meeting a silent refusal later.
 */
export async function probeToolCapability({
  baseUrl, apiKey, model, fetchImpl, signal, now = () => Date.now(),
} = {}) {
  // P1-D — measured on the SAME real call, never inferred from a brand. `null` until a
  // turn actually comes back: an endpoint nobody reached has not told us anything about
  // whether it bills, and "does not report cost" is a claim that must be earned.
  let reportsCost = null;
  const observe = (turn) => {
    if (!turn) return turn;
    reportsCost = costFromUsage(turn.usage) !== null;
    return turn;
  };
  const result = (capable, reason) => ({
    capable,
    capability: capable ? CAPABILITY.SWARM : CAPABILITY.CHAT_ONLY,
    reason,
    model: model ?? null,
    // TRUE  ⇒ the maxUsd ceiling can actually bind this endpoint.
    // FALSE ⇒ it reported no cost, so usdSpent stays 0 and only steps + wall-clock bound it.
    // NULL  ⇒ not measured (no turn was obtained).
    reportsCost,
    probedAt: now(),
  });

  if (!baseUrl || !apiKey) return result(false, "no endpoint or key is stored for this account");

  const req = {
    baseUrl,
    apiKey,
    model,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    tools: [PROBE_TOOL],
    fetchImpl,
    signal,
  };

  let turn;
  try {
    turn = observe(await completeWithTools(req));
  } catch {
    // A streamed probe can fail on servers that reject stream_options. Try once more
    // without streaming before concluding anything about the MODEL — the distinction
    // between "this model cannot call tools" and "this server dislikes our request" is
    // exactly the confusion the old table institutionalised.
    try {
      turn = observe(await completeWithToolsNonStreaming(req));
    } catch (err2) {
      return result(false, `the provider could not be reached: ${err2?.message ?? err2}`);
    }
  }

  const calls = turn?.toolCalls ?? [];
  if (!calls.length) {
    // Streaming may have dropped the calls even though the model made them.
    try {
      const retried = observe(await completeWithToolsNonStreaming(req));
      if (retried.toolCalls.some((c) => c.ok && c.name === PROBE_TOOL.function.name)) {
        return result(true, "the model returned a well-formed tool call (non-streamed)");
      }
    } catch {
      /* fall through to the negative result below */
    }
    return result(false, "the model answered without calling the tool it was given");
  }

  const good = calls.find((c) => c.ok && c.name === PROBE_TOOL.function.name);
  if (good) return result(true, "the model returned a well-formed tool call");

  const malformed = calls.find((c) => !c.ok);
  if (malformed) return result(false, `the model's tool call could not be parsed: ${malformed.error}`);
  return result(false, `the model called an unexpected tool: ${calls[0]?.name ?? "unknown"}`);
}

/**
 * The capability actually in force for an account.
 *
 * ORDER OF AUTHORITY, and why:
 *   1. A stored PROBE result for the CURRENT model — a measurement of this exact model.
 *   2. Claude accounts — "swarm" without an HTTP probe, because they run through the
 *      Claude CLI, a different transport entirely. This is NOT the old special case
 *      returning: it is a statement about which EXECUTOR drives them, and the CLI's
 *      ability to call tools is not in question. Any provider that passes the probe gets
 *      exactly the same standing.
 *   3. Everything else: chat_only. Fail closed — no proof of tool support means no
 *      autonomous dispatch, the same answer an unknown provider gets.
 *
 * A probe recorded against a DIFFERENT model is ignored: switching the model is switching
 * the thing that was measured.
 */
export function resolveCapability(acct) {
  if (!acct) return CAPABILITY.CHAT_ONLY;
  const probe = acct.toolProbe;
  if (probe && typeof probe.capability === "string") {
    const sameModel = (probe.model ?? null) === (acct.model ?? null);
    if (sameModel) return probe.capability;
  }
  if (acct.providerType === "claude") return CAPABILITY.SWARM;
  return CAPABILITY.CHAT_ONLY;
}

/** True when a stored probe no longer describes the account's current model. */
export function probeIsStale(acct) {
  if (!acct || acct.providerType === "claude") return false;
  const probe = acct.toolProbe;
  if (!probe) return true;
  return (probe.model ?? null) !== (acct.model ?? null);
}

/**
 * Operator-facing explanation of why the engine can or cannot use this account.
 * Task 2.1 renders this verbatim; a control that cannot succeed must say why.
 */
export function capabilityExplanation(acct) {
  if (!acct) return "no account is active";
  if (acct.providerType === "claude") return "Claude accounts drive the engine through the Claude CLI";
  const probe = acct.toolProbe;
  if (!probe) return "this model has not been probed for tool support yet";
  if (probeIsStale(acct)) return "the model changed since the last probe — re-probe to confirm tool support";
  return probe.reason ?? "no reason was recorded";
}

/**
 * P1-D — whether the $ ceiling on an autonomous turn can actually bind this account.
 *
 * The gap this closes: `DEFAULT_LOOP_LIMITS.maxUsd` is enforced from a reported
 * `usage.cost`. Only some endpoints send one (OpenRouter does; a self-hosted vLLM, NVIDIA
 * NIM, MiniMax or Z.ai deployment typically does not), so for those accounts `usdSpent`
 * stays 0 and the ceiling NEVER TRIPS. That was disclosed in code and in the phase's Known
 * Gaps but never to the operator, who was left reading a budget that does not exist.
 *
 * Three states, deliberately. "Not measured" is its own answer — asserting "does not report
 * cost" about an endpoint nobody called would be the same unearned claim the deleted
 * capability table made, just about billing instead of tools.
 */
export function spendCapExplanation(acct) {
  if (!acct) return "no account is active";
  if (acct.providerType === "claude") {
    return "Claude accounts run through the Claude CLI on your subscription — there is no per-turn dollar ceiling to enforce here.";
  }
  const probe = acct.toolProbe;
  const measured = probe && !probeIsStale(acct) && typeof probe.reportsCost === "boolean";
  if (!measured) {
    return "Spend cap: not measured. Run a capability probe — it records whether this endpoint reports a per-call cost, which is the only thing the dollar ceiling can be enforced from.";
  }
  if (probe.reportsCost) {
    return "Spend cap: enforceable. This endpoint reports a per-call cost, so the dollar ceiling on an autonomous turn is real.";
  }
  return "Spend cap: NOT enforceable — this endpoint does not report a per-call cost, so the dollar ceiling can never trip. The bounds that do hold are the step cap and the wall-clock cap, which limit API calls rather than money.";
}

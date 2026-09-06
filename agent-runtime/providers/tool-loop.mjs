// PHASE 1 TASK 1.1 — the tool loop that makes any tool-capable model an executor.
//
// The standard OpenAI protocol: send `tools`, read `delta.tool_calls`, append the
// assistant turn WITH its tool_calls, execute each one, append a
// `{role:"tool", tool_call_id, content}` per call, repeat until the model stops calling
// tools or a cap trips.
//
// TASK 1.4 — CAPS ARE THE REAL RISK CONTROL. A loop driven by a third-party model is
// unbounded by construction: steps, wall-clock, files written, bytes written, dollars.
// Every one of them is capped, and TRIPPING A CAP ABORTS THE TURN WITH A NAMED REASON that
// the caller turns into a failure Delivery. There is no silent stop anywhere in this file —
// a turn that ends always says which of the five reasons ended it.
//
// TASK 1.5 — the non-streaming fallback. Some OpenAI-compatible servers stream tool calls
// unreliably (no index, dropped final chunk). The accumulator reports that as unparseable
// rather than guessing, and this loop then re-asks the SAME step non-streamed, where the
// server returns one complete body and there is nothing to reassemble. Guessing at
// truncated JSON would be exactly the silent-corruption failure this project keeps finding.

import { completeWithTools, completeWithToolsNonStreaming, costFromUsage } from "./adapters/openai-compat.mjs";
import { createExecTools } from "./exec-tools.mjs";

/** Turn-level caps. The tool-level ones (writes, bytes) live in exec-tools. */
export const DEFAULT_LOOP_LIMITS = Object.freeze({
  maxSteps: 24, // assistant turns; a step is one model call plus its tool results
  maxWallClockMs: 10 * 60 * 1000,
  // MOSTLY UNENFORCEABLE, AND SAID SO PLAINLY. costFromUsage only counts a reported
  // `usage.cost`, which in practice only OpenRouter sends. A self-hosted vLLM, NVIDIA NIM,
  // MiniMax or Z.ai endpoint — the very providers this phase exists to unlock — report
  // nothing, so usdSpent stays 0 and this ceiling NEVER TRIPS for them. The real bounds for
  // those accounts are maxSteps and maxWallClockMs, which cap API CALLS rather than
  // dollars. Do not present this as a budget guarantee to an operator; it is one only for
  // providers that actually report cost. (Raised in code review as a MEDIUM: disclosed in
  // code but not surfaced in the UI. Listed in the phase's Known Gaps.)
  maxUsd: 2.0,
});

export const STOP = Object.freeze({
  COMPLETED: "completed",
  MAX_STEPS: "max_steps",
  WALL_CLOCK: "wall_clock",
  USD_BUDGET: "usd_budget",
  ABORTED: "aborted",
});

/** Human sentence for a stop reason, used verbatim in the failure Delivery. */
export function describeStop(reason, detail = {}) {
  switch (reason) {
    case STOP.COMPLETED:
      return "the model finished without requesting more tools";
    case STOP.MAX_STEPS:
      return `step cap reached (${detail.maxSteps} model turns) — the task was not finished`;
    case STOP.WALL_CLOCK:
      return `wall-clock cap reached (${Math.round((detail.maxWallClockMs ?? 0) / 1000)}s) — the task was not finished`;
    case STOP.USD_BUDGET:
      return `spend cap reached ($${detail.maxUsd}) — the task was not finished`;
    case STOP.ABORTED:
      return "the turn was aborted";
    default:
      return `stopped: ${reason}`;
  }
}

/**
 * Run one autonomous task to completion or to a cap.
 *
 * Returns `{ ok, stopReason, stopDetail, text, steps, usdSpent, usage, toolStats, messages }`.
 * `ok` is true ONLY for STOP.COMPLETED — every cap is a failure the caller must surface.
 */
export async function runToolLoop({
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  workdir,
  limits = {},
  toolLimits = {},
  fetchImpl,
  signal,
  onText,
  onStep,
  now = () => Date.now(),
} = {}) {
  const lim = { ...DEFAULT_LOOP_LIMITS, ...limits };
  const tools = createExecTools({ workdir, limits: toolLimits });
  const started = now();

  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: userPrompt },
  ];

  let steps = 0;
  let usdSpent = 0;
  let lastUsage = null;
  let text = "";

  const finish = (stopReason, stopDetail) => ({
    ok: stopReason === STOP.COMPLETED,
    stopReason,
    stopDetail: stopDetail ?? describeStop(stopReason, lim),
    text,
    steps,
    usdSpent,
    usage: lastUsage,
    toolStats: tools.stats,
    messages,
  });

  for (;;) {
    if (signal?.aborted) return finish(STOP.ABORTED);
    if (steps >= lim.maxSteps) return finish(STOP.MAX_STEPS);
    if (now() - started > lim.maxWallClockMs) return finish(STOP.WALL_CLOCK);

    const req = { baseUrl, apiKey, model, messages, tools: tools.schemas, signal, fetchImpl };
    let turn;
    try {
      turn = await completeWithTools({ ...req, onText });
    } catch (err) {
      // An abort arriving MID-REQUEST surfaces as a fetch rejection, not as a flag on the
      // next loop check. Without this it escaped as a generic "executor failed", which
      // reads to the operator as a provider fault rather than as their own kill landing.
      if (signal?.aborted) return finish(STOP.ABORTED);
      throw err;
    }

    // TASK 1.5 — retry NON-STREAMED when the stream produced an unparseable tool call.
    // Only for that specific failure: a well-formed refusal (no name, non-object args) is
    // the model's mistake and re-asking the transport would not fix it.
    const truncated = turn.toolCalls.some((c) => !c.ok && /json/i.test(String(c.error)));
    if (truncated) {
      try {
        const retried = await completeWithToolsNonStreaming(req);
        if (retried.toolCalls.every((c) => c.ok)) turn = retried;
      } catch {
        // Fallback unavailable (server rejects stream:false). Keep the streamed result;
        // the malformed call still goes back to the model as a readable tool error below.
      }
    }

    steps += 1;
    lastUsage = turn.usage ?? lastUsage;
    if (turn.text) text = turn.text;

    const reported = costFromUsage(turn.usage);
    if (reported !== null) usdSpent += reported;

    onStep?.({ step: steps, text: turn.text, toolCalls: turn.toolCalls, usage: turn.usage });

    if (!turn.toolCalls.length) return finish(STOP.COMPLETED);

    // The assistant turn must be appended WITH its tool_calls, in the exact shape the
    // server sent, or the follow-up tool messages have nothing to attach to and the
    // provider 400s on the next request.
    messages.push({
      role: "assistant",
      content: turn.text || null,
      tool_calls: turn.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.rawArgs },
      })),
    });

    for (const call of turn.toolCalls) {
      let content;
      if (!call.ok) {
        // A malformed call is handed BACK to the model as a tool error so it can retry.
        // Dropping it here is what makes a model look like it silently did nothing.
        content = `error: ${call.error}`;
      } else {
        const r = await tools.execute(call.name, call.args);
        content = r.content;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: String(content) });
    }

    // Checked AFTER the tool results are appended so the transcript records the work that
    // was actually done before the budget ran out.
    if (lim.maxUsd > 0 && usdSpent > lim.maxUsd) return finish(STOP.USD_BUDGET);
  }
}

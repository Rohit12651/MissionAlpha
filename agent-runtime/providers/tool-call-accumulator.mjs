// PHASE 1 TASK 1.1 — reassemble FRAGMENTED streamed tool calls.
//
// In the OpenAI streaming protocol a tool call is not delivered whole. It is split across
// SSE chunks and keyed by `index`, with `id` and `name` typically arriving only in the
// first fragment and `arguments` dribbling out over many:
//
//   {"index":0,"id":"call_a","type":"function","function":{"name":"Write","arguments":""}}
//   {"index":0,"function":{"arguments":"{\"pa"}}
//   {"index":0,"function":{"arguments":"th\":\"a.txt\"}"}}
//
// Read one fragment at a time and you get `{"pa` — unparseable. The usual shape of that
// bug is a try/catch that swallows the parse error and drops the call, so the model's
// request to write a file becomes silence, and the turn reads as "the model chose not to
// act". That is precisely the class of invisible failure this program exists to remove, so
// this module has ONE job and is tested before the tool loop that consumes it.
//
// DESIGN RULES, each one a test in test/tool-call-accumulator.test.mjs:
//   * Key by `index`. Arrival order is not call order, and parallel calls interleave.
//   * Concatenate BOTH `arguments` and `name` — name is normally atomic, but a server that
//     chunks it must not end up with the tail overwriting the head.
//   * A malformed call is REPORTED (`ok: false` with the raw text), never dropped. The
//     loop turns it into a tool error the model can see and retry, which is the whole
//     difference between a visible failure and a silent one.
//   * Fail closed on anything ambiguous: no name, or arguments that are valid JSON but not
//     an object, means do not execute.
//   * Ids are required on the tool-result message sent back to the model. When a server
//     omits them, synthesize DETERMINISTICALLY from the index so a retry of the same turn
//     produces the same id.

/** Arguments that parse to this shape are usable; anything else is refused. */
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Accumulate `delta.tool_calls` fragments across a stream.
 *
 * Usage: `push(frame.choices[0].delta.tool_calls)` for every chunk, then `finish()`.
 */
export function createToolCallAccumulator() {
  /** index -> { id, name, rawArgs } */
  const byIndex = new Map();

  function slot(index) {
    if (!byIndex.has(index)) byIndex.set(index, { id: "", name: "", rawArgs: "" });
    return byIndex.get(index);
  }

  return {
    /** Absorb one chunk's `tool_calls` array. Non-arrays are ignored, not thrown on. */
    push(toolCalls) {
      if (!Array.isArray(toolCalls)) return; // a malformed frame must not kill a good turn
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        // A single-call server may omit `index` entirely; 0 is the only coherent default.
        const index = Number.isInteger(tc.index) ? tc.index : 0;
        const s = slot(index);
        if (typeof tc.id === "string" && tc.id) s.id = tc.id;
        const fn = tc.function;
        if (fn && typeof fn === "object") {
          // Concatenated, not assigned — see the header note on chunked names.
          if (typeof fn.name === "string") s.name += fn.name;
          if (typeof fn.arguments === "string") s.rawArgs += fn.arguments;
        }
      }
    },

    /** True once any fragment has been seen. */
    hasCalls() {
      return byIndex.size > 0;
    },

    /**
     * The completed calls, in INDEX order.
     *
     * Shape: `{ index, id, name, args, rawArgs, ok, error }`. `ok === false` means do not
     * execute; `error` says why and is safe to hand back to the model as a tool result.
     * Pure — safe to call more than once.
     */
    finish() {
      return [...byIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, s]) => {
          // Deterministic so a retried turn reuses the id rather than minting a new one.
          const id = s.id || `call_${index}`;
          const base = { index, id, name: s.name, rawArgs: s.rawArgs };

          if (!s.name) {
            return { ...base, args: null, ok: false, error: "tool call arrived with no function name" };
          }

          const text = s.rawArgs.trim();
          if (text === "") return { ...base, args: {}, ok: true, error: null }; // zero-arg tool

          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch (err) {
            return {
              ...base,
              args: null,
              ok: false,
              // Names the real cause — a truncated stream — rather than "unexpected token".
              error: `tool call arguments are not valid JSON (the stream may have been truncated): ${err?.message ?? err}`,
            };
          }
          if (!isPlainObject(parsed)) {
            return {
              ...base,
              args: null,
              ok: false,
              error: `tool call arguments must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
            };
          }
          return { ...base, args: parsed, ok: true, error: null };
        });
    },
  };
}

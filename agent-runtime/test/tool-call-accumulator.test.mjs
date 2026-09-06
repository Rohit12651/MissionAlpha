// PHASE 1 TASK 1.1 — THE KNOWN TRAP, TESTED BEFORE THE LOOP EXISTS.
//
// The plan names this as the first thing to write, and the reason is specific: in the
// OpenAI streaming protocol a tool call does NOT arrive whole. It arrives as fragments
// spread across many SSE chunks, keyed by `index`:
//
//   {"index":0,"id":"call_a","type":"function","function":{"name":"Write","arguments":""}}
//   {"index":0,"function":{"arguments":"{\"pa"}}
//   {"index":0,"function":{"arguments":"th\":\"a.txt\"}"}}
//
// A naive parser that reads `delta.tool_calls[0].function.arguments` and JSON.parses it
// gets `{"pa` — truncated, unparseable — and the usual "handling" is a try/catch that
// drops the call. The model asked to write a file, the app silently did nothing, and the
// turn looks like the model simply chose not to act. That failure is invisible in exactly
// the way this whole program exists to eliminate, so the accumulator is written against
// tests first and the loop is built on top of it afterwards.
//
// Every case below is a real shape observed from some OpenAI-compatible server, not an
// invented edge: `index` omitted when there is only one call, ids absent entirely,
// `name` split across chunks, parallel calls interleaved out of order.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createToolCallAccumulator } from "../providers/tool-call-accumulator.mjs";

/** Feed a list of `delta.tool_calls` arrays, one per streamed chunk. */
function feed(chunks) {
  const acc = createToolCallAccumulator();
  for (const c of chunks) acc.push(c);
  return acc.finish();
}

test("the trap itself: arguments split across chunks reassemble into valid JSON", () => {
  const calls = feed([
    [{ index: 0, id: "call_a", type: "function", function: { name: "Write", arguments: "" } }],
    [{ index: 0, function: { arguments: '{"pa' } }],
    [{ index: 0, function: { arguments: 'th":"a.txt","content":"hi"' } }],
    [{ index: 0, function: { arguments: "}" } }],
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "Write");
  assert.equal(calls[0].id, "call_a");
  assert.deepEqual(calls[0].args, { path: "a.txt", content: "hi" });
  assert.equal(calls[0].ok, true);
});

test("a name split across chunks is concatenated, not overwritten", () => {
  // Rarer than split arguments but real: some servers chunk the whole function object.
  const calls = feed([
    [{ index: 0, id: "c1", function: { name: "Re" } }],
    [{ index: 0, function: { name: "ad", arguments: '{"path":"x"}' } }],
  ]);
  assert.equal(calls[0].name, "Read");
  assert.deepEqual(calls[0].args, { path: "x" });
});

test("parallel calls stay separate and are keyed by index, not by arrival order", () => {
  const calls = feed([
    [{ index: 0, id: "c0", function: { name: "Read", arguments: '{"path":' } }],
    [{ index: 1, id: "c1", function: { name: "Grep", arguments: '{"q":' } }],
    [{ index: 1, function: { arguments: '"needle"}' } }],
    [{ index: 0, function: { arguments: '"a.txt"}' } }],
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "Read");
  assert.deepEqual(calls[0].args, { path: "a.txt" });
  assert.equal(calls[1].name, "Grep");
  assert.deepEqual(calls[1].args, { q: "needle" });
});

test("indices arriving out of order are returned in index order", () => {
  const calls = feed([
    [{ index: 2, id: "c2", function: { name: "C", arguments: "{}" } }],
    [{ index: 0, id: "c0", function: { name: "A", arguments: "{}" } }],
    [{ index: 1, id: "c1", function: { name: "B", arguments: "{}" } }],
  ]);
  assert.deepEqual(calls.map((c) => c.name), ["A", "B", "C"]);
});

test("a missing index defaults to 0 — a single-call server that omits it still works", () => {
  const calls = feed([
    [{ id: "c0", function: { name: "Read", arguments: '{"path"' } }],
    [{ function: { arguments: ':"a"}' } }],
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { path: "a" });
});

test("empty arguments mean no arguments, not a parse failure", () => {
  // A zero-arg tool legitimately streams "" or nothing at all.
  const calls = feed([[{ index: 0, id: "c", function: { name: "ListTools", arguments: "" } }]]);
  assert.equal(calls[0].ok, true);
  assert.deepEqual(calls[0].args, {});
});

test("MALFORMED JSON IS SURFACED, NEVER SILENTLY DROPPED", () => {
  // The whole point. A truncated or corrupt argument string must produce a call marked
  // NOT ok, carrying the raw text, so the loop can return a tool error to the model and
  // let it retry. Dropping it is what makes the model look like it did nothing.
  const calls = feed([
    [{ index: 0, id: "c", function: { name: "Write", arguments: '{"path":"a.txt"' } }],
  ]);
  assert.equal(calls.length, 1, "a malformed call must still be reported");
  assert.equal(calls[0].ok, false);
  assert.equal(calls[0].name, "Write");
  assert.equal(calls[0].rawArgs, '{"path":"a.txt"');
  assert.match(String(calls[0].error), /json/i);
});

test("a call with no id gets a deterministic synthetic one", () => {
  // `tool_call_id` is REQUIRED on the tool result message that goes back to the model.
  // Some servers omit ids entirely; inventing a random one per attempt would break a
  // retry, so it is derived from the index.
  const a = feed([[{ index: 3, function: { name: "Read", arguments: "{}" } }]]);
  const b = feed([[{ index: 3, function: { name: "Read", arguments: "{}" } }]]);
  assert.ok(a[0].id, "an id must always be present");
  assert.equal(a[0].id, b[0].id, "the synthetic id must be deterministic");
});

test("a nameless call is reported as not-ok rather than executed", () => {
  // Executing a tool whose name never arrived would mean guessing. Fail closed.
  const calls = feed([[{ index: 0, id: "c", function: { arguments: "{}" } }]]);
  assert.equal(calls[0].ok, false);
  assert.match(String(calls[0].error), /name/i);
});

test("arguments that parse to a non-object are refused", () => {
  // `"just a string"` is valid JSON but not an argument map; passing it to a tool that
  // expects named parameters would throw somewhere far away from the cause.
  const calls = feed([[{ index: 0, id: "c", function: { name: "Read", arguments: '"hello"' } }]]);
  assert.equal(calls[0].ok, false);
  assert.match(String(calls[0].error), /object/i);
});

test("no tool calls at all yields an empty list, not a phantom entry", () => {
  assert.deepEqual(feed([]), []);
  assert.deepEqual(feed([[]]), []);
});

test("a non-array delta is ignored rather than throwing mid-stream", () => {
  // Defensive: a malformed frame must not kill an otherwise good turn.
  const acc = createToolCallAccumulator();
  acc.push(null);
  acc.push(undefined);
  acc.push({ not: "an array" });
  acc.push([{ index: 0, id: "c", function: { name: "Read", arguments: "{}" } }]);
  const calls = acc.finish();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "Read");
});

test("hasCalls reports whether the model asked for anything", () => {
  const empty = createToolCallAccumulator();
  assert.equal(empty.hasCalls(), false);
  const one = createToolCallAccumulator();
  one.push([{ index: 0, id: "c", function: { name: "Read", arguments: "{}" } }]);
  assert.equal(one.hasCalls(), true);
});

test("finish() is idempotent — calling it twice returns the same result", () => {
  const acc = createToolCallAccumulator();
  acc.push([{ index: 0, id: "c", function: { name: "Read", arguments: '{"path":"a"}' } }]);
  assert.deepEqual(acc.finish(), acc.finish());
});

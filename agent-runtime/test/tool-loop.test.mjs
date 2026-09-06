// PHASE 1 TASKS 1.1 / 1.4 / 1.5 — the tool loop end to end against a stub server.
//
// A stub `fetchImpl` plays the provider, so these run with no network and no key and
// still exercise the real SSE parsing, the real accumulator, the real tools and the real
// caps. The one thing they cannot prove is that a REAL provider behaves this way — that is
// what the phase's live proof on a real account is for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runToolLoop, STOP, DEFAULT_LOOP_LIMITS } from "../providers/tool-loop.mjs";

const wd = () => realpathSync(mkdtempSync(join(tmpdir(), "ma-loop-")));
const clean = (d) => rmSync(d, { recursive: true, force: true });

/** Build an SSE response body from a list of frame objects. */
function sse(frames) {
  const lines = frames.map((f) => `data: ${JSON.stringify(f)}\n`).concat("data: [DONE]\n");
  return {
    ok: true,
    status: 200,
    body: (async function* () { for (const l of lines) yield l; })(),
  };
}
const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj, body: null });

const textFrame = (t) => ({ choices: [{ delta: { content: t } }] });
const doneFrame = (usage) => ({ choices: [{ delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) });
const callFrames = (name, args, { id = "c1", index = 0, split = 1 } = {}) => {
  const chunks = [];
  const step = Math.ceil(args.length / split);
  chunks.push({ choices: [{ delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] } }] });
  for (let i = 0; i < args.length; i += step) {
    chunks.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(i, i + step) } }] } }] });
  }
  return chunks;
};

/** A stub provider that replays scripted responses in order. */
function stubFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error("stub ran out of responses");
    return typeof next === "function" ? next() : next;
  };
  impl.calls = calls;
  return impl;
}

const base = { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m", userPrompt: "do it" };

test("a model that calls Write actually creates the file, then completes", async () => {
  const d = wd();
  try {
    const fetchImpl = stubFetch([
      sse([...callFrames("Write", JSON.stringify({ path: "out.txt", content: "hello" }), { split: 4 })]),
      sse([textFrame("done"), doneFrame()]),
    ]);
    const r = await runToolLoop({ ...base, workdir: d, fetchImpl });
    assert.equal(r.ok, true, r.stopDetail);
    assert.equal(r.stopReason, STOP.COMPLETED);
    assert.equal(readFileSync(join(d, "out.txt"), "utf-8"), "hello");
    assert.equal(r.toolStats.writes, 1);
  } finally { clean(d); }
});

test("tools are advertised on the request and tool_choice is auto", async () => {
  const d = wd();
  try {
    const fetchImpl = stubFetch([sse([textFrame("hi"), doneFrame()])]);
    await runToolLoop({ ...base, workdir: d, fetchImpl });
    const sent = fetchImpl.calls[0].body;
    assert.equal(sent.tool_choice, "auto");
    assert.deepEqual(sent.tools.map((t) => t.function.name), ["Read", "Glob", "Grep", "Write", "Edit"]);
  } finally { clean(d); }
});

test("the assistant turn is appended WITH tool_calls, and a tool message per call follows", async () => {
  const d = wd();
  try {
    const fetchImpl = stubFetch([
      sse(callFrames("Write", JSON.stringify({ path: "a.txt", content: "x" }))),
      sse([doneFrame()]),
    ]);
    const r = await runToolLoop({ ...base, workdir: d, fetchImpl });
    const assistant = r.messages.find((m) => m.role === "assistant");
    assert.ok(assistant?.tool_calls?.length, "assistant turn must carry tool_calls");
    const tool = r.messages.find((m) => m.role === "tool");
    assert.equal(tool.tool_call_id, assistant.tool_calls[0].id, "tool result must reference the call id");
  } finally { clean(d); }
});

test("A MALFORMED TOOL CALL IS HANDED BACK TO THE MODEL, not dropped", async () => {
  const d = wd();
  try {
    // Truncated arguments AND a fallback that also fails, so the loop must surface it.
    const truncated = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Write", arguments: '{"path":' } }] } }] },
    ];
    const fetchImpl = stubFetch([
      sse(truncated),
      () => { throw new Error("server rejects stream:false"); },
      sse([doneFrame()]),
    ]);
    const r = await runToolLoop({ ...base, workdir: d, fetchImpl });
    const tool = r.messages.find((m) => m.role === "tool");
    assert.match(tool.content, /error:.*json/i, "the model must be told the call was unparseable");
  } finally { clean(d); }
});

test("TASK 1.5 — a truncated stream is retried NON-STREAMED and then succeeds", async () => {
  const d = wd();
  try {
    const truncated = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Write", arguments: '{"path":"b.txt","con' } }] } }] },
    ];
    const fetchImpl = stubFetch([
      sse(truncated),
      jsonRes({
        choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "Write", arguments: JSON.stringify({ path: "b.txt", content: "recovered" }) } }] }, finish_reason: "tool_calls" }],
      }),
      sse([doneFrame()]),
    ]);
    const res = await runToolLoop({ ...base, workdir: d, fetchImpl });
    assert.equal(readFileSync(join(d, "b.txt"), "utf-8"), "recovered");
    assert.equal(fetchImpl.calls[1].body.stream, false, "the retry must be non-streamed");
    // The recovered turn must also END cleanly — a fallback that writes the file but leaves
    // the loop in a failed state still reaches the operator as a failed task.
    assert.equal(res.ok, true, res.stopDetail);
    assert.equal(res.toolStats.writes, 1);
  } finally { clean(d); }
});

test("CAP: maxSteps aborts with a NAMED reason, never a silent stop", async () => {
  const d = wd();
  try {
    // A model that calls a tool forever.
    const forever = () => sse(callFrames("Read", JSON.stringify({ path: "nope.txt" }), { id: `c${Math.random()}` }));
    const fetchImpl = stubFetch(Array.from({ length: 10 }, () => forever));
    const r = await runToolLoop({ ...base, workdir: d, fetchImpl, limits: { maxSteps: 3 } });
    assert.equal(r.ok, false);
    assert.equal(r.stopReason, STOP.MAX_STEPS);
    assert.equal(r.steps, 3);
    assert.match(r.stopDetail, /step cap reached \(3/);
  } finally { clean(d); }
});

test("CAP: wall clock aborts with a named reason", async () => {
  const d = wd();
  try {
    const forever = () => sse(callFrames("Read", JSON.stringify({ path: "x" }), { id: `c${Math.random()}` }));
    const fetchImpl = stubFetch(Array.from({ length: 10 }, () => forever));
    let t = 0;
    const r = await runToolLoop({
      ...base, workdir: d, fetchImpl,
      limits: { maxWallClockMs: 50 },
      now: () => (t += 40), // second check exceeds the budget
    });
    assert.equal(r.stopReason, STOP.WALL_CLOCK);
    assert.match(r.stopDetail, /wall-clock cap/);
  } finally { clean(d); }
});

test("CAP: the USD budget aborts when the provider REPORTS a cost", async () => {
  const d = wd();
  try {
    const pricey = () => sse([
      ...callFrames("Read", JSON.stringify({ path: "x" }), { id: `c${Math.random()}` }),
      { choices: [{ delta: {} }], usage: { cost: 5 } },
    ]);
    const fetchImpl = stubFetch(Array.from({ length: 5 }, () => pricey));
    const r = await runToolLoop({ ...base, workdir: d, fetchImpl, limits: { maxUsd: 2 } });
    assert.equal(r.stopReason, STOP.USD_BUDGET);
    assert.ok(r.usdSpent >= 2);
  } finally { clean(d); }
});

test("an UNREPORTED cost never trips the budget — spend is measured, never inferred", async () => {
  const d = wd();
  try {
    // usage present but with token counts only and no `cost` — the Phase 7 rule.
    const fetchImpl = stubFetch([
      sse([textFrame("ok"), doneFrame({ prompt_tokens: 999999, completion_tokens: 999999 })]),
    ]);
    const r = await runToolLoop({ ...base, workdir: d, fetchImpl, limits: { maxUsd: 0.0001 } });
    assert.equal(r.stopReason, STOP.COMPLETED);
    assert.equal(r.usdSpent, 0);
  } finally { clean(d); }
});

test("a tool refusal reaches the model as text rather than throwing", async () => {
  const d = wd();
  try {
    const fetchImpl = stubFetch([
      sse(callFrames("Write", JSON.stringify({ path: "../escape.txt", content: "x" }))),
      sse([doneFrame()]),
    ]);
    const res = await runToolLoop({ ...base, workdir: d, fetchImpl });
    const tool = res.messages.find((m) => m.role === "tool");
    assert.match(tool.content, /workdir/i);
    assert.equal(existsSync(join(d, "..", "escape.txt")), false);
  } finally { clean(d); }
});

test("parallel tool calls in one turn all execute", async () => {
  const d = wd();
  try {
    writeFileSync(join(d, "seed.txt"), "seed\n");
    const frames = [
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: "a", type: "function", function: { name: "Write", arguments: JSON.stringify({ path: "p1.txt", content: "1" }) } },
        { index: 1, id: "b", type: "function", function: { name: "Write", arguments: JSON.stringify({ path: "p2.txt", content: "2" }) } },
      ] } }] },
    ];
    const fetchImpl = stubFetch([sse(frames), sse([doneFrame()])]);
    const r = await runToolLoop({ ...base, workdir: d, fetchImpl });
    assert.equal(readFileSync(join(d, "p1.txt"), "utf-8"), "1");
    assert.equal(readFileSync(join(d, "p2.txt"), "utf-8"), "2");
    assert.equal(r.messages.filter((m) => m.role === "tool").length, 2);
  } finally { clean(d); }
});

test("an aborted signal stops the loop with a named reason", async () => {
  const d = wd();
  try {
    const ac = new AbortController();
    ac.abort();
    const r = await runToolLoop({ ...base, workdir: d, fetchImpl: stubFetch([]), signal: ac.signal });
    assert.equal(r.stopReason, STOP.ABORTED);
  } finally { clean(d); }
});

test("defaults are bounded — no cap is Infinity", () => {
  for (const [k, v] of Object.entries(DEFAULT_LOOP_LIMITS)) {
    assert.ok(Number.isFinite(v) && v > 0, `${k} must be a finite positive bound, got ${v}`);
  }
});

test("an abort DURING a request stops the loop as ABORTED, not as a provider fault", async () => {
  // The kill switch lands as a fetch rejection, not as a flag the next loop check sees.
  // Reporting it as "executor failed" would tell the operator the provider broke when in
  // fact their own kill worked. Found while wiring ctx.registerKill for this executor.
  const d = wd();
  try {
    const ac = new AbortController();
    const fetchImpl = async () => {
      ac.abort();
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    const r = await runToolLoop({ ...base, workdir: d, fetchImpl, signal: ac.signal });
    assert.equal(r.stopReason, STOP.ABORTED);
    assert.equal(r.ok, false);
  } finally { clean(d); }
});

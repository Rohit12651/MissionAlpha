// CC-Primitives P2 — loop step parser (pure) + store (real sqlite via openDb, so the
// v14 migration is exercised, not mocked).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { stepsFromLine, createLoopSteps } from "../loop-steps.mjs";

// ── parser ───────────────────────────────────────────────────────────────────
test("assistant text → think; tool_use → tool (input JSON summarized)", () => {
  const steps = stepsFromLine({
    type: "assistant",
    message: { content: [
      { type: "text", text: "I will edit tokens.css" },
      { type: "tool_use", name: "Edit", input: { file_path: "/x/tokens.css" } },
    ] },
  });
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], { kind: "think", tool: "", summary: "I will edit tokens.css" });
  assert.equal(steps[1].kind, "tool");
  assert.equal(steps[1].tool, "Edit");
  assert.match(steps[1].summary, /tokens\.css/);
});

test("Task/Agent tool_use → subagent step (claude's own subagent spawn made visible)", () => {
  const steps = stepsFromLine({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Task", input: { prompt: "run regression suite" } },
    { type: "tool_use", name: "Bash", input: { command: "ls" } },
  ] } });
  assert.equal(steps[0].kind, "subagent");
  assert.equal(steps[0].tool, "Task");
  assert.equal(steps[1].kind, "tool");
});

test("user tool_result → observe (string and block-array content)", () => {
  const a = stepsFromLine({ type: "user", message: { content: [{ type: "tool_result", content: "118 tests passed" }] } });
  assert.deepEqual(a, [{ kind: "observe", tool: "", summary: "118 tests passed" }]);
  const b = stepsFromLine({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "ok done" }] }] } });
  assert.equal(b[0].summary, "ok done");
});

test("result → result step; deltas and unknown lines yield NO steps", () => {
  assert.equal(stepsFromLine({ type: "result", result: "changed 3 files" })[0].kind, "result");
  assert.deepEqual(stepsFromLine({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "x" } } }), []);
  assert.deepEqual(stepsFromLine({ type: "system" }), []);
  assert.deepEqual(stepsFromLine(null), []);
});

test("parser collapses whitespace and caps raw summaries at 2000 (memory bound)", () => {
  const s = stepsFromLine({ type: "result", result: "a".repeat(5000) + "\n\n  b" })[0];
  assert.equal(s.summary.length, 2000);
  assert.doesNotMatch(stepsFromLine({ type: "result", result: "x \n\n y" })[0].summary, /\n/);
});

test("store scrubs BEFORE the 200-char cut — a secret at the boundary never survives", () => {
  const { dir, h } = freshDb();
  try {
    // Secret placed to straddle a naive 200-cut; scrub-first must fully redact it.
    const secret = "hunter2token";
    const payload = "p".repeat(195) + secret + " tail";
    const ls = createLoopSteps({ db: h.db, emit: () => {}, scrub: (s) => String(s).replaceAll(secret, "[gone]") });
    ls.record("a", "task_bnd001", { type: "result", result: payload });
    const row = ls.list("task_bnd001")[0];
    assert.ok(row.summary.length <= 200);
    assert.doesNotMatch(row.summary, /hunter2/);
  } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── store ────────────────────────────────────────────────────────────────────
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "ma-loopsteps-"));
  return { dir, h: openDb({ path: join(dir, "m.db") }) };
}

test("record persists in order, list replays, emit is identity-only", () => {
  const { dir, h } = freshDb();
  try {
    const frames = [];
    const ls = createLoopSteps({ db: h.db, emit: (n, d) => frames.push([n, d]), scrub: (s) => s });
    ls.record("sr-backend", "task_abc123", { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { f: 1 } }] } });
    ls.record("sr-backend", "task_abc123", { type: "user", message: { content: [{ type: "tool_result", content: "file body SECRETVALUE" }] } });
    ls.record("sr-backend", "task_abc123", { type: "result", result: "done" });
    const rows = ls.list("task_abc123");
    assert.deepEqual(rows.map((r) => [r.seq, r.kind]), [[1, "tool"], [2, "observe"], [3, "result"]]);
    assert.equal(frames.length, 3);
    assert.equal(frames[0][0], "loop.step");
    // identity-only: no summary on the bus frame
    assert.deepEqual(Object.keys(frames[0][1]).sort(), ["agentId", "kind", "seq", "taskId", "tool"]);
  } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("summaries are scrubbed before landing at rest", () => {
  const { dir, h } = freshDb();
  try {
    const ls = createLoopSteps({ db: h.db, emit: () => {}, scrub: (s) => String(s).replaceAll("hunter2", "«scrubbed»") });
    ls.record("a", "task_s3crt1", { type: "result", result: "the token is hunter2 ok" });
    assert.match(ls.list("task_s3crt1")[0].summary, /«scrubbed»/);
    assert.doesNotMatch(ls.list("task_s3crt1")[0].summary, /hunter2/);
  } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ring buffer caps rows per task", () => {
  const { dir, h } = freshDb();
  try {
    const ls = createLoopSteps({ db: h.db, emit: () => {}, scrub: (s) => s, cap: 5 });
    for (let i = 0; i < 9; i++) ls.record("a", "task_cap001", { type: "result", result: "r" + i });
    const rows = ls.list("task_cap001");
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((r) => r.seq), [5, 6, 7, 8, 9]);
  } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("record without a taskId is a no-op; bad line objects never throw", () => {
  const { dir, h } = freshDb();
  try {
    const ls = createLoopSteps({ db: h.db, emit: () => {}, scrub: (s) => s });
    assert.equal(ls.record("a", "", { type: "result", result: "x" }), 0);
    assert.equal(ls.record("a", "task_ok0001", "not-an-object"), 0);
    assert.equal(ls.list("task_ok0001").length, 0);
  } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
});

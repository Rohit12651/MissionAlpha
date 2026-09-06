// MUNDER-ADOPTION A6 — run-inspector invariants, pinned.
import test from "node:test";
import assert from "node:assert/strict";
import { createRunInspector } from "../run-inspector.mjs";

function harness(over = {}) {
  const emitted = [];
  let t = 1_000_000;
  const r = createRunInspector({
    scrub: (s) => String(s).replaceAll("sk-secret-123", "[redacted-secret]"),
    emit: (name, data) => emitted.push({ name, data }),
    now: () => t,
    ...over,
  });
  return { r, emitted, tick: (ms) => { t += ms; } };
}

test("appends accumulate per task; read serves text + bytes; unknown task reads null", () => {
  const { r } = harness();
  r.append("web", "task_abc123", "line one\n");
  r.append("web", "task_abc123", "line two\n");
  const out = r.read("task_abc123");
  assert.equal(out.agentId, "web");
  assert.equal(out.text, "line one\nline two\n");
  assert.equal(out.bytes, 18);
  assert.equal(r.read("task_nope00"), null);
});

test("SCRUB ON APPEND: a secret never sits in the buffer", () => {
  const { r } = harness();
  r.append("web", "task_abc123", "key=sk-secret-123 done\n");
  assert.ok(!r.read("task_abc123").text.includes("sk-secret-123"));
  assert.ok(r.read("task_abc123").text.includes("[redacted-secret]"));
});

test("ring buffer: over cap keeps the TAIL, marks trimmed, prepends the marker", () => {
  const { r } = harness({ cap: 100 });
  r.append("web", "task_abc123", "A".repeat(80));
  r.append("web", "task_abc123", "B".repeat(80));
  const out = r.read("task_abc123");
  assert.equal(out.trimmed, true);
  assert.ok(out.text.includes("older output trimmed"));
  assert.ok(out.text.endsWith("B".repeat(80)));
  assert.equal(out.bytes, 160, "bytes counts everything ever appended");
});

test("run.output frames are identity-only and throttled to one per frameMs", () => {
  const { r, emitted, tick } = harness({ frameMs: 1000 });
  r.append("web", "task_abc123", "a");
  r.append("web", "task_abc123", "b"); // same instant — throttled
  assert.equal(emitted.length, 1);
  assert.deepEqual(Object.keys(emitted[0].data).sort(), ["agentId", "bytes", "taskId"]);
  assert.ok(!("text" in emitted[0].data));
  tick(1500);
  r.append("web", "task_abc123", "c");
  assert.equal(emitted.length, 2);
});

test("LRU: the task map never exceeds maxTasks; oldest-touched evicted first", () => {
  const { r, tick } = harness({ maxTasks: 2 });
  r.append("a", "task_aaaaaa", "1"); tick(10);
  r.append("b", "task_bbbbbb", "2"); tick(10);
  r.append("c", "task_cccccc", "3");
  assert.equal(r.list().length, 2);
  assert.equal(r.read("task_aaaaaa"), null, "oldest evicted");
  assert.ok(r.read("task_cccccc"));
});

test("list() is newest-first identity rows", () => {
  const { r, tick } = harness();
  r.append("a", "task_aaaaaa", "1"); tick(10);
  r.append("b", "task_bbbbbb", "2");
  const l = r.list();
  assert.deepEqual(l.map((x) => x.taskId), ["task_bbbbbb", "task_aaaaaa"]);
  assert.ok(!("text" in l[0]));
});

test("empty/blank appends and missing taskId are no-ops", () => {
  const { r, emitted } = harness();
  r.append("a", "", "text");
  r.append("a", "task_aaaaaa", "");
  assert.equal(r.list().length, 0);
  assert.equal(emitted.length, 0);
});

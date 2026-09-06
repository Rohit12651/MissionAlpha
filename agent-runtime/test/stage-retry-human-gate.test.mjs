// Phase 6 · task 6.3 — THE STALL CLOCK STOPS AT EVERY HUMAN GATE.
//
// THE DEFECT, measured live on 2026-09-02. A build task sat HELD for 13 minutes while
// the operator read its Delivery diff. The stage-retry sweep cannot see a human, so it
// read the same fact as machine silence and fired:
//     build-retry attempt 1/4 after: no progress for 771s — the stage stalled
// then, one beat later, the re-entry was declined and the story was parked:
//     build-failed retry declined: no pipeline agent for stage 'build'
// A human reading a diff BLOCKED THE STORY. The rescue mechanism became the outage.
//
// THE RULE: time a human owns is not time the machine was idle. An interval in which
//   (a) any task of the story is HELD, or
//   (b) a gate / Delivery is pending for the story, or
//   (c) the story itself is `waiting-you`
// is SUBTRACTED from the stall clock, never counted. The clock is PAUSED, not reset:
// after the human decides, the retry is still due 771s later — measured from the idle
// the machine actually accrued, not from the wall.
//
// Everything here runs on an INJECTED clock and INJECTED seams. No HTTP, no sqlite,
// no sleeping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStageRetry } from "../stage-retry.mjs";

const SEC = 1000, MIN = 60_000;
const STALL_MS = 720_000;      // the module default: the 600s stage deadline + a margin
const LIVE_IDLE_MS = 771 * SEC; // the exact figure from the 2026-09-02 log line

/**
 * One story, one injected clock, injected seams. `sweeps(n, everyMs)` advances the clock
 * in n steps and sweeps at each one — the sweep rides a 60s heartbeat in production, so a
 * pause that is only ever OBSERVED at sweep time is the real shape of the problem.
 */
function harness({ status = "active", tasks = [], gates = [], seams = true } = {}) {
  let t = 1_700_000_000_000;
  const story = { id: "story_gate", stage: "build", status };
  const log = [{ event: "build-enter", ref: null, ts: t }];
  const entered = [];
  const stories = {
    listStories: ({ status: want }) => (story.status === want ? [story] : []),
    getLog: () => log,
    update: (id, patch) => {
      if (patch.status) story.status = patch.status;
      log.push({ event: patch.event || "update", ref: patch.ref ?? null, ts: t });
      return story;
    },
  };
  const deps = {
    stories,
    enterStage: async (storyId, stage) => { entered.push({ storyId, stage }); return { ok: true }; },
    now: () => t,
    log: () => {},
  };
  if (seams) {
    deps.listGates = () => gates.slice();
    deps.tasksForStory = () => tasks.slice();
  }
  const retry = createStageRetry(deps);
  return {
    story, log, entered, retry,
    setStatus: (s) => { story.status = s; },
    setTasks: (next) => { tasks.length = 0; tasks.push(...next); },
    setGates: (next) => { gates.length = 0; gates.push(...next); },
    async sweeps(n, everyMs = MIN) { for (let i = 0; i < n; i++) { t += everyMs; await retry.sweep(); } },
    rows: (event) => log.filter((r) => r.event === event),
  };
}

const heldTask = { taskId: "task_aaaaaa", storyId: "story_gate", status: "held" };
const runningTask = { taskId: "task_aaaaaa", storyId: "story_gate", status: "claimed" };

// ── RATCHET, both directions ────────────────────────────────────────────────
// Direction 1: with the seams returning NOTHING, the pre-Phase-6 behaviour is byte-for-
// byte what it was — a genuinely silent story is still rescued at the deadline. A fix
// that also stopped rescuing real stalls would trade one outage for a worse one.
test("no human anywhere: a silent active story is still retried at the stall deadline", async () => {
  // PREMISE CHECK — this whole file is worthless if the live figure were under the
  // module's own deadline: nothing would have fired and there would be no defect.
  assert.ok(LIVE_IDLE_MS > STALL_MS, "771s must be past the 720s stall deadline for any of this to mean anything");
  const h = harness({ tasks: [], gates: [] });
  await h.sweeps(12, MIN);                          // 720s — exactly at the deadline, nothing held
  await h.sweeps(1, LIVE_IDLE_MS - 12 * MIN);       // 771s, the live figure
  assert.equal(h.entered.length, 1, "a story nobody is holding must still be rescued");
  assert.equal(h.entered[0].stage, "build");
  assert.equal(h.rows("build-retry").length, 1);
});

// Direction 2: the SAME 771 idle seconds with a HELD task must NOT fire. This is the
// live defect; it is RED against the pre-6.3 module.
test("a HELD task pauses the clock — 20 minutes of human reading is not a stall", async () => {
  const h = harness({ tasks: [heldTask] });
  await h.sweeps(20, MIN);            // 1200s of wall time, all of it human
  assert.equal(h.entered.length, 0,
    `a task HELD for a human decision must never look like a stalled stage (entered: ${JSON.stringify(h.entered)})`);
  assert.equal(h.rows("build-retry").length, 0, "and no build-retry row may be written");
});

test("the paused time is SUBTRACTED, not reset: the retry is still due 771s of real idle later", async () => {
  const h = harness({ tasks: [heldTask] });
  await h.sweeps(20, MIN);                    // 20 min held
  h.setTasks([runningTask]);                  // the operator decided; the machine owns it again
  await h.sweeps(11, MIN);                    // 660s of REAL idle — under the deadline
  assert.equal(h.entered.length, 0, "660s of real idle is not yet a stall");
  await h.sweeps(1, 111 * SEC);               // 771s of real idle
  assert.equal(h.entered.length, 1, "past the deadline on REAL idle the rescue must still fire");
  await h.sweeps(1, MIN);
  assert.equal(h.entered.length, 1, "and exactly once — the retry row is itself progress");
});

test("a pending gate / Delivery pauses the clock", async () => {
  const h = harness({ gates: [{ id: "01J", kind: "design-approval", status: "pending" }] });
  await h.sweeps(20, MIN);
  assert.equal(h.entered.length, 0, "a pending gate is a human, not machine silence");
  h.setGates([]);                              // decided
  await h.sweeps(13, MIN);                     // 780s of real idle
  assert.equal(h.entered.length, 1, "once the gate is decided the clock runs again");
});

test("a story parked `waiting-you` pauses the clock", async () => {
  const h = harness({ status: "waiting-you" });
  await h.sweeps(20, MIN);
  assert.equal(h.entered.length, 0);
  h.setStatus("active");
  await h.sweeps(11, MIN);
  assert.equal(h.entered.length, 0, "the 20 minutes the BOSS owned are not the machine's idle");
  await h.sweeps(1, 111 * SEC);
  assert.equal(h.entered.length, 1);
});

test("ONE stall-clock-paused row per episode, one stall-clock-resumed on release", async () => {
  const h = harness({ tasks: [heldTask] });
  await h.sweeps(20, MIN);
  assert.equal(h.rows("stall-clock-paused").length, 1, "one row per pause EPISODE, not one per sweep");
  assert.match(String(h.rows("stall-clock-paused")[0].ref || ""), /held/i, "the row must name the reason");
  h.setTasks([runningTask]);
  await h.sweeps(2, MIN);
  assert.equal(h.rows("stall-clock-resumed").length, 1);
  assert.equal(h.rows("stall-clock-paused").length, 1, "resuming must not re-log the pause");
});

test("the clock's OWN rows are bookkeeping, never progress", async () => {
  // If `stall-clock-paused` counted as a story-log row, it would reset `lastRowTs` and the
  // clock would silently restart from the pause — the pause would become a RESET and a
  // genuinely stalled story would never be rescued again.
  const h = harness({ tasks: [heldTask] });
  await h.sweeps(3, MIN);
  assert.equal(h.rows("stall-clock-paused").length, 1);
  h.setTasks([runningTask]);
  await h.sweeps(1, MIN);                 // resumed at wall 4 min, 3 min of it paused
  await h.sweeps(1, (720 - 60) * SEC);    // real idle now 720s counting the 1 pre-pause min
  assert.equal(h.entered.length, 1, "the pause must not have reset the clock to zero");
});

test("a seam that throws fails OPEN — a broken gate lookup costs a call, never a refused rescue", async () => {
  const h = harness({ tasks: [] });
  const boom = createStageRetry({
    stories: { listStories: () => [h.story], getLog: () => h.log, update: () => h.story },
    enterStage: async () => ({ ok: true }),
    now: () => Date.now(),
    listGates: () => { throw new Error("db is gone"); },
    tasksForStory: () => { throw new Error("queue is gone"); },
    log: () => {},
  });
  const out = await boom.sweep();
  assert.ok(out && typeof out.started === "number", "a seam fault must never throw out of the sweep");
});

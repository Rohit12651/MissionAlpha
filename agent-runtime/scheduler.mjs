// ADR-025 — Parallel Dispatch Scheduler. Slot-bounded fan-out over the SHARED
// inflight budget. It does NOT own a counter — it borrows server.mjs's via injected
// tryAcquireSlot/releaseSlot (one budget across chat + run + engine). Fairness lives
// in queue.claimNext (priority band → round-robin → per-agent cap → FIFO).
//
// INVARIANT (sr-security): total concurrent claude children = inflight ≤ MAX_INFLIGHT
// always. Never a second limit, never spawns off-budget. Exactly one releaseSlot per
// acquired slot, on step settle (resolve OR reject) — no slot leak / deadlock.

export function createScheduler(deps = {}) {
  const tryAcquireSlot = deps.tryAcquireSlot;
  const releaseSlot = deps.releaseSlot;
  const claimNext = deps.claimNext;
  let runStepRef = null; // set by start(); enables auto-re-drain on slot release

  // Drain: acquire as many slots as capacity allows, claim a ready task for each,
  // dispatch it, and guarantee a release when it settles. Returns dispatched count.
  function drain(runStep) {
    let dispatched = 0;
    while (tryAcquireSlot()) {
      const task = claimNext();
      if (!task) {
        releaseSlot(); // nothing ready — give the speculative slot back
        break;
      }
      dispatched++;
      let p;
      try {
        p = runStep(task); // invoke synchronously so dispatch order is deterministic
      } catch (e) {
        p = Promise.reject(e); // a sync throw still settles → slot still released
      }
      Promise.resolve(p)
        .catch(() => { /* engine records FAILED; swallow here so release always runs */ })
        .finally(() => {
          releaseSlot();
          // a slot just freed — if running under start(), backfill the next ready task
          if (runStepRef) setImmediate(() => drain(runStepRef));
        });
    }
    return dispatched;
  }

  // start: register the run-step fn so every slot release auto-re-drains (the engine
  // also calls tick() on enqueue). Idempotent enough — drain is capacity-guarded.
  function start(runStep) {
    runStepRef = runStep;
    drain(runStep);
  }

  function tick() {
    if (runStepRef) drain(runStepRef);
  }

  return { drain, start, tick };
}

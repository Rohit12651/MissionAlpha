// Story-Pipeline S3 — the BUILD-stage aggregator + the goal-completion → stage-advance
// driver. Two jobs, both PURE over injected seams (no storage, no transport of its own):
//
//   aggregate(storyId)        — fold a Story's engine goals + their tasks + each task's loop
//                               steps into the Build-panel shape the Story GET returns.
//   onTerminalTask(storyId)   — called once per TERMINAL task for a story (wired to the
//                               engine's existing onDone / onTerminalFailure seams). When
//                               EVERY goal of the story is terminal it advances the story
//                               `build → review-qa` (all done) OR marks it `blocked` and
//                               mints ONE Inbox alert (≥ failThreshold goal failures). This
//                               is the autonomy fail-safe: a story never sits half-built.
//
// A goal is one of three states, derived purely from its task records:
//   • failed  — any task of the goal is `failed`/`cancelled` (failTerminal PAUSES the chain,
//               so a failed step is the goal's terminal verdict — no later step will run).
//   • done    — the FINAL step's task is `done` (the whole chain landed).
//   • running — anything else (queued / claimed / held / an intermediate step done). `held`
//               counts as NOT terminal on purpose: an operator can still approve it.
//
// IDEMPOTENCY: onTerminalTask fires once per terminal task, so it re-runs as each goal
// finishes. It acts ONLY when the story is still at `build` AND every goal is terminal, and
// the block branch is a no-op once the story is already `blocked` — so a burst of terminal
// events advances/blocks exactly once, never twice.
//
// SECURITY: read-only over the queue + goal plans (metadata only — a task record grants no
// capability). It never runs a task, never widens apply scope, never writes to a repo; its
// only writes are the Story status transition and the diff-less Inbox alert.

const BUILD_STAGE = "build";
// The all-done advance is `build → review-qa` (stage 6). advance() computes that next stage
// itself from the closed machine — this module only decides WHEN to call it.
export const DEFAULT_FAIL_THRESHOLD = 1; // ≥1 goal exhausting its retries blocks the story

export function createStoryBuild(deps = {}) {
  const goals = typeof deps.goals === "function" ? deps.goals : () => [];
  const queue = deps.queue;
  const stories = deps.stories;
  if (!queue || typeof queue.all !== "function") throw new Error("createStoryBuild: queue with all() required");
  if (!stories || typeof stories.getStory !== "function") throw new Error("createStoryBuild: stories store required");
  const loopSteps = deps.loopSteps && typeof deps.loopSteps.list === "function" ? deps.loopSteps : null;
  const mintAlert = typeof deps.mintAlert === "function" ? deps.mintAlert : null;
  // S4 — fired ONCE right after a successful `build → review-qa` advance, so the review-QA
  // stage driver (reviewer + QA + PR gates) kicks in. Optional: unset ⇒ pre-S4 behaviour
  // (the story simply sits at review-qa). Isolated — a driver fault never un-advances.
  const onEnterReviewQa = typeof deps.onEnterReviewQa === "function" ? deps.onEnterReviewQa : null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const failThreshold = Number.isFinite(Number(deps.failThreshold)) && Number(deps.failThreshold) > 0
    ? Math.floor(Number(deps.failThreshold)) : DEFAULT_FAIL_THRESHOLD;

  const goalsForStory = (storyId) => {
    const sid = String(storyId || "");
    if (!sid) return [];
    return [...goals()].filter((g) => g && g.storyId === sid);
  };

  const tasksForGoal = (goalId) => queue.all()
    .filter((t) => t && t.goalId === goalId)
    .sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0));

  // 'done' | 'failed' | 'running' — derived purely from a goal's task records, RETRY-AWARE.
  //
  // S4 — a step can have SEVERAL task records: the engine's red→green loop (and every other
  // retry kind) marks a failed attempt `failed` and enqueues a FRESH task for the same
  // stepIndex. So a step that failed-then-succeeded holds a `failed` record AND a `done`
  // record. Folding per step is therefore mandatory: a step is `done` if ANY of its attempts
  // landed, `running` if a later attempt is still in flight (a fix is retrying), and only
  // `failed` once EVERY attempt for it is terminal-failed. Without this fold a single retried
  // step would read the stale `failed` attempt and wrongly block a story that actually passed.
  function stepStatus(list) {
    if (list.some((t) => t.status === "done")) return "done";
    if (list.some((t) => t.status !== "failed" && t.status !== "cancelled")) return "running";
    return "failed";
  }
  function goalState(goal) {
    const tasks = tasksForGoal(goal.goalId);
    if (!tasks.length) return "running";
    const lastIndex = Math.max(0, (Array.isArray(goal.steps) ? goal.steps.length : 1) - 1);
    const byStep = new Map();
    for (const t of tasks) {
      const i = t.stepIndex ?? 0;
      if (!byStep.has(i)) byStep.set(i, []);
      byStep.get(i).push(t);
    }
    // A goal fails the moment ANY step is terminally failed with no live retry left.
    for (const list of byStep.values()) if (stepStatus(list) === "failed") return "failed";
    // Otherwise it is done only when the FINAL step has landed; anything else is still running.
    const finalList = byStep.get(lastIndex);
    if (finalList && stepStatus(finalList) === "done") return "done";
    return "running";
  }

  // The Build-panel shape: per-seat goals, their tasks (status/hold/diff/attempts), and each
  // task's loop steps. Read-only; safe to call from the Story GET on every request.
  function aggregate(storyId) {
    const gs = goalsForStory(storyId);
    const goalsOut = gs.map((g) => {
      const tasks = tasksForGoal(g.goalId).map((t) => ({
        taskId: t.taskId,
        stepIndex: t.stepIndex ?? 0,
        status: t.status,
        engineState: t.engineState ?? null,
        heldReason: t.heldReason ?? null,
        branch: t.branch ?? null,
        attempts: t.attempts ?? 0,
        result: t.result ?? null,
        error: t.error ?? null,
        loopSteps: loopSteps ? loopSteps.list(t.taskId) : [],
      }));
      return {
        goalId: g.goalId,
        seat: g.agentId,
        tier: g.tier ?? null,
        steps: Array.isArray(g.steps) ? g.steps : [],
        state: goalState(g),
        tasks,
      };
    });
    const counts = { done: 0, failed: 0, running: 0 };
    for (const g of goalsOut) counts[g.state] = (counts[g.state] || 0) + 1;
    return { goals: goalsOut, counts, total: goalsOut.length };
  }

  // Called once per terminal task for a story (engine onDone / onTerminalFailure). Advances
  // or blocks the story when — and only when — every one of its goals is terminal.
  function onTerminalTask(storyId) {
    const story = stories.getStory(storyId);
    if (!story || story.stage !== BUILD_STAGE) return { skipped: true, reason: "not in build" };
    const gs = goalsForStory(storyId);
    if (!gs.length) return { skipped: true, reason: "no goals" };
    const states = gs.map(goalState);
    if (states.some((s) => s === "running")) return { pending: true };

    const failed = states.filter((s) => s === "failed").length;
    if (failed >= failThreshold) {
      // Fail-safe: park the story `blocked` and surface ONE Inbox alert. Idempotent — a
      // second terminal event finds the story already blocked and re-mints nothing.
      if (story.status !== "blocked") {
        try {
          stories.update(storyId, { status: "blocked", event: "build-blocked", ref: `${failed}/${gs.length} goal failure(s)` });
        } catch (e) { log(`[story-build] block write skipped for ${storyId}: ${e?.message}`); return { error: e?.message }; }
        if (mintAlert) {
          try {
            // taskId=storyId keeps the alert UNIQUE per story (mintFailure dedupes on
            // taskId+agentId), so two different blocked stories never collapse onto one row.
            mintAlert({
              agentId: gs[0].agentId, taskId: storyId, kind: "build-blocked", attempts: failed,
              detail: `Story ${storyId}: ${failed} of ${gs.length} build goal(s) exhausted their retries. The story is blocked pending your review.`,
            });
          } catch (e) { log(`[story-build] block alert skipped for ${storyId}: ${e?.message}`); }
        }
      }
      return { blocked: true, failed, total: gs.length };
    }

    // Every goal done → advance build → review-qa.
    try {
      stories.advance(storyId, { event: "build-complete", ref: `${gs.length} goal(s) done` });
    } catch (e) { log(`[story-build] advance skipped for ${storyId}: ${e?.message}`); return { error: e?.message }; }
    // S4 — kick the review-QA stage driver. Isolated + fire-and-forget: the advance already
    // committed, so a driver fault (or its async work) must never un-advance the story.
    if (onEnterReviewQa) {
      try { Promise.resolve(onEnterReviewQa(storyId)).catch((e) => log(`[story-build] review-qa driver rejected for ${storyId}: ${e?.message}`)); }
      catch (e) { log(`[story-build] review-qa driver kick skipped for ${storyId}: ${e?.message}`); }
    }
    return { advanced: true, total: gs.length };
  }

  return { aggregate, onTerminalTask, goalsForStory, goalState };
}

// AUTONOMY PROGRAM PHASE 3 — THE HANDBACK DISPATCHER.
//
// THE GAP, stated exactly: the reviewer→developer loop EXISTED as a state machine
// (STORY_STAGES, reject() → the closed STORY_BACK map, 409 on an unenumerated jump) and
// **nothing dispatched the rework**. A reject moved the stage and stopped. The one place
// that did enqueue anything was the reviewer gate's own private call — so a reject arriving
// any other way (the HTTP route, an operator, another agent) bounced a story that nobody
// then picked up. "Communicate continuously without human intervention" died at that seam.
//
// This module is what stories.reject() now fires. It is PURE over injected seams — no
// storage, no transport, no clock of its own — so its two real decisions are testable
// without a database or a queue:
//
//   1. WHO picks the work up. The handback may name a seat; otherwise the stage owns one.
//      A stage with no seat is ESCALATED, never silently dropped: an undispatchable rework
//      that looks dispatched is worse than one that pages a human.
//
//   2. WHEN TO STOP. A rework loop with no cap is a denial-of-service on your own budget —
//      reviewer blocks, fixer fixes, reviewer blocks, forever, spending real money each
//      round. The cap is counted from the DURABLE story_log, not from an in-memory Map:
//      the review gate's existing budget lives in a Map that empties on restart, so a
//      story could bounce indefinitely across restarts and the cap would never bite.

/** Rework rounds allowed per story per target stage before a human is paged. */
export const DEFAULT_MAX_ROUNDS = 3;

/**
 * Which seat picks up rework bounced BACK to each stage.
 *
 * The forward-driving stages reuse pipeline.STAGE_AGENTS' owners, so a bounce lands on the
 * same seat that produced the artifact being reworked. `build` is the fixer seat, matching
 * story-reviewqa's own default — a blocker found in review is fixed by the builder.
 * `idea` is absent deliberately: nothing is bounced back to intake (STORY_BACK has no
 * target that reaches it from a stage an agent drives), so a seat there would be fiction.
 */
export const SEAT_FOR_STAGE = Object.freeze({
  requirements: "pm-analyst",
  design: "architect",
  plan: "tech-lead",
  build: "sr-backend",
  "review-qa": "reviewer",
  "deploy-watch": "sre",
});

/** Cap the brief so a pasted reviewer essay cannot become an unbounded task prompt. */
const MAX_BRIEF = 4000;

/**
 * Compose the rework brief. It is the REASON, verbatim, plus the evidence the reviewer was
 * looking at — not a paraphrase. The seat receiving this needs what the sender actually
 * said; a summarised handback is how "fix the auth bug" becomes "improve auth".
 */
export function reworkBrief({ fromStage, toStage, byAgent, reason, evidence } = {}) {
  const who = byAgent ? `${byAgent}` : "the pipeline";
  const lines = [
    `REWORK REQUESTED. This story was sent back from '${fromStage}' to '${toStage}' by ${who}.`,
    "",
    `Reason: ${reason || "(no reason was recorded)"}`,
  ];
  const ev = Array.isArray(evidence) ? evidence.filter(Boolean) : [];
  if (ev.length) {
    lines.push("", "Evidence:");
    for (const e of ev) lines.push(`  - ${e}`);
  }
  lines.push(
    "",
    "Make the concrete change that resolves this in the working directory. Do not edit tests to hide a real failure.",
  );
  return lines.join("\n").slice(0, MAX_BRIEF);
}

export function createStoryHandback(deps = {}) {
  const enqueueGoal = typeof deps.enqueueGoal === "function" ? deps.enqueueGoal : null;
  const stories = deps.stories || null;
  const mintAlert = typeof deps.mintAlert === "function" ? deps.mintAlert : null;
  const seats = deps.seats || SEAT_FOR_STAGE;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const maxRounds = Number.isFinite(Number(deps.maxRounds)) && Number(deps.maxRounds) > 0
    ? Math.floor(Number(deps.maxRounds))
    : DEFAULT_MAX_ROUNDS;

  /**
   * Escalate to the BOSS instead of dispatching. Used for the round cap and for a handback
   * nobody can pick up. BOTH effects are attempted independently: a story parked `blocked`
   * with no Inbox row is invisible, and an Inbox row on a story still marked `active` reads
   * as though the loop is still running. Neither failure may suppress the other.
   */
  function escalate(hb, kind, detail) {
    if (stories && typeof stories.update === "function") {
      try {
        stories.update(hb.storyId, { status: "blocked", event: kind, ref: detail.slice(0, 480) });
      } catch (e) { log(`[handback] block write skipped for ${hb.storyId}: ${e?.message}`); }
    }
    if (mintAlert) {
      try {
        // taskId = storyId keeps the alert UNIQUE per story (mintFailure dedupes on
        // taskId+agentId), so two stuck stories never collapse onto one row.
        mintAlert({
          agentId: hb.byAgent || seats[hb.toStage] || "tech-lead",
          taskId: hb.storyId,
          kind,
          attempts: hb.round ?? 0,
          detail,
        });
      } catch (e) { log(`[handback] alert skipped for ${hb.storyId}: ${e?.message}`); }
    }
    return { escalated: true, kind, detail };
  }

  /**
   * Dispatch one committed handback. Never throws: stories.reject() has ALREADY persisted
   * the bounce by the time this runs, and an exception here would only obscure that.
   */
  function dispatch(hb = {}) {
    const storyId = String(hb.storyId || "");
    if (!storyId) return { skipped: true, reason: "no storyId" };
    const round = Number.isFinite(Number(hb.round)) ? Number(hb.round) : 0;

    // THE LOOP GUARD. Bounce N+1 does not dispatch — it pages a human with the count, so
    // the operator learns the loop is not converging rather than watching the budget drain.
    if (round > maxRounds) {
      return escalate(
        { ...hb, round },
        "rework-capped",
        `Story ${storyId}: rework has bounced ${round} time(s) from '${hb.fromStage}' to '${hb.toStage}' — past the cap of ${maxRounds}. `
        + `The loop is not converging, so it has been stopped and handed to you. Last reason: ${hb.reason || "(none recorded)"}`,
      );
    }

    const seat = hb.toAgent || seats[hb.toStage] || null;
    if (!seat) {
      return escalate(
        { ...hb, round },
        "handback-unroutable",
        `Story ${storyId}: sent back to '${hb.toStage}', but no seat owns that stage, so nothing can pick it up. Reason: ${hb.reason || "(none recorded)"}`,
      );
    }
    if (!enqueueGoal) {
      // Unwired (tests, or a runtime without an engine). Say so rather than reporting a
      // dispatch that did not happen — a false success here is exactly the class of claim
      // this program keeps finding.
      return escalate(
        { ...hb, round },
        "handback-undispatched",
        `Story ${storyId}: sent back to '${hb.toStage}' for ${seat}, but no engine is wired to run it. Reason: ${hb.reason || "(none recorded)"}`,
      );
    }

    const steps = [reworkBrief(hb)];
    try {
      // `priority: high` — rework is work that has ALREADY been through the pipeline once.
      // Queueing it behind fresh work is how a story ages out while nothing is wrong with it.
      const r = enqueueGoal({ agentId: seat, tier: "sonnet", priority: "high", storyId, steps });
      if (r && r.error) {
        return escalate({ ...hb, round }, "handback-undispatched",
          `Story ${storyId}: rework for ${seat} could not be queued (${r.error}). Reason: ${hb.reason || "(none recorded)"}`);
      }
      return { dispatched: true, seat, round, goalId: r?.goalId ?? null };
    } catch (e) {
      return escalate({ ...hb, round }, "handback-undispatched",
        `Story ${storyId}: rework for ${seat} could not be queued (${e?.message || e}). Reason: ${hb.reason || "(none recorded)"}`);
    }
  }

  return { dispatch, reworkBrief, maxRounds, seats };
}

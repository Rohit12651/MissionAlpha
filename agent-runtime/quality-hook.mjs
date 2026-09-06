// Phase 1 / R1 — the POST-EDIT QUALITY-GATE HANDLER.
//
// hooks.mjs shipped the veto MECHANISM and engineDispatchTracked shipped the CHOKE POINT,
// but nothing was ever registered on `post-edit`: a safety interlock with no user. This is
// its first real one. It runs the repo's configured test suite against the worktree the
// turn just wrote into, and stops the turn when the suite fails — before broker.listChanges
// computes a diff, before onDiffed mints a Delivery, before a human is asked to look at
// work that already fails its own tests.
//
// WHERE IT SITS AND WHY THAT IS NOT A DUPLICATE:
//   engine.runStep already runs this exact gate for STORY-BUILD tasks (post-diff, pre-mint,
//   gated on `task.storyId`). Everything else — a manual /run, a cadence worker, a Tier-0
//   codemod — has never had a quality gate at all. That gap is what this fills, so a story
//   task is SKIPPED here rather than gated twice: two container runs for one verdict is
//   pure cost, and a second verdict that disagreed with the first would be worse than cost.
//
// FAIL OPEN ON INFRASTRUCTURE, FAIL CLOSED ON EVIDENCE — the one judgement in this file.
//   A failing test suite is EVIDENCE about the diff → veto.
//   A missing Docker daemon, an unreadable quality config, a gate that threw → those say
//   nothing about the diff. Vetoing on them would kill every autonomous run on every
//   machine without Docker, forever, at the same line. That is exactly ruflo's dead-daemon
//   pathology: a guard whose own unavailability wedges the system it guards. The two cases
//   are separated by test-gate.mjs's own `reason` field, never by inference.
//
//   The cost of failing open is a LOST SIGNAL, not a widened boundary. This is a QUALITY
//   control. Containment — worktree isolation, broker.applyChanges, the risk band, the
//   policy gate, the human decision — is entirely downstream and entirely unaffected. A
//   diff that skipped this gate still cannot reach the repo without a person.
//
//   Failing open is never SILENT. Every skip logs its reason; `npm run doctor` already
//   reports sandbox reachability, so "my gate has not run in a week" is answerable.

/**
 * Reasons test-gate.mjs returns when the gate COULD NOT RUN, as opposed to running and
 * failing. Closed set, mirrored from that module's own return values — derived from the
 * code it grades, never assumed about it.
 */
export const INFRA_REASONS = Object.freeze(new Set([
  "sandbox-unavailable", // no Docker daemon
  "sandbox-error",       // the jail itself threw
  "config",              // quality.json missing/invalid — fails closed THERE, not here
  "no-worktree",         // nothing to test in isolation
  "workdir-escape",      // the cwd guard refused; a containment stop, not a code verdict
  // D1 — the whole configured suite was too big to finish inside the deadline. That is a
  // fact about the COMMAND, not about the diff, and treating it as evidence is precisely
  // what killed 42 consecutive autonomous runs on this install. A timeout on a SCOPED run
  // carries no such reason and keeps vetoing, because there it really is about the diff.
  "gate-timeout-unscoped",
]));

/** Hard bound on the veto reason. Test output is unbounded; a failure message is not. */
export const REASON_MAX = 500;

/**
 * createQualityGateHook({ gate, log }) → async (ctx) => { abort, reason } | undefined
 *
 * `gate` is the injected test gate ({ run({task, workdir}) }) — the SAME object
 * engine.runStep uses, so there is one gate implementation and one security posture.
 * Returning `undefined` means "no opinion, proceed", which is what hooks.fire treats as a
 * non-veto.
 */
export function createQualityGateHook(deps = {}) {
  const gate = deps.gate && typeof deps.gate.run === "function" ? deps.gate : null;
  const log = typeof deps.log === "function" ? deps.log : () => {};

  return async function qualityGate(ctx = {}) {
    // An unregistered seam is inert. A dependency that failed to wire must never become a
    // veto — that would turn a boot-order mistake into a total autonomy outage.
    if (!gate) return undefined;
    if (ctx.storyId) return undefined;      // engine.runStep owns the verdict for stories
    if (!ctx.workdir) return undefined;     // nothing isolated to test

    let verdict;
    try {
      verdict = await gate.run({ task: { taskId: ctx.taskId, agentId: ctx.agentId }, workdir: ctx.workdir });
    } catch (e) {
      log(`[quality-hook] gate threw for ${ctx.taskId} — proceeding unverified: ${e?.message || e}`);
      return undefined;
    }

    if (!verdict || typeof verdict !== "object") {
      log(`[quality-hook] gate returned no verdict for ${ctx.taskId} — proceeding unverified`);
      return undefined;
    }
    if (verdict.pass === true) return undefined;

    if (verdict.reason && INFRA_REASONS.has(verdict.reason)) {
      log(`[quality-hook] gate could not run for ${ctx.taskId} (${verdict.reason}) — proceeding UNVERIFIED, not vetoed`);
      return undefined;
    }

    const detail = verdict.timedOut
      ? "the suite timed out and was killed"
      : String(verdict.tail || `exit ${verdict.exitCode ?? "?"}`);
    return {
      abort: true,
      reason: `quality gate failed in the worktree — ${detail}`.slice(0, REASON_MAX),
    };
  };
}

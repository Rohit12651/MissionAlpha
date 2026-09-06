// Phase 4 / R14 — ANTI-DRIFT: the stall detector.
//
// WHAT WAS ALREADY THERE (audited before writing a line — this is a DELTA, not a rebuild):
//   • queue.mjs serializes per AGENT (maxPerAgent, default 1) inside claimNext.
//   • queue.mjs leases claims and reclaimExpiredLeases() requeues a claimed task whose
//     owner is gone.
//   • engine.runStep wraps the dispatch in a watchdog, so a hung SPAWN dies at 5 minutes.
//
// WHAT WAS MISSING, and why the gap mattered:
//   reclaimExpiredLeases only acts when `isLive(taskId)` is FALSE. A task whose handle is
//   still live but which never settles is invisible to it. So is a queued task nothing ever
//   claims. Neither condition produces an error, a retry, or a frame — the system is not
//   failing, it is SILENT, and silence is indistinguishable from idle. That is precisely
//   how a three-day outage on this install stayed invisible: every surface said "fine".
//
//   This module makes a wedge SAY SOMETHING. It does not repair anything (same law as
//   doctor and metaharness — silently fixing a wedge hides the drift that caused it).
//
// WHY `held` IS NOT A STALL. A held task is waiting for a human, and its Delivery is
// already sitting in the Inbox. Escalating it would mint a second row about a row the
// operator can already see, and would turn "nobody has decided yet" — a legitimate,
// possibly weeks-long state — into a daily alarm. The machine's silence is the fault;
// a person's is not this module's business.
//
// LAW 3, structurally:
//   • The ONLY mint path is deliveries.mintFailure, which hard-codes kind='failure',
//     diffFiles=0 and changedPaths='[]'. Auto-apply is therefore not "disallowed" but
//     IMPOSSIBLE — an approve has zero paths to apply.
//   • ONE per stall EPISODE. The episode key is (taskId, updatedAt): while the task does
//     not move it is the same event, and an event reported twice is noise that trains the
//     operator to ignore the channel. If the task moves and wedges again, that is new.
//   • DAILY CAPPED through the same worker-cap store the cadence workers use, under ONE
//     id, so a hundred wedged tasks cannot become a hundred Deliveries.
//   • Without a cap seam it mints NOTHING. A law whose mechanism is absent is not a law
//     you may proceed without — an unbounded escalation storm is worse than the wedge.

/** Non-terminal states the MACHINE owns. `held` is excluded on purpose (see header). */
export const STALL_STATES = Object.freeze(new Set(["queued", "claimed"]));

/** 30 minutes. Long enough that a slow-but-live turn is never mistaken for a wedge. */
export const DEFAULT_STALL_MS = 30 * 60_000;

/** One budget id for every stall escalation — the cap is on the CLASS, not per task. */
export const CAP_ID = "anti-drift";

export function createAntiDrift(deps = {}) {
  const queue = deps.queue;
  const mintFailure = typeof deps.mintFailure === "function" ? deps.mintFailure : null;
  const cap = deps.cap && typeof deps.cap.consume === "function" ? deps.cap : null;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const stallMs = Number.isFinite(Number(deps.stallMs)) && Number(deps.stallMs) > 0
    ? Number(deps.stallMs)
    : DEFAULT_STALL_MS;

  // taskId → the updatedAt we already escalated on. Bounded by pruning entries whose task
  // is no longer present in the queue.
  const reported = new Map();

  /**
   * Age of a record in ms, or null when it has NO USABLE TIMESTAMP.
   *
   * `null` here means unknown, never "very old". Date.parse(null) is 0, which would read
   * as 1970 and mark every timestamp-less record as maximally stalled — the same
   * null-is-not-zero trap sizeBand() hit. An absent measurement is not an extreme one.
   */
  function ageOf(rec, t) {
    const raw = rec?.updatedAt;
    if (typeof raw !== "string" || !raw) return null;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return null;
    return t - ms;
  }

  /**
   * One pass. Returns { checked, stalled, minted, repeats, capped, errors } and NEVER
   * throws — it runs on a shared timer, and a sweep that can take the timer down would be
   * a new silent-wedge source of exactly the kind it exists to remove.
   */
  function sweep() {
    const out = { checked: 0, stalled: 0, minted: 0, repeats: 0, capped: 0, errors: 0 };
    const t = now();

    let rows;
    try {
      rows = queue && typeof queue.all === "function" ? queue.all() : [];
    } catch (e) {
      log(`[anti-drift] queue read failed: ${e?.message || e}`);
      out.errors++;
      return out;
    }

    const live = new Set();
    for (const rec of rows || []) {
      live.add(rec?.taskId);
      out.checked++;
      if (!STALL_STATES.has(rec?.status)) continue;
      const age = ageOf(rec, t);
      if (age === null || age < stallMs) continue;

      out.stalled++;
      const key = rec.taskId;
      if (reported.get(key) === rec.updatedAt) { out.repeats++; continue; }

      if (!cap) {
        log(`[anti-drift] ${key} wedged ${Math.round(age / 60_000)}m but NO daily cap is wired — refusing to mint (Law 3)`);
        continue;
      }
      if (!mintFailure) {
        log(`[anti-drift] ${key} wedged but no mint seam is wired — nothing can be surfaced`);
        continue;
      }
      if (!cap.allows(CAP_ID, t)) { out.capped++; continue; }

      try {
        mintFailure({
          agentId: rec.agentId,
          taskId: rec.taskId,
          kind: "stalled",
          attempts: rec.attempts ?? 0,
          detail:
            `Task ${rec.taskId} has been '${rec.status}' for ${Math.round(age / 60_000)} minutes with no state change.\n`
            + `Story: ${rec.storyId ?? "(none)"}\n`
            + `No diff is attached: nothing was produced, which is the problem being reported.`,
        });
        cap.consume(CAP_ID, t);
        reported.set(key, rec.updatedAt);
        out.minted++;
        log(`[anti-drift] escalated ${key} — '${rec.status}' for ${Math.round(age / 60_000)}m`);
      } catch (e) {
        // One bad row must not abandon the rest of the sweep.
        out.errors++;
        log(`[anti-drift] escalation failed for ${key}: ${e?.message || e}`);
      }
    }

    // Forget tasks the queue no longer holds, so the episode map cannot grow forever.
    for (const k of reported.keys()) if (!live.has(k)) reported.delete(k);
    return out;
  }

  return { sweep, stallMs, STALL_STATES };
}

// D5 — THE STORY PIPELINE'S MISSING RETRY. PURE over an injected store + clock.
//
// THE DEFECT, measured live on 2026-08-24: `story_7ab7b078ca46d5bf` was advanced into
// `requirements`; the provider answered
//     HTTP 429 — "stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly."
// pipeline.failStage did exactly what it was built to do — parked the story `blocked`,
// landed no artifact, minted one honest failure Delivery — and then NOTHING ever came
// back for it. The engine queue has had bounded 429 backoff since ADR-028; the story
// pipeline had none. One rate-limit ended a story until a human noticed, in a product
// whose claim is "autonomous between decisions".
//
// THE ONE JUDGEMENT: `blocked` covers two very different facts.
//   • A TRANSIENT fault (429, 5xx, reset socket, an empty reply) is the provider saying
//     "not now". Re-entering the stage later is the whole point of a bounded backoff.
//   • A SETTLED fault (401/403, no active account, a broken quality config) is an answer.
//     Retrying it burns rate limit to re-derive a fact we already have and, worse, keeps
//     a blocker the OPERATOR must clear looking like weather.
// So the classifier is a CLOSED set on both sides, deterministic wins whenever both
// match, and anything unrecognised is NOT retried — silence is not a licence to spend.
//
// Bounded by construction: MAX_STAGE_ATTEMPTS failures per (story, stage), exponential
// backoff off the story's own last failure row, one in-flight re-entry per story. The
// attempt count is READ from `story_log`, never held in memory, so a runtime restart can
// neither reset the budget nor double-spend it.

/** Provider weather. Every entry has been observed on the wire or is a standard errno. */
const TRANSIENT = [
  /\b429\b/, /rate[- ]?limit/i, /too many requests/i,
  /\b50[0234]\b/, /bad gateway/i, /service unavailable/i, /gateway time-?out/i,
  /econnreset/i, /etimedout/i, /econnrefused/i, /eai_again/i, /socket hang up/i,
  /timed out/i, /\btimeout\b/i,
  /empty reply/i, /overloaded/i, /temporarily/i,
];

/** Settled answers. These BEAT the transient set — see the header. */
const DETERMINISTIC = [
  /\b401\b/, /\b403\b/, /unauthor/i, /forbidden/i,
  /authenticat/i, /oauth/i, /invalid api key/i, /api key/i,
  /no active account/i, /not tool[- ]capable/i, /chat[- ]only/i,
  /quality config/i, /insufficient_quota/i, /\bpayment\b/i, /\bbilling\b/i,
];

/** How many times ONE (story, stage) may be re-entered before it stays blocked for a human. */
export const MAX_STAGE_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 30_000;
const DEFAULT_MAX_DELAY_MS = 600_000;
// A stage on a live model takes 2-5 minutes; the runtime's own stage deadline is 600s.
// Past 600s + a margin the stage is not slow, it is GONE — see the stalled-active note.
const DEFAULT_STALL_MS = 720_000;

// D2 (Phase 6, task 6.3) — the rows THIS module writes about its own clock. They are
// bookkeeping, never progress: counting them as story-log activity would turn a PAUSE
// into a RESET, and a story that genuinely stalls behind a human gate would then never
// be rescued at all. `lastRowTs` skips them for exactly that reason.
const CLOCK_EVENTS = new Set(["stall-clock-paused", "stall-clock-resumed"]);

/** Is this failure reason worth another attempt? Closed set; unknown ⇒ no. Never throws. */
export function isTransientReason(reason) {
  const s = String(reason ?? "");
  if (!s) return false;
  if (DETERMINISTIC.some((re) => re.test(s))) return false;
  return TRANSIENT.some((re) => re.test(s));
}

/** How many times this stage has already FAILED, read from the story's own log. */
export function stageAttempts(log, stage) {
  const want = `${stage}-failed`;
  return (log || []).filter((r) => r && r.event === want).length;
}

/** Exponential backoff off the last failure, capped. Deterministic — no jitter to reason about. */
export function retryDelayMs(attempt, { baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS } = {}) {
  const n = Math.max(1, Math.floor(attempt));
  const raw = baseDelayMs * Math.pow(2, n - 1);
  return Math.min(raw, maxDelayMs);
}

/** The newest `${stage}-failed` row for this stage, or null. */
function lastFailure(log, stage) {
  const want = `${stage}-failed`;
  let best = null;
  for (const r of log || []) {
    if (!r || r.event !== want) continue;
    if (!best || Number(r.ts || 0) >= Number(best.ts || 0)) best = r;
  }
  return best;
}

/**
 * createStageRetry({ stories, enterStage, now, baseDelayMs, maxDelayMs, maxAttempts, log })
 *
 * `sweep()` is the whole surface: find blocked stories whose last stage failure was
 * transient and whose backoff has elapsed, flip them back to `active` with a logged
 * `${stage}-retry` row, and re-enter the stage. Returns counts; never throws.
 */
export function createStageRetry(deps = {}) {
  const stories = deps.stories;
  if (!stories || typeof stories.listStories !== "function" || typeof stories.getLog !== "function") {
    throw new Error("createStageRetry: stories store with listStories/getLog required");
  }
  const enterStage = typeof deps.enterStage === "function" ? deps.enterStage : null;
  if (!enterStage) throw new Error("createStageRetry: enterStage required");
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const baseDelayMs = Number(deps.baseDelayMs) > 0 ? Number(deps.baseDelayMs) : DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = Number(deps.maxDelayMs) > 0 ? Number(deps.maxDelayMs) : DEFAULT_MAX_DELAY_MS;
  const maxAttempts = Number(deps.maxAttempts) > 0 ? Number(deps.maxAttempts) : MAX_STAGE_ATTEMPTS;
  const stallMs = Number(deps.stallMs) > 0 ? Number(deps.stallMs) : DEFAULT_STALL_MS;
  // #8 — how long the shared provider is still refusing everyone (0 = it is answering).
  // Injected, optional, and FAIL-OPEN: this is an optimisation over a shared resource, and
  // a fault in it must cost a wasted call, never a refused retry.
  const providerHoldMs = typeof deps.providerHoldMs === "function" ? deps.providerHoldMs : () => 0;
  // D2 (Phase 6, task 6.3) — the two seams that let this module SEE A HUMAN.
  //
  // THE DEFECT, live 2026-09-02: a build task sat HELD for 13 minutes while the operator
  // read its Delivery diff. This sweep has no way to tell that from machine silence, so it
  // fired `no progress for 771s — the stage stalled`, the re-entry was declined, and the
  // story was parked `blocked`. A human reading a diff blocked the story; the rescue
  // mechanism became the outage.
  //
  // Both seams default to "nothing is holding it", which reproduces the pre-6.3 clock
  // EXACTLY — an un-wired runtime keeps the old, known behaviour rather than a silently
  // different one. Both are FAIL-OPEN for the same reason providerHoldMs is: a fault in a
  // lookup about a human must cost one wasted re-entry, never a story that is never rescued.
  const listGates = typeof deps.listGates === "function" ? deps.listGates : () => [];
  const tasksForStory = typeof deps.tasksForStory === "function" ? deps.tasksForStory : () => [];

  // One re-entry per story at a time. The sweep rides a shared 60s heartbeat and a stage
  // takes minutes on a real model, so overlapping sweeps are the normal case, not the edge.
  //
  // Keyed by START TIME, not just presence: a dispatch that never settles would otherwise
  // hold its story hostage forever, and "the recovery mechanism is itself wedged" is the
  // worst possible version of this bug. Past the stall deadline the entry is evicted — we
  // cannot cancel the orphan, but we can stop it blocking the rescue.
  const inFlight = new Map(); // storyId → startedAt

  function evictStaleInFlight() {
    const t = now();
    for (const [id, startedAt] of inFlight) {
      if (t - startedAt > stallMs) {
        inFlight.delete(id);
        log(`[stage-retry] re-entry for ${id} never settled within ${Math.round(stallMs / 1000)}s — releasing it so the story can be retried`);
      }
    }
  }

  /**
   * The newest row of any kind — how we tell "slow" from "gone". EXCEPT this module's own
   * clock rows: writing `stall-clock-paused` must not itself count as the story moving.
   */
  function lastRowTs(rows) {
    let t = 0;
    for (const r of rows || []) {
      if (r && CLOCK_EVENTS.has(r.event)) continue;
      t = Math.max(t, Number(r?.ts || 0));
    }
    return t;
  }

  // ── the paused stall clock ────────────────────────────────────────────────
  // storyId → { rowTs, pausedMs, pausedSince }. Keyed by the story's newest real row, so
  // any actual progress starts a fresh clock with a zero pause budget. Held in memory only:
  // losing it on restart costs at most one over-long idle measurement, and the alternative
  // (a durable pause ledger) is state this module has no business owning.
  const stallClock = new Map();

  /** WHY a human owns this story right now, or null when the machine does. Never throws. */
  function pauseReason(story) {
    if (story.status === "waiting-you") return "story is waiting-you — the BOSS owns it";
    let gates = [];
    try { gates = listGates(story.id) || []; }
    catch (e) { log(`[stage-retry] gate lookup failed for ${story.id}: ${e?.message || e}`); gates = []; }
    if (gates.length) return `${gates.length} pending gate/Delivery awaiting a decision`;
    let tasks = [];
    try { tasks = tasksForStory(story.id) || []; }
    catch (e) { log(`[stage-retry] task lookup failed for ${story.id}: ${e?.message || e}`); tasks = []; }
    const held = tasks.filter((t) => String(t?.status || "").toLowerCase() === "held");
    if (held.length) return `${held.length} task(s) held for an operator decision`;
    return null;
  }

  /** Record one clock row on the story. Never throws — bookkeeping must not break a sweep. */
  function clockRow(storyId, event, ref) {
    try { stories.update(storyId, { event, ref: String(ref).slice(0, 160) }); }
    catch (e) { log(`[stage-retry] could not log ${event} for ${storyId}: ${e?.message || e}`); }
  }

  /**
   * Idle time the MACHINE actually accrued: wall time since the last real row, minus every
   * interval a human owned. Also drives the pause/resume transitions (one logged row per
   * EPISODE, not per sweep). Called for every story the sweep sees, including `waiting-you`
   * ones that are not retry candidates — a pause that is never observed cannot be subtracted.
   */
  function machineIdleMs(story, rows) {
    const t = now();
    const rowTs = lastRowTs(rows);
    let st = stallClock.get(story.id);
    if (!st || st.rowTs !== rowTs) { st = { rowTs, pausedMs: 0, pausedSince: 0 }; stallClock.set(story.id, st); }
    const reason = pauseReason(story);
    if (reason && !st.pausedSince) {
      st.pausedSince = t;
      log(`[stage-retry] stall clock paused for ${story.id}: ${reason}`);
      clockRow(story.id, "stall-clock-paused", reason);
    } else if (!reason && st.pausedSince) {
      st.pausedMs += Math.max(0, t - st.pausedSince);
      st.pausedSince = 0;
      log(`[stage-retry] stall clock resumed for ${story.id} (${Math.round(st.pausedMs / 1000)}s not counted)`);
      clockRow(story.id, "stall-clock-resumed", `${Math.round(st.pausedMs / 1000)}s of human time not counted`);
    }
    const openPause = st.pausedSince ? Math.max(0, t - st.pausedSince) : 0;
    return Math.max(0, (t - rowTs) - st.pausedMs - openPause);
  }

  /** Is this story due for another attempt right now, and why / why not. */
  function candidate(story) {
    const rows = stories.getLog(story.id) || [];
    const attempts = stageAttempts(rows, story.stage);
    if (attempts >= maxAttempts) return null;

    // (1) STALLED-ACTIVE. A story `active` with nothing moving claims someone is working
    // on it. Observed live at twenty minutes and counting, produced by this very sweep,
    // which is why the rescue belongs here rather than in some other module.
    if (story.status === "active") {
      // 6.3 — the clock the human gates pause. `machineIdleMs` subtracts every interval a
      // task was HELD, a gate was pending, or the story was `waiting-you`.
      const idle = machineIdleMs(story, rows);
      if (idle < stallMs) return null;
      return { storyId: story.id, stage: story.stage, attempt: attempts + 1, stalled: true,
        reason: `no progress for ${Math.round(idle / 1000)}s — the stage stalled` };
    }

    // (2) BLOCKED by a transient fault, past its backoff.
    const fail = lastFailure(rows, story.stage);
    if (!fail) return null;
    if (!isTransientReason(fail.ref)) return null;
    const due = Number(fail.ts || 0) + retryDelayMs(attempts, { baseDelayMs, maxDelayMs });
    if (now() < due) return null;
    return { storyId: story.id, stage: story.stage, attempt: attempts + 1, reason: String(fail.ref || "") };
  }

  /** Put a story back where the sweep found it, with the reason recorded. Never throws. */
  function reblock(c, why) {
    try {
      stories.update(c.storyId, {
        status: "blocked",
        event: `${c.stage}-failed`,
        ref: `retry declined: ${String(why).slice(0, 160)}`,
      });
    } catch (e) { log(`[stage-retry] could not re-block ${c.storyId}: ${e?.message || e}`); }
  }

  async function sweep() {
    let started = 0, errors = 0;
    evictStaleInFlight();

    // Checked ONCE per sweep, not per story: the whole point is that these stories share
    // one endpoint. Re-entering six of them on the same beat is what produced the herd
    // against `stealth/ox-alpha` this was written for.
    let hold = 0;
    try { hold = Number(providerHoldMs()) || 0; } catch { hold = 0; }
    if (hold > 0) {
      log(`[stage-retry] holding all re-entries for ${Math.round(hold / 1000)}s — the provider is refusing calls`);
      return { started: 0, errors: 0, providerHeld: true };
    }
    let candidates = [];
    // 6.3 — `waiting-you` stories are NEVER retry candidates, but the clock still has to
    // watch them: a pause that is never observed cannot be subtracted later, and that is
    // precisely how 20 minutes the BOSS owned became "no progress for 771s".
    let watchOnly = [];
    try {
      candidates = [
        ...(stories.listStories({ status: "blocked", limit: 200 }) || []),
        ...(stories.listStories({ status: "active", limit: 200 }) || []),
      ];
      watchOnly = stories.listStories({ status: "waiting-you", limit: 200 }) || [];
    } catch (e) { log(`[stage-retry] could not list stories: ${e?.message || e}`); return { started: 0, errors: 1 }; }

    const seen = new Set();
    for (const story of watchOnly) {
      seen.add(story.id);
      try { machineIdleMs(story, stories.getLog(story.id) || []); }
      catch (e) { log(`[stage-retry] clock tick skipped for ${story.id}: ${e?.message || e}`); }
    }

    for (const story of candidates) {
      seen.add(story.id);
      if (inFlight.has(story.id)) continue;
      let c = null;
      try { c = candidate(story); } catch (e) { log(`[stage-retry] skipped ${story.id}: ${e?.message || e}`); }
      if (!c) continue;
      inFlight.set(story.id, now());
      started += 1;
      // Flip to `active` BEFORE re-entering: enterStage refuses a story whose stage does
      // not match, and a story left `blocked` while something is working on it is the same
      // silent non-event this program exists to remove.
      try {
        stories.update(c.storyId, {
          status: "active",
          event: `${c.stage}-retry`,
          ref: `attempt ${c.attempt}/${maxAttempts} after: ${c.reason}`.slice(0, 200),
        });
      } catch (e) { log(`[stage-retry] could not un-block ${c.storyId}: ${e?.message || e}`); }
      log(`[stage-retry] re-entering ${c.storyId} at ${c.stage} (attempt ${c.attempt}/${maxAttempts}) after a transient failure`);
      try {
        const out = await enterStage(c.storyId, c.stage, { rerun: true });
        // The pipeline can DECLINE without throwing — an illegal transition, a stage
        // already in flight, a missing seam. Leaving the story `active` after a decline
        // would be an active story nothing is working on: the silent non-event this whole
        // program exists to remove, and worse than the `blocked` it started from. So a
        // decline is put back exactly where it was found.
        if (out && (out.skipped || out.deduped || out.code)) {
          reblock(c, out.reason || out.error || "the pipeline declined to re-enter this stage");
        }
      } catch (e) {
        errors += 1;
        log(`[stage-retry] re-entry failed for ${c.storyId}: ${e?.message || e}`);
        reblock(c, `re-entry threw: ${e?.message || e}`);
      } finally {
        inFlight.delete(c.storyId);
      }
    }
    // Bounded by construction: a story the sweep can no longer see is terminal (shipped /
    // rejected) or aged out of the 200-row window, and its clock is dead weight.
    for (const id of stallClock.keys()) if (!seen.has(id)) stallClock.delete(id);
    return { started, errors };
  }

  return { sweep, candidate, inFlightCount: () => inFlight.size };
}

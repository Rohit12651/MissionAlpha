// Phase 9 / task 9.2 — THE MANAGER. The product.
//
// A pure state machine: every dependency is injected, there is no I/O in this file, and the
// clock is a parameter. That is what lets the whole loop be exercised in a unit test with no
// model, no database and no wall-clock — and it is what makes the stall rules provable rather
// than hopeful.
//
// WHAT IT DOES, one step per tick():
//   intake   → read the repo, learn what is true, list what only the BOSS can answer
//   clarify  → ask ONCE, as ONE gate, then wait (awaiting-you)
//   planned  → validate the plan, assign BY SKILL from the roster, enqueue
//   building → drain the Manager's inbox: done / blocked / out-of-scope
//   review   → every task accounted for
//
// THREE RULES THAT ARE EASY TO GET WRONG, so they are stated here and pinned in tests:
//
// 1. THE MANAGER NEVER PICKS A SEAT BY NAME. The model returns `skillsRequired`; the runtime
//    matches that to a seat through `roster.match()`. A Manager that chose names could hand
//    work to a seat whose writeScope refuses it, and the refusal would surface to the
//    operator as a mystery rather than as a planning error.
//
// 2. TIME DOES NOT PASS WHILE A HUMAN IS THE BLOCKER. The stall clock ignores any period when
//    a job task is HELD or the job is `awaiting-you`. Phase 6 shipped the opposite defect:
//    771 seconds of human review counted as a stall and blocked the story.
//
// 3. A TRANSIENT FAILURE IS RETRIED; A DETERMINISTIC ONE IS NOT. A 429 is the provider being
//    busy and is worth three attempts. A 401 is the credential being wrong and will be wrong
//    forever — retrying it burns quota to reach the same answer. Detected with the EXISTING
//    isProviderOverload, not a second copy of that judgement.

import { SEED_DIRS } from "./guards.mjs";
import { isProviderOverload } from "./provider-breaker.mjs";
import { MAX_TASKS } from "./manager-prompts.mjs";

/** No progress for this long, with nobody waiting on a human, is a stall. */
export const DEFAULT_STALL_MS = Number(process.env.RUNTIME_MANAGER_STALL_MS) || 900_000;
/** Transient dispatch failures worth another attempt. */
export const MAX_TRANSIENT_RETRIES = 3;

/**
 * PURE. Is a plan safe to act on?
 * Agent-authored, so it is validated before a single goal is enqueued: an unbounded or
 * malformed plan becomes queue work that nobody asked for.
 */
export function validatePlan(plan, { catalog } = {}) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : null;
  if (!tasks) return { ok: false, error: "plan has no tasks[]" };
  if (!tasks.length) return { ok: false, error: "plan is empty" };
  if (tasks.length > MAX_TASKS) return { ok: false, error: `plan has ${tasks.length} tasks, cap is ${MAX_TASKS}` };
  const known = catalog instanceof Set ? catalog : new Set(catalog || []);
  for (const [i, t] of tasks.entries()) {
    if (!t || typeof t !== "object") return { ok: false, error: `task ${i + 1} is not an object` };
    if (!String(t.title ?? "").trim()) return { ok: false, error: `task ${i + 1} has no title` };
    const steps = Array.isArray(t.steps) ? t.steps.filter((s) => String(s ?? "").trim()) : [];
    if (!steps.length) return { ok: false, error: `task ${i + 1} has no steps` };
    const skills = Array.isArray(t.skillsRequired) ? t.skillsRequired : [];
    if (!skills.length) return { ok: false, error: `task ${i + 1} names no skills` };
    if (known.size) {
      const unknown = skills.filter((sk) => !known.has(sk));
      // A skill outside the governed catalog cannot be hired for OR matched, so it would sit
      // unassignable forever. Refuse the plan instead of enqueuing a task nobody can take.
      if (unknown.length) return { ok: false, error: `task ${i + 1} names unknown skill(s): ${unknown.join(", ")}` };
    }
  }
  return { ok: true, tasks };
}

/**
 * PURE. Should this job be called stalled?
 * `heldOrWaiting` is the whole point: a human is allowed to take as long as they like.
 */
export function isStalled({ lastProgressAt, now, stallMs = DEFAULT_STALL_MS, heldOrWaiting = false }) {
  if (heldOrWaiting) return false;
  if (!Number.isFinite(lastProgressAt) || !Number.isFinite(now)) return false;
  return now - lastProgressAt >= stallMs;
}

/** PURE. A dispatch error: retry it, or stop? */
export function classifyDispatchError(error) {
  const s = typeof error === "string" ? error : String(error?.message ?? error ?? "");
  if (!s) return { transient: false, reason: "unknown error" };
  if (isProviderOverload(s)) return { transient: true, reason: s };
  if (/\b(429|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|50[0-9])\b/i.test(s)) return { transient: true, reason: s };
  return { transient: false, reason: s };
}

/** How many times a job may be RE-PLANNED before a human is asked. One. A reorder that
 *  did not unblock the job the first time is not more likely to work the second. */
export const MAX_REPLANS = 1;

/** HR's mailbox identity. Not a roster seat — a runtime function, like `engine`. */
export const HR_ID = "hr";

/** Total diff bytes handed to ONE review turn. Five tasks of unbounded diff is a context
 *  blowout and a bill; the cap is on the SUM, and truncation is announced, never silent. */
export const MAX_REVIEW_DIFF_BYTES = 60_000;
/** The review notes land verbatim in the gate body the BOSS reads. Agent-authored → bounded. */
export const MAX_REVIEW_NOTES = 1_200;
const RISK_BANDS = Object.freeze(["low", "medium", "high"]);

/**
 * PURE. Validate the review a model returned. Fails CLOSED: an unreadable review must never
 * become a gate, because a gate is the BOSS saying yes to content nobody could read.
 */
export function validateReview(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "review must be an object" };
  if (!RISK_BANDS.includes(raw.risk)) return { ok: false, error: `risk must be one of ${RISK_BANDS.join("|")}` };
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 200)).slice(0, 16) : null);
  const done = list(raw.done ?? []);
  const notDone = list(raw.notDone ?? []);
  if (done === null || notDone === null) return { ok: false, error: "done/notDone must be arrays" };
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  return {
    ok: true,
    review: {
      done, notDone,
      risk: raw.risk,
      notes: String(raw.notes ?? "").slice(0, MAX_REVIEW_NOTES),
      filesChanged: num(raw.filesChanged),
      testsRun: num(raw.testsRun),
    },
  };
}

/**
 * PURE. The writeScope the Manager PROPOSES for a hire.
 *
 * The model never chooses this. A plan that could name a new agent's writeScope could name
 * `agent-runtime/**`, and the whole point of Phase 7 is that a worker's reach is decided by
 * the runtime. Derived from the catalog skill id, which is already closed (`^[a-z0-9-]+$`,
 * validated against SKILL_CATALOG), so this cannot become free text.
 *
 * DELIBERATELY NARROW. `src/lib/<skill>/**` may well be too tight for real work — but a hire
 * that is refused for reaching too far is a visible problem an operator can widen, and one
 * that reaches too far is a silent one. validateRosterSpec re-checks it either way.
 */
export function proposedWriteScope(skills, steps = []) {
  // FROM THE WORK FIRST. Derived-from-the-skill-name was the Phase 10 live defect: the Manager
  // asked for `repo-edit` to write `docs/alerting.md` and the hire arrived scoped to
  // `src/lib/repo-edit/**`, a directory that does not exist. It failed all three attempts with
  // `empty-diff` — correctly refusing to write outside a scope that had nothing to do with the
  // task. The steps name the files; the files are what the seat must be able to touch.
  const out = [];
  for (const raw of Array.isArray(steps) ? steps : []) {
    // A path-shaped token rooted at a literal directory. Deliberately strict: no leading
    // slash, no `..`, no backslash, and it must carry a `/` so a bare word is not a path.
    for (const m of String(raw ?? "").matchAll(/\b([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+)\b/gi)) {
      const path = m[1];
      if (path.includes("..") || path.startsWith("/")) continue;
      const root = path.split("/")[0];
      // The steps are MODEL-AUTHORED. `agent-runtime` is a seed dir, so validateRosterSpec
      // would accept it — which would let a sentence in a plan grant a brand-new agent write
      // access to the runtime that dispatches it. Existing seats own that tree; a hire that
      // needs it is the BOSS's call, not the plan's.
      if (root === "agent-runtime") continue;
      if (!SEED_DIRS.includes(root)) continue;
      const segs = path.split("/");
      // The DIRECTORY the file lives in, not the file: a task usually writes more than the one
      // path it happens to name in a step.
      const dir = segs.length > 1 ? segs.slice(0, -1).join("/") : root;
      out.push(`${dir}/**`);
    }
  }
  if (out.length) return [...new Set(out)].slice(0, 4);

  // FALLBACK. validateRosterSpec REFUSES an empty writeScope, so this must always return
  // something; a guess that is visibly wrong is better than a hire that cannot be validated.
  const guess = [];
  for (const s of Array.isArray(skills) ? skills : []) {
    const id = String(s ?? "").trim();
    if (/^[a-z0-9-]+$/.test(id)) guess.push(`src/lib/${id}/**`);
  }
  return [...new Set(guess)];
}

export function createManager({
  jobs, roster, mailbox, enqueueGoal, dispatch,
  deliveries, queue, clock = () => Date.now(), log = () => {},
  catalog = [], managerId = "tech-lead", stallMs = DEFAULT_STALL_MS,
  // 11.1 — injected so the review turn is provable without a repo, a jail or a model.
  // `retest` RE-RUNS the task's scoped gate; the recorded tail is a claim, not a check.
  diffFor = () => "", retest = async () => ({ ok: null, tail: "not re-run" }),
  // 11.3 — the ship ladder (pr.mjs createJobBranch/commitTask/openJobPr) and the sha the job
  // branch is based on. Injected so ship is provable without a git repo or a remote.
  pr = null, baseSha = () => null,
  // 13.3 — called after a Job reaches `shipped`. Injected so this module never learns what a
  // ticket tracker is, and so the ship path is provable without one.
  onShipped = null,
} = {}) {
  const progress = new Map(); // jobId → last progress timestamp
  const retries = new Map();  // jobId → consecutive transient dispatch failures
  const hireAsked = new Set(); // `${jobId}:${sortedSkills}` → HR has been asked once

  const touch = (jobId) => progress.set(jobId, clock());
  const lastProgress = (jobId) => { if (!progress.has(jobId)) touch(jobId); return progress.get(jobId); };

  /** A human is the blocker when the job waits on a gate, or any of its tasks is HELD. */
  function heldOrWaiting(job) {
    if (job.status === "awaiting-you") return true;
    try { if ((deliveries?.listGates?.(job.id) || []).length) return true; } catch { /* read-only probe */ }
    try {
      const own = new Set(jobs.tasks(job.id).map((t) => t.taskId).filter(Boolean));
      if (own.size && (queue?.all?.() || []).some((t) => own.has(t.taskId) && String(t.status) === "held")) return true;
    } catch { /* read-only probe */ }
    return false;
  }

  /**
   * Ask HR for a seat, ONCE per (job, skills). Sending twice would be harmless — HR is
   * idempotent and reuses — but it would put a second unanswerable reply on the bus and make
   * the log lie about how many hires were needed.
   */
  function requestHire(job, task) {
    const key = `${job.id}:${[...task.skillsRequired].sort().join(",")}`;
    if (hireAsked.has(key)) return { action: "hire-already-asked", key };
    hireAsked.add(key);
    const body = JSON.stringify({
      skills: task.skillsRequired,
      writeScope: proposedWriteScope(task.skillsRequired, task.steps),
      reason: `no roster seat holds [${task.skillsRequired.join(", ")}] for "${String(task.title).slice(0, 120)}"`,
    });
    try {
      mailbox.send({ from: managerId, to: HR_ID, kind: "hire-request", jobId: job.id, body });
      log({ event: "hire-requested", jobId: job.id, taskId: task.id, skills: task.skillsRequired });
    } catch (e) {
      log({ event: "hire-request-failed", jobId: job.id, error: e?.message ?? String(e) });
    }
    return { action: "hire-requested" };
  }

  /** HR answered with a seat: give it the task it was hired for and start it. */
  function onHireDone(msg) {
    let agentId = null;
    try { agentId = String(JSON.parse(String(msg.body ?? "")).agentId ?? "").trim(); } catch { agentId = null; }
    if (!agentId) return false;
    const job = jobs.get(msg.jobId);
    if (!job) return false;
    let moved = false;
    for (const t of jobs.tasks(msg.jobId)) {
      if (t.status !== "awaiting-hire") continue;
      const g = enqueueGoal({ agentId, storyId: job.id, steps: t.steps });
      jobs.updateTask(t.id, {
        seat: agentId, goalId: g?.goalId ?? null, taskId: g?.firstTaskId ?? null, status: "queued",
      });
      log({ event: "hire-assigned", jobId: job.id, taskId: t.id, agentId });
      moved = true;
    }
    return moved;
  }

  /** HR could not hire. That is a decision only the BOSS can make — ask, once. */
  function onHireFailed(msg) {
    const job = jobs.get(msg.jobId);
    if (!job) return false;
    let reason = "HR could not make the hire";
    try { reason = String(JSON.parse(String(msg.body ?? "")).reason ?? reason); } catch { /* keep the default */ }
    const parked = jobs.tasks(msg.jobId).filter((t) => t.status === "awaiting-hire");
    const skills = [...new Set(parked.flatMap((t) => t.skillsRequired))];
    const gate = deliveries.mintGate({
      kind: "question", agentId: managerId, jobId: job.id, slot: `${job.id}-hire`,
      title: `Cannot staff: ${job.title}`.slice(0, 200),
      body: `Nobody on the roster holds [${skills.join(", ")}] and HR could not hire: ${String(reason).slice(0, 400)}\n\n`
        + "Reuse an existing seat for this work, widen someone's skills, or drop the task?",
    });
    jobs.setStatus(job.id, "awaiting-you");
    touch(job.id);
    log({ event: "hire-escalated", jobId: job.id, reason });
    return gate;
  }

  function block(job, reason) {
    log({ event: "job-blocked", jobId: job.id, reason });
    try { jobs.setStatus(job.id, "blocked", String(reason).slice(0, 500)); } catch { /* already terminal */ }
    return { action: "blocked", reason };
  }

  /**
   * One dispatch, with the transient/deterministic distinction applied.
   * Returns `{ok:true, data}` | `{retry:true}` | `{blocked:true, result}` — THREE outcomes,
   * not two. An earlier version returned `null` for both "retry" and "blocked", so a job that
   * had just been blocked was reported to the caller as retrying: the status was right in the
   * store and a lie in the return value.
   */
  async function runStage(job, stage, prompt, ctx = null) {
    let out;
    try {
      // `ctx` carries stage input the DISPATCHER cannot gather for itself: the review turn
      // needs each task's diff and a fresh gate re-run, which come from the worktrees and the
      // jail, not from the job row.
      out = await dispatch({ stage, jobId: job.id, prompt, job, ctx });
    } catch (e) {
      out = { ok: false, error: String(e?.message ?? e) };
    }
    if (out?.ok) { retries.delete(job.id); return { ok: true, data: out }; }
    const { transient, reason } = classifyDispatchError(out?.error);
    if (!transient) return { blocked: true, result: block(job, `${stage}: ${reason}`) };
    const n = (retries.get(job.id) || 0) + 1;
    retries.set(job.id, n);
    if (n > MAX_TRANSIENT_RETRIES) {
      retries.delete(job.id);
      return { blocked: true, result: block(job, `${stage}: ${reason} (after ${MAX_TRANSIENT_RETRIES} retries)`) };
    }
    log({ event: "job-retry", jobId: job.id, stage, attempt: n, reason });
    return { retry: true }; // the next tick retries; the job stays where it is
  }

  async function tick(jobId) {
    const job = jobs.get(jobId);
    if (!job) return { action: "none", reason: "no such job" };
    if (job.status === "shipped" || job.status === "blocked") return { action: "none", reason: job.status };

    // The stall check runs FIRST and on every tick, so a job cannot sit unnoticed in any
    // status — but never while a human is the one being waited on.
    if (isStalled({ lastProgressAt: lastProgress(job.id), now: clock(), stallMs, heldOrWaiting: heldOrWaiting(job) })) {
      log({ event: "job-stall", jobId: job.id, idleMs: clock() - lastProgress(job.id) });
      return block(job, `no progress for ${Math.round((clock() - lastProgress(job.id)) / 1000)}s`);
    }

    if (job.status === "intake") {
      const staged = await runStage(job, "intake", null);
      if (staged.blocked) return staged.result;
      if (!staged.ok) return { action: "retry" };
      const out = staged.data;
      const needs = Array.isArray(out.needs) ? out.needs.filter((n) => String(n ?? "").trim()) : [];
      jobs.setSummary(job.id, { findings: Array.isArray(out.findings) ? out.findings : [] });
      touch(job.id);
      // No questions is the GOOD case: skip clarify entirely rather than minting an empty gate.
      if (!needs.length) { jobs.setStatus(job.id, "planned"); return { action: "planned", needs: 0 }; }
      jobs.setQuestions(job.id, needs);
      jobs.setStatus(job.id, "clarify");
      return { action: "clarify", needs: needs.length };
    }

    if (job.status === "clarify") {
      const questions = job.questions || [];
      if (!questions.length) { jobs.setStatus(job.id, "planned"); return { action: "planned", needs: 0 }; }
      // ONE gate carrying every question. N gates would mean N notifications and N slots for
      // one decision the BOSS makes in one sitting.
      const gate = deliveries.mintGate({
        kind: "question", agentId: managerId, jobId: job.id, slot: `${job.id}-q`,
        title: `Questions about: ${job.title}`.slice(0, 200),
        body: questions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
      });
      jobs.setStatus(job.id, "awaiting-you");
      touch(job.id);
      return { action: "asked", gateId: gate.id, questions: questions.length };
    }

    // ── REVIEW (11.1) — read every diff, RE-RUN every gate, ask ONCE ──────────
    // Before this branch existed a job reached `review` and stopped dead: every live job in
    // Phases 9 and 10 ended there and never asked anyone anything.
    if (job.status === "review") {
      const tasks = jobs.tasks(job.id);
      // Already asked? One job, one decision.
      let open = [];
      try { open = deliveries.listGates(job.id, "job-approval") || []; } catch { open = []; }
      if (open.length) return { action: "review-gated", gateId: open[0].id, already: true };

      // Each task's diff and a FRESH re-run of its scoped gate. The diffs are capped in TOTAL
      // and the truncation is announced, so the model is never quietly shown less than it thinks.
      let budget = MAX_REVIEW_DIFF_BYTES;
      const reviewTasks = [];
      for (const t of tasks) {
        let diff = "";
        // SCOPED to the task's own paths. A bare worktree diff also carries the `.claude/`
        // deletions worktree.mjs makes on every checkout — 3,081 files in this repo — which
        // buried the task's real 4-line change and made the Manager call a correct gate stale.
        try { diff = String(diffFor(t.taskId, t.changedPaths || []) ?? ""); } catch { diff = ""; }
        let truncated = false;
        if (diff.length > budget) {
          // The note counts against the budget as well — otherwise the cap is exceeded by the
          // very message that says it was enforced. Once the budget cannot even hold the note,
          // the diff is dropped entirely and `truncated` is what tells the model so: a flag
          // costs nothing, and a note that itself overruns the cap defeats the cap.
          const NOTE = "\n[...diff truncated at the review budget]";
          diff = budget > NOTE.length ? `${diff.slice(0, budget - NOTE.length)}${NOTE}` : "";
          truncated = true;
        }
        budget = Math.max(0, budget - diff.length);
        let out;
        try { out = await retest(t.taskId); } catch (e) { out = { ok: false, tail: `re-run threw: ${e?.message ?? e}` }; }
        reviewTasks.push({
          title: t.title, seat: t.seat, changedPaths: t.changedPaths || [],
          diff, truncated, retest: out || { ok: null, tail: "no result" },
        });
      }

      const staged = await runStage(job, "review", null, { tasks: reviewTasks });
      if (staged.blocked) return staged.result;
      if (!staged.ok) return { action: "retry" };
      const v = validateReview(staged.data);
      if (!v.ok) return block(job, `review rejected: ${v.error}`);
      const rev = v.review;

      const body = [
        rev.notes,
        "",
        `RISK: ${rev.risk} · ${rev.filesChanged} file(s) changed · ${rev.testsRun} test run(s) re-run`,
        rev.done.length ? `\nDONE:\n${rev.done.map((d) => `  - ${d}`).join("\n")}` : "",
        rev.notDone.length ? `\nNOT DONE:\n${rev.notDone.map((d) => `  - ${d}`).join("\n")}` : "",
        `\nFILES:\n${reviewTasks.flatMap((t) => (t.changedPaths || []).map((p) => `  - ${p} (${t.seat})`)).join("\n") || "  (none)"}`,
      ].join("\n");

      const gate = deliveries.mintGate({
        kind: "job-approval", agentId: managerId, jobId: job.id, slot: `${job.id}-ship`,
        title: `Ship: ${job.title}`.slice(0, 200),
        body: body.slice(0, 4_000),
      });
      jobs.setSummary(job.id, { ...(job.summary || {}), review: rev }, job.prUrl ?? null);
      jobs.setStatus(job.id, "awaiting-you");
      touch(job.id);
      log({ event: "job-review", jobId: job.id, risk: rev.risk, notDone: rev.notDone.length });
      return { action: "review-gated", gateId: gate.id, risk: rev.risk };
    }

    if (job.status === "planned") {
      const staged = await runStage(job, "plan", null);
      if (staged.blocked) return staged.result;
      if (!staged.ok) return { action: "retry" };
      const v = validatePlan(staged.data, { catalog });
      if (!v.ok) return block(job, `plan rejected: ${v.error}`);

      // ASSIGN BY SKILL. The runtime picks the seat; the model never named one.
      // An unstaffed skill is NOT a dead end any more (Phase 10): it PARKS as `awaiting-hire`
      // and HR is asked. Parking rather than blocking is what lets the rest of the plan run —
      // one missing specialist used to stop the whole job.
      const assigned = [];
      for (const t of v.tasks) {
        const seat = roster.match(t.skillsRequired)[0]?.id ?? null;
        assigned.push({ ...t, seat, status: seat ? "planned" : "awaiting-hire" });
      }
      jobs.setTasks(job.id, assigned);

      for (const t of jobs.tasks(job.id)) {
        if (!t.seat) { requestHire(job, t); continue; }
        // storyId carries the JOB id: engine goals are owner-tagged, and 9.2's signal path
        // reads that prefix back to find which job a finished task belongs to.
        const g = enqueueGoal({ agentId: t.seat, storyId: job.id, steps: t.steps });
        jobs.updateTask(t.id, { goalId: g?.goalId ?? null, taskId: g?.firstTaskId ?? null, status: "queued" });
      }
      jobs.setStatus(job.id, "building");
      touch(job.id);
      return { action: "assigned", tasks: assigned.length };
    }

    if (job.status === "building") {
      // DRAIN THE WHOLE INBOX AND ROUTE BY THE TASK EACH MESSAGE NAMES — never by which job
      // happens to be ticking. `mailbox.read()` ARCHIVES everything it returns, so a message
      // this tick does not handle is GONE. Filtering to `m.jobId === job.id` therefore did not
      // defer other jobs' mail, it destroyed it: with two live jobs and one tick per beat, the
      // engine's `done` for job B was read by job A's tick and dropped, and B sat in `building`
      // forever — its stall clock is frozen while a task is HELD, so it could not time out
      // either. Found by the 9.6 live run; single-job tests could never see it (addendum #1:
      // the signal arrives and the handler discards it).
      let changed = false;
      for (const m of mailbox.read(managerId)) {
        // HR's replies name a JOB, not a task — the task they resolve is the parked one, so
        // they are routed before the taskId join below (which would find nothing for them).
        if (m.kind === "hire-done") { if (onHireDone(m)) { touch(m.jobId); if (m.jobId === job.id) changed = true; } continue; }
        if (m.kind === "hire-failed") { onHireFailed(m); continue; }
        // taskId FIRST, then goalId: the engine re-mints a taskId on every retry, so a
        // terminal signal often names an attempt this store never recorded.
        const t = (m.taskId ? jobs.byEngineTask(m.taskId) : null)
          || (m.goalId ? jobs.byEngineGoal(m.goalId) : null);
        if (!t) continue; // mail naming no known task: nothing to apply, and never guessed onto this job
        if (m.kind === "done") {
          jobs.updateTask(t.id, { status: "done", deliveryId: m.deliveryId ?? t.deliveryId, changedPaths: m.changedPaths ?? t.changedPaths });
        } else if (m.kind === "blocked") {
          jobs.updateTask(t.id, { status: "blocked", blockedOn: String(m.body ?? "").slice(0, 500) });
        } else {
          continue;
        }
        // Progress is the OTHER job's when the mail was not for this one; touch the job that
        // actually moved, so its stall clock reflects real news.
        touch(t.jobId);
        if (t.jobId === job.id) changed = true;
      }
      if (changed) touch(job.id);

      const tasks = jobs.tasks(job.id);
      const blocked = tasks.filter((t) => t.status === "blocked");
      if (blocked.length) {
        const staged = await runStage(job, "manage", null);
        if (staged.blocked) return staged.result;
        if (!staged.ok) return { action: "retry" };
        const out = staged.data;
        // ONE re-plan, and the count is PERSISTED. The rule used to live only in the comment
        // below, so a task that could never pass drove blocked → replan → build → blocked
        // forever: measured on job_b1430c862910 at six Manager turns and 82k input tokens,
        // still going. A counter held in memory would also reset on every restart, which on a
        // job that outlives a process is the same unbounded loop wearing a hat.
        const replans = Number(job.summary?.replans || 0);
        if (out.action === "replan" && Array.isArray(out.order) && out.order.length
            && replans < MAX_REPLANS) {
          // Re-plan is a REORDER of the tasks we already have, not a new plan: a Manager that
          // rewrote the list on every block could churn forever without finishing anything.
          const byIndex = out.order.map((i) => tasks[Number(i) - 1]).filter(Boolean);
          if (byIndex.length === tasks.length) {
            jobs.setTasks(job.id, byIndex.map((t) => ({ ...t, status: "planned" })));
            jobs.setSummary(job.id, { ...(job.summary || {}), replans: replans + 1 }, job.prUrl ?? null);
            jobs.setStatus(job.id, "planned");
            touch(job.id);
            return { action: "replanned", order: out.order, replans: replans + 1 };
          }
        }
        if (out.action === "escalate") {
          const q = String(out.question || out.reason || "the Manager needs a decision").slice(0, 1_000);
          const gate = deliveries.mintGate({
            kind: "question", agentId: managerId, jobId: job.id, slot: `${job.id}-esc-${tasks.length}`,
            title: `Blocked: ${job.title}`.slice(0, 200), body: q,
          });
          jobs.setStatus(job.id, "awaiting-you");
          touch(job.id);
          return { action: "escalated", gateId: gate.id };
        }
        // SAFETY NET. A dispatcher that answers `proceed` while a task is blocked would leave
        // the job spinning in `building` forever, waiting for news that already arrived. A
        // blocked task the Manager has no plan for is, by definition, a human's decision.
        const gate = deliveries.mintGate({
          kind: "question", agentId: managerId, jobId: job.id, slot: `${job.id}-blocked-${blocked[0].id}`,
          title: `Blocked: ${job.title}`.slice(0, 200),
          body: `Task "${blocked[0].title}" is blocked: ${blocked[0].blockedOn || "no reason given"}.`,
        });
        jobs.setStatus(job.id, "awaiting-you");
        touch(job.id);
        return { action: "escalated", gateId: gate.id, reason: "blocked with no replan" };
      }

      if (tasks.length && tasks.every((t) => t.status === "done")) {
        jobs.setStatus(job.id, "review");
        touch(job.id);
        return { action: "review", tasks: tasks.length };
      }
      return { action: "waiting", done: tasks.filter((t) => t.status === "done").length, of: tasks.length };
    }

    return { action: "none", reason: job.status };
  }

  return {
    tick,
    /** The gate was decided: an approve moves the job on, a reject blocks it with the note. */
    onGateDecided(jobId, { decision, feedback } = {}) {
      const job = jobs.get(jobId);
      if (!job) return { action: "none" };
      touch(jobId);
      if (decision === "approve") { jobs.setStatus(jobId, "planned"); return { action: "planned" }; }
      return block(job, `question gate ${decision}: ${String(feedback ?? "").slice(0, 300)}`);
    },
    /**
     * SHIP (11.3). The BOSS approved the one gate; this is what it buys.
     *
     * Each task's OWN changed paths become its OWN commit, in plan order, on one
     * `ma/job/<id>` branch built in pr.mjs's own worktree — the operator's tree and index are
     * never touched (PJB-6). A commit that fails STOPS the ship: a partial ship must never read
     * as shipped, and a PR is never opened over commits that are not all there.
     */
    async ship(jobId) {
      const job = jobs.get(jobId);
      if (!job) return { ok: false, reason: "no such job" };
      if (job.status === "shipped") return { ok: false, reason: "already shipped" };
      if (!pr?.createJobBranch) return { ok: false, reason: "no ship ladder is wired" };

      const base = String(baseSha() ?? "");
      const jb = await pr.createJobBranch(jobId, base);
      if (!jb?.ok) return { ok: false, reason: jb?.reason || "could not create the job branch" };

      const commits = [];
      for (const t of jobs.tasks(jobId)) {
        const paths = Array.isArray(t.changedPaths) ? t.changedPaths : [];
        // A task that changed nothing is not a failure and not a commit. `git commit` with an
        // empty staged set would abort anyway; skipping says so plainly.
        if (!paths.length) continue;
        const c = await pr.commitTask({
          jobWorktree: jb.worktree, taskId: t.taskId, paths,
          message: `feat: ${String(t.title).slice(0, 60)}\n\nJob ${jobId} · seat ${t.seat || "unassigned"}`,
        });
        if (!c?.ok) {
          log({ event: "job-ship-failed", jobId, taskId: t.taskId, reason: c?.reason, refused: c?.refused });
          return { ok: false, reason: `${t.taskId}: ${c?.reason || "commit failed"}`, branch: jb.branch, commits };
        }
        commits.push({ taskId: t.taskId, sha: c.sha, paths });
      }

      const notes = job.summary?.review?.notes || "";
      const out = await pr.openJobPr({ jobWorktree: jb.worktree, branch: jb.branch, title: job.title, body: notes });
      // `mode: branch` is a SUCCESSFUL ship without a PR (no remote, or no gh). It is recorded
      // as such — never as a PR, and never as a failure.
      // `pushed` rides alongside `mode`: `mode: "branch"` covers four outcomes and only one of
      // them means the commits are on the operator's remote where anyone can see them.
      jobs.setSummary(jobId, { ...(job.summary || {}), ship: { branch: jb.branch, commits, mode: out?.mode || "branch", pushed: out?.pushed === true, reason: out?.reason || "" } }, out?.prUrl ?? null);
      jobs.setStatus(jobId, "shipped");
      touch(jobId);
      // 13.3 — tell the ticket, if this Job came from one. NOT AWAITED and never able to fail
      // the ship: the commits are already on the branch and the Job is already `shipped`, so a
      // ticket tracker being unreachable must not unwind any of that. manager.mjs does not know
      // what Jira is — this is an injected hook, wired in server.mjs.
      if (onShipped) {
        Promise.resolve(onShipped(jobs.get(jobId), { prUrl: out?.prUrl ?? null, branch: jb.branch }))
          .then((r) => { if (r && !r.skipped && r.reason) log({ event: "job-ticket-partial", jobId, reason: r.reason }); })
          .catch((e) => log({ event: "job-ticket-failed", jobId, reason: String(e?.message ?? e) }));
      }
      log({ event: "job-shipped", jobId, branch: jb.branch, commits: commits.length, mode: out?.mode, prUrl: out?.prUrl ?? null });
      return { ok: true, branch: jb.branch, commits, mode: out?.mode || "branch", prUrl: out?.prUrl ?? null, reason: out?.reason || "" };
    },

    /** Test + operator seam. */
    markProgress: touch,
    lastProgressAt: lastProgress,
  };
}

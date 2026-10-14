// Phase 9 / task 9.1 — THE JOB STORE.
//
// A Job is NOT a Story, and the separation is deliberate rather than tidy-minded: a Job has
// its own gate slot, its own answer route, its own stall clock and its own retry budget.
// Borrowing the story tables would put a Job's clarify question in competition with a Story's
// pending gate slot, and measure a Job's stall with a clock built for a different lifecycle.
//
// TRANSITIONS ARE CLOSED, exactly as in stories.mjs. An unlisted move is a refusal, not a
// silent write — the status field is what the Manager's tick() branches on, so a status
// nobody planned for is a loop that does nothing forever.
//
// Text is SCRUBBED at rest (the brief is operator-supplied and the summary is agent-authored)
// and BOUNDED on the way in. `job.changed` carries identity only: a bus frame reaches every
// connected seat, and the brief is not something to broadcast.

import { randomBytes } from "node:crypto";

export class JobError extends Error {
  constructor(message, status = 400) { super(message); this.name = "JobError"; this.status = status; }
}

export const JOB_STATUSES = Object.freeze(new Set([
  "intake", "strategy", "clarify", "planned", "building", "review", "awaiting-you", "shipped", "blocked",
]));

// The only moves that exist. `blocked` is reachable from every live status because a job can
// fail at any point; nothing leaves `shipped`.
const NEXT = Object.freeze({
  intake: ["strategy", "clarify", "planned", "blocked"],
  // Phase F · 20 — the CEO's gate. proceed/defer → clarify, kill → blocked. `planned` is legal
  // for symmetry with intake (a clarify with no questions lands there the same tick).
  strategy: ["clarify", "planned", "blocked"],
  clarify: ["awaiting-you", "planned", "blocked"],
  // 'shipped' is reachable from here: 'awaiting-you' is the BOSS gate, and approving the
  // final summary is exactly what ships a job (the job-approval gate, Phase 11).
  "awaiting-you": ["planned", "building", "review", "shipped", "blocked"],
  planned: ["building", "blocked"],
  building: ["review", "awaiting-you", "planned", "blocked"],
  review: ["awaiting-you", "shipped", "building", "blocked"],
  shipped: [],
  // an operator or the Manager may retry a blocked job; Phase F · 20 — resume returns it to the CEO
  // (strategy never answered) or to clarify (questions never asked) instead of skipping them.
  blocked: ["planned", "building", "strategy", "clarify"],
});

export const MAX_BRIEF = 10_000;
export const MAX_TITLE = 300;

// Phase 12 / task 12.1 — the CREATE CAPS. Ash's single tool is `create_job`, and a model
// that retries a tool call mints a job per attempt. Both caps live in the STORE, not in the
// MCP server, because a rule enforced at one caller is allow-by-default for every other one
// (addendum #14/#20): the console button and a direct `POST /runtime/jobs` curl are bound by
// exactly the same numbers. Both read the DB rather than an in-memory counter, so they
// survive a restart and add no state that can drift from the rows it describes.
export const MAX_CREATES_PER_WINDOW = 5;
export const CREATE_WINDOW_MS = 60_000;
export const DUP_WINDOW_MS = 600_000;
const SOURCES = new Set(["paste", "jira", "github", "slack"]);

const newId = (prefix) => `${prefix}_${randomBytes(6).toString("hex")}`;
const j = (v, fallback = []) => { try { return JSON.parse(v ?? ""); } catch { return fallback; } };

export function createJobs({ db, scrub = (t) => t, emit, clock = () => Date.now() } = {}) {
  const h = db?.db ?? db; // openDb returns a handle; accept either
  if (!h?.prepare) throw new Error("createJobs: a database handle is required");

  const insJob = h.prepare(
    `INSERT INTO jobs(id,title,brief,repo,source,externalKey,status,questions,answers,summary,prUrl,blockedOn,createdAt,updatedAt)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const getJob = h.prepare("SELECT * FROM jobs WHERE id = ?");
  // rowid, not id, as the tiebreak: ids are RANDOM hex, so two jobs created in the same
  // millisecond would come back in an arbitrary order — nondeterministic for the operator
  // and flaky in tests. rowid is insertion order, which is what "newest first" means.
  const listJobs = h.prepare("SELECT * FROM jobs ORDER BY createdAt DESC, rowid DESC");
  // 12.1 create caps. Prepared once, like every other statement here.
  const countSince = h.prepare("SELECT COUNT(*) AS n FROM jobs WHERE createdAt > ?");
  const dupSince = h.prepare("SELECT id FROM jobs WHERE brief = ? AND createdAt > ?");
  const setStatusStmt = h.prepare("UPDATE jobs SET status = ?, blockedOn = ?, updatedAt = ? WHERE id = ?");
  const setQStmt = h.prepare("UPDATE jobs SET questions = ?, updatedAt = ? WHERE id = ?");
  const setAStmt = h.prepare("UPDATE jobs SET answers = ?, updatedAt = ? WHERE id = ?");
  const setSummaryStmt = h.prepare("UPDATE jobs SET summary = ?, prUrl = ?, updatedAt = ? WHERE id = ?");
  const insTask = h.prepare(
    `INSERT INTO job_tasks(id,jobId,seq,title,seat,skillsRequired,steps,status,goalId,taskId,deliveryId,changedPaths,blockedOn,dependsOn,questionTo,question,answer,answerFrom,resumeCount,createdAt,updatedAt)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const clearTasks = h.prepare("DELETE FROM job_tasks WHERE jobId = ?");
  const listTasks = h.prepare("SELECT * FROM job_tasks WHERE jobId = ? ORDER BY seq ASC");
  const getTask = h.prepare("SELECT * FROM job_tasks WHERE id = ?");
  const taskByTaskId = h.prepare("SELECT * FROM job_tasks WHERE taskId = ?");
  const taskByGoalId = h.prepare("SELECT * FROM job_tasks WHERE goalId = ?");

  const fire = (name, payload) => { try { emit?.(name, payload); } catch { /* the bus is observational */ } };

  const hydrate = (r) => r && {
    id: r.id, title: r.title, brief: r.brief, repo: r.repo, source: r.source,
    externalKey: r.externalKey, status: r.status,
    questions: j(r.questions, []), answers: r.answers === null ? null : j(r.answers, null),
    summary: r.summary === null ? null : j(r.summary, null),
    prUrl: r.prUrl, blockedOn: r.blockedOn, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
  const hydrateTask = (r) => r && {
    id: r.id, jobId: r.jobId, seq: r.seq, title: r.title, seat: r.seat,
    skillsRequired: j(r.skillsRequired, []), steps: j(r.steps, []), status: r.status,
    goalId: r.goalId, taskId: r.taskId, deliveryId: r.deliveryId,
    changedPaths: j(r.changedPaths, []), blockedOn: r.blockedOn,
    // Phase D · C21 — the dependency edges, as ROW IDS. Absent on every pre-migration row,
    // which reads as [] and means "depends on nothing" (the Phase C behaviour).
    dependsOn: j(r.dependsOn, []),
    // Phase D · task 13 — whom this task is waiting on, and how many times it was resumed.
    questionTo: r.questionTo ?? null, question: r.question ?? null, answer: r.answer ?? null, answerFrom: r.answerFrom ?? null,
    resumeCount: Number(r.resumeCount || 0),
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
  const must = (id) => {
    const row = getJob.get(String(id || ""));
    if (!row) throw new JobError(`no such job: ${id}`, 404);
    return row;
  };

  return {
    create({ title, brief, repo = null, source = "paste", externalKey = null } = {}) {
      const t = scrub(String(title ?? "").trim());
      const b = scrub(String(brief ?? "").trim());
      if (!t) throw new JobError("title is required");
      if (!b) throw new JobError("brief is required");
      if (t.length > MAX_TITLE) throw new JobError(`title exceeds ${MAX_TITLE} characters`);
      // REFUSED, not truncated: a brief the operator wrote is the specification. Silently
      // cutting it would plan against half a requirement.
      if (b.length > MAX_BRIEF) throw new JobError(`brief exceeds ${MAX_BRIEF} characters`);
      if (!SOURCES.has(source)) throw new JobError(`unknown source: ${source}`);
      const key = externalKey ? String(externalKey).slice(0, 120) : null;
      if (key && h.prepare("SELECT id FROM jobs WHERE externalKey = ?").get(key)) {
        throw new JobError(`a job already exists for ${key}`, 409);
      }
      const now = clock();
      // 12.1 — DUPLICATE first, then RATE. A model retrying one tool call trips the duplicate
      // guard on every attempt and inserts nothing, so it never burns the rate quota; the rate
      // cap is left to catch a flood of DISTINCT briefs, which is the case a duplicate check
      // cannot see. Both key on `createdAt`, which is the clock's value, so a frozen clock in a
      // test shapes the rows it then queries.
      if (dupSince.get(b, now - DUP_WINDOW_MS)) {
        throw new JobError(`an identical brief was submitted in the last ${Math.round(DUP_WINDOW_MS / 60_000)} minutes`, 409);
      }
      if ((countSince.get(now - CREATE_WINDOW_MS)?.n ?? 0) >= MAX_CREATES_PER_WINDOW) {
        throw new JobError(`too many jobs created — the cap is ${MAX_CREATES_PER_WINDOW} per ${Math.round(CREATE_WINDOW_MS / 1000)}s`, 429);
      }
      const id = newId("job");
      insJob.run(id, t, b, repo, source, key, "intake", "[]", null, null, null, null, now, now);
      fire("job.changed", { id, status: "intake" });
      return hydrate(getJob.get(id));
    },

    get: (id) => hydrate(getJob.get(String(id || ""))) ?? null,
    list: () => listJobs.all().map(hydrate),

    setStatus(id, status, blockedOn = null) {
      const row = must(id);
      if (!JOB_STATUSES.has(status)) throw new JobError(`unknown status: ${status}`);
      if (row.status === status) return hydrate(getJob.get(id)); // idempotent
      const allowed = NEXT[row.status] || [];
      if (!allowed.includes(status)) {
        throw new JobError(`a job in '${row.status}' cannot go to '${status}'`, 409);
      }
      setStatusStmt.run(status, blockedOn, Date.now(), id);
      fire("job.changed", { id, status });
      return hydrate(getJob.get(id));
    },

    setQuestions(id, questions) {
      must(id);
      const qs = (Array.isArray(questions) ? questions : [])
        .map((q) => scrub(String(q ?? "").trim())).filter(Boolean).slice(0, 5);
      setQStmt.run(JSON.stringify(qs), Date.now(), id);
      // Phase B · Task 6 — a NEW round of questions re-opens answers. A fact is asked once PER
      // ROUND; the old answers answered old questions. Without this, a later escalation could
      // never store its answer (setAnswers refused forever — Codex F09, related).
      h.prepare("UPDATE jobs SET answers = NULL, updatedAt = ? WHERE id = ?").run(Date.now(), id);
      return qs;
    },

    /** Answers are written ONCE. A fact is asked once; a second answer is a 409, not an overwrite. */
    setAnswers(id, answers) {
      const row = must(id);
      if (row.answers !== null) throw new JobError("this job's questions are already answered", 409);
      const as = (Array.isArray(answers) ? answers : []).slice(0, 5).map((a) => ({
        q: scrub(String(a?.q ?? "").trim()).slice(0, 500),
        a: scrub(String(a?.a ?? "").trim()).slice(0, 2_000),
      }));
      setAStmt.run(JSON.stringify(as), Date.now(), id);
      return as;
    },

    setSummary(id, summary, prUrl = null) {
      must(id);
      setSummaryStmt.run(JSON.stringify(summary ?? null), prUrl, Date.now(), id);
      return hydrate(getJob.get(id));
    },

    /** Replace the task list. Called by the Manager after plan and after a re-plan. */
    setTasks(id, tasks) {
      must(id);
      const now = Date.now();
      const rows = (Array.isArray(tasks) ? tasks : []).slice(0, 8);
      // Phase D · C21 — IDS ARE MINTED FIRST, before a single insert, because a dependency has
      // to be resolvable against the batch it is declared in.
      //
      // Two shapes arrive here and both are legitimate:
      //   a NUMBER  — a fresh plan. The planner writes task numbers (1-based); they are
      //               resolved against THIS batch's positions.
      //   a STRING  — a re-plan. The rows carry the ids they already held, and a re-plan
      //               REORDERS them, so a number would now name a different task entirely.
      // Resolving both to the newly-minted ids is what makes "B depends on A" survive the one
      // operation in this runtime that renumbers tasks. A self-edge and an out-of-range number
      // are dropped rather than stored: validatePlan refuses them aloud before they get here,
      // and a store that cannot be handed an unrunnable graph is one less way to strand a job.
      const ids = rows.map(() => newId("jt"));
      const byOldId = new Map();
      rows.forEach((t, i) => { if (t?.id) byOldId.set(String(t.id), ids[i]); });
      const resolveDeps = (raw, selfIdx) => {
        const out = [];
        for (const d of Array.isArray(raw) ? raw : []) {
          if (typeof d === "number" || /^\d+$/.test(String(d ?? ""))) {
            const k = Number(d);
            if (Number.isInteger(k) && k >= 1 && k <= rows.length && k - 1 !== selfIdx) out.push(ids[k - 1]);
            continue;
          }
          const mapped = byOldId.get(String(d));
          if (mapped && mapped !== ids[selfIdx]) out.push(mapped);
        }
        return [...new Set(out)].slice(0, 8);
      };
      h.transaction(() => {
        clearTasks.run(id);
        rows.forEach((t, i) => {
          insTask.run(
            ids[i], id, i,
            scrub(String(t?.title ?? "").trim()).slice(0, 300) || `task ${i + 1}`,
            t?.seat ?? null,
            JSON.stringify((Array.isArray(t?.skillsRequired) ? t.skillsRequired : []).map(String).slice(0, 8)),
            JSON.stringify((Array.isArray(t?.steps) ? t.steps : []).map((s) => scrub(String(s)).slice(0, 2_000)).slice(0, 12)),
            // Phase C · task 9 — these used to be hardcoded null/"[]", which meant a RE-PLAN
            // wiped the engine ids and the changed paths of every row, finished ones included.
            // With ship-as-you-go a finished task's changedPaths are what ship() commits, so
            // dropping them silently un-shipped work that was already done (SEQ-2). On a first
            // plan the fields are absent and the result is identical to before.
            t?.status ?? "planned",
            t?.goalId ?? null, t?.taskId ?? null, t?.deliveryId ?? null,
            JSON.stringify((Array.isArray(t?.changedPaths) ? t.changedPaths : []).map(String).slice(0, 100)),
            t?.blockedOn ?? null, JSON.stringify(resolveDeps(t?.dependsOn, i)),
            // Carried, like every field a re-plan must not reset (SEQ-2). resumeCount above all:
            // the once-only resume is a counter, and a re-plan that zeroed it would grant a second.
            t?.questionTo ?? null, t?.question ? String(t.question).slice(0, 1_000) : null,
            t?.answer ? String(t.answer).slice(0, 4_000) : null, t?.answerFrom ?? null,
            Math.max(0, Math.floor(Number(t?.resumeCount) || 0)),
            now, now);
        });
      })();
      // 12.2 — the board's live signal. A JOB's status changes a handful of times; its TASKS
      // change constantly, and every one of those moves a card. IDENTITY ONLY, exactly as
      // create/setStatus emit: a bus frame reaches every connected seat, and a task title is
      // not something to broadcast — the client re-reads the auth-gated GET.
      fire("job.changed", { id, status: getJob.get(id)?.status ?? "unknown" });
      return this.tasks(id);
    },

    tasks: (id) => listTasks.all(String(id || "")).map(hydrateTask),
    task: (taskRowId) => hydrateTask(getTask.get(String(taskRowId || ""))) ?? null,
    /** Find the job task that owns an ENGINE taskId — how a worker's signal finds its job. */
    byEngineTask: (engineTaskId) => hydrateTask(taskByTaskId.get(String(engineTaskId || ""))) ?? null,
    /**
     * Find it by GOAL instead. The engine mints a NEW taskId for every retry
     * (`task_c99b… → task_da44… → task_3469…`, attempts 1/2/3) while the job task still
     * stores the FIRST one, so a terminal-failure signal after a retry names an id this
     * store has never seen and `byEngineTask` returns null. The goalId is stable across
     * every attempt, which makes it the durable join.
     */
    byEngineGoal: (engineGoalId) => hydrateTask(taskByGoalId.get(String(engineGoalId || ""))) ?? null,

    updateTask(taskRowId, patch = {}) {
      const row = getTask.get(String(taskRowId || ""));
      if (!row) throw new JobError(`no such job task: ${taskRowId}`, 404);
      const next = {
        seat: patch.seat ?? row.seat,
        status: patch.status ?? row.status,
        goalId: patch.goalId ?? row.goalId,
        taskId: patch.taskId ?? row.taskId,
        deliveryId: patch.deliveryId ?? row.deliveryId,
        changedPaths: patch.changedPaths ? JSON.stringify(patch.changedPaths) : row.changedPaths,
        blockedOn: patch.blockedOn === undefined ? row.blockedOn : patch.blockedOn,
        questionTo: patch.questionTo === undefined ? row.questionTo : patch.questionTo,
        question: patch.question === undefined ? row.question : (patch.question === null ? null : String(patch.question).slice(0, 1_000)),
        answer: patch.answer === undefined ? row.answer : (patch.answer === null ? null : String(patch.answer).slice(0, 4_000)),
        answerFrom: patch.answerFrom === undefined ? row.answerFrom : patch.answerFrom,
        resumeCount: patch.resumeCount === undefined ? row.resumeCount : Math.max(0, Math.floor(Number(patch.resumeCount) || 0)),
      };
      h.prepare(
        `UPDATE job_tasks SET seat=?, status=?, goalId=?, taskId=?, deliveryId=?, changedPaths=?, blockedOn=?, questionTo=?, question=?, answer=?, answerFrom=?, resumeCount=?, updatedAt=?
         WHERE id = ?`,
      ).run(next.seat, next.status, next.goalId, next.taskId, next.deliveryId, next.changedPaths, next.blockedOn, next.questionTo, next.question, next.answer, next.answerFrom, next.resumeCount, Date.now(), taskRowId);
      // 12.2 — see setTasks. The frame names the JOB because that is what the board re-reads.
      fire("job.changed", { id: row.jobId, status: getJob.get(row.jobId)?.status ?? "unknown" });
      return hydrateTask(getTask.get(taskRowId));
    },
  };
}

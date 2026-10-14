// Phase 9 · task 9.2 — the Manager state machine. Zero I/O: every dependency injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFileSync } from "node:fs";
import { parse } from "acorn";

import { openDb } from "../db.mjs";
import { createJobs } from "../jobs.mjs";
import { createManager, validatePlan, isStalled, classifyDispatchError, MAX_TRANSIENT_RETRIES, proposedWriteScope, stepPaths } from "../manager.mjs";

const CATALOG = ["ui", "api", "db", "test", "notifications", "repo-read"];
const ROSTER = {
  match: (skills) => {
    const seats = [
      { id: "sr-frontend", skills: ["ui"] },
      { id: "sr-backend", skills: ["api", "db"] },
      { id: "qa", skills: ["test"] },
    ];
    return seats.filter((s) => (skills || []).every((k) => s.skills.includes(k)));
  },
};

function harness(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ma-mgr-"));
  const db = openDb({ path: join(dir, "mission.db"), patchesDir: join(dir, "patches") });
  const jobs = createJobs({ db, scrub: (t) => t });
  const gates = [];
  const enqueued = [];
  const inbox = [];
  const sent = [];
  const logs = [];
  let now = 1_000_000;
  // Phase C · task 8 — the scope check reads the ROSTER for the hired seat's real writeScope,
  // never the message body. `seats` is mutable so a test can hand back a deliberately wrong one.
  const roster = { ...ROSTER, seats: {}, get(id) { return this.seats[id] ?? null; } };
  const mgr = createManager({
    jobs, roster, catalog: CATALOG,
    mailbox: { read: () => inbox.splice(0, inbox.length), send: (m) => { sent.push(m); return { id: `m${sent.length}` }; } },
    enqueueGoal: (g) => { enqueued.push(g); return { goalId: `goal_${enqueued.length}`, firstTaskId: `task_${enqueued.length}` }; },
    deliveries: { mintGate: (g) => { const row = { id: `d${gates.length + 1}`, ...g }; gates.push(row); return row; }, listGates: () => [] },
    queue: { all: () => [] },
    clock: () => now,
    log: (r) => logs.push(r),
    ...over,
  });
  return { jobs, mgr, roster, gates, enqueued, inbox, sent, logs, setNow: (v) => { now = v; }, nowRef: () => now };
}

// ── validatePlan ─────────────────────────────────────────────────────────────
test("MGR-PLAN-1: a good plan validates", () => {
  const v = validatePlan({ tasks: [{ title: "t", skillsRequired: ["api"], steps: ["do"] }] }, { catalog: CATALOG });
  assert.equal(v.ok, true);
});

// ── Phase C · task 7 — ONE TASK IS ONE STEP ──────────────────────────────────
// The four things, named, because three of them were being conflated:
//   STEP    one model turn on one worktree.
//   ATTEMPT one engine task id for one step (a retry is a new attempt, same step).
//   TASK    a job row. Closed ONLY by the engine's terminal `done` (Phase B, task 4).
//   JOB     closes on the ship ladder.
// Until step chaining exists, one task = one step, and the planner is told so in words.
// A multi-step task silently drops steps 2..n: the seat gets one turn and the row closes.
test("PLAN-STEPS-1: a task with more than one step is refused, and the reason names the task", () => {
  // Mutation proof (2026-09-17): dropped the `steps.length > 1` refusal →
  // ✖ PLAN-STEPS-1 (fail 1). Restored, md5 matched, 153/153 green across manager+pipeline+jobs.
  const v = validatePlan({ tasks: [
    { title: "fine", skillsRequired: ["api"], steps: ["one"] },
    { title: "Add the endpoint AND the test", skillsRequired: ["api"], steps: ["add endpoint", "add test"] },
  ] }, { catalog: CATALOG });
  assert.equal(v.ok, false);
  assert.match(v.error, /Add the endpoint AND the test/, "the BOSS must be able to see WHICH task to split");
  assert.match(v.error, /2 steps|one step/i);
});

test("PLAN-STEPS-2 (GOOD leg): exactly one step passes, and an empty trailing step does not count", () => {
  assert.equal(validatePlan({ tasks: [{ title: "t", skillsRequired: ["api"], steps: ["do"] }] }, { catalog: CATALOG }).ok, true);
  // steps are filtered for blanks before the count, so a trailing "" is not a second step
  assert.equal(validatePlan({ tasks: [{ title: "t", skillsRequired: ["api"], steps: ["do", "  "] }] }, { catalog: CATALOG }).ok, true);
});

test("MGR-PLAN-2: an empty / missing / oversized plan is refused", () => {
  assert.equal(validatePlan({}, {}).ok, false);
  assert.equal(validatePlan({ tasks: [] }, {}).ok, false);
  const many = Array.from({ length: 9 }, () => ({ title: "t", skillsRequired: ["api"], steps: ["s"] }));
  assert.match(validatePlan({ tasks: many }, { catalog: CATALOG }).error, /cap is 8/);
});

test("MGR-PLAN-3: a task with no steps is refused — 'investigate X' is not a task", () => {
  assert.match(validatePlan({ tasks: [{ title: "look into it", skillsRequired: ["api"], steps: [] }] }, {}).error, /no steps/);
});

test("MGR-PLAN-4: an UNKNOWN skill is refused — it could never be matched or hired", () => {
  const v = validatePlan({ tasks: [{ title: "t", skillsRequired: ["telepathy"], steps: ["s"] }] }, { catalog: CATALOG });
  assert.match(v.error, /unknown skill\(s\): telepathy/);
});

// ── the stall clock ──────────────────────────────────────────────────────────
test("MGR-STALL-1: idle past the budget is a stall", () => {
  assert.equal(isStalled({ lastProgressAt: 0, now: 900_000, stallMs: 900_000 }), true);
  assert.equal(isStalled({ lastProgressAt: 0, now: 899_999, stallMs: 900_000 }), false);
});

test("MGR-STALL-2: time does NOT pass while a human is the blocker", () => {
  // Phase 6 shipped the opposite: 771 s of human review counted as a stall and blocked a story.
  assert.equal(isStalled({ lastProgressAt: 0, now: 10 ** 9, stallMs: 900_000, heldOrWaiting: true }), false);
});

test("MGR-STALL-3: a job awaiting the BOSS never stalls, however long it sits", async () => {
  const h = harness();
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "clarify");
  h.jobs.setQuestions(j.id, ["q?"]);
  await h.mgr.tick(j.id);                       // → awaiting-you, one gate
  h.setNow(h.nowRef() + 30 * 24 * 3600 * 1000); // a month
  const r = await h.mgr.tick(j.id);
  assert.notEqual(r.action, "blocked", "a job waiting on a human must never be called stalled");
  assert.equal(h.jobs.get(j.id).status, "awaiting-you");
});

test("MGR-STALL-4: a HELD task also freezes the clock", async () => {
  const h = harness({ queue: { all: () => [{ taskId: "task_1", status: "held" }] } });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  h.jobs.setTasks(j.id, [{ title: "one", skillsRequired: ["api"], steps: ["s"] }]);
  const [t] = h.jobs.tasks(j.id);
  h.jobs.updateTask(t.id, { taskId: "task_1", status: "queued" });
  h.jobs.setStatus(j.id, "building");
  h.setNow(h.nowRef() + 3600_000);
  const r = await h.mgr.tick(j.id);
  assert.notEqual(r.action, "blocked", "a diff waiting for the operator is not a stalled job");
});

test("MGR-STALL-5: a genuinely idle RUNNING job blocks, and says how long", async () => {
  const h = harness();
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  h.jobs.setStatus(j.id, "building");
  h.mgr.markProgress(j.id);
  h.setNow(h.nowRef() + 900_000);
  const r = await h.mgr.tick(j.id);
  assert.equal(r.action, "blocked");
  assert.match(r.reason, /no progress for 900s/);
  assert.equal(h.logs.some((l) => l.event === "job-stall"), true, "a stall is logged, never silent");
});

// ── the shared inbox: one mailbox, many live jobs ────────────────────────────
test("MGR-MAIL-1: a `done` for ANOTHER job is not thrown away when this job ticks", async () => {
  // THE DEFECT, found by the 9.6 live run. `mailbox.read()` ARCHIVES everything it returns
  // ("so nothing is re-read"), and the building branch then kept only `m.jobId === job.id`.
  // With two live jobs and a round-robin of one tick per beat, the engine's `done` for job B
  // was read by job A's tick, filtered out, and archived — delivered, then silently dropped.
  // Job B sat in `building` forever: its stall clock is deliberately frozen while a task is
  // HELD, so it could not even time out. Live evidence: mail 01M1S3RJ7KEV8MDDJ81GFZX361
  // ("task task_b30e30fd6cc2 is HELD…") sat in tech-lead/archive while job_1f2973ced79c's
  // task row still read `queued`.
  const h = harness();

  const a = h.jobs.create({ title: "A", brief: "brief for job A" });
  h.jobs.setStatus(a.id, "planned");
  h.jobs.setTasks(a.id, [{ title: "a1", skillsRequired: ["api"], steps: ["s"] }]);
  h.jobs.updateTask(h.jobs.tasks(a.id)[0].id, { taskId: "task_A", status: "queued" });
  h.jobs.setStatus(a.id, "building");

  const b = h.jobs.create({ title: "B", brief: "brief for job B" });
  h.jobs.setStatus(b.id, "planned");
  h.jobs.setTasks(b.id, [{ title: "b1", skillsRequired: ["test"], steps: ["s"] }]);
  const bTask = h.jobs.tasks(b.id)[0];
  h.jobs.updateTask(bTask.id, { taskId: "task_B", status: "queued" });
  h.jobs.setStatus(b.id, "building");

  // The engine reports B's task done. The round-robin happens to tick A.
  h.inbox.push({ from: "engine", to: "tech-lead", kind: "done", jobId: b.id, taskId: "task_B" });
  await h.mgr.tick(a.id);

  assert.equal(h.jobs.tasks(b.id)[0].status, "done",
    "B's task must be marked from the mail that named it, whichever job's tick drained the inbox");
});

test("MGR-MAIL-2: a `blocked` for another job is applied too, not just `done`", async () => {
  const h = harness();
  const a = h.jobs.create({ title: "A", brief: "brief for job A" });
  h.jobs.setStatus(a.id, "planned");
  h.jobs.setTasks(a.id, [{ title: "a1", skillsRequired: ["api"], steps: ["s"] }]);
  h.jobs.updateTask(h.jobs.tasks(a.id)[0].id, { taskId: "task_A", status: "queued" });
  h.jobs.setStatus(a.id, "building");

  const b = h.jobs.create({ title: "B", brief: "brief for job B" });
  h.jobs.setStatus(b.id, "planned");
  h.jobs.setTasks(b.id, [{ title: "b1", skillsRequired: ["test"], steps: ["s"] }]);
  h.jobs.updateTask(h.jobs.tasks(b.id)[0].id, { taskId: "task_B", status: "queued" });
  h.jobs.setStatus(b.id, "building");

  h.inbox.push({ from: "engine", to: "tech-lead", kind: "blocked", jobId: b.id, taskId: "task_B", body: "seat died" });
  await h.mgr.tick(a.id);

  const bt = h.jobs.tasks(b.id)[0];
  assert.equal(bt.status, "blocked");
  assert.match(bt.blockedOn || "", /seat died/);
});

test("MGR-MAIL-3: mail naming no known task is dropped without throwing", async () => {
  // The inbox is drained destructively, so an unmatched row must not take the tick down —
  // and must not be applied to the ticking job just because it is the one in hand.
  const h = harness();
  const a = h.jobs.create({ title: "A", brief: "brief for job A" });
  h.jobs.setStatus(a.id, "planned");
  h.jobs.setTasks(a.id, [{ title: "a1", skillsRequired: ["api"], steps: ["s"] }]);
  h.jobs.updateTask(h.jobs.tasks(a.id)[0].id, { taskId: "task_A", status: "queued" });
  h.jobs.setStatus(a.id, "building");

  h.inbox.push({ from: "engine", to: "tech-lead", kind: "done", jobId: "job_ghost", taskId: "task_GHOST" });
  await h.mgr.tick(a.id);
  assert.equal(h.jobs.tasks(a.id)[0].status, "queued", "A's task is untouched by mail that did not name it");
});

test("MGR-MAIL-4: a signal from a RETRY attempt still finds its job task, via the goal", async () => {
  // THE DEFECT, second instance of the same class, found by the 9.6 scenario-2 live run.
  // The engine mints a NEW taskId per attempt — task_c99b6b2287ca (1) → task_da44f06d4386 (2)
  // → task_3469f3220a79 (3) — while the job task still stores the FIRST. The terminal
  // `blocked` for attempt 3 therefore named an id the job store had never seen,
  // `byEngineTask` returned null, and the message was dropped by the same destructive read.
  // The qa task stayed `queued` forever while the engine had already given up on it.
  // goalId (goal_bd1e6c80e8af) was identical across all three attempts.
  const h = harness();
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  h.jobs.setTasks(j.id, [{ title: "t1", skillsRequired: ["test"], steps: ["s"] }]);
  h.jobs.updateTask(h.jobs.tasks(j.id)[0].id, { taskId: "task_attempt1", goalId: "goal_1", status: "queued" });
  h.jobs.setStatus(j.id, "building");

  // Attempt 3's id was never recorded against the job task; only the goal matches.
  h.inbox.push({ from: "engine", to: "tech-lead", kind: "blocked",
    jobId: j.id, taskId: "task_attempt3", goalId: "goal_1", body: "terminal failure" });
  await h.mgr.tick(j.id);

  assert.equal(h.jobs.tasks(j.id)[0].status, "blocked",
    "a retry's terminal signal must still reach the job task — goalId is stable, taskId is not");
});

test("MGR-REPLAN-CAP: the Manager re-plans ONCE, then escalates — it never loops", async () => {
  // THE DEFECT, measured on the live 9.6 scenario-2 run (job_b1430c862910): a task that can
  // never pass (its dependency is HELD, so it never lands in the next seat's worktree) drove
  // blocked → replan → build → blocked → replan → … The code said "re-plan ONCE" in a comment
  // and nothing enforced it. Six Manager turns, 82k input + 268k cache-read tokens, still
  // going. A runaway that costs money and never terminates is exactly what this phase's own
  // threat model says must be bounded ("…then `blocked` — never silent").
  const h = harness({
    dispatch: async ({ stage }) => (stage === "manage"
      ? { ok: true, action: "replan", order: [2, 1] }   // a Manager that ALWAYS wants a reorder
      : { ok: true, tasks: [] }),
  });
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  h.jobs.setTasks(j.id, [
    { title: "a", skillsRequired: ["api"], steps: ["s"] },
    { title: "b", skillsRequired: ["test"], steps: ["s"] },
  ]);
  const [t1, t2] = h.jobs.tasks(j.id);
  h.jobs.updateTask(t1.id, { taskId: "task_1", status: "done" });
  h.jobs.updateTask(t2.id, { taskId: "task_2", status: "blocked", blockedOn: "dependency not landed" });
  h.jobs.setStatus(j.id, "building");

  const first = await h.mgr.tick(j.id);
  assert.equal(first.action, "replanned", "the FIRST block earns a reorder");

  // Same wall again: the job comes back to `building` with the same task still blocked.
  h.jobs.setStatus(j.id, "building");
  for (const t of h.jobs.tasks(j.id)) {
    if (t.title === "b") h.jobs.updateTask(t.id, { status: "blocked", blockedOn: "dependency not landed" });
  }
  const second = await h.mgr.tick(j.id);
  assert.equal(second.action, "escalated",
    `the SECOND block must reach a human, not re-plan again (got ${second.action})`);
  assert.equal(h.jobs.get(j.id).status, "awaiting-you");
});

// ── Phase 10 · task 10.1b — HIRING, FROM THE MANAGER'S SIDE ──────────────────
// Hiring is ASYNCHRONOUS. Phase 9 left a synchronous `hire()` seam that returned an agent or
// an error in one call; a real hire is a mail to HR, a heartbeat, and a reply. The task must
// therefore PARK and be resumed by the answer — a seam that blocked the tick waiting for HR
// would stall the whole round-robin.

const hireHarness = () => harness({
  dispatch: async ({ stage }) => (stage === "plan"
    ? { ok: true, tasks: [
      // The path deliberately does NOT match the skill name: `notifications` would fall back to
      // `src/lib/notifications/**`, so a step under src/lib/alerts/ is the only way to tell a
      // work-derived scope from a skill-name guess. (The first version of MGR-HIRE-6b used a
      // matching path and passed with the fix mutated out — vacuous, addendum #22.)
      { title: "wire the notifier", skillsRequired: ["notifications"], steps: ["add src/lib/alerts/send.ts"] },
      { title: "cover it", skillsRequired: ["test"], steps: ["add a test"] },
    ] }
    : { ok: true, findings: [], needs: [] }),
});

test("MGR-HIRE-1: an unstaffed skill mails HR and PARKS the task — it does not block the job", async () => {
  const h = hireHarness();
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);

  const req = h.sent.find((m) => m.kind === "hire-request");
  assert.ok(req, `no hire-request was sent: ${JSON.stringify(h.sent)}`);
  assert.equal(req.to, "hr");
  assert.equal(req.jobId, j.id);
  assert.match(req.body, /notifications/);

  const parked = h.jobs.tasks(j.id).find((t) => t.status === "awaiting-hire");
  assert.ok(parked, "the unstaffed task must PARK, not block the job and not vanish");
  assert.equal(parked.seat, null, "an unstaffed task has no seat until HR answers");
});

test("MGR-HIRE-2: the STAFFED task in the same plan is still enqueued — one gap does not stop the rest", async () => {
  const h = hireHarness();
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  const staffed = h.jobs.tasks(j.id).find((t) => t.seat === "qa");
  assert.ok(staffed, "the test task should have matched qa");
  assert.equal(staffed.status, "queued");
  assert.equal(h.enqueued.length, 1, "exactly the staffed task was enqueued");
});

test("MGR-HIRE-3: hire-done assigns the new seat and enqueues the parked task", async () => {
  const h = hireHarness();
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);

  // HR answers. The new member is on the roster by the time the Manager reads the reply.
  h.inbox.push({ from: "hr", to: "tech-lead", kind: "hire-done", jobId: j.id,
    body: JSON.stringify({ agentId: "notifications-engineer" }) });
  await h.mgr.tick(j.id);

  const t = h.jobs.tasks(j.id).find((x) => x.title === "wire the notifier");
  assert.equal(t.seat, "notifications-engineer", "the hire must be given the task it was hired for");
  assert.equal(t.status, "queued");
  assert.equal(h.enqueued.length, 2, "the parked task is enqueued once the seat exists");
});

test("MGR-HIRE-4: hire-failed reaches the BOSS as ONE question gate, and the job waits", async () => {
  const h = hireHarness();
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);

  h.inbox.push({ from: "hr", to: "tech-lead", kind: "hire-failed", jobId: j.id,
    body: JSON.stringify({ reason: "worker cap reached (20/20)" }) });
  await h.mgr.tick(j.id);

  assert.equal(h.gates.length, 1, "a failed hire is a decision only the BOSS can make");
  assert.match(h.gates[0].body, /cap/i, "the gate must carry HR's actual reason, not a generic one");
  assert.equal(h.jobs.get(j.id).status, "awaiting-you");
});

test("MGR-HIRE-5: the same request is not sent twice — HR is idempotent, the Manager is too", async () => {
  const h = hireHarness();
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  await h.mgr.tick(j.id);
  await h.mgr.tick(j.id);
  const reqs = h.sent.filter((m) => m.kind === "hire-request");
  assert.equal(reqs.length, 1, `the Manager re-asked for the same hire ${reqs.length} times`);
});

test("MGR-HIRE-6b: requestHire passes the task's STEPS — not just its skills", async () => {
  // The third time this exact shape has bitten in two phases (addendum #25): a function grows a
  // parameter, the call site does not, and the default silently restores the old behaviour with
  // every test green. Here the default would put the hire back on the skill-name guess that
  // failed live.
  const h = hireHarness();
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  const body = JSON.parse(h.sent.find((m) => m.kind === "hire-request").body);
  // The plan's step says "add src/lib/notifications/send.ts", so the scope must follow the FILE.
  assert.deepEqual(body.writeScope, ["src/lib/alerts/**"],
    "the scope did not follow the work — requestHire is not passing task.steps "
    + "(src/lib/notifications/** means it fell back to the skill NAME)");
});

test("MGR-HIRE-6: the PROPOSED writeScope is narrow, inside the appliable dirs, never CORE_GUARD", async () => {
  const h = hireHarness();
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  const body = JSON.parse(h.sent.find((m) => m.kind === "hire-request").body);
  assert.ok(Array.isArray(body.writeScope) && body.writeScope.length, "a hire needs a scope to be validated against");
  for (const g of body.writeScope) {
    assert.ok(!/agent-runtime\/(guards|roster)\.(mjs|json)/.test(g), `proposed a CORE_GUARD path: ${g}`);
    assert.ok(!g.includes(".."), `proposed a traversal: ${g}`);
    assert.equal(g.split("/")[0], "src", `proposed a scope outside src: ${g}`);
  }
});

test("MGR-HIRE-7: an unstaffed job whose HR never answers eventually BLOCKS — silence is not a state", async () => {
  // Deviation from the phase plan, deliberate: the plan says the stall clock PAUSES while a
  // task is awaiting-hire. `heldOrWaiting` means "a HUMAN is the blocker"; HR is a runtime
  // function on the heartbeat, not a human. Pausing for it would hide an HR outage forever —
  // the exact "waiting on news that never comes" shape Phase 9's #29/#30 were about. HR
  // answers within a beat in the happy path, so a running clock costs nothing there.
  const h = hireHarness();
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  h.setNow(h.nowRef() + 900_000);
  const r = await h.mgr.tick(j.id);
  assert.equal(r.action, "blocked", "a hire that never comes back must surface, not hang");
});

test("MGR-SCOPE-1: the proposed scope comes from the WORK, not from the skill's name", () => {
  // THE DEFECT, proven live in the Phase 10 hire run. The Manager asked for `repo-edit` to
  // write `docs/alerting.md`; the proposed scope was derived from the skill id, so the hire
  // arrived with writeScope ["src/lib/repo-edit/**"] — a directory that does not exist and has
  // nothing to do with the task. `repo-edit-engineer` then failed all three attempts with
  // `empty-diff — no diff produced`: it was told its scope in its SKILL body, correctly
  // refused to write outside it, and therefore wrote nothing. A hire that cannot do the job it
  // was hired for is worse than no hire — it costs a seat AND still blocks the job.
  assert.deepEqual(
    proposedWriteScope(["repo-edit"], ["Write docs/alerting.md: the operator runbook"]),
    ["docs/**"]);
  assert.deepEqual(
    proposedWriteScope(["notifications"], ["Create src/lib/notifications/formatAlert.ts exporting formatAlert()"]),
    ["src/lib/notifications/**"]);
});

test("MGR-SCOPE-2: a step naming agent-runtime does NOT widen a hire into the runtime", () => {
  // The steps are MODEL-AUTHORED. agent-runtime is a seed dir, so validateRosterSpec would
  // accept it — which would let a plan grant a brand-new agent write access to the runtime
  // that dispatches it. Existing seats own agent-runtime; a hire that needs it is a decision
  // for the BOSS, not a sentence in a plan.
  const out = proposedWriteScope(["api"], ["Edit agent-runtime/server.mjs to add a route"]);
  for (const g of out) assert.notEqual(g.split("/")[0], "agent-runtime", `proposed ${g}`);
});

test("MGR-SCOPE-3: junk in the steps is ignored, and there is always a fallback", () => {
  // A hire with NO scope is refused by validateRosterSpec, so this must never return [].
  for (const steps of [[], ["investigate the thing"], ["../../etc/passwd"], ["/absolute/path.ts"]]) {
    const out = proposedWriteScope(["notifications"], steps);
    assert.ok(out.length, `no scope proposed for ${JSON.stringify(steps)}`);
    for (const g of out) {
      assert.ok(!g.includes(".."), g);
      assert.ok(!g.startsWith("/"), g);
    }
  }
});

test("MGR-PATHS-1: the engine's done signal populates the task's changedPaths", async () => {
  // THE DEFECT, found by the Phase 11 live chain. The engine knows exactly which files a task
  // changed (it passes them to onHeld), but `signalManager` never forwarded them, so the job
  // task kept `changedPaths: []`. Consequences, both live: the review turn was handed "0 files
  // changed", and `manager.ship` skips a task with no paths (MS-7) — so an approved job would
  // have shipped ZERO commits and still reported `shipped`.
  const h = harness();
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  h.jobs.setTasks(j.id, [{ title: "t", skillsRequired: ["api"], steps: ["s"] }]);
  h.jobs.updateTask(h.jobs.tasks(j.id)[0].id, { taskId: "task_1", status: "queued" });
  h.jobs.setStatus(j.id, "building");

  h.inbox.push({ from: "engine", to: "tech-lead", kind: "done", jobId: j.id, taskId: "task_1",
    changedPaths: ["src/lib/x.ts", "src/lib/y.ts"], deliveryId: "d9" });
  await h.mgr.tick(j.id);

  const t = h.jobs.tasks(j.id)[0];
  assert.deepEqual(t.changedPaths, ["src/lib/x.ts", "src/lib/y.ts"],
    "without these the review reports 0 files and ship commits nothing");
  assert.equal(t.deliveryId, "d9");
});

// ── transient vs deterministic ───────────────────────────────────────────────
test("MGR-RETRY-1: 429/timeout is transient; 401 is not", () => {
  assert.equal(classifyDispatchError("429 Too Many Requests").transient, true);
  assert.equal(classifyDispatchError("ETIMEDOUT").transient, true);
  assert.equal(classifyDispatchError("401 Unauthorized").transient, false);
  assert.equal(classifyDispatchError("invalid api key").transient, false);
});

test("MGR-RETRY-2: two 429s then success proceeds — the job is NOT blocked", async () => {
  let n = 0;
  const h = harness({
    dispatch: async () => (++n <= 2 ? { ok: false, error: "429 rate limit" } : { ok: true, findings: [], needs: [] }),
  });
  const j = h.jobs.create({ title: "t", brief: "b" });
  assert.equal((await h.mgr.tick(j.id)).action, "retry");
  assert.equal((await h.mgr.tick(j.id)).action, "retry");
  assert.equal(h.jobs.get(j.id).status, "intake", "a transient failure must not move the job");
  const r = await h.mgr.tick(j.id);
  // Phase F · 20: a successful intake now hands the job to the CEO (`strategy`), not to planned.
  // The claim — two 429s then success MOVES the job and does not block it — is unchanged.
  assert.equal(r.action, "strategy");
  assert.equal(h.jobs.get(j.id).status, "strategy");
});

test("MGR-RETRY-3: a deterministic error blocks on the FIRST try — no quota burned", async () => {
  const h = harness({ dispatch: async () => ({ ok: false, error: "401 Unauthorized" }) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  const r = await h.mgr.tick(j.id);
  assert.equal(r.action, "blocked");
  assert.match(r.reason, /401/);
});

test("MGR-RETRY-4: transient failures are capped, then the job blocks", async () => {
  const h = harness({ dispatch: async () => ({ ok: false, error: "503 upstream" }) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  for (let i = 0; i < MAX_TRANSIENT_RETRIES; i++) assert.equal((await h.mgr.tick(j.id)).action, "retry");
  assert.equal((await h.mgr.tick(j.id)).action, "blocked", "retrying forever is a hang, not resilience");
});

// ── the walk ─────────────────────────────────────────────────────────────────
function scripted(replies) {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)];
}

test("MGR-WALK-1: intake with no questions SKIPS clarify — an empty gate is not asked", async () => {
  // Phase F · 20: intake → strategy (the CEO) → clarify, which still skips itself with no questions.
  const h = harness({ dispatch: scripted([{ ok: true, findings: ["x exists"], needs: [] }, { ok: true, verdict: "proceed", why: "w" }]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  assert.equal((await h.mgr.tick(j.id)).action, "strategy");
  assert.equal((await h.mgr.tick(j.id)).verdict, "proceed");
  assert.equal((await h.mgr.tick(j.id)).action, "planned");
  assert.equal(h.gates.length, 0, "no question means no gate");
});

test("MGR-WALK-2: questions become ONE gate, not N", async () => {
  const h = harness({ dispatch: scripted([{ ok: true, findings: [], needs: ["a?", "b?", "c?"] }, { ok: true, verdict: "proceed", why: "w" }]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  await h.mgr.tick(j.id);                     // intake → strategy (Phase F · 20)
  await h.mgr.tick(j.id);                     // strategy (proceed) → clarify
  const r = await h.mgr.tick(j.id);           // clarify → one gate
  assert.equal(r.action, "asked");
  assert.equal(h.gates.length, 1, "one decision the BOSS makes in one sitting = one gate");
  assert.equal(h.gates[0].jobId, j.id, "and it is a JOB gate, not a story gate");
  assert.match(h.gates[0].body, /1\. a\?/);
});

// SUPERSEDED BY PHASE C · task 9, rewritten rather than deleted (same convention as the
// Phase 10 rewrites below). The claim "one goal per task" WAS the P-F08 defect: every seat's
// worktree was cut from the same HEAD at once, so an ordered plan was ordered in name only.
// The seat-selection half of the claim is unchanged and still pinned.
test("MGR-WALK-3: plan assigns BY SKILL and dispatches the FIRST task only", async () => {
  const h = harness({ dispatch: scripted([{ ok: true, tasks: [
    { title: "api bit", skillsRequired: ["api"], steps: ["add x"] },
    { title: "test bit", skillsRequired: ["test"], steps: ["test x"] },
  ] }]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  const r = await h.mgr.tick(j.id);
  assert.equal(r.action, "assigned");
  assert.deepEqual(h.jobs.tasks(j.id).map((t) => t.seat), ["sr-backend", "qa"],
    "the RUNTIME chose the seats from skills — the model never named one");
  assert.equal(h.enqueued.length, 1, "one task in flight — B is cut from A's commit, not from HEAD");
  assert.deepEqual(h.jobs.tasks(j.id).map((t) => t.status), ["queued", "planned"]);
  assert.equal(h.enqueued[0].storyId, j.id, "goals are owner-tagged with the job id");
  assert.equal(h.jobs.get(j.id).status, "building");
});

// SUPERSEDED BY PHASE 10, rewritten rather than deleted. Both of these pinned the Phase 9
// behaviour they were written for: an unstaffed skill BLOCKED the job, and a synchronous
// `hire()` seam returned an agent in one call. Phase 10 replaces both — the task parks, HR is
// mailed, and the reply resumes it. Keeping the old assertions passing would have meant
// keeping the old dead end; keeping the tests, with their claims updated, keeps the coverage.
test("MGR-WALK-4: a skill nobody holds now PARKS and asks HR — it no longer dead-ends the job", async () => {
  const h = harness({ dispatch: scripted([{ ok: true, tasks: [
    { title: "notify", skillsRequired: ["notifications"], steps: ["send"] },
  ] }]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  const r = await h.mgr.tick(j.id);
  assert.notEqual(r.action, "blocked", "Phase 10: an unstaffed skill is a hire, not a dead end");
  const [t] = h.jobs.tasks(j.id);
  assert.equal(t.status, "awaiting-hire");
  assert.equal(t.seat, null);
  assert.ok(h.sent.some((m) => m.kind === "hire-request" && m.to === "hr"), "HR must have been asked");
});

test("MGR-WALK-4b: HR's answer is what assigns the seat — not a synchronous hire() call", async () => {
  const h = harness({
    dispatch: scripted([{ ok: true, tasks: [{ title: "notify", skillsRequired: ["notifications"], steps: ["send"] }] }]),
  });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  h.inbox.push({ from: "hr", to: "tech-lead", kind: "hire-done", jobId: j.id,
    body: JSON.stringify({ agentId: "notifications-engineer" }) });
  await h.mgr.tick(j.id);
  assert.equal(h.jobs.tasks(j.id)[0].seat, "notifications-engineer");
  assert.equal(h.jobs.tasks(j.id)[0].status, "queued");
});

test("MGR-WALK-5: a `done` mail marks the task and the job reaches review", async () => {
  const h = harness({ dispatch: scripted([{ ok: true, tasks: [{ title: "one", skillsRequired: ["api"], steps: ["s"] }] }]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  h.inbox.push({ from: "engine", kind: "done", taskId: "task_1", deliveryId: "d1", changedPaths: ["src/lib/x.ts"], jobId: j.id });
  const r = await h.mgr.tick(j.id);
  assert.equal(r.action, "review");
  const [t] = h.jobs.tasks(j.id);
  assert.equal(t.status, "done");
  assert.deepEqual(t.changedPaths, ["src/lib/x.ts"]);
});

test("MGR-WALK-5b: a worker's own `done` is PROGRESS, not completion — the task stays building", async () => {
  // Step 2 ratchet. Mutation proof (2026-09-17): manager.mjs `m.from !== "engine"` → `=== "never"` →
  //   ✖ MGR-WALK-5b  AssertionError: Expected values to be strictly equal: actual: 'done', expected: 'queued'
  //   ✖ MGR-WALK-5c  (from=sr-backend closed the task). Restored, md5 matched, 45/45 green.
  const h = harness({ dispatch: scripted([{ ok: true, tasks: [{ title: "one", skillsRequired: ["api"], steps: ["s"] }] }]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  const before = h.jobs.tasks(j.id)[0].status; // "queued" until the engine claims it
  h.inbox.push({ from: "sr-backend", kind: "done", taskId: "task_1", changedPaths: ["src/lib/x.ts"], jobId: j.id });
  const r = await h.mgr.tick(j.id);
  assert.notEqual(r.action, "review", "a seat's word does not reach review");
  const [t] = h.jobs.tasks(j.id);
  assert.equal(t.status, before, "unchanged by the claim");
  assert.notEqual(t.status, "done");
  assert.ok(h.logs.some((l) => l.event === "worker-done-claim" && l.taskId === t.id), "the claim is logged, not applied");
});

test("MGR-WALK-5c: BAD/GOOD/UNRELATED — only `engine` closes; a manager `done` is ignored too", async () => {
  for (const [from, closes] of [["engine", true], ["sr-backend", false], ["tech-lead", false]]) {
    const h = harness({ dispatch: scripted([{ ok: true, tasks: [{ title: "one", skillsRequired: ["api"], steps: ["s"] }] }]) });
    const j = h.jobs.create({ title: "t", brief: "b" });
    h.jobs.setStatus(j.id, "planned");
    await h.mgr.tick(j.id);
    const before = h.jobs.tasks(j.id)[0].status;
    h.inbox.push({ from, kind: "done", taskId: "task_1", changedPaths: ["src/lib/x.ts"], jobId: j.id });
    await h.mgr.tick(j.id);
    const after = h.jobs.tasks(j.id)[0].status;
    assert.equal(after, closes ? "done" : before, `from=${from}`);
  }
});

test("MGR-DONE-ID-1: a `done` for a RETRY attempt updates the job task's taskId to the attempt that succeeded", async () => {
  // Phase B · Task 4. CEO review C08 / Codex F07, reproduced: the done update at manager.mjs
  // omitted taskId, so after a transient failure + successful retry the job task still named
  // attempt_one — whose worktree engine.mjs had already removed — and review read an empty
  // diff, ship said "no worktree for task". Mutation proof (2026-09-17): `taskId: m.taskId ?? t.taskId` removed →
  //   ✖ MGR-DONE-ID-1  actual: 'attempt_one', expected: 'attempt_two'. Restored, md5 matched.
  const h = harness({ dispatch: scripted([{ ok: true, tasks: [{ title: "one", skillsRequired: ["api"], steps: ["s"] }] }]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  h.jobs.updateTask(h.jobs.tasks(j.id)[0].id, { taskId: "attempt_one", goalId: "goal_1", status: "queued" });
  h.inbox.push({ from: "engine", kind: "done", taskId: "attempt_two", goalId: "goal_1", changedPaths: ["src/lib/x.ts"], jobId: j.id });
  await h.mgr.tick(j.id);
  const [t] = h.jobs.tasks(j.id);
  assert.equal(t.status, "done");
  assert.equal(t.taskId, "attempt_two", "review and ship must read the attempt that actually produced the diff");
});

test("MGR-WALK-6: a `blocked` mail triggers a REPLAN, and the order is applied", async () => {
  const h = harness({ dispatch: scripted([
    { ok: true, tasks: [
      { title: "one", skillsRequired: ["api"], steps: ["s1"] },
      { title: "two", skillsRequired: ["test"], steps: ["s2"] },
    ] },
    { ok: true, action: "replan", reason: "schema first", order: [2, 1] },
  ]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  h.inbox.push({ from: "engine", kind: "blocked", taskId: "task_1", body: "need the other one first", jobId: j.id });
  const r = await h.mgr.tick(j.id);
  assert.equal(r.action, "replanned");
  assert.deepEqual(h.jobs.tasks(j.id).map((t) => t.title), ["two", "one"]);
  assert.equal(h.jobs.get(j.id).status, "building", "C30: a reordered job is ALREADY planned — it builds. The old assertion (back to `planned`) WAS the defect: the next tick re-ran the PLAN stage and replaced the rows this reorder had just preserved, orphaning their commits");
});

test("MGR-WALK-7: an `escalate` mints a gate and waits — it does not block the job", async () => {
  const h = harness({ dispatch: scripted([
    { ok: true, tasks: [{ title: "one", skillsRequired: ["api"], steps: ["s"] }] },
    { ok: true, action: "escalate", question: "which database?" },
  ]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  h.inbox.push({ from: "engine", kind: "blocked", taskId: "task_1", body: "cannot tell", jobId: j.id });
  const r = await h.mgr.tick(j.id);
  assert.equal(r.action, "escalated");
  assert.equal(h.jobs.get(j.id).status, "awaiting-you");
  assert.equal(h.gates.at(-1).body, "which database?");
});

test("MGR-GATE-1: approving the question gate moves the job to planned", async () => {
  const h = harness();
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "clarify");
  h.jobs.setStatus(j.id, "awaiting-you");
  assert.equal(h.mgr.onGateDecided(j.id, { decision: "approve" }).action, "planned");
  assert.equal(h.jobs.get(j.id).status, "planned");
});

test("MGR-GATE-2: rejecting the question gate BLOCKS with the note", async () => {
  const h = harness();
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "clarify");
  h.jobs.setStatus(j.id, "awaiting-you");
  h.mgr.onGateDecided(j.id, { decision: "reject", feedback: "not now" });
  assert.equal(h.jobs.get(j.id).status, "blocked");
  assert.match(h.jobs.get(j.id).blockedOn, /not now/);
});

test("MGR-8: a terminal job is never ticked again", async () => {
  const h = harness({ dispatch: async () => { throw new Error("dispatch must not be called"); } });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "blocked");
  assert.equal((await h.mgr.tick(j.id)).action, "none");
});

test("MGR-9: an unknown job id is a no-op, never a throw", async () => {
  assert.equal((await harness().mgr.tick("job_nope")).action, "none");
});

test("MGR-10: a dispatch that throws is treated as a dispatch error, not a crash", async () => {
  const h = harness({ dispatch: async () => { throw new Error("401 bad key"); } });
  const j = h.jobs.create({ title: "t", brief: "b" });
  assert.equal((await h.mgr.tick(j.id)).action, "blocked");
});

test("MGR-RECOVER-1: on boot, an awaiting-you job with NO pending gate and not shipped is blocked with a reason — a job with a gate is left alone", () => {
  // Phase B · Task 6. Codex F09, reproduced: ship failed after the yes; the job sat in
  // awaiting-you with nothing pending, exempt from the stall clock, skipped by the scheduler.
  // Mutation proof (2026-09-17): `if (gates.length) continue` → `=== -1` → ✖ MGR-RECOVER-1 actual: [both ids], expected: [stranded only] — the gated job was wrongly blocked. Restored, md5 matched.
  const gated = new Set();
  const h = harness({ deliveries: { mintGate: (g) => ({ id: "d1", ...g }), listGates: (jobId) => (gated.has(jobId) ? [{ id: "g1" }] : []) } });
  // distinct briefs: the store refuses an identical brief within 10 minutes (dedupe), which is not what this test is about
  const mk = (title) => { const j = h.jobs.create({ title, brief: `brief for ${title}` }); for (const st of ["planned", "building", "review", "awaiting-you"]) h.jobs.setStatus(j.id, st); return j; };
  const stranded = mk("stranded");
  const waiting = mk("waiting"); gated.add(waiting.id);
  const out = h.mgr.reconcileStranded();
  assert.deepEqual(out.blocked, [stranded.id]);
  assert.equal(h.jobs.get(stranded.id).status, "blocked");
  assert.match(String(h.jobs.get(stranded.id).blockedOn || ""), /no decision pending|ship failed after approval/i);
  assert.equal(h.jobs.get(waiting.id).status, "awaiting-you", "GOOD leg: a real pending gate is the human's turn");
});

test("MGR-RESUME-1: resume() moves a blocked job to planned; any other status is refused with 409", () => {
  // Phase B · Task 6. The store allowed blocked→planned (jobs.mjs:38) but no operator path called it.
  // Mutation proof (2026-09-17): status check → `=== "never"` → ✖ MGR-RESUME-1 actual: true, expected: false (409 leg). Restored, md5 matched.
  const h = harness();
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  // Phase F · 20: a job that got as far as `planned` has a CEO verdict; without one, resume sends
  // a never-planned job back to the CEO (REV-2). This test is about the ship-failure path.
  h.jobs.setSummary(j.id, { strategy: { verdict: "proceed", why: "w" } });
  const early = h.mgr.resume(j.id);
  assert.equal(early.ok, false); assert.equal(early.status, 409);
  h.jobs.setStatus(j.id, "blocked", "ship failed after approval — x");
  const r = h.mgr.resume(j.id);
  assert.equal(r.ok, true, r.reason);
  assert.equal(h.jobs.get(j.id).status, "planned");
  assert.equal(h.jobs.get(j.id).blockedOn, null, "the reason is cleared on resume");
  assert.equal(h.mgr.resume("job_nope").status, 404);
});

// ── G7 (2026-09-17) HIGH — a second question round must be answerable at EVERY site that mints one ──
// setQuestions() clears answers, but only the intake→clarify path called it; the three
// escalation sites minted a "question" gate directly, so round 2 hit 409 forever (addendum #11).
test("MGR-ANS-ROUND-1: an ESCALATE opens a new question round the BOSS can answer after round 1 was answered", async () => {
  // Mutation proof (2026-09-17): dropped `jobs.setQuestions(job.id,[q])` at the escalate site →
  // ✖ MGR-ANS-ROUND-1 ... the escalation IS the new round, on the job row (fail 1). Restored, md5 ok.
  const h = harness({ dispatch: scripted([
    { ok: true, tasks: [{ title: "one", skillsRequired: ["api"], steps: ["s"] }] },
    { ok: true, action: "escalate", question: "which database?" },
  ]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setQuestions(j.id, ["tz?"]); h.jobs.setAnswers(j.id, [{ q: "tz?", a: "UTC" }]); // round 1, answered
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  h.inbox.push({ from: "engine", kind: "blocked", taskId: "task_1", body: "cannot tell", jobId: j.id });
  assert.equal((await h.mgr.tick(j.id)).action, "escalated");
  assert.deepEqual(h.jobs.get(j.id).questions, ["which database?"], "the escalation IS the new round, on the job row");
  const as = h.jobs.setAnswers(j.id, [{ q: "which database?", a: "sqlite" }]); // must not 409
  assert.equal(as[0].a, "sqlite");
});

test("MGR-ANS-ROUND-2: a HIRE-FAILED gate opens a new question round too", async () => {
  // Mutation proof (2026-09-17): dropped setQuestions in onHireFailed → ✖ MGR-ANS-ROUND-2 (fail 1). Restored, md5 ok.
  const h = hireHarness();
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setQuestions(j.id, ["tz?"]); h.jobs.setAnswers(j.id, [{ q: "tz?", a: "UTC" }]);
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  h.inbox.push({ from: "hr", to: "tech-lead", kind: "hire-failed", jobId: j.id, body: JSON.stringify({ reason: "worker cap reached (20/20)" }) });
  await h.mgr.tick(j.id);
  assert.equal(h.jobs.get(j.id).status, "awaiting-you");
  assert.match(h.jobs.get(j.id).questions?.[0] ?? "", /could not hire/);
  assert.doesNotThrow(() => h.jobs.setAnswers(j.id, [{ q: "hire?", a: "drop the task" }]));
});

test("MGR-ANS-ROUND-3: a BLOCKED-WITH-NO-REPLAN gate opens a new question round too", async () => {
  // Mutation proof (2026-09-17): dropped setQuestions at the blocked-no-replan site → ✖ MGR-ANS-ROUND-3 (fail 1).
  // First attempt was VACUOUS — the 8-space anchor is a substring of the 10-space escalate line, so the patch
  // refused as non-unique (addendum #13). Re-anchored on the preceding `const q = ...` line. Restored, md5 ok.
  const h = harness({ dispatch: scripted([
    { ok: true, tasks: [{ title: "one", skillsRequired: ["api"], steps: ["s"] }] },
    { ok: true }, // manage turn with no action → blocked task, no replan → gate
  ]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setQuestions(j.id, ["tz?"]); h.jobs.setAnswers(j.id, [{ q: "tz?", a: "UTC" }]);
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  h.inbox.push({ from: "engine", kind: "blocked", taskId: "task_1", body: "cannot tell", jobId: j.id });
  const r = await h.mgr.tick(j.id);
  assert.equal(r.reason, "blocked with no replan", JSON.stringify(r));
  assert.match(h.jobs.get(j.id).questions?.[0] ?? "", /is blocked/);
  assert.doesNotThrow(() => h.jobs.setAnswers(j.id, [{ q: "blocked?", a: "skip it" }]));
});

test("MGR-RESUME-2: resume() refuses while any task is still live in the engine (queued) — re-planning would orphan the goal", async () => {
  // G7 (2026-09-17) MEDIUM: blocked→planned wipes tasks (setTasks) with no goal cancellation.
  // Safe after a ship failure (all tasks terminal); unsafe after a stall-block with a queued task.
  // Mutation proof (2026-09-17): dropped the `live.length` refusal → ✖ MGR-RESUME-2 (fail 1). Restored, md5 ok.
  const h = harness({ dispatch: scripted([{ ok: true, tasks: [{ title: "one", skillsRequired: ["api"], steps: ["s"] }] }]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned"); await h.mgr.tick(j.id); // one task queued in the engine
  h.jobs.setStatus(j.id, "blocked", "stalled");
  const r = h.mgr.resume(j.id);
  assert.equal(r.ok, false); assert.equal(r.status, 409); assert.match(r.reason, /still live/i);
  assert.equal(h.jobs.get(j.id).status, "blocked");
  h.jobs.updateTask(h.jobs.tasks(j.id)[0].id, { status: "blocked", blockedOn: "x" }); // now terminal
  assert.equal(h.mgr.resume(j.id).ok, true);
});

// ── Phase C · task 8 — A HIRE ANSWERS ONE REQUEST, NOT EVERY PARKED TASK ─────
// P-F13: onHireDone looped every awaiting-hire task and gave them ALL to whichever seat HR
// returned. Two parked tasks needing different skills both went to the first hire; the second
// hire never arrived because requestHire had already marked its key asked.
const twoHireHarness = () => harness({
  dispatch: async ({ stage }) => (stage === "plan"
    ? { ok: true, tasks: [
      { title: "wire the notifier", skillsRequired: ["notifications"], steps: ["add src/lib/alerts/send.ts"] },
      { title: "read the repo", skillsRequired: ["repo-read"], steps: ["add docs/notes.md"] },
    ] }
    : { ok: true, findings: [], needs: [] }),
});

test("HIRE-CORR-1: a hire-done for the notifications request assigns ONLY that task", async () => {
  // Mutation proof (2026-09-17): dropped `if (hiredFor !== null && key !== hiredFor) continue;` →
  // ✖ HIRE-CORR-1 (fail 1). The FIRST attempt at this proof reported fail 0 — see the scope note
  // below. Restored, md5 matched.
  const h = twoHireHarness();
  // The seat is scoped WIDE ENOUGH FOR BOTH tasks on purpose. The first version of this test
  // scoped it to src/lib/alerts/** only, so the repo-read task stayed parked because the SCOPE
  // check refused it — and the test passed with the correlation mutated out. Vacuous, exactly
  // addendum #22. With both paths reachable, only the correlation can keep the second task parked.
  h.roster.seats = { "hire-notif": { id: "hire-notif", writeScope: ["src/lib/alerts/**", "docs/**"] } };
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  const parked = h.jobs.tasks(j.id).filter((t) => t.status === "awaiting-hire");
  assert.equal(parked.length, 2, `both tasks should be parked: ${JSON.stringify(h.jobs.tasks(j.id).map((t) => [t.title, t.status]))}`);

  h.inbox.push({ from: "hr", to: "tech-lead", kind: "hire-done", jobId: j.id,
    body: JSON.stringify({ agentId: "hire-notif", skills: ["notifications"] }) });
  await h.mgr.tick(j.id);

  const byTitle = Object.fromEntries(h.jobs.tasks(j.id).map((t) => [t.title, t]));
  assert.equal(byTitle["wire the notifier"].seat, "hire-notif");
  assert.equal(byTitle["wire the notifier"].status, "queued");
  assert.equal(byTitle["read the repo"].seat, null, "the repo-read task was NOT what this hire answered");
  assert.equal(byTitle["read the repo"].status, "awaiting-hire");
  assert.equal(byTitle["read the repo"].blockedOn, null,
    "it is parked because this hire did not answer it — NOT because the scope refused it");
});

test("HIRE-CORR-2: a hire whose writeScope cannot reach the task's files is not assigned", async () => {
  // Mutation proof (2026-09-17): dropped the `unreachable.length` refusal → ✖ HIRE-CORR-2
  // (fail 1). Restored, md5 matched.
  const h = twoHireHarness();
  // HR returned a seat scoped to the WRONG tree — it can never write src/lib/alerts/send.ts.
  h.roster.seats = { "hire-notif": { id: "hire-notif", writeScope: ["docs/**"] } };
  const j = h.jobs.create({ title: "J", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  h.inbox.push({ from: "hr", to: "tech-lead", kind: "hire-done", jobId: j.id,
    body: JSON.stringify({ agentId: "hire-notif", skills: ["notifications"] }) });
  await h.mgr.tick(j.id);

  const t = h.jobs.tasks(j.id).find((x) => x.title === "wire the notifier");
  assert.equal(t.status, "awaiting-hire", "a seat that cannot reach the file must not take the task");
  assert.equal(t.seat, null);
  assert.match(String(t.blockedOn || ""), /scope/i, "the reason must say WHY, or this looks like a lost message");
});

test("SEQ-2: a re-plan reorders the UN-STARTED tasks and leaves finished work alone", async () => {
  // Phase C · task 9. `setTasks(..., { status: "planned" })` reset EVERY row, so a re-plan
  // after task A had already produced a commit sent A back to the queue — the commit stayed on
  // the branch and a second seat redid the same work on top of it.
  // Mutation proof (2026-09-17), two independent legs:
  //   replan back to `status: "planned"` for every row      → ✖ SEQ-2 (fail 1)
  //   setTasks back to hardcoded null/"[]" for the carried fields → ✖ SEQ-2 (fail 1)
  // Restored, md5 matched both times.
  const h = harness({ dispatch: scripted([
    { ok: true, tasks: [
      { title: "A", skillsRequired: ["api"], steps: ["add src/a.ts"] },
      { title: "B", skillsRequired: ["api"], steps: ["add src/b.ts"] },
    ] },
    { ok: true, action: "replan", order: [2, 1] },
  ]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);

  // A finishes and carries its commit; that dispatches B (sequential, Phase C · task 9).
  const [a] = h.jobs.tasks(j.id);
  h.jobs.updateTask(a.id, { changedPaths: ["src/a.ts"] });
  h.inbox.push({ from: "engine", kind: "done", taskId: a.taskId, jobId: j.id, body: "ok" });
  await h.mgr.tick(j.id);
  const b = h.jobs.tasks(j.id)[1];
  assert.equal(b.status, "queued", "B must be in flight before it can block");

  h.inbox.push({ from: "engine", kind: "blocked", taskId: b.taskId, body: "stuck", jobId: j.id });
  const r = await h.mgr.tick(j.id);
  assert.equal(r.action, "replanned", JSON.stringify(r));

  const after = Object.fromEntries(h.jobs.tasks(j.id).map((t) => [t.title, t]));
  assert.equal(after.A.status, "done", "A already produced a commit — a re-plan must not re-run it");
  assert.deepEqual(after.A.changedPaths, ["src/a.ts"], "and its changed paths must survive");
  // C30: the reorder now dispatches the un-started work itself instead of bouncing the job
  // through `planned`, so B is in flight rather than waiting for a tick that re-plans.
  assert.equal(after.B.status, "queued", "B is the un-started work the re-plan is actually for");
});

// ── Phase C · task 9 — SEQUENTIAL DISPATCH ──────────────────────────────────
// The root of probe P-F08 is manager.mjs's plan branch: it enqueued EVERY task at once, so
// every seat's worktree was cut from the same HEAD before any of them had produced anything.
// Ordering the plan ("if task B needs task A's file, A comes first") was advice the runtime
// then ignored. Ship-as-you-go means one task in flight at a time, each based on the last.
const seqHarness = (over = {}) => harness({
  dispatch: scripted([{ ok: true, tasks: [
    { title: "A", skillsRequired: ["api"], steps: ["add src/a.ts"] },
    { title: "B", skillsRequired: ["api"], steps: ["add src/b.ts"] },
  ] }]),
  ...over,
});

test("SEQ-3: only the FIRST task is dispatched at plan time", async () => {
  // Mutation proof (2026-09-18): plan branch restored to the fan-out loop → ✖ SEQ-3 and ✖ SEQ-4
  // (fail 2). Restored, md5 matched.
  const h = seqHarness();
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);

  const st = h.jobs.tasks(j.id).map((t) => [t.title, t.status]);
  assert.deepEqual(st, [["A", "queued"], ["B", "planned"]],
    `B must wait for A, not race it from the same HEAD: ${JSON.stringify(st)}`);
  assert.equal(h.enqueued.length, 1, "exactly one goal in flight");
});

test("SEQ-4: when A finishes it is COMMITTED and B is dispatched based on the job branch", async () => {
  // Mutation proof (2026-09-18): dropped `await commitOnDone(...)` → ✖ SEQ-4 and ✖ SEQ-5
  // (fail 2). Restored, md5 matched.
  const committed = [];
  const h = seqHarness({ pr: {
    createJobBranch: async (jobId) => ({ ok: true, branch: `ma/job/${jobId}`, worktree: "/tmp/jobwt" }),
    commitTask: async (a) => { committed.push(a.taskId); return { ok: true, sha: `sha${committed.length}`, refused: [], reason: "" }; },
    openJobPr: async () => ({ mode: "pr", prUrl: "u", reason: "" }),
  } });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);

  const a = h.jobs.tasks(j.id)[0];
  h.jobs.updateTask(a.id, { changedPaths: ["src/a.ts"] });
  h.inbox.push({ from: "engine", kind: "done", taskId: a.taskId, jobId: j.id, body: "ok" });
  await h.mgr.tick(j.id);

  assert.deepEqual(committed, [a.taskId], "A's work is committed as soon as it is done");
  const after = h.jobs.tasks(j.id);
  assert.equal(after[0].status, "done");
  assert.equal(after[1].status, "queued", "B is dispatched only now");
  const bGoal = h.enqueued.at(-1);
  assert.equal(bGoal.baseRef, `ma/job/${j.id}`,
    `B's worktree must be cut from the job branch tip, not HEAD: ${JSON.stringify(bGoal)}`);
});

test("SEQ-5: ship() opens the PR from the branch tip and does NOT re-commit what is already committed", async () => {
  // Mutation proof (2026-09-18): removed `if (already.has(t.taskId)) continue;` → ✖ SEQ-5 ALONE
  // (fail 1), which is what proves it is not redundant with SEQ-4. Restored, md5 matched.
  // With commit-on-done the commits already exist. Re-running commitTask would stage nothing,
  // return "nothing to commit", and BLOCK a job whose work is entirely present on the branch.
  const commitCalls = [];
  const h = seqHarness({ pr: {
    createJobBranch: async (jobId) => ({ ok: true, branch: `ma/job/${jobId}`, worktree: "/tmp/jobwt" }),
    commitTask: async (a) => { commitCalls.push(a.taskId); return { ok: true, sha: `sha${commitCalls.length}`, refused: [], reason: "" }; },
    openJobPr: async ({ branch }) => ({ mode: "pr", prUrl: `https://x/pr/1?b=${branch}`, reason: "" }),
  } });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);

  // Walk both tasks to done, each committing as it lands.
  for (let i = 0; i < 2; i++) {
    const t = h.jobs.tasks(j.id).find((x) => x.status === "queued");
    h.jobs.updateTask(t.id, { changedPaths: [`src/${t.title}.ts`] });
    h.inbox.push({ from: "engine", kind: "done", taskId: t.taskId, jobId: j.id, body: "ok" });
    await h.mgr.tick(j.id);
  }
  assert.equal(commitCalls.length, 2, `both tasks committed once each as they finished: ${JSON.stringify(commitCalls)}`);

  const out = await h.mgr.ship(j.id);
  assert.equal(out.ok, true, `ship must succeed on an already-assembled branch: ${JSON.stringify(out)}`);
  assert.equal(commitCalls.length, 2, "ship must NOT re-commit — the commits are already on the branch");
  assert.equal(h.jobs.get(j.id).status, "shipped");
  assert.equal(h.jobs.get(j.id).summary.ship.outcome, "pr");
});

// ── Phase C · task 10 — WHAT THE BOSS APPROVED IS WHAT SHIPS ────────────────
const treeHarness = (tree) => {
  let current = tree;
  const h = harness({
    dispatch: async ({ stage }) => (stage === "plan"
      ? { ok: true, tasks: [
        { title: "A", skillsRequired: ["api"], steps: ["add src/a.ts"] },
        { title: "B", skillsRequired: ["api"], steps: ["add src/b.ts"] },
      ] }
      : { ok: true, done: ["A", "B"], notDone: [], risk: "low", notes: "clean", filesChanged: 2, testsRun: 2 }),
    pr: {
      createJobBranch: async (jobId) => ({ ok: true, branch: `ma/job/${jobId}`, worktree: "/tmp/jobwt" }),
      commitTask: async () => ({ ok: true, sha: "sha1", refused: [], reason: "" }),
      openJobPr: async () => ({ mode: "pr", prUrl: "u", reason: "" }),
      treeOf: async () => current,
    },
  });
  return { h, moveTree: (t) => { current = t; } };
};

async function driveToApproval(h) {
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  for (let i = 0; i < 2; i++) {
    const t = h.jobs.tasks(j.id).find((x) => x.status === "queued");
    if (!t) break;
    h.jobs.updateTask(t.id, { changedPaths: [`src/${t.title}.ts`] });
    h.inbox.push({ from: "engine", kind: "done", taskId: t.taskId, jobId: j.id, body: "ok" });
    await h.mgr.tick(j.id);
  }
  return j;
}

test("DIFF-3 (BAD leg): ship REFUSES when the branch moved after the BOSS approved it", async () => {
  // Mutation proof (2026-09-18), two independent legs:
  //   never record the approved tree   → ✖ DIFF-3 BAD (fail 1)
  //   never compare it at ship         → ✖ DIFF-3 BAD (fail 1)
  // Restored, md5 matched both times. The GOOD leg stayed green throughout, which is what
  // shows the guard refuses a MOVED branch rather than refusing everything.
  const { h, moveTree } = treeHarness("tree_approved");
  const j = await driveToApproval(h);
  h.jobs.setStatus(j.id, "review");
  await h.mgr.tick(j.id);
  assert.equal(h.jobs.get(j.id).summary.ship.tree, "tree_approved",
    "the gate must record the tree the BOSS is looking at");

  moveTree("tree_someone_pushed_more");           // the branch changed between yes and ship
  const out = await h.mgr.ship(j.id);
  assert.equal(out.ok, false, `must refuse: ${JSON.stringify(out)}`);
  assert.match(out.reason, /moved|changed|approved/i);
  assert.equal(h.jobs.get(j.id).status, "blocked");
});

test("DIFF-3 (GOOD leg): an unchanged branch ships", async () => {
  const { h } = treeHarness("tree_approved");
  const j = await driveToApproval(h);
  h.jobs.setStatus(j.id, "review");
  await h.mgr.tick(j.id);
  const out = await h.mgr.ship(j.id);
  assert.equal(out.ok, true, `an untouched branch must still ship: ${JSON.stringify(out)}`);
  assert.equal(h.jobs.get(j.id).status, "shipped");
});

// ── C28 · a ROOT-LEVEL file is invisible to the path miner ──────────────────
// Live run 2: `repo-edit-engineer` was hired with writeScope ["src/lib/**"] for a task whose
// step was "In README.md, add a Helpers heading". Every attempt died
//   empty-diff — the agent wrote 1 path(s) OUTSIDE the appliable scope: README.md
// because stepPaths() only matches tokens containing a "/", so a root-level filename yields
// nothing, proposedWriteScope falls back to the skill-name guess, and HIRE-CORR-2's scope
// check has nothing to check. The broker DOES allow README.md (applyAllowed → true), so the
// two halves of the system disagreed about what a seat may touch.
test("STEPPATH-1: a root-level documentation file is seen", () => {
  // Mutation proof (2026-09-18): dropping the root-doc pass in stepPaths → ✖ STEPPATH-1 and
  // ✖ STEPPATH-4 (fail 2); dropping the root branch in proposedWriteScope → ✖ STEPPATH-4 alone
  // (fail 1). STEPPATH-2/3 stayed green throughout — the widening did not loosen the prose guard.
  assert.deepEqual(stepPaths(["In README.md, add a Helpers heading describing formatRelative"]), ["README.md"]);
  assert.deepEqual(stepPaths(["update CHANGELOG.md and src/lib/x.ts"]), ["CHANGELOG.md", "src/lib/x.ts"]);
});

test("STEPPATH-2: prose that merely contains a dot is NOT a path", () => {
  // The reason the original regex demanded a "/". Widening it naively turns "e.g." into a file.
  for (const prose of ["say e.g. three minutes ago", "roughly 3.5 seconds", "call formatRelative(ms)",
                       "it runs on node.js and deno", "the U.S. format"]) {
    assert.deepEqual(stepPaths([prose]), [], `prose became a path: ${prose}`);
  }
});

test("STEPPATH-3: a root-level file that is NOT documentation stays invisible", () => {
  // Granting a freshly-hired specialist write access to root config by way of a sentence in a
  // plan is a privilege escalation. Docs only; everything else still needs a directory.
  for (const s of ["edit package.json", "change tsconfig.json", "touch .env", "edit Makefile"]) {
    assert.deepEqual(stepPaths([s]), [], `root config became a path: ${s}`);
  }
});

test("STEPPATH-4: the proposed scope for a root doc is the FILE, not a directory glob", () => {
  assert.deepEqual(proposedWriteScope(["repo-edit"], ["In README.md, add a Helpers heading"]), ["README.md"]);
});

// ── C30 · a re-plan must not become a FRESH plan ────────────────────────────
// Live run 4: the branch carried two commits, `summary.ship.commits` recorded one, and the
// job's task titles matched neither. Cause: the reorder path at manager.mjs:669 carefully
// preserves rows (SEQ-2) and then sets the job back to `planned` — so the NEXT tick runs the
// PLAN stage from scratch, calls setTasks with brand-new rows, and throws the reorder away.
// With commit-as-you-go those discarded rows own real commits on `ma/job/<id>`, so the work is
// redone and ship() cannot account for it. Two plan-stage runs were logged in that job.
const replanHarness = (over = {}) => {
  const stages = [];
  const h = harness({
    dispatch: async ({ stage }) => {
      stages.push(stage);
      if (stage === "plan") {
        return { ok: true, tasks: [
          { title: "A", skillsRequired: ["api"], steps: ["add src/a.ts"] },
          { title: "B", skillsRequired: ["api"], steps: ["add src/b.ts"] },
        ] };
      }
      if (stage === "manage") return { ok: true, action: "replan", order: [2, 1] };
      return { ok: true, findings: [], needs: [] };
    },
    pr: {
      createJobBranch: async (jobId) => ({ ok: true, branch: `ma/job/${jobId}`, worktree: "/tmp/jobwt" }),
      commitTask: async () => ({ ok: true, sha: "sha1", refused: [], reason: "" }),
      openJobPr: async () => ({ mode: "pr", prUrl: "u", reason: "" }),
    },
    ...over,
  });
  return { h, stages };
};

test("C30-1: a re-plan dispatches the reordered work itself — it does NOT re-enter the PLAN stage", async () => {
  // Mutation proof (2026-09-19): reorder restored to `setStatus(planned)` — the original defect —
  // → ✖ C30-1 (fail 1). Restored, md5 matched.
  const { h, stages } = replanHarness();
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);                      // plan #1 + dispatch A
  const titlesBefore = h.jobs.tasks(j.id).map((t) => t.title);

  h.inbox.push({ from: "engine", kind: "blocked", taskId: h.jobs.tasks(j.id)[0].taskId, body: "stuck", jobId: j.id });
  await h.mgr.tick(j.id);                      // manage → replan (reorder)
  assert.equal(h.jobs.get(j.id).status, "building", "a reordered job is already planned — it must build, not re-plan");

  await h.mgr.tick(j.id);                      // the tick that used to re-plan from scratch
  assert.equal(stages.filter((x) => x === "plan").length, 1,
    `the PLAN stage must run ONCE for this job; ran ${stages.filter((x) => x === "plan").length}x`);
  assert.deepEqual(h.jobs.tasks(j.id).map((t) => t.title).sort(), titlesBefore.sort(),
    "the reordered rows must survive — new rows would orphan their commits");
});

test("C30-2: a job whose branch already has commits is BLOCKED rather than re-planned from scratch", async () => {
  // Mutation proof (2026-09-19): `if (committed.length)` → `if (false)` → ✖ C30-2 ALONE (fail 1),
  // which is what shows the guard is not redundant with C30-1's fix. Restored, md5 matched.
  // The belt to C30-1's braces: resume() and an approved gate ALSO set `planned`, and a fresh
  // plan there would orphan committed work just as silently.
  const { h } = replanHarness();
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  const t0 = h.jobs.tasks(j.id)[0];
  h.jobs.updateTask(t0.id, { changedPaths: ["src/a.ts"] });
  h.inbox.push({ from: "engine", kind: "done", taskId: t0.taskId, jobId: j.id, body: "ok" });
  await h.mgr.tick(j.id);                      // A commits onto the branch
  assert.ok((h.jobs.get(j.id).summary?.ship?.commits || []).length >= 1, "A is committed");

  h.jobs.setStatus(j.id, "planned");           // what resume()/approve do
  const r = await h.mgr.tick(j.id);
  assert.equal(h.jobs.get(j.id).status, "blocked", `must refuse: ${JSON.stringify(r)}`);
  assert.match(String(h.jobs.get(j.id).blockedOn || ""), /commit/i, "and say WHY, naming the committed work");
});

test("C30-3 (GOOD leg): a job with no commits still plans normally", async () => {
  const { h, stages } = replanHarness();
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  const r = await h.mgr.tick(j.id);
  assert.equal(r.action, "assigned", JSON.stringify(r));
  assert.equal(stages.filter((x) => x === "plan").length, 1);
  assert.equal(h.jobs.get(j.id).status, "building");
});

test("DIFF-WIRED-2: server.mjs forwards pr.treeOf to the Manager", () => {
  // Live run 5 shipped a gate with `"tree": null`. DIFF-3's tree pin is proven at the unit seam
  // — the tests inject `pr` with a treeOf — but server.mjs wires only createJobBranch/
  // commitTask/openJobPr, so `pr?.treeOf` is undefined in the running Manager and the pin is
  // INERT. Third occurrence of this shape (SEAT-12, SEQ-WIRED-1): proven everywhere except the
  // hop the server actually uses. Asserted on the AST, never on source text.
  // Mutation proof (2026-09-19): removed `treeOf` from the pr dep → ✖ DIFF-WIRED-2 (fail 1).
  // Restored, md5 matched.
  const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  let wired = false;
  (function walk(n) {
    if (!n || typeof n.type !== "string" || wired) return;
    if (n.type === "ObjectExpression") {
      const keys = n.properties.map((pr) => pr.key?.name);
      if (keys.includes("createJobBranch") && keys.includes("commitTask") && keys.includes("treeOf")) wired = true;
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  })(ast);
  assert.ok(wired, "the Manager's pr dep must carry treeOf beside the other ladder rungs, or DIFF-3 pins nothing");
});

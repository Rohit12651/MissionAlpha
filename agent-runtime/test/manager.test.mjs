// Phase 9 · task 9.2 — the Manager state machine. Zero I/O: every dependency injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../db.mjs";
import { createJobs } from "../jobs.mjs";
import { createManager, validatePlan, isStalled, classifyDispatchError, MAX_TRANSIENT_RETRIES, proposedWriteScope } from "../manager.mjs";

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
  const mgr = createManager({
    jobs, roster: ROSTER, catalog: CATALOG,
    mailbox: { read: () => inbox.splice(0, inbox.length), send: (m) => { sent.push(m); return { id: `m${sent.length}` }; } },
    enqueueGoal: (g) => { enqueued.push(g); return { goalId: `goal_${enqueued.length}`, firstTaskId: `task_${enqueued.length}` }; },
    deliveries: { mintGate: (g) => { const row = { id: `d${gates.length + 1}`, ...g }; gates.push(row); return row; }, listGates: () => [] },
    queue: { all: () => [] },
    clock: () => now,
    log: (r) => logs.push(r),
    ...over,
  });
  return { jobs, mgr, gates, enqueued, inbox, sent, logs, setNow: (v) => { now = v; }, nowRef: () => now };
}

// ── validatePlan ─────────────────────────────────────────────────────────────
test("MGR-PLAN-1: a good plan validates", () => {
  const v = validatePlan({ tasks: [{ title: "t", skillsRequired: ["api"], steps: ["do"] }] }, { catalog: CATALOG });
  assert.equal(v.ok, true);
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
  assert.equal(r.action, "planned");
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
  const h = harness({ dispatch: scripted([{ ok: true, findings: ["x exists"], needs: [] }]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  assert.equal((await h.mgr.tick(j.id)).action, "planned");
  assert.equal(h.gates.length, 0, "no question means no gate");
});

test("MGR-WALK-2: questions become ONE gate, not N", async () => {
  const h = harness({ dispatch: scripted([{ ok: true, findings: [], needs: ["a?", "b?", "c?"] }]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  await h.mgr.tick(j.id);                     // intake → clarify
  const r = await h.mgr.tick(j.id);           // clarify → one gate
  assert.equal(r.action, "asked");
  assert.equal(h.gates.length, 1, "one decision the BOSS makes in one sitting = one gate");
  assert.equal(h.gates[0].jobId, j.id, "and it is a JOB gate, not a story gate");
  assert.match(h.gates[0].body, /1\. a\?/);
});

test("MGR-WALK-3: plan assigns BY SKILL and enqueues one goal per task", async () => {
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
  assert.equal(h.enqueued.length, 2);
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
  assert.equal(h.jobs.get(j.id).status, "planned", "a replan goes back through planning, not straight to building");
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

// Phase D · C21 — READY-SET DISPATCH.
//
// Phase C closed probe P-F08 by making dispatch SEQUENTIAL: one task in flight, each worktree
// cut from the previous task's commit. Phase D needs two seats working at once, so the fix for
// one phase is the blocker for the next. The spec is
// docs/superpowers/specs/2026-09-19-ready-set-dispatch.md.
//
// THE FACT THE WHOLE DESIGN RESTS ON: `pr.commitTask` does not merge. It reads each approved
// path's BODY from the task worktree and writes it into the job's assembly worktree
// (pr.mjs:468,481,486). Two tasks on DISJOINT paths therefore commit cleanly in any order;
// two tasks on the SAME path silently revert each other, with no conflict marker, because
// there is no merge. So the rule guarantees parallel work cannot collide — it does not
// reconcile collisions after the fact. READY-7 (in pr-job-branch.test.mjs) is that claim run
// against a real git repo.
//
// A task is READY when: predecessors done, seat free, seat's writeScope disjoint from every
// in-flight task's. Disjointness is checked on the ENFORCED writeScope (guards.mjs:263), never
// on stepPaths() predictions — C28 proved a prediction can miss a file outright.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../db.mjs";
import { createJobs } from "../jobs.mjs";
import { createManager, validatePlan, scopesDisjoint } from "../manager.mjs";

const CATALOG = ["ui", "api", "db", "test", "notifications", "repo-read"];

function harness(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ma-ready-"));
  const db = openDb({ path: join(dir, "mission.db"), patchesDir: join(dir, "patches") });
  const jobs = createJobs({ db, scrub: (t) => t });
  const enqueued = [];
  const inbox = [];
  const logs = [];
  const roster = {
    match: (skills) => [
      { id: "sr-frontend", skills: ["ui"] },
      { id: "sr-backend", skills: ["api", "db"] },
      { id: "qa", skills: ["test"] },
    ].filter((s) => (skills || []).every((k) => s.skills.includes(k))),
    seats: {},
    get(id) { return this.seats[id] ?? null; },
  };
  const mgr = createManager({
    jobs, roster, catalog: CATALOG,
    mailbox: { read: () => inbox.splice(0, inbox.length), send: () => ({ id: "m1" }) },
    enqueueGoal: (g) => { enqueued.push(g); return { goalId: `goal_${enqueued.length}`, firstTaskId: `task_${enqueued.length}` }; },
    deliveries: { mintGate: (g) => ({ id: "d1", ...g }), listGates: () => [] },
    queue: { all: () => [] },
    clock: () => 1_000_000,
    log: (r) => logs.push(r),
    ...over,
  });
  return { jobs, mgr, roster, enqueued, inbox, logs, db };
}

const scripted = (replies) => { let i = 0; return async () => replies[Math.min(i++, replies.length - 1)]; };

/** Two tasks needing DIFFERENT skills, so the runtime assigns two different seats. */
const twoSeatPlan = (deps = {}) => scripted([{ ok: true, tasks: [
  { title: "A", skillsRequired: ["ui"], steps: ["add src/ui/a.ts"], ...(deps.a ? { dependsOn: deps.a } : {}) },
  { title: "B", skillsRequired: ["api"], steps: ["add docs/b.md"], ...(deps.b ? { dependsOn: deps.b } : {}) },
] }]);

/** Both seats declared as WORKERS — only a worker is narrowed by writeScope (guards.mjs). */
const seats = (h, frontend, backend) => {
  h.roster.seats = {
    "sr-frontend": { id: "sr-frontend", role: "worker", writeScope: frontend },
    "sr-backend": { id: "sr-backend", role: "worker", writeScope: backend },
  };
};

const statuses = (h, jobId) => h.jobs.tasks(jobId).map((t) => [t.title, t.status]);

async function planned(h) {
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  return j;
}

// ── the scope predicate ──────────────────────────────────────────────────────
test("READY-SCOPE-1: disjointness is decided on the literal prefix, and it is never wrong in the unsafe direction", () => {
  // SOUNDNESS, stated as the reason this cheap test is allowed to be the whole predicate:
  // if two globs both match some path P, then P starts with both of their literal prefixes,
  // so one prefix must be a prefix of the other. A prefix test can therefore say "collide"
  // when they would not have (conservative, costs parallelism) but can NEVER say "disjoint"
  // when they would (unsafe, costs the BOSS's work).
  assert.equal(scopesDisjoint(["src/ui/**"], ["docs/**"]), true);
  assert.equal(scopesDisjoint(["src/**"], ["src/lib/**"]), false, "one contains the other");
  assert.equal(scopesDisjoint(["src/lib/**"], ["src/lib/**"]), false, "identical scopes collide");
  assert.equal(scopesDisjoint(["**"], ["docs/**"]), false, "a `**` seat intersects everything");
  assert.equal(scopesDisjoint(["README.md"], ["docs/**"]), true, "a root file is its own scope (C28)");
  assert.equal(scopesDisjoint(["src/a*"], ["src/ab/**"]), false, "conservative: prefixes overlap even though the globs do not");
  // Unknown or empty is NOT disjoint. A seat whose scope the runtime cannot read must never
  // be assumed narrow — that is the direction that loses work.
  assert.equal(scopesDisjoint(null, ["docs/**"]), false);
  assert.equal(scopesDisjoint([], ["docs/**"]), false);
  assert.equal(scopesDisjoint(["docs/**"], undefined), false);
});

// ── dispatch ─────────────────────────────────────────────────────────────────
test("READY-1: two tasks with no dependency and DISJOINT scopes are both dispatched on one tick", async () => {
  const h = harness({ dispatch: twoSeatPlan() });
  seats(h, ["src/ui/**"], ["docs/**"]);
  const j = await planned(h);

  assert.deepEqual(statuses(h, j.id), [["A", "queued"], ["B", "queued"]],
    "nothing stops these two from running at once — that is the whole of Phase D step 14");
  assert.equal(h.enqueued.length, 2, "two goals, one tick");
  assert.notEqual(h.enqueued[0].agentId, h.enqueued[1].agentId, "two seats, not one seat twice");
});

test("READY-2: two tasks with OVERLAPPING scopes never run together — the second waits", async () => {
  const h = harness({ dispatch: twoSeatPlan() });
  seats(h, ["src/**"], ["src/lib/**"]); // sr-backend's scope is inside sr-frontend's
  const j = await planned(h);

  assert.deepEqual(statuses(h, j.id), [["A", "queued"], ["B", "planned"]],
    "commitTask copies bodies and never merges, so two seats on one tree silently revert each other");
  assert.equal(h.enqueued.length, 1);

  // And it SAYS so. A task parked for a scope collision is indistinguishable from one waiting
  // on a dependency, and from one the dispatcher simply forgot — which is the position the
  // Phase C live run left us in when a task sat in `claimed` for 16 minutes with no trace.
  const why = h.logs.filter((e) => e.event === "task-waiting");
  assert.equal(why.length, 1, `exactly one task was held back: ${JSON.stringify(why)}`);
  assert.equal(why[0].why, "scope");
  assert.equal(why[0].seat, "sr-backend", "and names the seat, so the scope can be looked up");
});

test("READY-3: a declared dependency holds a task back even when the scopes are disjoint", async () => {
  const h = harness({ dispatch: twoSeatPlan({ b: [1] }) });
  seats(h, ["src/ui/**"], ["docs/**"]);
  const j = await planned(h);

  assert.deepEqual(statuses(h, j.id), [["A", "queued"], ["B", "planned"]],
    "B needs A's file: disjointness permits parallelism, the graph forbids it");
  assert.equal(h.logs.find((e) => e.event === "task-waiting")?.why, "deps",
    "the trace must distinguish a dependency hold from a scope hold");

  const a = h.jobs.tasks(j.id)[0];
  h.jobs.updateTask(a.id, { changedPaths: ["src/ui/a.ts"] });
  h.inbox.push({ from: "engine", kind: "done", taskId: a.taskId, jobId: j.id, body: "ok" });
  await h.mgr.tick(j.id);

  assert.deepEqual(statuses(h, j.id), [["A", "done"], ["B", "queued"]], "and released the moment A is done");
});

test("READY-6 (GOOD leg): with no declared scopes the runtime is EXACTLY as sequential as Phase C left it", async () => {
  // The default must be Phase C's behaviour, not a new one. A roster that declares no worker
  // scope — every unit harness, and any install whose roster predates this — reads as
  // "unknown", and unknown is a collision. Parallelism happens only where it is PROVEN safe.
  const h = harness({ dispatch: twoSeatPlan() });
  h.roster.seats = {}; // roster.get returns null for both seats
  const j = await planned(h);
  assert.deepEqual(statuses(h, j.id), [["A", "queued"], ["B", "planned"]]);

  // And a seat that is not a `worker` keeps the legacy allow-set (guards.mjs applyAllowed only
  // narrows workers), so its declared scope is not a narrowing and must not buy parallelism.
  const h2 = harness({ dispatch: twoSeatPlan() });
  h2.roster.seats = {
    "sr-frontend": { id: "sr-frontend", role: "station", writeScope: ["src/ui/**"] },
    "sr-backend": { id: "sr-backend", role: "worker", writeScope: ["docs/**"] },
  };
  const j2 = await planned(h2);
  assert.deepEqual(statuses(h2, j2.id), [["A", "queued"], ["B", "planned"]],
    "a station seat writes anything the floor allows — treating its writeScope as a bound is a lie");
});

// ── the graph is validated before a single goal is enqueued ──────────────────
test("READY-4: a cyclic dependsOn is refused, and the error names the cycle", () => {
  const v = validatePlan({ tasks: [
    { title: "A", skillsRequired: ["api"], steps: ["s"], dependsOn: [2] },
    { title: "B", skillsRequired: ["api"], steps: ["s"], dependsOn: [1] },
  ] }, { catalog: CATALOG });
  assert.equal(v.ok, false, "a cycle is a job that can never dispatch anything");
  assert.match(v.error, /cycle/i);
  assert.match(v.error, /1/);
  assert.match(v.error, /2/);

  const self = validatePlan({ tasks: [
    { title: "A", skillsRequired: ["api"], steps: ["s"], dependsOn: [1] },
  ] }, { catalog: CATALOG });
  assert.equal(self.ok, false, "a task that depends on itself is the one-node cycle");
});

test("READY-5: a dependsOn naming a task that does not exist is refused", () => {
  const v = validatePlan({ tasks: [
    { title: "A", skillsRequired: ["api"], steps: ["s"], dependsOn: [7] },
  ] }, { catalog: CATALOG });
  assert.equal(v.ok, false);
  assert.match(v.error, /does not exist/i);
  for (const bad of ["two", 0, -1, 1.5, null, {}]) {
    assert.equal(validatePlan({ tasks: [
      { title: "A", skillsRequired: ["api"], steps: ["s"] },
      { title: "B", skillsRequired: ["api"], steps: ["s"], dependsOn: [bad] },
    ] }, { catalog: CATALOG }).ok, false, `dependsOn accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(validatePlan({ tasks: [
    { title: "A", skillsRequired: ["api"], steps: ["s"], dependsOn: "1,2" },
  ] }, { catalog: CATALOG }).ok, false, "dependsOn must be an array");
  // GOOD leg: absent and empty are both fine, and mean the same thing.
  assert.equal(validatePlan({ tasks: [{ title: "A", skillsRequired: ["api"], steps: ["s"] }] }, { catalog: CATALOG }).ok, true);
  assert.equal(validatePlan({ tasks: [{ title: "A", skillsRequired: ["api"], steps: ["s"], dependsOn: [] }] }, { catalog: CATALOG }).ok, true);
});

// ── the store: a dependency must survive the thing that renumbers tasks ──────
test("READY-STORE-1: dependsOn is stored as ROW IDS, so a re-plan reorder cannot dangle it", () => {
  // The trap this exists for: the planner declares dependencies as task NUMBERS, and a re-plan
  // REORDERS the rows. Keeping numbers would silently repoint every dependency at whatever
  // task landed in that position — a graph that validates and means something else.
  const dir = mkdtempSync(join(tmpdir(), "ma-readystore-"));
  const db = openDb({ path: join(dir, "mission.db"), patchesDir: join(dir, "patches") });
  const jobs = createJobs({ db, scrub: (t) => t });
  const j = jobs.create({ title: "t", brief: "b" });

  const first = jobs.setTasks(j.id, [
    { title: "A", steps: ["s"] },
    { title: "B", steps: ["s"], dependsOn: [1] },
  ]);
  assert.deepEqual(first[0].dependsOn, [], "A depends on nothing");
  assert.deepEqual(first[1].dependsOn, [first[0].id], "the index became A's row id");

  // Now re-plan: the same two tasks, order swapped, carrying the ids they already hold.
  const after = jobs.setTasks(j.id, [{ ...first[1] }, { ...first[0] }]);
  const a = after.find((t) => t.title === "A");
  const b = after.find((t) => t.title === "B");
  assert.deepEqual(b.dependsOn, [a.id], "B still depends on A, not on whatever is now first");
  assert.notEqual(a.id, first[0].id, "the rows really were re-minted — this is not a no-op");
});

test("READY-ROSTER-1: measured against the SEED roster, no two seed worker seats can parallelise", () => {
  // Honest scope of what Phase D step 14 bought, measured rather than asserted in prose.
  // sr-frontend owns `src/**` and sr-backend owns `src/lib/**`, which is inside it; qa owns
  // `**/*.test.*`, whose literal prefix is empty and therefore intersects everything. So the
  // ready-set rule changes NOTHING for the three seats that ship in roster.json — the gain is
  // for HIRED seats, whose scope proposedWriteScope derives narrowly from the task's own steps.
  //
  // This test is here so the fact cannot rot: narrow sr-frontend off `src/**` and it goes red,
  // which is the moment someone should notice that seed seats just became concurrent.
  const seed = JSON.parse(readFileSync(new URL("../roster.json", import.meta.url), "utf8"));
  const workers = (seed.members ?? seed).filter((m) => m.role === "worker");
  assert.ok(workers.length >= 3, `the seed roster should carry the three worker seats: ${workers.map((w) => w.id)}`);
  for (const a of workers) {
    for (const b of workers) {
      if (a.id >= b.id) continue;
      assert.equal(scopesDisjoint(a.writeScope, b.writeScope), false,
        `${a.id} and ${b.id} now parallelise — that is a real behaviour change, not a config tweak`);
    }
  }
  // GOOD leg: a narrowly-scoped hire, which is the case this feature actually serves.
  const hire = ["docs/**"];
  assert.equal(scopesDisjoint(workers.find((w) => w.id === "sr-frontend").writeScope, hire), true,
    "a hire scoped away from src/ must be able to run beside the frontend seat");
});

test("READY-SEAT-1: ONE seat never holds two tasks at once — the scope rule subsumes the seat rule", () => {
  // Why this test exists rather than a `busySeats` branch in the dispatcher: the branch was
  // written, and a mutation that deleted it reddened NOTHING. A scope is never disjoint from
  // itself, so the scope check already refuses a seat its own second task, and an unreachable
  // guard is not a guard (addendum #5). The property the dispatcher now leans on is asserted
  // here directly — every scope shape in this repo, compared against itself.
  for (const shape of [["src/**"], ["src/lib/**", "agent-runtime/**"], ["**/*.test.*"], ["README.md"], ["docs/**"], ["**"], [], null, undefined]) {
    assert.equal(scopesDisjoint(shape, shape), false,
      `${JSON.stringify(shape)} is disjoint from itself — a seat could now be handed two worktrees at once`);
  }
});

test("READY-SEAT-2: two tasks needing the SAME skill go one at a time, and the trace says why", async () => {
  // The end-to-end half of READY-SEAT-1, through the real dispatcher: both tasks match
  // sr-backend, which holds a declared worker scope, so the second is held on `scope`.
  const h = harness({ dispatch: scripted([{ ok: true, tasks: [
    { title: "A", skillsRequired: ["api"], steps: ["add src/lib/a.ts"] },
    { title: "B", skillsRequired: ["api"], steps: ["add src/lib/b.ts"] },
  ] }]) });
  seats(h, ["src/ui/**"], ["src/lib/**"]);
  const j = await planned(h);
  assert.deepEqual(statuses(h, j.id), [["A", "queued"], ["B", "planned"]]);
  assert.equal(h.enqueued.length, 1, "one seat, one worktree, one task at a time");
  assert.equal(h.logs.find((e) => e.event === "task-waiting")?.why, "scope");
});

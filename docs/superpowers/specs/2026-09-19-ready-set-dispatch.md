# Ready-set dispatch — spec (C21)

**Status:** spec only. Nothing implemented. Written 2026-09-19, before Phase D opens.

## The problem, stated honestly

Phase C closed probe P-F08 by making dispatch **sequential**: one task in flight, each worktree
cut from the previous task's commit on `ma/job/<id>`. That is what made "if task B needs task
A's file, A comes first" true of the runtime instead of only of the prompt.

Phase D is "a team that talks" — two workers collaborating. Sequential dispatch makes that
impossible by construction. The fix for one phase is the blocker for the next, which is why
this is a spec and not a patch.

## What the ladder already does, and why it matters

`pr.mjs commitTask` does **not** merge. For each approved path it reads the file BODY from the
task worktree and writes it into the job's assembly worktree, then `git add -- <paths>` and
commits there (`pr.mjs:468,481,486`).

The consequence decides this design: **two tasks that touch disjoint paths can both commit
cleanly, in any order, with no merge and no rebase.** Two tasks that touch the SAME path cannot
— the later commit copies a body computed from a tree that never saw the earlier change, and
silently reverts it. There is no conflict marker, because there is no merge.

So the question is not "how do we merge parallel work" but "how do we guarantee parallel work
cannot collide".

## The rule

A task is **ready** when all three hold:

1. **Predecessors done.** Every task it depends on has `status === "done"`.
2. **Seat free.** Its seat has no other task in flight (the per-agent cap already exists in
   `queue.claimNext`).
3. **Scope disjoint.** Its seat's `writeScope` does not intersect the `writeScope` of any
   task currently in flight.

Dispatch every ready task, not just the first. When a task finishes, recompute.

### Why scope, not predicted paths

`stepPaths()` predicts what a task will touch from the words in its step. That is a guess, and
C28 showed it misses things (a root-level filename was invisible to it). `writeScope` is
different: it is **enforced** by `applyAllowed` → `matchesWriteScope` (`guards.mjs:263`), so a
seat physically cannot write outside it. Disjointness of an enforced boundary is a guarantee;
disjointness of a prediction is a hope.

Cost: this is conservative. Two tasks scoped `src/lib/**` never run in parallel even when they
would have touched different files. That is the correct direction to be wrong in.

### Dependencies have to be declared

`job_tasks` has no dependency column today — only `seq`, the plan order. Two options:

- **(a) `seq` means dependency.** Task N depends on tasks 1..N-1. Zero schema change, and it is
  what the prompt already asks the planner for ("be ordered: if task B needs task A's file, A
  comes first"). But it forbids ALL parallelism, since every task depends on every earlier one.
- **(b) The planner declares `dependsOn: []`.** A real dependency graph. Needs a schema column,
  a prompt change (which re-opens the `APPROVED-BY` gate in `manager-prompts.mjs`), and
  validation that the graph is acyclic and references real tasks.

**(b) is the only one that delivers Phase D.** (a) is the status quo with extra words.

## Base commit for a parallel task

Each ready task is cut from the job branch tip **at the moment it is dispatched**. Tasks
dispatched together share a base; a task dispatched later sees its predecessors' commits.

This is safe *only because* of the disjointness rule. A parallel task's base may go stale while
it works — another task commits — but the staleness cannot touch its own paths, and `commitTask`
copies bodies per path rather than merging trees.

## What this does NOT solve

- **Two tasks that must share a file.** They are dependency-ordered; that is what the graph is
  for. The rule refuses parallelism, it does not enable collision.
- **A seat whose writeScope is `**`.** It intersects everything and can never run in parallel.
  Correct, and worth surfacing to the planner as a reason to scope hires narrowly.
- **C30's guard.** A job with commits still refuses a fresh plan. Unchanged.
- **Cross-task communication.** Phase D's actual USP (frontend asks backend, backend answers)
  is the mailbox, already built in Phase 8. This spec only lets two seats run at once; it does
  not make them talk.

## Test plan (red first, each mutation-proven)

| Test | Claim |
|---|---|
| `READY-1` | two tasks, no deps, disjoint scopes → BOTH dispatched on one tick |
| `READY-2` | two tasks, no deps, OVERLAPPING scopes → only one in flight; the second waits |
| `READY-3` | B depends on A → B is not dispatched until A is `done`, even with disjoint scopes |
| `READY-4` | a cyclic `dependsOn` is refused by `validatePlan`, naming the cycle |
| `READY-5` | `dependsOn` naming a task that does not exist is refused |
| `READY-6` (GOOD) | the sequential case still behaves exactly as Phase C left it |
| `READY-7` | two parallel tasks both commit; the branch carries both, neither reverts the other |

`READY-7` is the one that matters — it is the claim the whole design rests on, and it must run
against a real git repo, not a mock ladder.

## Open question for the BOSS

Adding `dependsOn` to the plan prompt is a material edit to `manager-prompts.mjs`, which
re-opens its `APPROVED-BY` gate (the header reverts to `_PENDING BOSS_` and `MP-GATE` enforces
it). That is a review you will have to do before any live run of Phase D.

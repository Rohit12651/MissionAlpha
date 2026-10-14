# Phase C live run — findings (2026-09-18)

Target: `/tmp/ma-trial` (clone of MissionAlpha @ 85796ae, **origin removed** so nothing can
push into the operator's repo). Runtime: local working tree (all Phase A/B/C fixes, uncommitted).
Every durable root on `/tmp/ma-run`. `RUNTIME_BACKEND=cli`, `RUNTIME_MANAGER_DISPATCH=claude`.

## What WORKED, live, with a real model

| Claim | Evidence |
|---|---|
| Intake reads the actual repo before planning | The Manager found an existing `src/lib/formatRelative.ts` that the brief did not mention |
| It asks rather than guesses | It refused to create a second same-named function and asked which the BOSS wanted |
| An answer re-plans the job | BOSS said "reuse the existing helper"; the plan came back as "extend formatRelative", not "create relativeTime.ts" |
| Plan assigns BY SKILL | sr-backend / qa chosen by the runtime; the model never named a seat |
| An unstaffed skill HIRES | `hr-hired repo-edit-engineer skills=[repo-edit] writeScope=[src/lib/**]` — live, unprompted |
| **Task 7 — one step per task** | All three planned tasks carried exactly one step |
| **Task 9 — sequential dispatch** | `task-dispatched … baseRef` fired once per task, not three at once |
| **Task 8 — hire correlation** | `hire-assigned` named ONE task, not every parked one |
| Replans are bounded | `replans: 1`, capped — no infinite blocked→replan loop |

## Defects the live run found that the suite could not

**L1 — the engine refuses to run with no active account, and nothing surfaces it as a job-level
problem.** Every worker task died `{"kind":"not-capable","msg":"no active account …"}`. The job
showed only `task … failed: terminal failure`; the BOSS-visible reason never named the account.
Fixed for the run by adding a `subscription` account (stores no secret). The DEFECT is that a
config precondition the operator can fix reads as an opaque task failure. This is the "account
blocker" already named in HEAD's commit message — now reproduced end to end.

**L2 — `RUNTIME_TOOLS` defaults to `none`, which makes every worker fail terminally.** A runtime
booted without it looks healthy (`/runtime/health` returns ok:true) and plans jobs happily; the
workers simply cannot write. Boot says `tools=none` and nothing else complains.

**L3 — the Manager's own worktree branch accumulates commits and can then never be recreated.**
`worktree: branch ma/task/mgr_job_<id> holds commits not in the base (…) — refusing to delete it`
fired 5+ times. The stale-branch guard (#6) is correct in isolation: it refuses to `branch -D` a
ref carrying unlanded commits. But the Manager's OWN scratch worktree gets a snapshot-base commit,
so on the next manage turn the guard refuses, and every later manage turn runs WITHOUT a worktree
— degraded (exit 0) but blind to the repo. Deleting the branches by hand let it recreate them, and
it re-accumulated within one tick.

**L4 — a state-machine violation reachable from the live loop.**
`manager tick failed for job_…: a job in 'planned' cannot go to 'awaiting-you'`. Reached after a
replan set the job back to `planned` while a path that mints a question gate then set
`awaiting-you`. Once, not fatal, but it is an unhandled transition in the live loop.

**L5 — a claimed task can stall forever with no process and no watchdog.** The run ended here.
`task_701a2f542692` (seat `repo-edit-engineer`) was claimed at 23:19:22, reached `EDITING` at
23:19:24 — and then nothing for 16 minutes. Evidence:

    status: claimed · engineState: EDITING · leaseUntil: None
    no worker `claude` process alive
    0 spawn/worker lines in the server log
    0 files written in the task worktree (only the by-design .claude/ strip)
    engine health: inflight 1, queued 1 — the slot is leaked

`RUNTIME_STEP_TIMEOUT_MS` defaults to 300_000, so the step watchdog should have reclaimed it at
5 minutes. It never fired. `leaseUntil: None` is the likely reason — nothing to expire. The job
was eventually blocked by the MANAGER's stall clock (`no progress for 957s`,
`DEFAULT_STALL_MS` = 900_000), which is a 15-minute backstop for a 5-minute failure.

Two distinct bugs in one symptom: the dispatch produced no process and reported no error, and
nothing reclaimed the claim.

## Not reached

`shipped`. No PR, no ship gate, no BOSS yes. **The Phase C exit criterion is NOT met.**
13 manager turns were spent; every one of them succeeded. Not one worker turn ran.

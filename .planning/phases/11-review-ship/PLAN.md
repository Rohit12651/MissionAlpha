---
phase: 11
name: Review + ship
requirements: [M2-REVIEW, M2-SUMMARY, M2-JOBGATE, M2-SHIP]
depends_on: [9]
files_modified:
  - agent-runtime/manager.mjs + manager-prompts.mjs (review + ship steps)
  - agent-runtime/deliveries.mjs + db.mjs (KINDS/GATE_KINDS += `job-approval`; CHECK migration)
  - agent-runtime/risk.mjs (job-approval → high band, typed-confirm)
  - agent-runtime/pr.mjs (CORE_GUARD — `ma/job/<id>` branch, one commit per task, `gh pr create`)
  - agent-runtime/broker.mjs (applyChanges(taskId, paths) resolves seat via seatFor — 7.2)
  - src/components/inbox/JobApprovalCard.tsx (new) + inbox wiring
  - agent-runtime/test/{manager-review,job-approval,manager-ship,pr-job-branch}.test.mjs
autonomous: true
waves: {1: [11.0, 11.1, 11.2], 2: [11.3], 3: [11.4, 11.5]}
checkpoints: [11.0]  # pr.mjs is CORE_GUARD — BOSS OK before edit
commit_policy: NO COMMITS by the agent; the runtime's own commits on ma/job/* are exempt exactly as ma/task/* are
---

<objective>
When every task is held, the Manager reads all the diffs and the gate results, writes ONE
summary, and mints ONE job-approval gate. BOSS says yes once. The runtime applies each task's
own changed paths AS THAT TASK'S WORKER SEAT (never as Manager), commits per task on
`ma/job/<id>`, opens the PR with the summary, and marks the Job shipped.
</objective>

<skills mandatory="true">
- security-review — apply must use only `task.changedPaths` from 6.2; PR body scrubbed; pr.mjs is CORE_GUARD and gains a new outbound (push/PR) path
- sp-test-driven-development · sp-verification-before-completion · code-reviewer · /qa /review
</skills>

<tasks>
<task id="11.0" name="BOSS gate — pr.mjs (CORE_GUARD) edit plan (BLOCKING)">
Files: .planning/phases/11-review-ship/PR-LADDER-EDITS.md (new).
Action: name the exact functions added to pr.mjs (`createJobBranch(jobId, baseSha)`, `commitTask(branch, worktree, paths, message)`, `openPr(branch, title, body)`), the guards each runs (secret-scrub on body, branch name allow-list, no force-push, never touches the operator's index — D3 content-hash assertion reused), and the fallback when `gh` is absent (branch only, reported). BOSS approves in header.
Done when: APPROVED in header.
</task>
<task id="11.1" name="Manager review turn" tdd="true">
Files: agent-runtime/manager.mjs, manager-prompts.mjs, test/manager-review.test.mjs.
Action: when all job tasks ∈ {HELD, DONE}: review prompt receives per task `changedPaths` + diff (fenced DATA, ≤ 60 KB total) + the result of RE-RUNNING the scoped test gate in the jail for that task (spec §3.1 step 6 — re-run, not the recorded tail); output `{done[], notDone[], risk: low|medium|high, notes ≤ 1200 chars, filesChanged, testsRun}` validated/bounded. Job → `review` → mint `job-approval` → `awaiting-you`.
Verify: fixture with one failed task → notDone lists it; risk propagated; malformed reply → `ok:false` → Job blocked.
Done when: green.
</task>
<task id="11.2" name="job-approval gate kind + card" tdd="true">
Files: deliveries.mjs, db.mjs (CHECK migration adds `job-approval`), risk.mjs, src/components/inbox/JobApprovalCard.tsx, src/lib/inboxClient.ts, test/job-approval.test.mjs, src/lib/__tests__/inboxClient.test.ts.
Action: new GATE kind, diff-less, high band, typed-confirm `APPLY`; card shows summary, per-task file list, tests run, risk. Approve → `manager.ship(jobId)`; Reject with note → Job `blocked`, note stored as the Manager's next input (re-plan on resume).
Verify: HTTP: approve advances to ship; reject stores note and blocks; card unit + visual snapshot.
Done when: green.
</task>
<task id="11.3" name="Ship: apply as the worker, commit per task, PR" tdd="true">
Files: manager.mjs, pr.mjs, broker.mjs, test/manager-ship.test.mjs, test/pr-job-branch.test.mjs.
Action: for each task in plan order: `broker.applyChanges(taskId, task.changedPaths)` (existing name) — seat resolved by `seatFor(taskId)` (7.2) so writeScope is the WORKER's; then `commitTask` on `ma/job/<jobId>` (base = the job's snapshot sha); after all: `openPr` when `gh` is present (title = job.title, body = scrubbed summary), else record branch. Job → `shipped`, `prUrl`, `job.changed`. Operator index content-hash asserted unchanged before/after.
Verify: deterministic spawner + deterministic Manager: 2 tasks → 2 commits on one branch, `git show --stat` per commit == that task's changedPaths; operator index hash unchanged; with `gh` stubbed absent → branch only + honest report.
Done when: live: a pasted job ships as a branch (PR once `gh` is installed — 14.0); STATE.md records branch + commit shas.
</task>
<task id="11.4" name="Live proof">
Action: paste → questions → answer → build → summary in Inbox → typed APPLY → shipped; record job id, branch, commits, prUrl/absent.
Done when: recorded.
</task>
<task id="11.5" name="Phase gate">
Action: contract BEFORE and AFTER; PES report.
Done when: numbers in STATE.md.
</task>
</tasks>

<must_haves>
- Exactly one decision from BOSS per job
- Applied paths == union of tasks' changedPaths, applied under each worker's writeScope
- Operator index hash unchanged across ship
- Job reaches `shipped` on the running install
</must_haves>

<threat_model>
- NEW outbound write path: `git commit` on `ma/job/*` and `gh pr create`. Mitigations: branch name allow-list `^ma/job/[a-z0-9_]+$`, no force, no push to any other ref, D3 index-hash assertion, body scrubbed by secret-scrub.mjs, `gh` invoked as argv (no shell).
- Summary is agent-authored → scrubbed and bounded.
- Apply reuses the broker + all guards; seat is the task's worker, never Manager.
</threat_model>

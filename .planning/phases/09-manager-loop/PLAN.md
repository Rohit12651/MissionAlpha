---
phase: 9
name: Manager loop
requirements: [M2-JOB, M2-JOBGATE-Q, M2-INTAKE, M2-CLARIFY, M2-PLAN, M2-ASSIGN, M2-MANAGE, M2-JOBCLOCK, M2-CANNED-MGR]
depends_on: [8]
files_modified:
  - agent-runtime/db.mjs (migration: jobs incl. source + externalKey (unique index), job_tasks; deliveries.jobId column)
  - agent-runtime/jobs.mjs (new; store, closed transitions, emits job.changed)
  - agent-runtime/deliveries.mjs (mintGate accepts {jobId} XOR {storyId}; decide() onDecided routes by owner)
  - agent-runtime/manager.mjs (new; pure state machine + job-level stall/retry, injected clock)
  - agent-runtime/manager-prompts.mjs (new; intake/clarify/plan/manage prompt builders)
  - agent-runtime/manager-dispatch.mjs (new; live claude dispatch + RUNTIME_MANAGER_DISPATCH=deterministic canned dispatcher)
  - agent-runtime/server.mjs (routes: POST/GET /runtime/jobs, GET /runtime/jobs/:id, POST /runtime/jobs/:id/answer; heartbeat → manager.tick; `onTerminalFailure` → `blocked` mail; `onDone`/HELD → `done` mail)
  - agent-runtime/test/{jobs,job-gate,manager,manager-clock,manager-dispatch-http}.test.mjs
autonomous: true
waves: {1: [9.0, 9.1, 9.2], 2: [9.3, 9.4, 9.5], 3: [9.6, 9.7]}
checkpoints: [9.0]  # BOSS reads the Manager prompts before they run live
commit_policy: NO COMMITS until BOSS says
---

<objective>
The product. A Manager that takes a Job in plain words, reads the repo, asks once, writes the
task list, assigns by skill from the roster (HR if none — Phase 10), enqueues, and manages
blockers until every task is done or held. Runs as a real `claude -p` session with read-only
tools on a read-only checkout; never writes code. A Job is NOT a Story: it has its own gate
slot, its own answer route, its own stall clock and retry budget.
</objective>

<skills mandatory="true">
- sp-test-driven-development · sp-verification-before-completion · code-reviewer · /review /qa
- security-review — Manager output (tasks, questions) is agent-authored: validated, scrubbed, bounded; Manager Bash is a read-only allowlist
- context7 — claude CLI flags (--allowed-tools, --append-system-prompt, --max-turns, --setting-sources)
</skills>

<tasks>

<task id="9.0" name="BOSS gate — Manager prompts (BLOCKING)">
Files: agent-runtime/manager-prompts.mjs (new).
Action: Four pure functions `intakePrompt(job, repoFacts)`, `clarifyPrompt`, `planPrompt(job, roster)`, `managePrompt(job, inbox)`; each ≤ 1 page of plain English, each ends with the exact fenced JSON shape expected. BOSS reads and approves in the file header.
Verify: header line `APPROVED-BY: BOSS <date>`.
Done when: approval recorded. 9.3+ do not run live before this.
</task>

<task id="9.1" name="Job store + job-scoped gate slot" tdd="true">
Files: agent-runtime/db.mjs, agent-runtime/jobs.mjs, agent-runtime/deliveries.mjs, agent-runtime/test/jobs.test.mjs, agent-runtime/test/job-gate.test.mjs.
Action: Migration vNN: `jobs(id, title, brief, repo, source TEXT DEFAULT 'paste', externalKey TEXT NULL UNIQUE, status CHECK IN ('intake','clarify','planned','building','review','awaiting-you','shipped','blocked'), questions JSON, answers JSON, summary JSON, prUrl, createdAt, updatedAt)` (source/externalKey are for Phase 13; created now so 13 needs no migration), `job_tasks(id, jobId, seat, skillsRequired JSON, steps JSON, status, goalId, taskId, deliveryId, changedPaths JSON, blockedOn)`, and `deliveries.jobId TEXT NULL` (additive). `mintGate` accepts exactly one of `{storyId}` / `{jobId}` (both or neither → 400); `listGates(ownerId, kind)` matches either column; `decide()`'s `onDecided` dispatches to the STORY pipeline when `storyId` is set and to `manager.onGateDecided` when `jobId` is set — the story path is byte-identical to today. Closed transitions like stories.mjs; emits `job.changed` (declared in 7.0b).
Verify: transitions table incl. 409s; `mintGate({jobId})` lands a `question` gate with `storyId` null; `pipeline.answerQuestion` still 409s for a job gate; existing pipeline tests unchanged and green.
Done when: routes in 9.5 can read/write it; SSE `job.changed` observed.
</task>

<task id="9.2" name="Manager state machine, job stall clock, transient retry (pure)" tdd="true">
Files: agent-runtime/manager.mjs, agent-runtime/test/manager.test.mjs, agent-runtime/test/manager-clock.test.mjs.
Action: `createManager({jobs, roster, mailbox, enqueueGoal, dispatch, hire, deliveries, queue, clock, log})`. `tick(jobId)` advances one step by status: intake → dispatch(intake) → `{repoFacts, needs[]}`; clarify → if `needs` non-empty mint ONE `question` gate ({jobId}) with ≤5 questions → `awaiting-you`, else skip; planned → validatePlan (plan-scope rules: every task ends in a file change, ≤ 8 tasks, seats from roster only, `skillsRequired ⊆ catalog`) → assign: `roster.match(skillsRequired)` → else `hire()` — a seam injected by Phase 10 (10.1b); until then the default seam returns `{ok:false}` and the Job goes `blocked` with reason "no roster match" → `enqueueGoal({agentId, storyId: jobId, tier: requestedTier, steps})`; building → drain Manager inbox: `blocked` → re-plan ONCE (reorder/split) then escalate as a `question` gate; `done` → mark, unblock dependents; `out-of-scope` → reassign. **Job stall clock**: `lastProgressAt` advances on any task state change or mail; time is NOT counted while any job task is HELD or the job is `awaiting-you` (uses injected `deliveries.listGates(jobId, kind)` and `queue.all()` filtered by the job's goalIds — both exist); no progress for `MANAGER_STALL_MS` (default 900 s, env-overridable) → one `stall` log row + Job `blocked` (never a silent retry). **Manager-turn retry**: transient dispatch errors (429/5xx/timeout, detected with the existing `isProviderOverload` from provider-breaker.mjs) retried ≤ 3 with backoff; deterministic errors → `blocked` on first. **Engine → Manager signals (both synthesized by the runtime, so a worker that never calls `mail_send` still reports):** server.mjs `onTerminalFailure` (~2382, today `story-build.onTerminalTask` returns `{skipped}` for a non-story owner) → when the owner id has the `job_` prefix, send `blocked {taskId, reason}` to the Manager as sender `engine`; server.mjs `onDone` (~2407) and the HELD transition → send `done {taskId, deliveryId, changedPaths, refused}` likewise — `refused` carries the broker's `refused[out-of-scope]` list (7.2), and a non-empty `refused` is what triggers the Manager's reassign/re-plan branch (spec §5). A worker's own `mail_send done` is optional and deduped by taskId. Every parse fails closed.
Verify: worker terminal failure → Manager inbox has `blocked`; task HELD → Manager inbox has `done` with the deliveryId; fixture dispatch walks intake→clarify→(answer)→planned→building→review with 3 tasks; one `blocked`→re-plan; injected clock: HELD 20 min → no stall; RUNNING idle 900 s → blocked; 429 ×2 then success → proceeds; 401 → blocked first try. 30+ tests, zero I/O.
Done when: green.
</task>

<task id="9.3" name="Manager dispatch: live claude session + deterministic canned dispatcher" tdd="true">
Files: agent-runtime/manager-dispatch.mjs, agent-runtime/server.mjs, agent-runtime/test/manager-dispatch-http.test.mjs.
Action: `createManagerDispatch({mode})`. `mode=claude`: `claude -p` on the Claude CLI road with `--allowed-tools Read,Glob,Grep,"Bash(ls:*)","Bash(rg:*)","Bash(cat:*)","Bash(git log:*)","Bash(git show:*)"`, `--max-turns 40`, `--setting-sources project`, cwd = a worktree created through the EXISTING `createWorktreeMgr` (no worktree.mjs change, no CORE_GUARD edit); "read-only" is enforced by `--allowed-tools` excluding Write/Edit and by the Bash allow-list; released after the turn. Output = the LAST fenced ```json block; missing/invalid → `{ok:false, error}` (never an empty success). `mode=deterministic` (`RUNTIME_MANAGER_DISPATCH=deterministic`): canned answers keyed by stage from a fixture file — intake reads real repo facts deterministically (file list), plan returns one task per seat the brief names, PLUS — when the brief contains the word `notifications` — a task with `skillsRequired:["notifications"]` so 10.2 and 14.1 can exercise a hire deterministically; manage echoes inbox. Same interface as the engine's deterministic spawner so 14.1 can run the whole loop with no model.
Verify: HTTP test boots the server with `RUNTIME_MANAGER_DISPATCH=deterministic` and walks a Job to `building`; a malformed model reply in unit → `ok:false`.
Done when: both modes exercised in tests; live mode proven in 9.6.
</task>

<task id="9.4" name="Answer route and gate decision routing" tdd="true">
Files: agent-runtime/server.mjs, agent-runtime/manager.mjs, agent-runtime/test/manager-dispatch-http.test.mjs.
Action: `POST /runtime/jobs/:id/answer {deliveryId, answers:[{q, a}]}` (approver-gated, scrubbed, capped): stores answers on the Job, resolves the gate via `deliveries.decide(approve)`, `onDecided` → `manager.onGateDecided(jobId)` → status `planned` → next tick plans. A `reject` on the question gate → Job `blocked` with the note.
Verify: HTTP: answer → job.status planned; second answer for the same fact → 409 `already answered`; reject → blocked.
Done when: green.
</task>

<task id="9.5" name="Job routes + heartbeat">
Files: agent-runtime/server.mjs.
Action: `POST /runtime/jobs {title, brief, repo?}` (approver, brief ≤ 10 KB, scrubbed), `GET /runtime/jobs`, `GET /runtime/jobs/:id` (job + tasks + gates + mail thread). Heartbeat calls `manager.tick` for every job not in {shipped, blocked, awaiting-you}, one job per tick per agent to respect breaker/backoff.
Verify: HTTP test for each route (auth, caps, 404, shape).
Done when: routes green.
</task>

<task id="9.6" name="Live proof — the Manager reads the code and assigns by skill">
Action: paste the formatRelative brief → loop_steps show `Read src/lib/formatRelative.ts` and `Grep` calls in the intake turn → plan has ONE task (tests) assigned to Squirtle (skills [test]) and none to Pikachu → task enqueued on the Claude CLI road → HELD. Then a second brief whose plan orders Charizard before Bulbasaur → Charizard mails `blocked` → Manager re-plans (Bulbasaur first) → both HELD. No human touch between paste and HELD except answering questions.
Verify: loop_steps, job thread, `usage` rows per Manager turn, all recorded in STATE.md with job ids.
Done when: both scenarios observed.
</task>

<task id="9.7" name="Phase gate">
Action: contract BEFORE and AFTER (servers stopped); PES report with Known Gaps & Risks.
Done when: numbers in STATE.md.
</task>

</tasks>

<must_haves>
- A Job has its own gate slot, answer route, stall clock and retry budget — never borrowed from Stories
- Manager reads the code before planning (loop_steps prove it)
- Questions asked at most once per fact; answers persist on the Job
- Assignment is by roster skills; a `blocked` worker is handled by the Manager, not surfaced raw
- The whole loop runs with `RUNTIME_MANAGER_DISPATCH=deterministic` for CI
</must_haves>

<threat_model>
- Manager Bash = read-only allowlist enforced by the CLI's `--allowed-tools`; cwd is a read-only worktree released after the turn; it can never write code.
- Plans/questions are agent-authored → validated, scrubbed, bounded before storage or enqueue; seats must exist in roster; skills must exist in catalog.
- Runaway: `--max-turns 40`, stage timeout 600 s, provider breaker, ≤ 3 transient retries, then `blocked` — never silent.
</threat_model>

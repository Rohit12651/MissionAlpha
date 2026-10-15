# MissionAlpha → Devin parity roadmap (Phases 1–3)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans. Each ticket below gets its own TDD step plan (failing test → run → minimal code → run → commit), written against the code at the moment that ticket starts. Steps use checkbox (`- [ ]`) syntax.

**Goal:** MissionAlpha takes work from a person, a ticket, a chat or an event, and delivers a reviewed PR with green CI that a human merges. This is the loop Devin sells.

**Architecture:** Keep the existing job state machine (`agent-runtime/jobs.mjs`), Manager (`manager.mjs`), engine, worktrees, test gate and PR ladder (`pr.mjs`). Each phase adds a layer on top, and only after the phase below proves itself with real runs.

**Tech stack:** Node ESM runtime (`agent-runtime/`, `node --test`), Electron + Vite React UI (`src/`, Vitest), Claude CLI workers under `worker-jail.mjs`, Docker test gate (`sandbox.mjs`), `gh` for GitHub.

**Companion docs:**
- Phase 1 detail: `docs/plans/2026-10-14-devin-loop-phase1.md`
- UI mockup of all three phases: `docs/mockups/missionalpha-devin-phases.html`
- Source review: `devin-missionalpha-architecture-review.pdf`, findings F01–F16

---

## The three phases at a glance

| Phase | Question it answers | Exit gate (all required) |
|---|---|---|
| **1 · Prove the loop** | Can one ticket become a real PR with green CI? | ≥6/10 tickets: PR open + CI green · ≥4/10 mergeable as-is · zero silent failures |
| **2 · Make it mergeable** | Would a human merge what it produces without edits? | ≥7/10 mergeable as-is on a fresh 10-ticket set · every PR review-commented by the clean reviewer · CI failures auto-fixed in ≥50% of cases |
| **3 · Make it autonomous** | Can work arrive and finish without a human starting it? | 5 jobs started by Slack/Linear/automation reach a PR end to end · no job starts without a named trigger in the audit log · VM sandbox passes the escape tests |

**Rule:** no ticket from Phase N+1 starts until Phase N's exit gate is met and recorded in its scorecard. Phase 2 tickets may be reordered by the Phase 1 scorecard (fix where it actually broke first).

### Coverage: every capability in the parity table has an owner

| Capability | Today | Phase | Ticket |
|---|---|---|---|
| Intake: chat, API, Jira | Partial | 1 | R1 |
| Intake: Slack, Linear | Missing (Slack mints deliveries, not jobs) | 3 | P3-1, P3-2 |
| Plan approved by a human before work | Missing | 2 | P2-1 |
| Planner/reviewer is an AI model | Off by default | 1 | R3 + step 3 |
| Agent runs shell, build, tests itself | Pushed (`abbad37`) | 1 | done; verified in R6 |
| Isolated machine + prebuilt env | Worktree only | 2 (env) · 3 (VM) | P2-5, P3-5 |
| Browser self-test | Missing | 2 | P2-8 |
| Branch → commit → push → PR | Never run on a real remote | 1 | R6 |
| Watches CI, answers PR comments | Missing | 2 | P2-3, P2-4 |
| Independent clean-context reviewer | Same manager, rule-based | 2 | P2-2 |
| Auto-fix loop on review/CI failures | One test retry | 2 | P2-3 |
| Parallel agents | One task at a time | 2 | P2-7 |
| Memory across sessions | Written, never read by workers | 2 | P2-6 |
| Automations → jobs | Cadence queues station goals | 3 | P3-3, P3-4 |
| Session states, live view | Real | — | keep |
| Security guards | Real | — | extended in P3-5 |
| Observability | Real | — | extended per ticket |

---

## Phase 1 · Prove the loop (in progress)

Full detail stays in `2026-10-14-devin-loop-phase1.md`. Summary for this roadmap:

| # | Ticket | Files | Exit evidence |
|---|---|---|---|
| ✅ | Tree landed, worker shell allowlist, ship gate names unverified tasks | `server.mjs`, `manager.mjs`, `sandbox.mjs` | pushed `05e8dbd..70da1d7` |
| R1 | **Start job** action → typed Job endpoint → accepted Job ID | `src/components/workspace/ChatPane.tsx`, `src/components/board/JobBoard.tsx`, `server.mjs` (`POST /runtime/jobs`) | brief → one Job ID → board row; a question creates no job; viewer refused |
| R2 | Accepted/refused results; awaited dispatch | `manager.mjs:470-500`, `ChatPane.tsx:494-527` | injected backlog-full leaves no phantom `queued` row |
| R3 | Mode + readiness visible; AI mode default for real runs (step 3) | `manager-dispatch.mjs`, `engine-readiness.mjs`, `src/components/board/JobDetail.tsx` | each job shows `AI` or `rules`; skipped probe never says "measured" |
| R4 | Integrate before dependents | `manager.mjs:990-1022`, `worktree.mjs` | injected commit failure → dependent never starts |
| R5 | Combined-branch acceptance gate | `test-gate.mjs`, `manager.mjs` review gate | two tasks green alone, red combined → no shippable approval |
| R6 | Pilot: test repo, 10 graded tickets, single-worker baseline | `docs/plans/phase1-scorecard.md` | scorecard filled from real runs, each row links its PR |

**UI change in Phase 1 (small, no new tabs):** Start-job button, accepted/refused chips in chat, mode + readiness badges on each job, unverified-tests list on the ship gate.

---

## Phase 2 · Make it mergeable

Entry: Phase 1 exit gate met. Order below is the default; reorder by the Phase 1 scorecard's "failing stage" column.

### P2-1 · Human plan approval before build

- **Why:** the review PDF's top trust gap: work starts before anyone agrees on the plan. Devin's "plan → approve → run" pattern.
- **Behaviour:** after `clarify`, a job with a plan goes to `awaiting-you` with `gate: "plan"`, not straight to `planned`. Approve → `planned`. Edit → plan text replaced, re-validated. Reject → `blocked` with the reason. A `planApproval: "auto"` setting per workspace keeps the current behaviour for trusted repos.
- **Files:**
  - Modify `agent-runtime/jobs.mjs` (no new status; reuse `awaiting-you` + a `gate` field)
  - Modify `agent-runtime/manager.mjs` (stop at the plan gate)
  - Modify `agent-runtime/server.mjs` (`POST /runtime/jobs/:id/plan` with `{ action: "approve" | "edit" | "reject", plan?, reason? }`)
  - Create `src/components/board/PlanApproval.tsx`
  - Modify `JobDetail.tsx` to mount it
- **Tests:**
  - `agent-runtime/test/plan-gate.test.mjs`:
    - a job with a plan stops at `awaiting-you/plan`;
    - approve moves it to `planned` exactly once;
    - reject moves it to `blocked` with the reason;
    - an edit with an empty plan is refused (400);
    - `auto` mode skips the gate;
    - a viewer role gets 403.
  - `src/components/board/PlanApproval.test.tsx`: renders steps, approve calls the endpoint, keyboard (Enter = approve, Esc = close).
- **Exit evidence:** a pilot job pauses on its plan; approving it starts the build; the audit log shows who approved.

### P2-2 · Clean-context reviewer

- **Why:** today the Manager that planned the work also reviews it, and is rule-based by default (F06/F07). Devin Review runs on a fresh context.
- **Behaviour:** at `review`, spawn a separate reviewer seat. It gets only the diff, the ticket, and the test-gate result; never the planner transcript. It returns typed findings `{ severity: "blocker" | "major" | "minor", file, line, claim, evidence }`. Blockers send the job back to `building` with the findings as the fix brief. No blockers → `awaiting-you/ship`.
- **Files:**
  - Create `agent-runtime/reviewer.mjs` (builds the prompt, parses and validates findings)
  - Add a reviewer seat to `roster.json` (tools: Read, Glob, Grep; no Write, no Bash)
  - Modify `manager.mjs` review stage
  - Create `src/components/inbox/ReviewFindings.tsx` (reuses `ReviewPane.tsx`, `DiffEditor.tsx`)
- **Tests:**
  - `agent-runtime/test/reviewer.test.mjs`:
    - the prompt contains the diff and ticket but no planner transcript;
    - a malformed findings JSON fails closed (status `review-unavailable`, never pass);
    - a blocker routes to `building`;
    - minors only routes to the ship gate;
    - the reviewer seat cannot write (jail probe).
- **Exit evidence:** every pilot PR carries a reviewer comment; at least one blocker caught that the tests missed.

### P2-3 · CI watch + auto-fix loop

- **Why:** D7 says "delivered = PR open + CI green". Today nothing reads CI after the PR opens.
- **Behaviour:** after `pr.mjs` opens a PR, poll `gh pr checks <n> --json` with backoff (30 s → 5 min, 45 min cap).
  - Red: fetch the failing log tail (`gh run view --log-failed`), scrub it (`secret-scrub.mjs`), and enqueue a fix task on the same branch.
  - Max 2 fix rounds, then `blocked` with reason `ci-red-after-2`.
  - Green: job `shipped`, and the scorecard row is written.
- **Files:**
  - Create `agent-runtime/ci-watch.mjs` (pure: `nextAction(checks, round) → "wait" | "fix" | "done" | "give-up"`)
  - Modify `pr.mjs` (return the PR number)
  - Modify `manager.mjs` (fix-task enqueue)
  - Modify `server.mjs` (wire the poller into the scheduler tick)
- **Tests:**
  - `agent-runtime/test/ci-watch.test.mjs`:
    - pending → wait;
    - one red check → fix with the scrubbed log;
    - red after round 2 → give-up;
    - all green → done;
    - a `gh` auth error → `blocked` with a named reason (no silent wait);
    - a log containing a token is scrubbed.
- **Exit evidence:** a pilot PR with a deliberately broken test goes red, gets fixed by the agent, and turns green.

### P2-4 · Answer PR review comments

- **Behaviour:** on each CI-watch tick, also read new PR review comments via `gh api repos/{o}/{r}/pulls/{n}/comments`. A comment from an allowlisted human that mentions `@missionalpha`, or is on a changed line, becomes a fix task. The agent replies on the thread with the commit SHA. Comments from non-allowlisted authors are logged, never acted on, because prompt-injection text arrives through comments.
- **Files:**
  - Create `agent-runtime/pr-comments.mjs`
  - Reuse `inject-detect.mjs` for each comment body
  - Modify `ci-watch.mjs` to share the tick
- **Tests:** `agent-runtime/test/pr-comments.test.mjs`
  - a non-allowlisted author is ignored;
  - an injection-flagged body goes to a human, not to a task;
  - the reply contains the SHA;
  - the same comment is never processed twice (idempotency key = comment id).
- **Exit evidence:** a human comment on a pilot PR is fixed and answered without anyone touching MissionAlpha.

### P2-5 · Environment snapshot per repo

- **Behaviour:** a repo-level `missionalpha.env.json` (or detected from `repo-scripts.mjs`) names the install command, Node/Python version and test command. The first job builds a Docker image `ma-env:<repo>-<lockfile-hash>`; later jobs reuse it. A lockfile change → rebuild.
- **Files:**
  - Create `agent-runtime/env-snapshot.mjs` (`imageTagFor(repo, lockHash)`, `ensureImage()`)
  - Modify `sandbox.mjs` to accept the image
  - Modify `test-gate.mjs`
- **Tests:** `agent-runtime/test/env-snapshot.test.mjs`
  - same lockfile → same tag, no rebuild;
  - changed lockfile → new tag;
  - an install failure is a named `env-build-failed`, never a test pass;
  - the image never contains `.env`.
- **Exit evidence:** second pilot job on the same repo starts tests ≥60% faster than the first (measured, both numbers in the scorecard).

### P2-6 · Workers read memory

- **Behaviour:** before a worker turn, take the top-k vault records for the repo plus the ticket (`vault.mjs` search, k=5, ≤4,000 chars total) and add them to the worker prompt under `## Prior decisions`, with their source ids. Only records the vault marks `confirmed` are used.
- **Files:**
  - Modify `agent-runtime/system-prompt.mjs`
  - Modify `agent-runtime/vault.mjs` (add `searchConfirmed(repo, query, k)`)
- **Tests:** `agent-runtime/test/worker-memory.test.mjs`
  - the budget cap is respected;
  - unconfirmed records are excluded;
  - an empty vault produces no section (not an empty header);
  - the record ids are cited.
- **Exit evidence:** a pilot rerun of a ticket that previously hit a known pitfall avoids it, with the vault id cited in the transcript.

### P2-7 · Parallel tasks on the default roster

- **Behaviour:** independent tasks (no `dependsOn` edge) run concurrently up to `computeMaxInflight()` (`concurrency.mjs`). The combined-branch gate (R5) remains the single merge point.
- **Files:**
  - Modify `agent-runtime/scheduler.mjs`
  - Modify `agent-runtime/queue.mjs`
  - Modify `roster.json` (two worker seats per role)
- **Tests:** `agent-runtime/test/parallel-dispatch.test.mjs`
  - two independent tasks start in the same tick;
  - a dependent task waits for its parent's commit (R4);
  - the cap is honoured;
  - a cancel stops both.
- **Exit evidence:** a 3-task pilot job finishes in less wall time than its single-worker baseline, with the same green result.

### P2-8 · Browser self-test

- **Behaviour:** for tickets touching UI files, the worker may run a Playwright smoke check inside the env snapshot. It records a screenshot and a short trace; both attach to the PR body as artifacts. Network egress is limited to localhost.
- **Files:**
  - Create `agent-runtime/browser-check.mjs`
  - Add Playwright to the env image when `package.json` has a dev server script
  - Modify `pr.mjs` (attach artifacts)
- **Tests:** `agent-runtime/test/browser-check.test.mjs`
  - a non-UI diff skips the check;
  - a dev server that fails to start is a named failure;
  - the screenshot path is attached;
  - egress to a non-localhost URL is refused.
- **Exit evidence:** a UI pilot PR shows the agent's own screenshot of the change.

**UI added in Phase 2:**
- Plan approval panel.
- Review findings beside a split diff.
- PR + CI status timeline on each job (open → checks → fix round → green).
- A "memory used" list on the job.
- Parallel lanes on the job board.

---

## Phase 3 · Make it autonomous

Entry: Phase 2 exit gate met. Every Phase 3 trigger creates a job through the **same** typed endpoint R1 built. No second intake path.

### P3-1 · Slack → job

- **Why:** `adapters/slack.mjs` already verifies signatures and mints deliveries. It does not create jobs.
- **Behaviour:** `/missionalpha <brief>` or `@MissionAlpha start: <brief>` in an allowlisted channel calls `jobs.create({ source: "slack", sourceRef: <permalink> })`. It replies in the thread with the Job ID, then posts state changes (plan ready, PR open, CI green) to the same thread. Ordinary chatter never creates a job (D6 holds).
- **Files:**
  - Modify `agent-runtime/adapters/slack.mjs`
  - Modify `server.mjs` ingress
  - Create `agent-runtime/thread-notify.mjs` (shared by Slack and Linear)
- **Tests:** `agent-runtime/test/slack-job.test.mjs`
  - a bad signature → 401 and no job;
  - a non-allowlisted channel is ignored;
  - a plain message with no command creates no job;
  - a valid command returns the Job ID;
  - a replay with the same `event_id` is not a second job;
  - the per-window create cap (`MAX_CREATES_PER_WINDOW`) is honoured.

### P3-2 · Linear → job

- **Behaviour:** a webhook on issue label `missionalpha` (or assignment to the MissionAlpha user) creates a job with `source: "linear"`. Status syncs back:
  - In Progress at `building`;
  - In Review at PR open;
  - Done at merge.

  It mirrors `jira-watch.mjs` and `jira-ship.mjs`.
- **Files:**
  - Create `agent-runtime/adapters/linear.mjs`
  - Create `agent-runtime/linear-ship.mjs`
  - Modify `server.mjs` (`POST /runtime/ingress/linear`, HMAC verified with `LINEAR_WEBHOOK_SECRET`)
- **Tests:** `agent-runtime/test/linear-adapter.test.mjs`
  - a bad HMAC → 401;
  - an unlabelled issue is ignored;
  - a label add creates exactly one job;
  - a label removed before start cancels the job;
  - the status sync maps every job status, or names it unmapped.

### P3-3 · Automations engine (trigger → condition → action)

- **Why:** `cadence.mjs` queues station goals, not jobs. Devin's Automations editor is trigger → condition → preflight → action.
- **Behaviour:** an automation is `{ id, trigger, condition, action: { kind: "create-job", briefTemplate, repo }, enabled, owner, maxRunsPerDay }`.
  - Triggers:
    - `ci-failed` (from CI watch on the default branch);
    - `cron` (reuse `nextRun()` from `cadence.mjs`);
    - `webhook` (signed, per-automation secret);
    - `linear-label`;
    - `slack-command`.
  - Conditions: path globs, branch, label, author allowlist.
  - Preflight: dry-run renders the brief and shows which job *would* be created, and never creates it.
  - Every run writes `{ automationId, triggerEvent, jobId | refusedReason }` to the audit log.
- **Files:**
  - Create `agent-runtime/automations.mjs` (pure matcher + store)
  - Modify `agent-runtime/db.mjs` (an `automations` table and an `automation_runs` table)
  - Modify `server.mjs` (`GET/POST /runtime/automations`, `POST /runtime/automations/:id/preflight`)
- **Tests:** `agent-runtime/test/automations.test.mjs`
  - cron fires once per window;
  - a condition mismatch → no job and a logged reason;
  - preflight never creates a job;
  - `maxRunsPerDay` is honoured;
  - a disabled automation never fires;
  - a webhook with a bad secret → 401;
  - brief template injection (a `{{` inside the event payload) is rendered as literal text.

### P3-4 · Automations UI

- **Files:**
  - Create `src/components/automations/AutomationList.tsx`
  - Create `src/components/automations/AutomationEditor.tsx`
  - Add an `Automations` entry to `BOS_NAV`
- **Behaviour:** the list shows each automation's last run and next run. The editor has a trigger picker, condition rows, a brief template with variable chips, and a Preflight button showing the would-be job. Saving requires a successful preflight.
- **Tests:**
  - `AutomationEditor.test.tsx`: Save is disabled until a preflight passes; validation errors appear inline; the editor is keyboard-operable.

### P3-5 · VM sandbox per job

- **Why:** the worktree jail protects the host from mistakes, not from a hostile repo. Unattended triggers (P3-1..3) raise the stakes.
- **Behaviour:** jobs from external triggers run in a microVM or rootless container with:
  - no host mounts except the worktree;
  - egress allowlisted to the package registry and the git remote;
  - CPU/RAM/time caps.

  Host-launched jobs keep the current jail unless the workspace opts in.
- **Files:**
  - Create `agent-runtime/vm-sandbox.mjs` (adapter interface with one implementation, chosen at build time)
  - Modify `worker-jail.mjs` (route by `job.source`)
- **Tests:** `agent-runtime/test/vm-escape.test.mjs`
  - reading `~/.ssh` fails;
  - writing outside the worktree fails;
  - `curl` to a non-allowlisted host fails;
  - a fork bomb hits the cap and leaves the host responsive;
  - the job is marked `blocked` with `sandbox-limit`.
- **Decision needed before P3-5:** Firecracker (Linux only, strongest), Docker rootless + gVisor (portable), or Apple Virtualization (macOS dev). This is a real trade-off and it waits for Phase 2 data on how jobs actually run.

**UI added in Phase 3:**
- Automations list + editor.
- A "source" chip on every job (chat / Jira / Slack / Linear / automation) linking back to the origin.
- Settings cards for Slack and Linear connections.
- A sandbox badge (jail / VM) on each job.

---

## Cross-cutting rules (all phases)

- **One intake path:** every source calls the R1 typed job endpoint. Accepted → Job ID. Refused → a named reason. Never a silent drop.
- **Fail closed:** a missing tool, credential, image or CI signal is a named `blocked` reason, never a pass.
- **Untrusted text:** Slack messages, Linear issues, PR comments and CI logs pass through `inject-detect.mjs` + `secret-scrub.mjs` before reaching a prompt.
- **Feature freeze per phase:** no ticket from a later phase starts early, including UI.
- **Scorecard per phase:** `docs/plans/phase{1,2,3}-scorecard.md`, filled from real runs only.

## Known gaps and risks

- **Ticket-level TDD step plans are not written yet for Phase 2/3.** Writing exact code now would target code that R1–R5 will change. Each ticket gets its step plan when it starts. This roadmap fixes the behaviour, files, tests and exit evidence.
- **Phase 2 order may change.** It is set by the Phase 1 scorecard's failing stages.
- **P3-5 sandbox technology is undecided** (see the decision above).
- **Linear has no adapter today.** Effort estimate is unknown until P3-2 starts; Jira's adapter is the template.
- **Exit thresholds are proposals:** 6/10, 7/10, 50%. Revisit them after Phase 1 data exists.

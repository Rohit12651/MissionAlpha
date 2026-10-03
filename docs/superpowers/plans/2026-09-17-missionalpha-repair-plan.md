# MissionAlpha Repair Plan — one honest job, then a team that talks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pasted job runs intake → review → PR with every task's work preserved, "shipped" true only when a commit exists, then two workers exchange a question and answer mid-job without the BOSS relaying, then a CEO stage judges the job before planning.

**Architecture:** Six phases, twenty steps, each step one small diff behind a test written first. Phases A–C repair what every job hits (evidence, honesty, recovery, integration). Phase D unlocks the second worker and the resume-on-answer path. Phase E closes the containment holes. Phase F splits `server.mjs` and adds the CEO as a job status. Nothing before step 18 changes how the app executes; it changes what the app records and refuses.

**Tech Stack:** Node 26 ESM runtime (`node --test`, `.mjs`), TypeScript + React 19 + Vite UI (`node --experimental-strip-types --test`, `.ts`), Playwright (`test/visual`, `playwright.config.mjs`), SQLite WAL, file mailbox.

**Evidence base:** `~/Downloads/MissionAlpha-Claude-review.md` (CEO agent, 2026-09-16, 14 findings reproduced), `~/Downloads/MissionAlpha-review.md` (Codex, 21 findings, 19 probes), `docs/PES-ADDENDUM.md` classes 14–60.

---

## 📊 STATUS BOARD — read this first (updated 2026-09-24)

**Where the plan actually stands.** A ✅ means closed with evidence shown in this document. An
item with no tick is not done, whatever else is written about it below.

| Phase | Steps | State | Proof |
|---|---|---|---|
| **A — Honesty** | 0–2 | ✅ closed | Tasks 0/1/2 + Phase A exit |
| **B — Recovery** | 3–6 | ✅ closed | Tasks 3–6, G7 adversarial round, Phase B exit checklist |
| **C — One reliable job** | 7–11 | ✅ closed | PLAN-STEPS, HIRE-CORR, SEQ-1…5, ENG-BASE-1, DIFF-1…6, CANON-1…5 — all mutation-proven |
| **C — exit (live run)** | — | ✅ **MET** | Live run 5 shipped `job_49d5f0028fb8`, `outcome: local-branch`, commit `9e1c5d7`, plan stages run: 1 |
| **D — step 14** | 14 | ✅ **PROVEN LIVE** | Run 6: two seats dispatched on ONE tick (`inFlight:1` → `inFlight:2`), both committed, job **shipped**. Prompt approved `BOSS 2026-09-21` |
| **D — rest** | 12, 13, 15 | ✅ **closed** (run 9) · rule 8 ✅ 09-24 | Frontend asked, backend answered in a reply turn, frontend resumed once and shipped. Playwright 31/1/1 under load — re-run pending |
| **E — Boundaries** | 16–18 | ✅ **closed** 09-24 · rule 8 ✅ · /cso 0 open HIGH | GUARD-* · SCRIPTS-* · JAIL-* all mutation-proven; JAIL-1 proven live (Operation not permitted) |
| **F — Structure + CEO** | 19–20 | 🟡 **20 ✅ live** · 19 ⬜ (off the critical path, as recommended) | Run 10 shipped through the CEO gate (`proceed`), jail ON; 36 mutations; Playwright 32/1/0 |

### Gates at the last full run

| Gate | Result |
|---|---|
| runtime suite | ✅ **2803 / 2803**, exit 0 (09-24, after every Phase F · 20 change) |
| unit (UI) | ✅ 597 / 597 |
| vendor | ✅ 54 / 54 |
| electron | ✅ 14 / 14 |
| visual (Playwright) | ✅ **32 passed, 1 skipped, 0 failed**, exit 0 (09-24, after every Phase E change; an earlier run at load 56→179 had 6 shell timeouts) |
| tsc | ✅ 0 errors |
| lint | ✅ 0 errors |

### Defects found AFTER Phase C closed, and their real state

| # | What | State |
|---|---|---|
| C23 | A task stuck in `running` had nothing able to intervene — `reclaimExpiredLeases` deliberately skips tasks still in the `running` map | ✅ **BOUNDED, not diagnosed.** Last-resort reaper at `watchdog × 2` (300s → 600s in production). MUT-1/2/3 each reddened ENG-REAP-1. Never reproduced, so this is a bound on the damage, not a cause fix |
| C28 | `stepPaths` could not see a root-level filename (`README.md`), so the write scope missed the file the task was about | ✅ fixed, mutation-proven |
| C29 | "TypeScript repos are ungateable" | ✅ **WITHDRAWN — my error, not the product's.** `.env` already set `RUNTIME_SANDBOX_IMAGE=node:24-alpine`; my harness never sourced it. The "fix" carved a hole in a deliberate ban and made things worse. Reverted to a zero diff |
| C30 | A re-plan on a job that already had commits would orphan them | ✅ fixed — `planned` is refused once commits exist, naming them |
| C31 | The live run wrote a seat file into the real repo (`RUNTIME_AGENTS_DIR` unset) | ✅ fixed — file deleted, the var added to the isolation set |
| C32 | `pr.treeOf` was never forwarded to the Manager, so the tree pin was inert in production (`"tree": null` in the shipped summary) | ⚠️ **wired, NOT proven live.** Needs run 6 |
| C33 | The PR rung has never opened a real PR — every trial clone had `origin` removed for safety | ⬜ open |
| — | Multi-task job ship | ⬜ **unproven.** Run 5 was deliberately narrowed to ONE documentation task |

### What is happening right now

**Phase D, step 14 (concurrency 2), entered through its design blocker.**

`docs/superpowers/specs/2026-09-19-ready-set-dispatch.md` states the rule: a task is ready when
its predecessors are `done`, its seat is free, and its seat's **enforced** `writeScope` is
disjoint from every in-flight task's. The design rests on one fact about the ladder —
`commitTask` copies file BODIES per approved path and **never merges** (`pr.mjs:468,481,486`),
so disjoint tasks commit cleanly in any order and same-path tasks silently revert each other.

The BOSS approved option **(b)**: a declared `dependsOn` graph, which needs a `job_tasks` column
and a plan-prompt change. **That prompt edit re-opens the `APPROVED-BY` gate** in
`manager-prompts.mjs` — the header reverts to `_PENDING BOSS_` and `MP-GATE` enforces it, so
the BOSS must review the prompt diff before any Phase D live run.

### Rule 0 — still in force

Nothing has been committed. `HEAD` is `85796ae`; ~85 files are modified in the working tree.
No commit, no push, no stash, no branch until the BOSS says so in a message of their own.

---

---

## THE ONE RULE THAT OVERRIDES EVERYTHING IN THIS PLAN

**NO `git commit`. NO `git push`. NO `git stash`. NO branch creation. Not at the end of a task, not at the end of a phase, not when the suite is green. Not ever, until the BOSS says the words in a message of their own.**

Every task in this plan ends with a STOP step that reports the diff and waits. The `sp-writing-plans` skill's default "Step 5: Commit" is **deleted from every task below on purpose**. If you find yourself typing `git commit`, you have left the plan. Permission given in one session does not carry to the next (STATE.md §1).

---

## PES intake (principal-standard, Part 2)

**Restated.** Make MissionAlpha's job pipeline honest and recoverable, then make its worker team able to talk, for the BOSS (sole operator today) so that one pasted job reaches a real PR without hand-relay.

**Classification: CRITICAL.** Touches permissions (`guards.mjs`, `mailbox.mjs` routing), identity (`mail-tools.mjs` binding), git operations (`pr.mjs`, `worktree.mjs`), process spawning (`engine-exec.mjs`), HTTP auth (`routeNeedsApprover`). Full protocol. `security-review` skill mandatory on phases B, C, E. Design note per phase.

**Scope ledger** (reappears in every delivery report; each item ✅ or ❌-with-reason):

| # | Step | Phase |
|---|---|---|
| 0 | One startup config for CLI, desktop, tests | A |
| 1 | Worker mail carries the job id | A |
| 2 | A worker's own `done` is progress, not proof | A |
| 3 | Mail sender bound to outbox owner; HTTP mail needs approver; operator reads non-destructive | B |
| 4 | Retry keeps its task identity; ship refuses a missing worktree by name | B |
| 5 | `shipped` only when every task with paths committed; outcome recorded | B |
| 6 | Ship stage persisted; boot reconcile; resume route; second answer allowed | B |
| 7 | Single-step tasks, refused explicitly | C |
| 8 | Hire response correlated to its request; scope checked | C |
| 9 | Ship as you go: sequential base per task; replan touches un-started only | C |
| 10 | Review diff includes new files; tree hash pinned | C |
| 11 | Symlink-safe writers via one shared helper | C |
| 12 | Workers get a TEAM block and `mail_read` first | D |
| 13 | An `answer` re-enqueues the blocked task once | D |
| 14 | Concurrency 2 for disjoint-path tasks | D |
| 15 | Manager tick lease | D |
| 16 | Protected floor: fail-closed `applyAllowed`; CORE_GUARD widened | E |
| 17 | Target-repo scripts gated | E |
| 18 | Worker spawn inside the jail (flagged) | E |
| 19 | `server.mjs` decomposition, eight commits' worth of extraction (uncommitted) | F |
| 20 | CEO as job status `strategy` | F |

**Acceptance criteria** (binary; each maps to a phase exit below):

1. `mail_send` from a worker on job `job_X` lands in the Manager's inbox with `jobId === "job_X"`. (A)
2. A `done` message with `from: "sr-backend"` leaves the task in `building`; the same with `from: "engine"` sets `done`. (A)
3. A forged file in `sr-backend/outbox/` claiming `from: "tech-lead"` is deleted at route and logged; `POST /runtime/mail` without an approver session is 403. (B)
4. A retry that succeeds leaves the job task's `taskId` equal to the successful attempt's id. (B)
5. A job with three tasks and one commit does not reach `shipped`; it reaches `blocked` with a reason naming the uncommitted tasks. (B)
6. After a simulated ship failure post-approval, boot moves the job to `blocked` with reason text; `POST /runtime/jobs/:id/resume` (approver) moves it to `planned`. (B)
7. Task A writes `base+A`, task B writes `base+B` to the same file; the job branch tip contains both. (C)
8. A task that creates a new file shows that file in the review diff. (C)
9. A destination symlink `src/alias → ../docs` is refused by broker, `commitTask`, and codemod, with no write outside the worktree. (C)
10. Worker 1 sends `question` to worker 2; worker 2 sends `answer`; worker 1's task is re-enqueued exactly once with the answer in its brief. (D)
11. Two tasks with disjoint `paths[]` run concurrently under `RUNTIME_STORY_MAX_CONCURRENT=2`; two with overlapping paths do not. (D)
12. `applyAllowed("src/x.ts", { seat: undefined })` returns `false` on engine and ship paths. (E)
13. The deterministic paste-to-shipped test and `tsc --noEmit` are green after every task. (all)
14. A job passes through `strategy` before `clarify`; a `kill` verdict sets `blocked`, `proceed` sets `clarify`. (F)

**Risk scan.** Blast radius: the job pipeline and the mailbox — every live job. Data touched: `mission.db` jobs/tasks rows (additive columns only), mailbox files, `roster.json` (not in this plan). Rollback: every step is one reverted diff; no migration is destructive; new columns are nullable. Irreversible: none before step 18; step 18 changes process spawning and ships behind a flag.

**Assumptions.** (1) The BOSS is the only operator for phases A–D; multi-user isolation is Phase E+. (2) The deterministic Manager (`RUNTIME_MANAGER_DISPATCH=deterministic`) and deterministic spawner remain the test harness; no model calls in any gate. (3) The active account stays "Claude Max (CLI)". (4) Live runs happen only at phase exits, on a throwaway clone, with the BOSS present.

---

## Spec (product-management:write-spec, condensed)

**Problem.** The BOSS pastes a job and cannot trust what comes back. Tasks close on a worker's word, one worker's edit overwrites another's, the review omits new files, "shipped" appears with no commit, and an approved job can strand forever. Two workers can never run at once, so the promised team conversation is impossible by construction.

**Goals.** (G1) One job from paste to PR with every task's work preserved and every status true — measured by acceptance criteria 1–9 green and one live run on a clone reaching a real PR. (G2) Two workers exchange a necessary Q&A that resumes work — criterion 10. (G3) The CEO gates planning — criterion 14.

**Non-goals.** Multi-tenant isolation (no second user exists). Hosted deployment. GitHub Enterprise hostnames (`pr.mjs:197` stays github.com-only). Rewriting `server.mjs` before the pipeline is honest (step 19 is last for a reason). Broadening the mailbox to `ceo` (the CEO becomes a job status, not a bus participant).

**P0** steps 0–11. **P1** steps 12–15. **P2** steps 16–20.

**Success metrics.** Leading: acceptance criteria green per phase; ratchet count with recorded mutation proof (target: one per step). Lagging: the C4 unattended week (`ROADMAP.md`) — five jobs Monday → PRs Friday, zero operator-tree incidents.

**Open questions** (blocking marked ●):
- ● Step 9 base strategy: commit-as-you-go onto `ma/job/<id>` (chosen) vs. merge at the end. Decision needed before phase C. *Owner: BOSS.*
- Step 18: current Claude CLI sandbox flags. *Owner: engineering, verify against docs before design.*
- Origin of three fixture-shaped messages in the live mailbox dated 2026-09-05. *Owner: BOSS.*
- ~~C15~~ **CLOSED 2026-09-17** — 21 baselines refreshed, validated 32/0 on the Phase A tree. Rule 8 is measurable from here on. Run it at load < 30.
- **C17 — load-sensitive shell mount** (`inbox @ dark`, `schedule @ light`, `outputs @ light` fail `waitForShell` above load ~35–50, pass at ≤ 33; four runs). No red loop at producible load, so no fix. Stays open. A no-main failure at a phase exit with load > 30 is C17, not the phase. *Owner: agent, if a stress harness is ever wanted.*

---

## Ground rules

1. **NO COMMIT, NO PUSH, NO STASH, NO BRANCH.** See the rule at the top. Repeated in every phase. Each task ends with STOP.
2. **Every new test is a RATCHET.** After it passes: break the protected thing (remove ONE real call site, not a redundant one), run it, record the red line in the test's docstring, restore, confirm `md5 -q <file>` matches the pre-mutation hash, re-run green. Prefer a BAD / GOOD / UNRELATED trio inside the test so the proof runs in CI (addendum #13).
3. **Match on values and AST, never on source text** (addendum #13, #15).
4. **CORE_GUARD files are modified in this plan** — `server.mjs`, `broker.mjs`, `guards.mjs`, `mailbox.mjs`. The write-scope plan avoided them; this plan cannot. Every such edit is named in its task and runs `security-review` before STOP.
5. **Gates run with dev servers stopped.** Boot check after every task: `RUNTIME_MANAGER_DISPATCH=deterministic RUNTIME_ENGINE_SPAWNER=deterministic node --test agent-runtime/test/loop-paste-to-shipped.test.mjs` green, plus `npx tsc --noEmit` exit 0.
6. **Two-strike debugging.** Same failure twice → `sp-systematic-debugging`. Never a third patch.
7. **Repo drift.** Every shell command uses `git -C /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha` or an absolute path. The cwd snaps back to WaahyuPython between turns (STATE.md §7).
8. **Playwright at EVERY phase exit, UI or not.** `npm run test:visual` (self-contained: `playwright.config.mjs` builds and serves on :3007) must be green before a phase closes, even when the phase touched no UI. A phase that changed runtime behaviour and left the board unchanged is proven by an unchanged snapshot set. Phases that add a UI element (5, 6, 20) additionally add their own locator assertion and snapshot. Dev servers stopped first.
9. **Memory at EVERY phase exit.** Append a dated phase record to `.planning/STATE.md` (what landed, file:line, tests + red lines, gates with output, gaps) — the house convention; the session-close hook appends to `docs/SESSION_MEMORY.md` on its own and claude-mem captures automatically. Then update the mockup (`missionalpha-repair-plan.html`, republished to the same artifact URL) so the finished phase shows ✓ and the next shows in progress. Both before STOP.

Commands:

```bash
M=/Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha
cd "$M"
npm run typecheck                                   # tsc --noEmit
npm run lint                                        # eslint, zero warnings
npm run test:unit                                   # .ts unit + test/visual/*.test.mjs
npm run test:runtime                                # node --test, serial
npm run test:visual                                 # playwright test test/visual
node --test agent-runtime/test/<one>.test.mjs       # one file
```

---

## Skill roster — every skill this plan uses, and where

| Skill | Owner of | Phase(s) | Why it is the owner |
|---|---|---|---|
| `principal-standard` (PES) | Intake, gates G0–G8, delivery report | all | Prime directive. Reserved words need evidence |
| `sp-writing-plans` | This document's task shape | — | Bite-sized steps, no placeholders |
| `sp-executing-plans` / `sp-subagent-driven-development` | Running this plan | all | One task at a time, checkpoint between |
| `sp-test-driven-development` + `mattpocock-skills:tdd` | Red → green → refactor per task | all | Test first, watch it fail, minimal code |
| `sp-verification-before-completion` | Pre-STOP check every task | all | Nothing claimed without output shown |
| `mattpocock-skills:code-review` + `/code-review` | Adversarial diff read (G7) | all | Two independent readers per diff |
| `code-reviewer` agent + `typescript-reviewer` / `react-reviewer` | G7 language pass | all; react on 5, 6, 20 | Matches touched stack |
| `security-review` + `security-reviewer` agent | G5 on sensitive paths | B, C, E; any task naming a CORE_GUARD file | Blocks on HIGH/CRITICAL |
| `ponytail` | Minimal diff, YAGNI ladder | all | Smallest change that closes the class |
| `caveman` | Bus/prose compression | all | Token discipline |
| `sp-systematic-debugging` | Two-strike escalation | any | Root cause over patch |
| `mattpocock-skills:diagnosing-bugs` | Root cause before fix on 4, 7, 10 | B, C | These are bug fixes, not features |
| `mattpocock-skills:domain-modeling` | Step/task/attempt/job state model | C (7, 9), F (20) | The completion semantics are a domain model |
| `mattpocock-skills:codebase-design` | `server.mjs` extraction boundaries | F (19) | Module boundaries before moving code |
| `mattpocock-skills:writing-for-agents` | TEAM block, prompt text, SKILL bodies | D (12), F (20) | Prompt text is a document an agent consumes |
| `webapp-testing` + `playwright` + `agent-browser` | G6 runtime proof on UI-touching steps | B (5, 6), F (20) | Badge, resume button, `strategy` status must render |
| `hallmark` → `impeccable` | UI direction when a new surface is added | B (5 badge), F (20 status) | No default-template slop; a11y as input |
| `docs-lookup` / context7 | Claude CLI sandbox flags | E (18) | Verify before design; never assume a flag |
| `mem-search` | Prior-art recall | intake | **Currently broken** (`/api/search` DOMException). Use `sqlite3 ~/.claude-mem/claude-mem.db` directly |
| `/qa`, `/review` (gstack) | Phase-exit gate | each phase exit | **`/qa` EXCLUDED while Rule 0 stands** — its setup requires a clean tree (offers commit or stash) and its fix loop commits every fix. Loaded 2026-09-17, read, not run. `/review` is read-only and stays. The phase-exit gate is rule 8 (Playwright) + `code-reviewer` agent + G7 |
| `sp-finishing-a-development-branch` | **NOT USED** | — | It commits. Excluded by the top rule |

---

## File structure (locked before any task)

| File | Change | Responsibility after this plan |
|---|---|---|
| `electron/runtime-env.cjs` | Create | Pure: pick allow-listed `RUNTIME_*` from a `.env` text and process env |
| `electron/main.cjs:91-99` | Modify | `buildSupervisorEnv` calls the picker |
| `electron/test/runtime-env.test.cjs` | Create | Ratchet for the picker |
| `agent-runtime/mail-env.mjs` | Create | Pure: the MCP env block for a seat's mail server |
| `agent-runtime/server.mjs:2131-2143` | Modify (CORE_GUARD) | Calls `mailEnvFor()` |
| `agent-runtime/engine.mjs:366` | Modify | `ctx` gains `goalId` |
| `agent-runtime/mcp/mail-tools.mjs:22-23` | Modify | Reads `MA_MAIL_GOAL_ID` |
| `agent-runtime/test/mail-env.test.mjs` | Create | Ratchet: env binds job id from `storyId` |
| `agent-runtime/manager.mjs:466-467` | Modify | `done` authoritative only from `engine` |
| `agent-runtime/test/manager.test.mjs` | Modify | MGR-WALK-5 rewritten; new MGR-WALK-5b/5c |
| `agent-runtime/mailbox.mjs:143-160` | Modify (CORE_GUARD) | `route()` binds sender to outbox owner |
| `agent-runtime/server.mjs` (`routeNeedsApprover`, `/runtime/mail`) | Modify (CORE_GUARD) | Mail mutations need approver |
| `agent-runtime/test/mailbox.test.mjs`, `mailbox-http.test.mjs` | Modify | Forged-sender and 403 ratchets |
| `agent-runtime/manager.mjs:467, 566-592` | Modify | `taskId` carried; ship honesty; ship stage persisted |
| `agent-runtime/jobs.mjs` | Modify | `summary.ship.*` fields; `resume()`; second-answer rule |
| `agent-runtime/test/manager-ship.test.mjs`, `pr-job-branch.test.mjs` | Modify | Honesty and recovery ratchets |
| `src/components/board/JobDetail.tsx` | Modify | Ship-outcome badge; resume button |
| `test/visual/jobboard.spec.mjs` | Modify | Playwright: badge and button render; snapshot |
| `agent-runtime/manager.mjs` (`validatePlan`, `requestHire`, `onHireDone`, replan) | Modify | Steps 7, 8, 9, 13 |
| `agent-runtime/worktree.mjs` (`create` gains `baseRef`) | Modify | Step 9 |
| `agent-runtime/workdir-guard.mjs` | Modify | Exports `assertCanonicalInside(root, rel)` |
| `agent-runtime/broker.mjs`, `pr.mjs`, `codemod.mjs` | Modify (broker is CORE_GUARD) | Call the shared helper |
| `agent-runtime/system-prompt.mjs`, `manager-prompts.mjs` | Modify | TEAM block; `strategy` prompt |
| `agent-runtime/guards.mjs:102, 244` | Modify (CORE_GUARD) | Widened CORE_GUARD; fail-closed seat |
| `agent-runtime/providers/engine-exec.mjs:67-72` | Modify (flagged) | Jailed spawn path |
| `agent-runtime/jobs.mjs:22-39` | Modify | `strategy` status and transitions |

---

# PHASE A — Honesty (steps 0–2)

**Goal.** You can see which job a message belongs to, and a task closes only on runtime evidence.

**Skills required, in order.** `principal-standard` (intake done above) → `sp-test-driven-development` → `ponytail` → `sp-verification-before-completion` → `mattpocock-skills:code-review` + `/code-review` → `code-reviewer` agent → `/qa` at phase exit.

**Gates.** G2 `tsc`, G3 `lint`, G4 the three test files below + boot check, G5 checklist (no new inputs from outside the process; env is trusted), G6 not applicable (no runtime surface changes), G7 diff list, G8 delivery report.

**NO COMMIT. NO PUSH.** Each task ends at STOP.

**Exit criterion.** Acceptance criteria 1 and 2 green; `test:runtime` subset green; `tsc` 0; three ratchets each with a recorded red line.

---

### Task 0: One startup config for CLI, desktop, tests

**Why.** `electron/main.cjs:91-99` spreads `process.env` but never reads the repo `.env`, so the packaged app runs the deterministic Manager and the Node 20 sandbox image while the documented live proof used `.env` values. One picker, one allow-list.

**Files:**
- Create: `electron/runtime-env.cjs`
- Modify: `electron/main.cjs:91-99`
- Test: `electron/test/runtime-env.test.mjs` (the electron runner is `node --test electron/test/*.test.mjs`)

- [x] **Step 1: Write the failing test**

```js
// electron/test/runtime-env.test.mjs
// Step 0 ratchet — the picker takes ONLY allow-listed RUNTIME_* keys, process env wins
// over .env, and a .env line that is not on the list is dropped.
// Mutation proof (record the red line here after Step 6): <fill after mutation>
import { test } from "node:test";
import assert from "node:assert/strict";
import rt from "../runtime-env.cjs";
const { pickRuntimeEnv, RUNTIME_ENV_ALLOW } = rt;

test("RTENV-1: allow-listed .env keys pass through; others are dropped", () => {
  const dotenv = [
    "RUNTIME_MANAGER_DISPATCH=claude",
    "RUNTIME_SANDBOX_IMAGE=node:24-alpine",
    "RUNTIME_STORY_MAX_CONCURRENT=2",
    "NOT_ON_THE_LIST=1",
    "# a comment",
    "",
  ].join("\n");
  const out = pickRuntimeEnv(dotenv, {});
  assert.deepEqual(out, {
    RUNTIME_MANAGER_DISPATCH: "claude",
    RUNTIME_SANDBOX_IMAGE: "node:24-alpine",
    RUNTIME_STORY_MAX_CONCURRENT: "2",
  });
});

test("RTENV-2: process env beats .env for the same key", () => {
  const out = pickRuntimeEnv("RUNTIME_MANAGER_DISPATCH=claude\n", { RUNTIME_MANAGER_DISPATCH: "deterministic" });
  assert.equal(out.RUNTIME_MANAGER_DISPATCH, "deterministic");
});

test("RTENV-3: the allow-list is closed — a key not in RUNTIME_ENV_ALLOW never appears", () => {
  const out = pickRuntimeEnv("RUNTIME_TOKEN_DIR=/tmp/x\n", {});
  assert.equal(out.RUNTIME_TOKEN_DIR, undefined, "TOKEN_DIR is set by main.cjs itself, never from .env");
  assert.ok(RUNTIME_ENV_ALLOW.includes("RUNTIME_MANAGER_DISPATCH"));
});
```

- [x] **Step 2: Run it — expect FAIL**

```bash
node --test electron/test/runtime-env.test.mjs
```
Expected: `Error: Cannot find module '../runtime-env.cjs'`

- [x] **Step 3: Minimal implementation**

```js
// electron/runtime-env.cjs
// Step 0 — ONE picker for the RUNTIME_* keys the desktop supervisor may take from the repo
// .env. Closed allow-list: a key not named here never reaches the child, so .env cannot
// redirect the token dir, the port, or the repo root (those are main.cjs's to set).
"use strict";

const RUNTIME_ENV_ALLOW = Object.freeze([
  "RUNTIME_MANAGER_DISPATCH",
  "RUNTIME_ENGINE_SPAWNER",
  "RUNTIME_SANDBOX_IMAGE",
  "RUNTIME_STORY_MAX_CONCURRENT",
  "RUNTIME_BACKEND",
]);

function parseDotenv(text) {
  const out = {};
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Allow-listed RUNTIME_* from `.env` text, with `processEnv` winning on conflict. */
function pickRuntimeEnv(dotenvText, processEnv) {
  const fromFile = parseDotenv(dotenvText);
  const out = {};
  for (const key of RUNTIME_ENV_ALLOW) {
    const v = processEnv?.[key] ?? fromFile[key];
    if (v !== undefined && v !== "") out[key] = String(v);
  }
  return out;
}

module.exports = { pickRuntimeEnv, RUNTIME_ENV_ALLOW, parseDotenv };
```

- [x] **Step 4: Run it — expect PASS (3/3)**

```bash
node --test electron/test/runtime-env.test.mjs
```

- [x] **Step 5: Wire `buildSupervisorEnv`**

Replace `electron/main.cjs:91-99` with:

```js
function buildSupervisorEnv() {
  let dotenv = "";
  try { dotenv = readFileSync(join(__dirname, "..", ".env"), "utf8"); } catch { /* no .env — picker returns only process env */ }
  const picked = require("./runtime-env.cjs").pickRuntimeEnv(dotenv, process.env);
  return {
    ...process.env,
    ...picked,
    RUNTIME_PORT: String(RUNTIME_PORT),
    RUNTIME_TOKEN_DIR,
    RUNTIME_BACKEND: picked.RUNTIME_BACKEND || "cli",
    WAAHYU_STATE_PATH: process.env.WAAHYU_STATE_PATH || join(app.getPath("userData"), "agent-status", "state.json"),
    ...(repoRoot ? { RUNTIME_REPO_ROOT: repoRoot } : {}),
  };
}
```

- [x] **Step 6: Mutation proof**

Remove `"RUNTIME_MANAGER_DISPATCH",` from `RUNTIME_ENV_ALLOW` → run → RTENV-1 red (`RUNTIME_MANAGER_DISPATCH` missing from the deepEqual). Record the red line in the test's header comment. Restore. `md5 -q electron/runtime-env.cjs` matches the pre-mutation hash. Re-run green.

- [x] **Step 7: Gates**

```bash
npm run typecheck && npm run lint && node --test electron/test/*.test.mjs
```

- [x] **Step 8: STOP.** Report `git -C "$M" diff --stat` and the three test lines. **Do not commit.** Wait for the BOSS.

---

### Task 1: Worker mail carries the job id

**Why.** `server.mjs:2139` binds `MA_MAIL_JOB_ID: ctx.goalId || ""` and `engine.mjs:366` never puts `goalId` on `ctx`. Every worker message ships `jobId: null` (confirmed in the live store). The job id is `task.storyId` for Manager-planned work (`signalManager` at `server.mjs:2924` already relies on this).

**Files:**
- Create: `agent-runtime/mail-env.mjs`
- Modify: `agent-runtime/server.mjs:2131-2143` (CORE_GUARD — named), `agent-runtime/engine.mjs:366`, `agent-runtime/mcp/mail-tools.mjs:22-23`
- Test: `agent-runtime/test/mail-env.test.mjs`

- [x] **Step 1: Write the failing test**

```js
// agent-runtime/test/mail-env.test.mjs
// Step 1 ratchet — the mail MCP env binds the JOB id from ctx.storyId (Manager-planned work
// carries the job id there, see server.mjs signalManager) and the GOAL id from ctx.goalId.
// A ctx with no storyId binds "" for the job, never the goal id in its place.
// Mutation proof: <record red line>
import { test } from "node:test";
import assert from "node:assert/strict";
import { mailEnvFor } from "../mail-env.mjs";

const roster = { all: () => [{ id: "sr-backend", role: "worker" }, { id: "tech-lead", role: "manager" }] };
const seat = { id: "sr-backend" };

test("MAILENV-1: job id comes from storyId, goal id from goalId", () => {
  const env = mailEnvFor({ seat, ctx: { storyId: "job_7", goalId: "goal_3", taskId: "task_9" }, roster, mailDir: "/tmp/m" });
  assert.equal(env.MA_MAIL_JOB_ID, "job_7");
  assert.equal(env.MA_MAIL_GOAL_ID, "goal_3");
  assert.equal(env.MA_MAIL_TASK_ID, "task_9");
  assert.equal(env.MA_MAIL_AGENT_ID, "sr-backend");
});

test("MAILENV-2: no storyId → job id is empty, NOT the goal id", () => {
  const env = mailEnvFor({ seat, ctx: { goalId: "goal_3", taskId: "task_9" }, roster, mailDir: "/tmp/m" });
  assert.equal(env.MA_MAIL_JOB_ID, "");
  assert.equal(env.MA_MAIL_GOAL_ID, "goal_3");
});

test("MAILENV-3: roles only — no writeScope leaks into the env", () => {
  const r = { all: () => [{ id: "sr-backend", role: "worker", writeScope: ["src/**"] }] };
  const env = mailEnvFor({ seat, ctx: {}, roster: r, mailDir: "/tmp/m" });
  assert.deepEqual(JSON.parse(env.MA_MAIL_ROLES), { "sr-backend": "worker" });
  assert.ok(!JSON.stringify(env).includes("src/**"));
});
```

- [x] **Step 2: Run — expect FAIL** (`Cannot find module '../mail-env.mjs'`)

```bash
node --test agent-runtime/test/mail-env.test.mjs
```

- [x] **Step 3: Minimal implementation**

```js
// agent-runtime/mail-env.mjs
// Step 1 — the env block for a seat's mail MCP server, as ONE pure function so the binding
// can be pinned without spawning anything. Job id = ctx.storyId (Manager-planned goals carry
// the job id there); goal id = ctx.goalId. Roles only — never a writeScope.
export function mailEnvFor({ seat, ctx, roster, mailDir }) {
  return {
    MA_MAIL_AGENT_ID: seat.id,
    MA_MAIL_DIR: mailDir,
    MA_MAIL_JOB_ID: ctx?.storyId || "",
    MA_MAIL_GOAL_ID: ctx?.goalId || "",
    MA_MAIL_TASK_ID: ctx?.taskId || "",
    MA_MAIL_ROLES: JSON.stringify(Object.fromEntries(roster.all().map((m) => [m.id, m.role]))),
  };
}
```

- [x] **Step 4: Run — expect PASS (3/3)**

- [x] **Step 5: Wire the three call sites**

`agent-runtime/engine.mjs:366` — add `goalId: task.goalId ?? null,` after `storyId: task.storyId ?? null,`.

`agent-runtime/server.mjs:2136-2143` — replace the inline `env: { ... }` object with `env: mailEnvFor({ seat, ctx, roster, mailDir: process.env.RUNTIME_MAIL_DIR || join(ENGINE_STORE, "mail") }),` and add `import { mailEnvFor } from "./mail-env.mjs";` beside the other local imports near `server.mjs:99`.

`agent-runtime/mcp/mail-tools.mjs:22-23` — add `const GOAL_ID = process.env.MA_MAIL_GOAL_ID || null;` and include `goalId: GOAL_ID` beside `jobId: JOB_ID` on the outgoing message (one site: `mail-tools.mjs:102`, the send).

- [x] **Step 6: Existing suite still green**

```bash
node --test agent-runtime/test/mail-tools.test.mjs agent-runtime/test/manager-spawn-wiring.test.mjs agent-runtime/test/engine.test.mjs
```

- [x] **Step 7: Mutation proof** — in `mail-env.mjs` change `ctx?.storyId` to `ctx?.goalId` → MAILENV-1 red (`"goal_3" !== "job_7"`) and MAILENV-2 red. Record. Restore. `md5 -q` matches. Green.

- [x] **Step 8: Security pass** — `security-review` on the `server.mjs` hunk: the env block still carries roles only (MAILENV-3 pins it). G5 checklist: no new input from outside the process.

- [x] **Step 9: STOP.** Diff stat + test lines. **Do not commit.**

---

### Task 2: A worker's own `done` is progress, not proof

**Why.** `manager.mjs:466-467` closes a task on any `done` mail that names it. A worker's `mail_send done` with no diff closes the task; the job ships with one commit for three tasks (reproduced, P4). The runtime already synthesises the authoritative `done` as sender `engine` (`server.mjs:2911-2925`).

**Files:**
- Modify: `agent-runtime/manager.mjs:466-467`
- Test: `agent-runtime/test/manager.test.mjs` (MGR-WALK-5 already sends from `engine`; add 5b and 5c)

- [x] **Step 1: Write the failing tests**

Append to `agent-runtime/test/manager.test.mjs` after MGR-WALK-5:

```js
test("MGR-WALK-5b: a worker's own `done` is PROGRESS, not completion — the task stays building", async () => {
  const h = harness({ dispatch: scripted([{ ok: true, tasks: [{ title: "one", skillsRequired: ["api"], steps: ["s"] }] }]) });
  const j = h.jobs.create({ title: "t", brief: "b" });
  h.jobs.setStatus(j.id, "planned");
  await h.mgr.tick(j.id);
  const before = h.nowRef();
  h.setNow(before + 5_000);
  h.inbox.push({ from: "sr-backend", kind: "done", taskId: "task_1", changedPaths: ["src/lib/x.ts"], jobId: j.id });
  const r = await h.mgr.tick(j.id);
  assert.notEqual(r.action, "review", "a seat's word does not reach review");
  const [t] = h.jobs.tasks(j.id);
  assert.equal(t.status, "building");
  assert.ok(h.logs.some((l) => l.event === "worker-done-claim" && l.taskId === "task_1"), "the claim is logged, not applied");
});

test("MGR-WALK-5c: BAD/GOOD/UNRELATED — only `engine` closes; a manager `done` is ignored too", async () => {
  for (const [from, expect] of [["engine", "done"], ["sr-backend", "building"], ["tech-lead", "building"]]) {
    const h = harness({ dispatch: scripted([{ ok: true, tasks: [{ title: "one", skillsRequired: ["api"], steps: ["s"] }] }]) });
    const j = h.jobs.create({ title: "t", brief: "b" });
    h.jobs.setStatus(j.id, "planned");
    await h.mgr.tick(j.id);
    h.inbox.push({ from, kind: "done", taskId: "task_1", changedPaths: ["src/lib/x.ts"], jobId: j.id });
    await h.mgr.tick(j.id);
    assert.equal(h.jobs.tasks(j.id)[0].status, expect, `from=${from}`);
  }
});
```

- [x] **Step 2: Run — expect 5b and 5c FAIL** (task is `done` on the worker's mail)

```bash
node --test agent-runtime/test/manager.test.mjs
```

- [x] **Step 3: Minimal implementation** — replace `manager.mjs:466-467`:

```js
        if (m.kind === "done") {
          // Step 2 — a task closes on RUNTIME evidence only. The engine synthesises the
          // authoritative `done` from the task's own terminal transition (server.mjs
          // signalManager); a seat's own `mail_send done` is a claim, logged and counted as
          // progress so the stall clock moves, never applied. Found by probe P4: two tasks
          // closed with no diff, job shipped with one commit for three tasks.
          if (m.from !== "engine") {
            log({ event: "worker-done-claim", jobId: t.jobId, taskId: t.id, byAgent: m.from, at: clock() });
            touch(t.jobId);
            continue;
          }
          jobs.updateTask(t.id, { status: "done", deliveryId: m.deliveryId ?? t.deliveryId, changedPaths: m.changedPaths ?? t.changedPaths });
```

(`log` and `clock` are already in scope in `createManager`.)

- [x] **Step 4: Run — expect PASS**, including MGR-WALK-5 (unchanged, sends from `engine`).

- [x] **Step 5: Mutation proof** — change `m.from !== "engine"` to `m.from === "never"` → 5b red, 5c red on `sr-backend`. Record. Restore. Green.

- [x] **Step 6: Boot check + gates**

```bash
RUNTIME_MANAGER_DISPATCH=deterministic RUNTIME_ENGINE_SPAWNER=deterministic node --test agent-runtime/test/loop-paste-to-shipped.test.mjs
npm run typecheck
```

- [x] **Step 7: STOP.** **Do not commit.**

---

### Phase A exit

- [x] `/qa` — NOT RUN, by rule: it demands a clean tree and commits fixes (Rule 0). Covered instead by `code-reviewer` agent (approve-with-fixes, fixes applied) + G7 + rule 8.
- [x] `code-reviewer` agent on the combined diff — approve-with-fixes; 1 MEDIUM (quoted .env values) + 2 LOW, all three fixed (RTENV-4/5 added, main.cjs comment corrected). It re-ran all three mutations independently.
- [x] PES delivery report for Phase A — delivered in-session 2026-09-17; rows 0–2 ✅; Known Gaps: rule 8 (C15), JOBHTTP-8/9 load-sensitive, `/qa` excluded.
- [x] `npm run test:visual` — **✅ retroactively (2026-09-17 19:36): 32 passed / 1 skipped / 0 failed on the Phase A tree after the C15 refresh.** Earlier: ❌ pre-existing, fully attributed — Run 1 (load 96): 13 failed, 10 timeouts. Run 2 after the BOSS had the 6-day `next-server` killed (quiet host, 10.3 min): **11 failed / 21 passed, 0 timeouts** — 8 `toHaveScreenshot` mismatches against baselines all last committed in `62312d5` (2026-09-06), before the roster move and queue strip (2026-09-07) = **C15**; plus 3 routes (`inbox @ dark`, `schedule @ light`, `outputs @ light`) that never mount `<main>` in 45 s, same in both runs = **new C17**. Phase A changed no UI-bundle input. Baselines NOT updated — the BOSS has the diffs. Full table in STATE.md Phase A addendum.
- [x] Memory: Phase A record appended to `.planning/STATE.md` (2026-09-17); mockup republished with A marked complete + rule-8 gap.
- [x] **STOPPED. NOTHING COMMITTED.** HEAD `85796ae`. Awaiting the BOSS on: commit decision, C15 baseline refresh, Phase B go.

---

# PHASE B — Recovery (steps 3–6)

**Goal.** An approved job cannot vanish. Nobody can forge the Manager. Status tells the truth.

**Skills required, in order.** `mattpocock-skills:diagnosing-bugs` (steps 4, 6 are bug fixes — root cause first) → `sp-test-driven-development` → `security-review` + `security-reviewer` agent (steps 3, 6 touch auth and identity — BLOCKING) → `hallmark` → `impeccable` (step 5 badge, step 6 button: pick a direction, states before happy path, a11y as input) → `webapp-testing` + `playwright` (G6 for 5 and 6) → `react-reviewer` → `sp-verification-before-completion` → `/qa`.

**Gates.** G2–G5 as Phase A; **G6 mandatory** for steps 5 and 6 (Playwright screenshot of the badge and the resume control); G7; G8.

**NO COMMIT. NO PUSH.** Each task ends at STOP.

**Exit criterion.** Acceptance criteria 3–6 green; `test:visual` green with updated snapshots for `jobboard.spec.mjs`; one Playwright trace showing `blocked → resume → planned`.

### Task 3: Mail sender bound to the outbox owner; HTTP mail needs an approver

**Files:** `agent-runtime/mailbox.mjs:143-160` (CORE_GUARD), `agent-runtime/server.mjs` `routeNeedsApprover` (CORE_GUARD) and the `/runtime/mail` handlers, `agent-runtime/test/mailbox.test.mjs`, `agent-runtime/test/mailbox-http.test.mjs`.

**Tests to write first** (names and assertions; the file's existing `harness()` builds a root dir and a mailbox):
- `MBX-ROUTE-1: a file in <a>/outbox whose msg.from !== <a> is deleted at route, never delivered, and logged as mail-forged` — write `sr-backend/outbox/forged.json` with `from: "tech-lead", to: "hr", kind: "hire-request"`; call `route()`; assert `hr/inbox` empty, file gone, `log` has `{event:"mail-forged", byAgent:"sr-backend", claimed:"tech-lead"}`.
- `MBX-ROUTE-2: route() re-runs send() validation — a bad id shape is dropped` — outbox file with `id: "../x"`; assert dropped.
- `MBX-ROUTE-3: BAD/GOOD/UNRELATED — an honest worker→manager message still delivers` (the GOOD leg, so the ratchet cannot pass by refusing everything).
- `MBX-HTTP-1: POST /runtime/mail from a viewer session is 403` and `MBX-HTTP-2: GET /runtime/mail/:id does not archive` (assert inbox count unchanged after the read).

**Implementation.** In `route()`, after `JSON.parse`: `if (msg.from !== from) { unlinkSync(src); log?.({ event: "mail-forged", byAgent: from, claimed: msg.from, ... }); continue; }` then run the same shape checks `send()` runs (extract `validateEnvelope(msg)` from `send()` and call it from both). In `server.mjs`, add `/runtime/mail` (POST) to `routeNeedsApprover`; change the GET to `listJson` without archive.

**Mutation proof.** Remove the `msg.from !== from` check → MBX-ROUTE-1 red. Remove `/runtime/mail` from the approver list → MBX-HTTP-1 red.

**Security pass.** `security-review` on both hunks. STRIDE: spoof (closed by owner binding), tamper (envelope validation), replay (id uniqueness already enforced at deliver — verify the read site), elevation (approver gate).


**Executed 2026-09-17.** Tests: MBX-ROUTE-1/2/3 in `mailbox.test.mjs` (37/37), MBX-HTTP-1/2 in `auth-http.test.mjs` (31/31 — placed inside the active-auth window; the file's line ~348 deletes accounts back to solo, so anything appended after it runs ungated), `MAILHTTP-4` in `mailbox-http.test.mjs` rewritten from "read archives" to "read is a glance" (8/8). Implementation: `mailbox.mjs` `envelopeError()` shared by `send()` and `route()`, owner-bound `route()`, new `peek()`; `server.mjs:2740` approver gate, `:4988` GET → `peek`. Mutations: owner check → ROUTE-1 red (actual 1, expected 0); gate → HTTP-1 red (201 vs 403); both restored md5-identical. tsc 0, lint 0. Security review (`security-reviewer` agent): **approve-with-fixes** — 1 HIGH (the two audit events were dropped by `stories.appendMailLog`'s whitelist and lacked a `jobId`: forged mail was refused but recorded nowhere), 1 MEDIUM (an id-less planted file passed `envelopeError` and was written as `undefined.json`), 2 LOW (stale comments). All fixed red-first: `STORIES-MAILLOG-1` (whitelist + mutation), `MBX-ROUTE-4` (`requireId` on the route path + jobId on audit rows + mutation), an always-on `console.warn` sink in `server.mjs`'s mailbox `log` wiring, both comments corrected. The reviewer re-ran all three original mutations itself and confirmed the forged-identity and traversal holes are closed. `security-review` *skill* could not load (its preamble needs `origin/HEAD`, which this repo lacks; not set — git metadata). **Not committed.**

**STOP. Do not commit.**

### Task 4: Retry keeps its task identity; ship refuses a missing worktree by name

**Files:** `agent-runtime/manager.mjs:467` and the ship path `~566-592`, `agent-runtime/test/manager.test.mjs`, `agent-runtime/test/manager-ship.test.mjs`.

**Root cause first** (`diagnosing-bugs`): the `done` update at `:467` omits `taskId`; review at `:368` and ship at `:575` read the stale attempt id; `engine.mjs:303` removed that attempt's worktree on retry.

**Tests to write first.**
- `MGR-DONE-ID-1 (was MGR-RETRY-1; that name already existed): a done for attempt_two on goal_one sets the job task's taskId to attempt_two` — push `{from:"engine", kind:"done", taskId:"attempt_two", goalId:"goal_1", ...}` where the task was created with `taskId: "attempt_one"`; assert `tasks(j.id)[0].taskId === "attempt_two"`.
- `SHIP-1: a task whose pathFor(taskId) is null blocks the job with a reason naming the task, never returns silently` — inject `worktreeMgr.pathFor: () => null`; call `ship`; assert `job.status === "blocked"` and `job.summary.blockedReason` includes the task title.

**Implementation.** `:467` → add `taskId: m.taskId ?? t.taskId`. In `ship`, replace the silent `continue`/`return` on a null path with `jobs.setStatus(job.id, "blocked", { reason: \`no worktree for task "${t.title}" (${t.taskId})\` }); return { ok: false, reason };`.

**Mutation proof.** Remove `taskId:` from the update → MGR-RETRY-1 red. Restore the silent return → SHIP-1 red.


**Executed 2026-09-17.** Tests: `MGR-DONE-ID-1` in `manager.test.mjs` (46/46), `SHIP-1` in `manager-ship.test.mjs` (9/9); 55/55 together. Implementation: `manager.mjs:477` done update carries `taskId: m.taskId ?? t.taskId`; ship loop `~588` — a failed `commitTask` now `setStatus(jobId, "blocked", reason)` with the task title and id in the reason, then returns; previously returned silently into a decided gate. Mutations: taskId dropped → `actual: 'attempt_one', expected: 'attempt_two'`; block removed → `actual: 'awaiting-you', expected: 'blocked'`; both restored md5-identical. tsc 0. **Not committed.**

**STOP. Do not commit.**

### Task 5: `shipped` only when every task with paths committed; outcome recorded and shown

**Files:** `agent-runtime/manager.mjs` ship path, `agent-runtime/jobs.mjs` (`summary.ship.outcome`), `src/components/board/JobDetail.tsx`, `test/visual/jobboard.spec.mjs`.

**Tests to write first.**
- `SHIP-2: three tasks with paths, one commit → NOT shipped; blocked with reason listing the two uncommitted titles`.
- `SHIP-3: outcome is recorded — {local-branch | pushed | pr} — and shipped only when commits.length === tasksWithPaths.length`.
- `SHIP-4 (UNRELATED leg): a task with no changed paths and an explicit no-change flag does not block` (so the ratchet does not refuse honest no-ops).
- Playwright `jobboard.spec.mjs`: `ship outcome badge renders "local branch" / "pushed" / "PR #n" from summary.ship.outcome` — fixture a job with each outcome; `expect(page.getByTestId("ship-outcome")).toHaveText(/local branch/)`; snapshot.

**UI direction** (`hallmark` → `impeccable`): the badge is a status token, not a new surface. Reuse the existing status pill component in `JobDetail.tsx`; three states + loading/empty. Contrast ≥ 4.5:1 checked by the existing a11y-contract pattern. No new colour outside the design tokens.

**G6.** `npm run test:visual` green; screenshot attached to the delivery report.

**Mutation proof.** Change the guard to `commits.length > 0` → SHIP-2 red.


**Executed 2026-09-17.** Runtime: `SHIP-2/3/4` in `manager-ship.test.mjs` (12/12) — zero commits now blocks by reason (PES #39), `summary.ship.outcome` ∈ {pr, pushed, local-branch} derived once in `manager.mjs`. Mutations: guard `=== 0` → `=== -1` (SHIP-2 red), outcome hard-coded (SHIP-3 red); both restored. UI: `jobsClient.ts` gains `ShipOutcome`, `shipOutcome` on `Job` (parsed, closed set), `outcomeTone()`/`outcomeLabel()` — `JOBS-OUTCOME-1/2` in `jobsClient.test.ts` (15/15, mutation pr→amber red); `JobBoard.tsx:42` renders a second `helm-chip` (`data-testid="ship-outcome"`, semantic tone, aria-label carries it) only when an outcome exists. Fixture: the shipped job in `api.json` carries `summary.ship.outcome:"pr"` (one string value changed). Playwright: `toHaveText("PR")` + `toBeInViewport` after scroll + a **locator-level** `toHaveScreenshot` of the shipped card — the SHIPPED column is off-screen at every viewport, so the page capture cannot see the chip and a page-level green was vacuous. New baselines `jobs-shipped-card-{light,dark}.png` — **pending the BOSS's acceptance** (rule: snapshots update only after the diff is seen). impeccable: loader found no PRODUCT.md/DESIGN.md; applied the shared laws + product register directly (reuse, restrained, semantic tone); `/impeccable teach` recommended before Task 20. **Not committed.**

**STOP. Do not commit.**

### Task 6: Ship stage persisted; boot reconcile; resume route; second answer

**Files:** `agent-runtime/manager.mjs` (`ship` writes `summary.ship.stage` before each rung), `agent-runtime/server.mjs` boot (after `:6627` restore) and a new `POST /runtime/jobs/:id/resume` in **both** `routeNeedsApprover` and `needsAuth`, `agent-runtime/jobs.mjs:168` (`setAnswers` accepts a second call when a new question gate exists), `src/components/board/JobDetail.tsx` (resume button, approver only), `test/visual/jobboard.spec.mjs`.

**Tests to write first.**
- `SHIP-5: stage is persisted before branch, before commit, before push, before pr` — inject a failing `createBranch`; assert `summary.ship.stage === "branch"` and job `blocked` with `"ship failed after approval: <reason>"`.
- `BOOT-1: on boot, a job awaiting-you with no pending gate and no shipped → blocked with the persisted reason` — seed the DB, run the reconcile function (extract `reconcileStrandedJobs({jobs, deliveries})` so it is testable without booting).
- `RESUME-1: POST /runtime/jobs/:id/resume by approver moves blocked → planned; by viewer → 403; on a non-blocked job → 409`.
- `ANS-2: a second setAnswers succeeds when a new question gate exists, and is refused when none does` (BAD/GOOD).
- Playwright: `blocked job shows Resume; clicking it moves the status to planned` — use the existing `pages.mjs` fixtures; `await page.getByRole("button", { name: "Resume" }).click(); await expect(page.getByTestId("job-status")).toHaveText("planned")`.

**Security pass.** Resume is a state mutation → approver-only, in both gate lists (`routeNeedsApprover` AND `needsAuth` — addendum #20 is the class this closes).


**Executed 2026-09-17.** Runtime: `SHIP-5/6` (stage persisted before branch/commit/pr; branch failure blocks by reason), `MGR-RECOVER-1` (`reconcileStranded()`: awaiting-you + no gate → blocked; gated job untouched), `MGR-RESUME-1` (`resume()`: blocked→planned, else 409/404), `ANS-2` (`setQuestions()` clears answers → a new round is answerable), `RESUME-HTTP-1` (viewer 403 · approver 404 on a ghost · 409 on a non-blocked job · 401 with no session; route in `routeNeedsApprover` at `server.mjs:2795` AND `needsAuth`; boot reconcile after `engine.reconcile()`). Five mutations, all red at the assertion, all restored md5-identical. UI: `jobsClient.resumeJob()` (house `runtimeToken` pattern), `JobDetail` Resume control (`data-testid="job-resume"`, server enforces approver, refusal renders as the error line), `api.json` gains `GET /runtime/jobs/job_e5f6a1b2c3d4` (one entry, textual insert), Playwright opens the blocked card → asserts Resume → locator capture `jobs-blocked-detail-head-{theme}.png` — 2 passed on the confirming run, **baselines pending the BOSS's acceptance**. Two probe lessons recorded in the test: `--test-name-pattern` skips the account setup so the gate is inactive by design; an `await res.text()` in an assertion message consumes the body before `.json()`. **Not committed.**

**STOP. Do not commit.**

### Phase B exit

- [ ] `security-review` findings: zero HIGH/CRITICAL open.
- [ ] `npm run test:visual` green; snapshots updated with the diff shown.
- [ ] `/review` (read-only). `/qa` excluded under Rule 0 — see skill roster.
- [ ] Delivery report rows 3–6.
- [ ] `npm run test:visual` green (rule 8) — output pasted into the delivery report.
- [ ] Memory: phase record appended to `.planning/STATE.md`; mockup republished with this phase ✓ (rule 9).
- [ ] **STOP. NO COMMIT.**

---

# PHASE C — One reliable job (steps 7–11)

**Goal.** One job from paste to PR with every task's work preserved. **First milestone.** A live run on a throwaway clone happens at this phase's exit, with the BOSS present, before Phase D opens.

**Skills required, in order.** `mattpocock-skills:domain-modeling` (step 7: step / attempt / task / job are four things; write the model before the code) → `sp-brainstorming` for the step 9 base-strategy decision (● open question) → `mattpocock-skills:diagnosing-bugs` (10, 11) → `sp-test-driven-development` → `security-review` + `security-reviewer` (11 touches broker, pr, codemod — BLOCKING) → `sp-verification-before-completion` → `/qa` → **live run** (`agent-browser` to drive the cockpit; the BOSS answers the two stops).

**Gates.** G2–G5; **G6 = the live run** on the clone (`git clone "$M" /tmp/ma-trial`, `RUNTIME_REPO_ROOT=/tmp/ma-trial`, scratch `RUNTIME_*` roots) — evidence is the PR URL or the exact refusal text; G7; G8.

**NO COMMIT. NO PUSH.** The live run's `ma/job/*` branch lands in `/tmp/ma-trial`, never in `$M`.

**Exit criterion.** Acceptance criteria 7, 8, 9 green; one live job on the clone reaches `shipped` with `summary.ship.outcome === "pr"` or a named refusal the BOSS agrees with.

### Task 7: Single-step tasks, refused explicitly

**Domain model first.** A *step* is one model turn on one worktree. An *attempt* is one engine task id for one step. A *task* is a job row, closed only by the engine's terminal `done`. A *job* closes on the ship ladder. Until a chain exists, one task = one step, and `validatePlan` says so aloud.

**Tests.** `PLAN-STEPS-1: a plan with steps.length > 1 on any task is refused with a reason naming the task` (BAD); `PLAN-STEPS-2: one step passes` (GOOD). The plan prompt text gains the sentence "Each task has exactly one step." — pinned by `manager-prompts.test.mjs` per its existing prompt-gate rule.

**STOP. Do not commit.**

### Task 8: Hire response correlated to its request; scope checked

**Tests.** `HIRE-CORR-1: two awaiting-hire tasks (ui, test); one hire-done for the ui request assigns ONLY the ui task` — the probe that failed (P-F13) becomes the ratchet. `HIRE-CORR-2: a hire whose writeScope does not cover the task's steps-derived scope is not assigned; task stays awaiting-hire with reason`.

**Implementation.** `requestHire` persists `hireRequestId` on the task; HR echoes it in `hire-done`; `onHireDone` matches on it and calls `matchesWriteScope(stepsScope, hire.writeScope)` before assigning.

**STOP. Do not commit.**

### Task 9: Ship as you go — sequential base per task; replan touches un-started tasks only

**● Decision gate.** Confirm with the BOSS: commit each HELD task onto `ma/job/<id>` immediately and base the next task's worktree on that tip (chosen), or merge at the end. The plan proceeds on the chosen path only after the BOSS answers.

**Tests.** `SEQ-1: task A writes base+A; task B (created after A is HELD) starts from a tree containing A; the branch tip contains both` — the probe P-F08 reversed. `SEQ-2: replan after A is HELD reorders only B and C; A's commit is intact and A is not re-planned`. `SEQ-3: final approval pushes/opens the PR from the branch tip, not from a fresh copy`.

**Implementation.** `worktree.create(key, { baseRef })`; Manager calls `commitTask` on HELD (existing ladder) then creates the next worktree with `baseRef: "ma/job/<id>"`. Replan filters `tasks.filter(t => t.status === "planned")`.

**Security pass.** Git operations on the operator's repo — `security-review` on the branch/base logic.

**STOP. Do not commit.**

### Task 10: Review diff includes new files; tree hash pinned

**Tests.** `DIFF-1: a new untracked src/new.ts appears in diffFor()` (probe P-F11 reversed). `DIFF-2: a staged-only change appears`. `DIFF-3: the gate body records the assembled branch's tree hash; ship refuses if HEAD^{tree} moved` (BAD/GOOD).

**Implementation.** `diffFor` → `git add -N -- <paths>` then `git diff HEAD --`; record `git rev-parse <branch>^{tree}` in the gate; compare at ship.

**STOP. Do not commit.**

### Task 11: Symlink-safe writers via one shared helper

**Tests** (the Codex probes P2/P3 become ratchets): `CANON-1: broker refuses src/alias/out.txt when src/alias → ../docs, and docs/ is untouched`. `CANON-2: commitTask refuses a tracked symlink destination; the outside file is unchanged`. `CANON-3: codemod refuses a symlinked parent`. `CANON-4 (GOOD): a real nested path under scope still writes`.

**Implementation.** `workdir-guard.mjs` exports `assertCanonicalInside(root, rel)` — `realpath` of the parent must equal the lexical parent, and the canonical destination must match scope. Broker (`:266-282`), `pr.mjs commitTask` (`:453-463`), `codemod.mjs` (`:135-181`) all call it before any mutation.

**Security pass.** BLOCKING. `security-reviewer` agent on all three hunks; verify no write precedes the check (addendum "refusal before side-effect").

**STOP. Do not commit.**

### Phase C exit — the live run

- [ ] Clone: `git clone "$M" /tmp/ma-trial`. Scratch roots: `RUNTIME_REPO_ROOT=/tmp/ma-trial RUNTIME_MAIL_DIR=/tmp/ma-mail RUNTIME_TOKEN_DIR=/tmp/ma-tok` (and the DB/engine-store roots — read `server.mjs:279-310` for the full list; every durable root overridden, addendum #49).
- [ ] Start the runtime with `RUNTIME_MANAGER_DISPATCH=claude` and `RUNTIME_BACKEND=cli`.
- [ ] `agent-browser` drives the cockpit: paste the run-sheet job ("add an endpoint, add a test, add a doc line" — three tasks, two seats). The BOSS answers clarify and gives the yes.
- [ ] Evidence: `summary.ship.outcome`, the branch tip in `/tmp/ma-trial`, and `gh pr view` output if a PR opened. Attach to the delivery report.
- [ ] `/review` (read-only). `/qa` excluded under Rule 0 — see skill roster. Delivery report rows 7–11.
- [ ] `npm run test:visual` green (rule 8) — output pasted into the delivery report.
- [ ] Memory: phase record appended to `.planning/STATE.md`; mockup republished with this phase ✓ (rule 9).
- [ ] **STOP. NO COMMIT.** `/tmp/ma-trial` is deleted only when the BOSS says.

---

# PHASE D — A team that talks (steps 12–15)

**Goal.** Frontend asks backend, backend answers, frontend continues. Nobody relays. **This is the USP.**

**Skills required, in order.** `mattpocock-skills:writing-for-agents` (step 12: the TEAM block is a document an agent consumes — leading words, completion criteria, no negation-steering) → `sp-test-driven-development` → `mattpocock-skills:code-review` → `sp-verification-before-completion` → `/qa` → second live run on the clone.

**Gates.** G2–G5; **G6 = live run** with two seats and one real question; G7; G8.

**NO COMMIT. NO PUSH.**

**Exit criterion.** Acceptance criteria 10 and 11 green; a live job where `sr-frontend`'s mail thread shows `question → answer → resumed` and the resumed task's brief contains the answer text.

### Task 12: Workers get a TEAM block and read mail first

**Test.** `PROMPT-TEAM-1: seatSystemPrompt(seat, job) contains a TEAM block listing every worker id with its skills, the job id and title, and the instruction to call mail_read before starting` — assert on structure (a parsed block), never on prose. `PROMPT-TEAM-2: the block names peers by id — "sr-backend" — not by skill — never "the api seat"`.

**Writing rule** (`writing-for-agents`): state the positive ("Read your mail, then start"), one completion criterion ("You have read every message addressed to you"), no prohibitions.

**STOP. Do not commit.**

### Task 13: An `answer` re-enqueues the blocked task once

**Tests.** `MGR-ANS-1: a task blocked on question q1; an answer naming q1 re-enqueues the task once with the answer appended to its brief; the persisted counter is 1`. `MGR-ANS-2: a second answer for the same question does NOT re-enqueue (counter stays 1)`. `MGR-ANS-3 (UNRELATED): an answer naming an unknown question is logged and ignored`.

**Implementation.** Manager's inbox drain handles `kind === "answer"`: find the task by `m.questionId` (worker's `blocked` mail must carry `questionId`), guard `resumeCount < 1`, call `engine.enqueueGoal` with the answer in the brief, persist `resumeCount`.

**STOP. Do not commit.**

### Task 14: Concurrency 2 for disjoint-path tasks

**Tests.** `CONC-1: two tasks with disjoint paths[] both claim under RUNTIME_STORY_MAX_CONCURRENT=2` (the P-C1 probe reversed). `CONC-2: two tasks with overlapping paths — only one claims`. Both against the real `queue.mjs` claim path.

**Implementation.** Planner emits `paths[]`; Manager computes overlap; the queue's per-story cap becomes per-overlap-group. `server.mjs:1597` default stays 1 until Phase C's live run passed.

**STOP. Do not commit.**

### Task 15: Manager tick lease

**Test.** `TICK-1: a second tick for a job whose first tick has not settled is skipped and logged` — inject a `manager.tick` that returns a pending promise; call the heartbeat body twice; assert one call.

**Implementation.** `const inflight = new Set()` in the heartbeat at `server.mjs:6710-6720`; skip when `inflight.has(jid)`; delete on settle.

**STOP. Do not commit.**

### Phase D exit — the second live run

- [ ] Same clone. Job: "frontend needs the response shape of a new endpoint from backend." Two seats. The BOSS watches the mail thread.
- [ ] Evidence: `sr-frontend` thread shows `question`, `sr-backend` thread shows `answer`, `sr-frontend`'s task re-enqueued once with the answer in its brief.
- [ ] `/review` (read-only). `/qa` excluded under Rule 0 — see skill roster. Delivery report rows 12–15.
- [ ] `npm run test:visual` green (rule 8) — output pasted into the delivery report.
- [ ] Memory: phase record appended to `.planning/STATE.md`; mockup republished with this phase ✓ (rule 9).
- [ ] **STOP. NO COMMIT.**

---

# PHASE E — Boundaries (steps 16–18)

**Goal.** Safe to point at code you didn't write.

**Skills required, in order.** `security-review` + `security-reviewer` agent (every task — BLOCKING) → `docs-lookup` / context7 for the Claude CLI sandbox flags (step 18, before design) → `sp-brainstorming` for step 18's design (it changes the execution model) → `sp-test-driven-development` → `sp-verification-before-completion` → `/cso` (gstack security check) at exit.

**Gates.** G2–G5 with `security-review` output attached; G6 = a deliberate out-of-scope write attempt from a worker is refused with no side-effect; G7; G8.

**NO COMMIT. NO PUSH.**

### Task 16: Protected floor — fail-closed `applyAllowed`; CORE_GUARD widened

**Tests.** `GUARD-1: applyAllowed("src/x.ts", { seat: undefined }) is false on the engine and ship call sites` (BAD). `GUARD-2: the four documented legacy single-argument callers still pass` (GOOD — list them by file:line in the test). `GUARD-3: CORE_GUARD refuses agent-runtime/{factory,mailbox,manager,seat-settings-guard}.mjs and providers/*`.

**Implementation.** `guards.mjs:244` gains a `strict` option; engine and ship pass `strict: true`. `guards.mjs:102` list widened.

> **Record (2026-09-24) — ✅ built, mutation-proven.** Census (addendum #11/#17): the plan named
> four legacy callers; there are **7** `applyAllowed` sites. Legacy single-argument, pinned by file in
> GUARD-2: patch-edit ×1, policy ×2, factory ×1 (validates a spec, writes nothing), broker ×2
> (diagnostic wording after a refusal). Strict: `broker.seatVerdict` (engine broker only; the manual
> `/run` broker stays legacy — every apply there is a human click) and **both** pr.mjs ladders
> (`commitTask` = job ship, `deliverApproved` = P5), which now resolve the seat from the TASK via
> an injected `seatFor`. A strict refusal says why: `no roster seat resolved for this task`.
> CORE_GUARD + factory, mailbox, manager, seat-settings-guard, `providers/.*` (second directory
> clause). CG-1/CG-5 encoded providers/ as ordinary work — updated with the reason in-line.
> Tests: GUARD-1a–g, GUARD-1-WIRED (AST), GUARD-2 census, GUARD-2b, GUARD-3/3b — 12/12.
> Mutations **16/16 red**, each md5-restored. Addendum #75.

**STOP. Do not commit.**

### Task 17: Target-repo scripts gated

**Test.** `SCRIPTS-1: with RUNTIME_REPO_ROOT ≠ MissionAlpha, reportBack/escalateFn emit to the bus and spawn nothing` (assert `child_process.spawn` not called via an injected spawner). `SCRIPTS-2: on MissionAlpha itself, or with RUNTIME_ALLOW_REPO_SCRIPTS=1, the script runs`.

> **Record (2026-09-24) — ✅ built, mutation-proven.** One gate, `agent-runtime/repo-scripts.mjs`
> (CORE_GUARD): trusted iff target == this runtime's repo, or `RUNTIME_ALLOW_REPO_SCRIPTS` is the
> literal `1`. Untrusted ⇒ `bus.script-skipped` on `events`, nothing spawned; spawn failure ⇒
> `bus.script-failed` (no more empty catch). Census found a THIRD bash spawn (factory
> `announceOnBus`) — premise-checked: NOT a hole, factory's own `REPO_ROOT` is always the runtime
> repo (addendum #76); routed through the gate anyway. Tests SCRIPTS-1/2/2b/3/4/SELF/WIRED/
> BUS-WIRED/GUARD — 9/9. Mutations **12/12 red**, md5-restored.

**STOP. Do not commit.**

### Phase E security pass (2026-09-24) — independent `security-reviewer` on the 16/17 diff

| # | Finding | Sev | State |
|---|---|---|---|
| 5 | Chat `cliReply` spawns `claude -p` with cwd = target repo; `-p` skips trust (docs: *"Trust verification is disabled when running non-interactively with the -p flag"*) ⇒ a foreign repo's `.claude/settings.json` hooks run on the host | HIGH | ✅ fixed: untrusted target ⇒ `--setting-sources user` (operator rules kept). SETSRC-FOREIGN-1, 3 mutations red. The old "chat never gains the flag" test now pins "never `project`" |
| 1 | Non-git target: `POST /runtime/task_…/apply` read the engine's copy-sandbox through the NON-strict manual broker | MED | ✅ fixed: route picks its broker by key (`brokerFor`). GUARD-5 census: no bare `applyChanges` in server.mjs |
| 3 | `i` without `u` folds ASCII only; `guardſ.mjs`/`hooKs.mjs` are the same inode on APFS | MED | ✅ fixed: `iu` on CORE_GUARD, APPLY_DENY (`id.Key`) and PUBLIC_DENY (`.jſ`). GUARD-4/4b, 3 mutations red |
| 4a | `workdir-guard.mjs` (assertCanonicalInside) appliable | MED | ✅ added to CORE_GUARD, mutation red |
| 8 | `repo-scripts` missed spawn's async `error` event ⇒ server crash if bash missing | LOW | ✅ fixed: SCRIPTS-4b; a fake-only `?.` guard removed (spy is now a real EventEmitter) |
| 2 | Strict refuses only an UNRESOLVED seat; a resolved `station`/`manager` seat (`writeScope: []`) still gets the legacy set on the engine path (`/runtime/engine/enqueue` takes any agentId; cadences enqueue `sre`) | MED | ✅ **accepted by the BOSS 2026-09-24** — "keep station seats legacy" |
| 4b | engine.mjs, tool-broker.mjs, mcp/mail-tools.mjs, mail-env.mjs appliable; CONFIG_GUARD covers root package.json only | MED | ✅ 2026-09-24: floor + those four + manager-prompts/manager-dispatch/deliveries (GUARD-3); every package.json guarded by basename, NFKC (CFG-NEST-1…8) |
| 6 | `manager-dispatch.mjs:163` falls back to cwd = repoRoot (with `--setting-sources project`) when the worktree cannot be created | **HIGH** (re-rated by /cso: a non-git target ALWAYS takes this path) | ✅ fixed: untrusted repo + no isolated worktree ⇒ stage refused, nothing spawned. MD-UNTRUSTED-1/2/WIRED, 3 mutations red |
| 7 | `gh pr create` runs git without GIT_SAFE_ARGS (fsmonitor) | MED, unverified (probe stopped at 401) | ✅ closed by mechanism 2026-09-24: the runner's env carries GIT_SAFE_ARGS as GIT_CONFIG_* for every child (PR-GITENV-0…3) |
| — | `factory.mjs:578` `claude` spawn with cwd REPO_ROOT | — | ✅ not a hole: factory's REPO_ROOT is the runtime's own repo (addendum #76) |

**/cso (2026-09-24, `--diff --code`, daily 8/10 gate):** 2 HIGH reported, both fixed in session (chat path #5,
Manager fallback #6). No secrets in the diff, no new dependencies. Report: `.gstack/security-reports/2026-09-24-131908.json`
(`.gstack/` is not gitignored — untracked, do not commit by accident). **Open HIGH/CRITICAL: 0.**

### Open-MEDIUM + defer-no pass (2026-09-24, BOSS: "fix the open mediums and the defer-no gap")

| Item | State |
|---|---|
| DEFER-NO — a deferred job could not be told "no" through `/answer` | ✅ strict whole-token yes/no (NFKC, curly quotes); no → gate rejected, job blocked "deferred"; anything else → 400. E2E on a live server (DEFER-NO-E2E-1/2). Deterministic brief "defer" drives it |
| Found by mutation D8: `/answer`'s no-gate fallback approved a job waiting on SHIP approval (re-plan of finished work) | ✅ `/answer` requires an open question gate; fallback deleted (ANSWER-GATE-1) |
| Bulk approve could answer the CEO's "Proceed anyway?" (even high-risk-confirmed) | ✅ bulk approve skips job question gates (DEFER-NO-E2E-3); bulk reject unchanged |
| Nested `package.json` exec keys unguarded (Phase E #4b) | ✅ `configGuardKeys` by basename + NFKC; broker, both pr ladders, policy (CFG-NEST-1…8) |
| `gh` runs its own git without hardening (Phase E #7) | ✅ runner env (PR-GITENV-0…3) |
| Control-plane files appliable (Phase E #4b + re-review HIGH) | ✅ floor += engine, tool-broker, mail-tools, mail-env, manager-prompts, manager-dispatch, deliveries, users, risk, patch-edit, task-diff, jobs, deploy, story-deploy, adapters/github, station-perms, perm-mode, worker-cap, trust, inject-detect, mcp/ash-tools, engine-spawner, pipeline, db, hr (GUARD-3/6) |
| Runtime state under agent-runtime/ appliable (engine-store MCP connectors = host commands; threads; token) | ✅ CORE_GUARD dir clauses + `.runtime-token` (GUARD-8) |
| Lockfiles, `.npmrc`/`.yarnrc`/`.pnpmfile.cjs` appliable; CONFIG_GUARD missing overrides/resolutions/pnpm/workspaces/imports | ✅ APPLY_DENY + keys (GUARD-7/9, CFG-NEST-8) |
| Review diff ran a seat worktree's fsmonitor / external diff / clean filter / textconv | ✅ task-diff: GIT_SAFE_ARGS + filter neutralisers + `--no-textconv --no-ext-diff` (GITSAFE-1/3); census of every literal git spawn (GITSAFE-2) — found 6, fixed 5, 1 reviewed exemption |
| **Open — BOSS decision:** ~60 other runtime modules are still appliable and run with host privilege; a named list cannot be complete | ✅ 2026-09-27 BOSS: "go with #1". `RUNTIME_FLOOR` — everything under `agent-runtime/` outside `test/` and `__tests__/` is refused for every caller and seat (66 modules + 2 JSON + any new path). Allowlist of named runtime files is EMPTY: no module qualified. RTF-1…7; see record below |
| **Open — BOSS decision:** `agent-runtime/test/**` appliable (a diff could weaken a ratchet; it is human-approved, never auto) | ⬜ |
| **Open — MEDIUM:** clean filters on the add/commit write paths (broker/worktree/pr) — blanking filters there breaks Git-LFS | ⬜ needs an LFS-aware design |
| **Open — MEDIUM (pre-existing):** an Inbox Approve on a job question card advances the job without recording answers | ⬜ recommend an answer box on the card that posts to `/answer` |

Two independent security reviews (opus) ran on this pass; every fix above is mutation-proven. Addendum #79, #80.

### Decision #1 — agent-runtime/ deny-by-default (2026-09-27, BOSS: "go with #1, keep going until done")

> **Record — ✅ built, uncommitted.** `guards.mjs` `RUNTIME_FLOOR = /^agent-runtime\/(?!(?:test|__tests__)\/)/iu`,
> checked in `applyAllowed` right after CORE_GUARD, before SEED_DIRS and writeScope — so every write path inherits it
> (engine + manual broker, `pr.commitTask` / `deliverApproved`, `policy.isAutoSafe` auto-apply, `patch-edit`, factory
> hire check; census: every caller routes through `applyAllowed`). The named-exception allowlist is empty: no runtime
> module qualified. CORE_GUARD rows kept — `fatalScopeProblem` still refuses a literal CORE_GUARD scope entry.
> **Tests** `runtime-floor.test.mjs` RTF-1…7 + 6b/6c (9): whole-tree census (66 modules + `imported-agents.json` + `package.json`),
> new paths and look-alike dirs, GOOD test dirs + src/docs untouched, premise "runtime never imports a test dir" (AST),
> broker end-to-end, ship ladder, symlink out of a test dir. RED first: 4 of 7 failed on the old code for the right reason.
> **Mutations** (md5-restored): M1 remove the floor check → RTF-1/2/5/6/6c red; M2 a runtime module importing `./test/…` → RTF-4 red.
> A first "deletion is refused" test was VACUOUS (job-ship `commitTask` refuses every deletion as unreadable) — M1 left it
> green; rewritten on the P5 ladder with a premise arm (RTF-6b: the deletion lands when the gate allows it).
> **Gates:** runtime full suite **2843/2843**, exit 0 (before the RTF-6b rewrite; `runtime-floor.test.mjs` 9/9 after it —
> +1 test net) · unit 601/601 · tsc 0 · eslint on every touched file 0 · **Playwright 32 passed / 1 skipped / 0 failed**.
> An earlier full run at load 311 had 1 timing failure (`engine.test.mjs` self-heal, 20 ms sleeps, writes no files):
> 61/61 alone, and green in the final full run.
> **11 older tests pinned the old design** (CG-1/5, GUARD-2b/3b/6, WS-3/8, CFG-NEST-4/5/6/7): updated with in-line reasons;
> CORE_GUARD exactness now asserted on the regex; CFG-NEST fixtures moved to `src/widget/package.json` so nested-package
> coverage is kept, not lost.
> **Runtime proof (G6):** real server (`.env`, :3006), manual `/apply` on a staged sandbox → `agent-runtime/kpis.mjs`
> `"path not allowed"`, md5 unchanged; `agent-runtime/test/zz-g6-probe.test.mjs` landed (then deleted).
> **Independent security review:** no bypass found in the floor (case, Unicode fold, `..`, `//`, trailing dot/space,
> symlink, `.claude/` all probed). HIGH, pre-existing and not specific to this change: CI runs agent-authored code
> (`ci.yml` on every push, no `permissions:` block) — decision #2 alone would not close it, because src/ code runs there too.

### Task 18: Worker spawn inside the jail — flagged

**Before design.** `docs-lookup`: current Claude CLI sandbox settings. Record what exists.

**Design** (`sp-brainstorming`, presented to the BOSS before code): Option 1 — spawn the `claude` child inside the existing Docker jail (`sandbox.mjs`) with the worktree mounted. Option 2 — enable the CLI's own sandbox setting if it provides an OS boundary. Option 3 — both, flag-selected. Recommendation after the docs check.

> **Record (2026-09-24) — ✅ built (Option 2, BOSS: "go with option 2, keep station seats legacy").**
> `agent-runtime/worker-jail.mjs` (CORE_GUARD): `--settings {"sandbox":{enabled, allowUnsandboxedCommands:false,
> failIfUnavailable:true, filesystem.denyRead:[~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh, ~/.claude/.credentials.json]}}`
> on every claude worker spawn (codex excluded — unknown flag; it has its own sandbox). Mode: `RUNTIME_WORKER_JAIL=off`
> ⇒ off; unset ⇒ on iff the target is untrusted (Task 17's decision); any other value ⇒ on (typo fails closed).
> Readiness carries `workerJail` + `warnings` (JAIL-2). Tests JAIL-MODE-1/2, JAIL-1 (argv), JAIL-2, JAIL-GUARD,
> JAIL-WIRED-1/2/3 — 8/8; mutations 14, all red (J13 needed a codex case added first).
> **JAIL-1 LIVE (CLI 2.1.187, haiku):** control run of `./build.sh` wrote `~/.ma-jail-probe-…` (file YES);
> jailed run → `./build.sh: line 3: …: Operation not permitted`, file **no**. First probe was void — the model
> declined in both arms (addendum #77).
> **Station seats:** BOSS decision 2026-09-24 — keep the legacy allow-set (security-pass #2 closed as accepted).

**Test.** `JAIL-1: with RUNTIME_WORKER_JAIL=docker, a worker Bash write to an absolute path outside the worktree fails and the file does not exist`. `JAIL-2: with the flag off, readiness reports "workers run on the host" as a warning`.

**STOP. Do not commit.**

### Phase E exit

- [x] `npm run test:visual` green (rule 8) — 32 passed, 1 skipped, 0 failed, exit 0 (2026-09-24).
- [x] Memory: phase record appended to `.planning/STATE.md`; mockup republished with this phase ✓ (rule 9).
- [x] `/cso` (2 HIGH found, both fixed). Independent security review: 0 open HIGH/CRITICAL. Delivery report rows 16–18. **STOPPED. NOTHING COMMITTED.**

---

# PHASE F — Structure and the CEO (steps 19–20)

**Goal.** `server.mjs` is a composition root, not a monolith. The CEO is a job status.

**Skills required, in order.** `mattpocock-skills:codebase-design` (extraction boundaries — write them before moving a line) → `sp-writing-plans` (a sub-plan per extraction; each is its own task list) → `sp-test-driven-development` (boot harness first) → `mattpocock-skills:domain-modeling` (step 20: `strategy` as a state) → `mattpocock-skills:writing-for-agents` (the `strategy` prompt from `ceo.md`) → `hallmark` → `impeccable` (the `strategy` status on the board) → `playwright` (G6) → `react-reviewer` → `/qa` + `/review`.

**NO COMMIT. NO PUSH.** Step 19 is "eight commits' worth" in the Codex order — executed as eight **uncommitted** extraction tasks, each leaving the boot harness green. The BOSS commits, if at all, at their own cadence.

### Task 19: `server.mjs` decomposition

Follow the Codex eight-step order exactly (`MissionAlpha-review.md` §"Incremental server decomposition"). Each extraction: write the boot harness assertion first (`BOOT-N`), extract behind the existing call site, old path delegates, no duplicate owner. Sub-plan per extraction under `docs/superpowers/plans/2026-09-XX-server-split-N.md`.

**STOP after each extraction. Do not commit.**

### Task 20: CEO as job status `strategy`

**Tests.** `JOBS-STRAT-1: NEXT.intake includes "strategy"; NEXT.strategy = ["clarify","planned","blocked"]`. `MGR-STRAT-1: a strategy verdict "proceed" → clarify; "kill" → blocked with the WHY; "defer" → a question gate`. `PROMPT-STRAT-1: the strategy prompt is built from .claude/agents/ceo.md and asks for VERDICT/WHY/COSTS/CHEAPER/ASSUMES` (structure, not prose). Deterministic mode returns `proceed`. Playwright: the board shows `strategy` as a status with the verdict on the job card.

**Mailbox stays closed to `ceo`** (`mailbox.mjs:48` unchanged). The CEO is a Manager pre-stage, dispatched through `managerDispatch`, never a bus participant.

> **Record (2026-09-24) — ✅ built, mutation-proven, BOSS-approved, proven live (run 10).**
> - Store: `strategy` in JOB_STATUSES; NEXT `intake → strategy`, `strategy → clarify | planned | blocked` (as specified),
>   `blocked → … strategy, clarify` for resume. **Migration 26** rebuilds `jobs` to widen the CHECK — proven on a REAL
>   v25 database with rows (every column byte-for-byte, both indexes, the uniqueness index still refusing).
> - CEO turn: `strategyPrompt` = `.claude/agents/ceo.md` (runtime's own copy, front-matter stripped) + fenced brief +
>   fenced intake findings + read-only rules + the five labelled lines. `parseVerdict` takes the LAST of each label,
>   tolerates bold, and refuses a missing/unknown verdict or a verdict with no WHY. Deterministic mode → `proceed`.
> - Manager: intake always → `strategy`; proceed → clarify; kill → blocked `CEO: kill — WHY`; defer → the CEO's case
>   is the FIRST question in the BOSS's gate (a dropped Manager question is logged); anything else → blocked.
> - **Approval is enforced**: `STRATEGY_PROMPT_APPROVED = false` with the header at `_PENDING BOSS_`; claude-mode
>   strategy refuses until both flip together (REV-8, REV-8-WIRED). Deterministic mode is unaffected.
> - UI: Strategy column (brass), `CEO: verdict` chip on every card after it (proceed green, defer amber, kill red).
>   Playwright: new `jobs-strategy-card` / `jobs-defer-card` captures; the six board page baselines were re-shot for
>   the new column and inspected by eye before acceptance.
> - Independent review (code-reviewer, opus): 0 CRITICAL/HIGH; fixed #1 (a gate decision/answer on a job not
>   awaiting-you could skip the CEO — guard in `onGateDecided` + 409 in `/answer`), #2 (resume went straight to
>   planned — now back to strategy if never judged, clarify if questions are unasked; legacy jobs untouched), #4
>   (migration test could not see data loss), #6 (findings unfenced; brief fence case-sensitive), #7 (silent question
>   drop), #8 (approval was a sentence). **Open:** #3 — a deferred job's question cannot be answered "no" through
>   `/answer` (Ash); rejecting the gate in the Inbox works. Proper fix: a dedicated strategy gate kind (a deliveries
>   migration). #5 — `.claude/agents/ceo.md` is UNTRACKED; it must be committed with this change.
> - Tests: strategy.test 29, client JC-STRAT-1/2/3, JOB-16 now reads the live CHECK. Mutations **36**, all red,
>   md5-restored (17 runtime, 6 client, 12 review fixes, 1 legacy-resume guard). Addendum #78.
>
> **LIVE RUN 10 (2026-09-24, CLI claude-mode, clone `/tmp/ma-trial10`, `job_69f15d7ab120`) — ✅ shipped.**
> CEO prompt approved by the BOSS the same day (header `APPROVED-BY: BOSS 2026-09-24` + `STRATEGY_PROMPT_APPROVED = true`).
> Target was foreign ⇒ worker jail ON (boot line + readiness `workerJail: true`), repo scripts off.
> intake 16:31 → **strategy: `proceed`** (1 CEO turn) → clarify (no questions) → planned → two seats in parallel →
> sr-frontend asked sr-backend → reply turn → answer → resumed once → both committed → review risk low → BOSS gate
> approved → **shipped `local-branch` 16:42:51**, 2 commits, `2 files, 129 insertions`. The CEO's memo named a
> CHEAPER option — "have ItemList `import type { Item }` from itemsApi.ts so the shape is compiler-enforced" — and
> the shipped `ItemList.tsx` does exactly that (`import type { Item } from "@/lib/itemsApi"`). Verdict survives ship.
> **Not captured live:** the worker argv (`--settings` sandbox) — the server does not log argv and the seats run with
> `--no-session-persistence`; it rests on JAIL-WIRED-1/2 + the live process reporting the jail ON + JAIL-1's live
> probe with the same JSON. No worker attempted an out-of-worktree write, so no denial was observed. The repo-scripts
> gate was not exercised (no apply route or terminal failure in this job).

**STOP. Do not commit.**

### Phase F exit

- [x] `npm run test:visual` green including the `strategy` status snapshot (rule 8) — 32 passed, 1 skipped, 0 failed (2026-09-24).
- [x] Memory: phase record appended to `.planning/STATE.md`; mockup republished (rule 9) — F shown as 20 ✓, 19 not started.
- [x] Review (read-only; independent code-reviewer agent standing in for `/review`). Delivery report row 20. **Row 19 not started.**
- [ ] **STOP. NO COMMIT.**

---

## Testing strategy — how the whole plan is proven

**TDD loop per task** (`sp-test-driven-development`): write the test → run, watch red, read the red line → smallest code → run, green → mutation → restore → green.

**Ratchet proof** (addendum #13): one real call site removed, red line recorded in the test docstring, `md5 -q` restore check, BAD/GOOD/UNRELATED trio preferred.

**Unit vs runtime vs Playwright.**

| Layer | Runner | Covers |
|---|---|---|
| Pure modules | `node --test agent-runtime/test/<x>.test.mjs` | mail-env, manager, mailbox, guards, jobs |
| UI logic | `npm run test:unit` | queueModel-style selectors |
| Runtime contract | `npm run test:runtime` (serial, quiet host) | boot check, paste-to-shipped, HTTP gates |
| Visual + interaction | `npm run test:visual` (Playwright) | badge (5), resume (6), `strategy` status (20) |
| Live | `agent-browser` on `/tmp/ma-trial` | Phase C and D exits |

**Acceptance scenario mapping** (from the brief's minimum milestone):

| Scenario line | Proven by |
|---|---|
| Human creates one task | Phase C live run |
| CEO turns it into an objective | Task 20 + Phase F Playwright |
| Manager creates a suitable team | Task 8 (HIRE-CORR) + live run |
| Two workers exchange a necessary Q&A; the answer changes work | Tasks 12–13 + Phase D live run |
| QA finds a defect; owner fixes; QA verifies integrated result | Phase D live run with `qa` seat; SEQ-1 guarantees the fix lands on the shared base |
| Retry and restart lose nothing | MGR-RETRY-1, SHIP-5, BOOT-1 |
| Delivery accurately reported | SHIP-2/3, `summary.ship.outcome` |
| Two concurrent jobs | TICK-1 + MBX-ROUTE (per-job inbox correctness via jobId) |
| Unanswered dependency | MGR-ANS-3 + stall clock (existing `isStalled` tests) |
| Failed hire | HIRE-CORR-2 + existing `hire-failed` path |
| Unauthorized message/write | MBX-ROUTE-1, MBX-HTTP-1, CANON-1..3, GUARD-1 |
| Failed publication after approval | SHIP-5, BOOT-1, RESUME-1 |

**Playwright specifics.** Tests live in `test/visual/`, run by `playwright.config.mjs`. New assertions go in `jobboard.spec.mjs` using the existing `pages.mjs` fixtures and `harness.mjs`. Every UI-touching task adds: one role-based locator assertion, one snapshot, and runs `npm run test:visual` with the snapshot diff pasted into the delivery report. Snapshots are updated with `npm run test:visual:update` only after the BOSS sees the diff.

---

## Delivery report template (PES Part 7) — one per phase

```
## Delivery Report — Phase <X>
**Outcome:** <1–2 sentences>
**Scope ledger:** rows <n–m>: ✅ / ❌ + reason
**Acceptance criteria:** <each: ✅/❌ + test name>
**Gates:** G2 tsc <exit> · G3 lint <exit> · G4 <files> <pass/fail counts> · G5 <checklist + security-review output> · G6 <screenshot / PR URL / refusal text> · G7 <adversarial list with resolutions>
**Files changed:** <git diff --stat>
**Ratchets:** <name → recorded red line>
**Security:** <what was checked, findings, fixes>
**Known Gaps & Risks:** <mandatory; severity + suggested fix>
**Commit status:** NOT COMMITTED. Awaiting the BOSS.
```

---

## Self-review (sp-writing-plans)

**Spec coverage.** Every acceptance criterion 1–14 maps to a named test above. The brief's "two concurrent jobs / unanswered dependency / failed hire / unauthorized / failed publication" each map in the scenario table.

**Placeholder scan.** Phase A tasks carry complete code. Phases B–F carry test names with assertions, exact files and lines, and implementation direction; they are written to code level when their phase opens (this plan's own rule: detail one phase ahead, so a reordered phase does not waste code-level work). Two items are deliberately open and marked ●: the step 9 base strategy and the step 18 sandbox flags — both need a BOSS or docs answer that does not exist yet.

**Type consistency.** `mailEnvFor({ seat, ctx, roster, mailDir })` — same shape in the test, the module, and the `server.mjs` call. `summary.ship.{stage,outcome}` — same names in Tasks 5 and 6. `hireRequestId` — Task 8 only. `resumeCount` — Task 13 only.

**Scope check.** Six phases is more than one plan's worth. Each phase is executed as its own unit with its own exit gate and delivery report; Phase A is fully specified here, later phases are specified to task level and expanded on entry.

---

## Phase B — G7 adversarial review round (2026-09-17, applied before Phase B exit)

The reviewer read the Phase B diff (Tasks 3–6) and raised three findings. All three fixed
red-first in `agent-runtime/manager.mjs`, every fix mutation-proven, nothing committed.

| # | Sev | Finding (reviewer's words, condensed) | Fix | Test | Mutation red line |
|---|-----|----------------------------------------|-----|------|-------------------|
| Q4 | HIGH | `setQuestions()`'s answers-reset fixes only 1 of the 4 gate paths. `onHireFailed`, the building-stage `escalate` branch, and the building-stage blocked-with-no-replan branch all call `deliveries.mintGate({kind:"question"})` directly and never touch `jobs.questions` / `jobs.answers` — round 2 is unanswerable (409 forever) | `jobs.setQuestions(job.id,[q])` immediately before each of the three `mintGate` calls (`manager.mjs` onHireFailed, escalate, blocked-no-replan) | MGR-ANS-ROUND-1 / -2 / -3 (`manager.test.mjs`) | drop each `setQuestions` → ✖ the matching ROUND test, fail 1 |
| Q2 | MEDIUM | `resume()` reaches a `blocked→planned` re-plan that can orphan a still-live engine goal; refuse any job task still in a non-terminal engine-tracked status | `resume()` returns 409 naming the live tasks when any task is `status:"queued"` | MGR-RESUME-2 | drop the `live.length` refusal → ✖ MGR-RESUME-2, fail 1 |
| Q3 | LOW | `ship()`'s three rungs have no local try/catch — a throw from `pr.mjs` rejects into an already-decided gate instead of blocking the job | the three rungs wrapped; catch logs `job-ship-threw` and calls `blockShip(reason)` | SHIP-7 (`manager-ship.test.mjs`) | catch → `throw e` → ✖ SHIP-7, fail 1 |

**Vacuous-mutation catch (addendum #13, again).** The first MUT-C attempt anchored on the
8-space `jobs.setQuestions(job.id, [q]); // G7 HIGH…` line — which is a *substring* of the
10-space escalate line, so the patcher's `count(old)==1` assertion refused it. Without that
assertion the mutation would have silently hit the escalate site (already proven by MUT-A)
and MGR-ANS-ROUND-3 would have gone red for the wrong reason, reading as proof. Re-anchored
on the preceding `const q = …` line. Recorded in the test docstring.

Note on Q2's scope: the refusal covers `queued` only. A task in `building` is mid-flight in
the engine and a resume during that window is still possible; goal cancellation is the real
fix and is not in Phase B. Carried as a Known Gap.

## Phase B — exit checklist (2026-09-17)

| Rule | Requirement | State |
|------|-------------|-------|
| 0 | Nothing committed, pushed, stashed or branched | ✅ HEAD still `85796ae`, 40+ files modified in the working tree |
| 1–7 | Tasks 3–6 implemented red-first, every fix mutation-proven | ✅ 23 test ids verified present by name; every behavioural fix has a recorded red line |
| 8 | Playwright at every phase exit, load < 30 | ⏳ PENDING — host load (see STATE.md "The blocker") |
| 9 | STATE.md record + mockup tick | ✅ STATE.md `PHASE B RECORD`; mockup tick WITHHELD until gate 8 and the full runtime suite pass |
| — | G7 adversarial review | ✅ 3 findings (1 HIGH, 1 MEDIUM, 1 LOW), all fixed red-first |
| — | Validation coverage audit (`/gsd-validate-phase`) | ✅ `.planning/B-VALIDATION.md` — 22 claims, 20 COVERED, 1 PARTIAL, 2 limitations |

Two gates are deliberately NOT ticked. The mockup stays amber for Phase B until they produce a
number: a green tick against a contaminated run would be exactly the "80% presented as 100%"
this plan's Rule 0 exists to prevent.

### Skills used this round, and what each actually changed

| Skill | What it changed |
|-------|-----------------|
| `principal-standard` (PES) | Gate order and the evidence rule — two gates are recorded PENDING rather than claimed |
| `gsd-verify-work` | Reframed the exit as claim-by-claim verification; produced the per-claim table now in `.planning/B-VALIDATION.md` |
| `gsd-validate-phase` | The coverage audit itself — it is what surfaced L1 (identical light/dark baselines) and G2 (duplicate test names) |
| `sp-test-driven-development` | Red-first on all five G7 tests; each watched fail before the fix |
| `diagnosing-bugs` | The REDOS/roster failure: built the fast isolated loop BEFORE hypothesising, which is what showed a 0.26 ms failure cannot be load |
| `ponytail` | The roster fix reuses `factory.SKILL_CATALOG` (rung 2, in-repo code) instead of adding a fourth hardcoded copy |
| `/qa` (gstack) | NOT RUN — it requires a clean tree and commits its fixes, which Rule 0 forbids. Its substance (runtime QA of the UI surfaces) is covered by `test:visual`, which is gate 8 and is pending. |

## Phase C — execution record (2026-09-18)

Tasks 7–11 closed. The phase EXIT (live run) is outstanding and needs the BOSS.

| Task | Tests (all mutation-proven) | Probe closed |
|------|------------------------------|--------------|
| 7 | PLAN-STEPS-1/2, MP-STEPS-1 | — |
| 8 | HIRE-CORR-1/2 | P-F13 |
| 9 | SEQ-1, SEQ-1b, SEQ-2, SEQ-3, SEQ-4, SEQ-5, ENG-BASE-1, SEQ-WIRED-1 | P-F08 |
| 10 | DIFF-1/2/4/5/6, DIFF-WIRED-1, DIFF-3 (BAD+GOOD) | P-F11 |
| 11 | CANON-1/2/3, CANON-4 (GOOD), CANON-5 (no regression) | Codex P2/P3 |

**● Decision gate (task 9) — ANSWERED.** The BOSS chose *commit as you go*: each HELD task
commits onto `ma/job/<id>` immediately and the next worktree is cut from that tip.

**Prompt gate (task 7) — RESOLVED.** `planPrompt` gained the one-step rule, which re-opened the
`APPROVED-BY` gate per that file's own rule. The BOSS reviewed the exact two-line diff rendered
in place and approved: `APPROVED-BY: BOSS 2026-09-18`. The live run is unblocked.

**13 mutations this round**, each reddening only the test it belongs to. Three found real
problems the tests alone did not: two vacuous tests of my own (HIRE-CORR-1, CANON-2) and one
uncovered wiring hop (`server.mjs` dropping `baseRef`, which left ENG-BASE-1 green).

### Phase C exit — ✅ MET (live run 5, 2026-09-20)

- [x] The live run on an isolated clone with the BOSS present (clarify answer + ship yes).
- [x] Evidence, exactly as recorded by the run:
      `status: awaiting-you` → approved → `ship: {"branch": "ma/job/job_49d5f0028fb8",
      "commits": [{"sha": "9e1c5d7a37ab…", "paths": ["README.md"]}], "tree": null}`,
      `plan stages run: 1`, `outcome: local-branch`.
- [x] **STOP. NO COMMIT.** Honoured — `HEAD` is still `85796ae`.

Four runs failed before it. What each one cost is the useful part:

| Run | Ended | Cause |
|---|---|---|
| 1–3 | did not reach ship | isolation gaps in my own harness, not the product |
| 4 | `blocked` after 2600s | two tasks failed (`test-failed` ×4, `timeout` ×2); C23 — a task sat in `running` with nothing able to reap it |
| 5 | ✅ `shipped` | narrowed to ONE documentation task, with the reaper armed and `RUNTIME_AGENTS_DIR` set |

`"tree": null` in that summary is C32: the pin was computed at the seam and never wired to the
Manager. It is wired now and still has not run live.

**Three things Phase C did NOT prove**, and they are named here so no later reader mistakes run
5 for more than it was: a MULTI-task job has never shipped; a real PR has never been opened
(every trial clone had `origin` removed); and the tree pin has never been exercised in
production.

## Phase D — opening record (2026-09-20)

**Entered through its design blocker, not through its first task.** Step 14 is "concurrency 2
for disjoint-path tasks", and Phase C's own fix for probe P-F08 made dispatch SEQUENTIAL. The
fix for one phase is the blocker for the next, so the rule got a spec before it got a patch:
`docs/superpowers/specs/2026-09-19-ready-set-dispatch.md`.

| Decision | Answer |
|---|---|
| How is a dependency declared? | **(b) a declared `dependsOn` graph** — BOSS, 2026-09-20. Option (a), "`seq` means dependency", forbids all parallelism and is the status quo with extra words |
| What is checked for collision? | The seat's **enforced** `writeScope` (`guards.mjs:263`), never `stepPaths()` predictions — C28 proved a prediction can miss a file outright |
| Cost accepted | Conservative. Two seats both scoped `src/lib/**` never parallelise even when they would have touched different files |

**Gate re-opened by this decision.** Adding `dependsOn` to `planPrompt` is a material edit to
`manager-prompts.mjs`, so its header reverts to `APPROVED-BY: _PENDING BOSS_` and `MP-GATE`
refuses until the BOSS reviews the diff. No Phase D live run until that review happens.

Test plan, red first, each mutation-proven: `READY-1` (disjoint → both dispatched), `READY-2`
(overlapping → one waits), `READY-3` (dependency respected), `READY-4` (cycle refused),
`READY-5` (unknown task refused), `READY-6` (the sequential case unchanged), `READY-7` (two
parallel tasks both commit, neither reverts the other — against a REAL git repo, not a mock
ladder). `READY-7` is the claim the whole design rests on.

### Phase D · step 14 — BUILT (2026-09-20)

`dispatchNext` now walks the task list and starts every READY task. Ready = predecessors
`done` + seat's enforced `writeScope` disjoint from everything in flight. The in-flight set
grows as the loop dispatches, so two ready tasks that would collide with EACH OTHER still
cannot both go. Migration 23 adds `job_tasks.dependsOn`, holding ROW IDS rather than the task
numbers the planner writes — a re-plan reorders the rows, and a stored number would silently
repoint every edge at whatever task landed in that position.

| Gate | Result |
|---|---|
| runtime | ✅ 2701 / 2701, exit 0 |
| unit / vendor / electron | ✅ 597 / 54 / 14 |
| tsc / lint | ✅ 0 / 0 |
| visual (Playwright) | ✅ 32 passed, 1 skipped, 0 failed, exit 0. The skip is `record.spec.mjs`, the opt-in re-recorder (`test.skip(!process.env.VISUAL_RECORD)`) — read, not counted (addendum #24) |
| migration on a COPY of the live 1.8 MB `mission.db` | ✅ applied; 11 existing `job_tasks` rows backfilled to `[]`; original untouched |

**Nine mutation legs. Eight reddened exactly what they should. The ninth reddened NOTHING, and
it is the finding of the round.** The spec's third ready condition, "seat free", was written as
its own branch; deleting it broke no test anywhere. A seat's `writeScope` is the same array
whichever of its tasks you ask about, and `scopesDisjoint` is reflexively false, so the scope
rule already refuses a seat its own second task. The branch was unreachable — deleted, with
`READY-SEAT-1/2` pinning the subsumption. Re-running the scope mutation afterwards reds six
tests including Phase C's own `SEQ-3` and `SEQ-4`, which is the proof the new rule carries the
old guarantee rather than merely replacing it.

Two defects found in passing, neither part of the feature:

- **`MP-GATE` could not fail.** It grepped the WHOLE FILE for `APPROVED-BY: BOSS <date>`, and
  that file deliberately keeps every prior approval as history — so a granted line from
  2026-09-05 satisfied it while the governing line at the top said `_PENDING BOSS_`. Green for
  three phases, cited as evidence twice, on the one control whose job is to stop a live run. It
  now reads the FIRST line and carries a BAD/GOOD pair that runs every time.
- **A load-dependent flake in `ENG-TRACE-1`** (mine, from the C23 work). Its dispatch never
  settles, so a stray watchdog write lands after `afterEach` deletes the tmpdir and node:test
  turns the ENOENT into an uncaughtException — the whole FILE red while every test inside it
  reads green. 0/3 in isolation, 1/5 under six CPU hogs, **0/8 under that same load after the
  fix**.

**What step 14 did NOT buy, measured rather than asserted.** Against the seed roster this
feature is inert: `sr-frontend` owns `src/**`, `sr-backend` owns `src/lib/**` (inside it), and
`qa` owns `**/*.test.*` whose literal prefix is empty and therefore intersects everything. No
pair of seed worker seats can run concurrently. The gain is for HIRED seats, whose scope is
derived narrowly from the task's own steps — `READY-ROSTER-1` pins this and goes red the day
someone narrows `sr-frontend`. And no live run has yet dispatched two seats at once.

### Phase D · step 14 — PROVEN LIVE (run 6, 2026-09-21)

The first job in this project's history to dispatch two seats at once, and the first
MULTI-TASK job to ship.

| Evidence | Value |
|---|---|
| job | `job_a745a82f0636`, brief: two independent new files |
| plan | both tasks came back `dependsOn: []` — the planner used the new field correctly |
| dispatch | `task-dispatched … inFlight:1` then `task-dispatched … inFlight:2`, **one tick** |
| concurrency, observed | `/runtime/health` mid-run: one task `held`, the other `sr-frontend EDITING claimedForMs=37476` |
| seats | `repo-edit-engineer` (`src/lib/**`) and `sr-frontend` (`src/components/**`) — disjoint |
| commits | `02fff58` `src/lib/formatRelativeDelta.ts`, `b886902` `src/components/StatusDot.tsx` |
| READY-7 live | branch diff is `2 files changed, 73 insertions(+)`, **0 deletions** — neither commit reverted the other |
| scope held | the pre-existing `src/lib/formatRelative.ts` contract untouched, as the answer required |
| C32 | gate carried `"tree": "bc3351c364337f…"` — **the tree pin is real live at last** (run 5 had `null`) |
| outcome | `shipped`, `outcome: local-branch`, plan stages run **1**, replans **0** |
| operator repo | `HEAD 85796ae`, 88 modified — untouched by the run |

**Three defects the live run found that the test suite could not.**

1. **`no active account`** — both tasks failed `not-capable` on the first attempt. The account
   lives in `accounts.json` inside `RUNTIME_TOKEN_DIR`, and isolating that directory isolated
   the credential too. The record and the key that decrypts it travel together. This is the
   two-override trap (MEMORY.md) wearing a third hat.
2. **The harness did not carry `RUNTIME_SANDBOX_DISK_BYTES`** from `.env` — the same class as
   C29, caught this time BEFORE the run rather than after. Added.
3. **`ship()` erased the tree pin it exists to check.** The gate recorded
   `"tree": "bc3351c…"`; the shipped record read `"tree": null`, and `worktree` was gone too.
   The final `setSummary` built a FRESH `ship` object instead of spreading the existing one.
   The audit loss is the small half — the large half is that `ship()` refuses when
   `known.tree` disagrees with the branch, so once the pin is erased a SECOND ship reads it as
   undefined, skips the comparison, and the branch-moved refusal stops existing. A guard that
   disarms itself on its own success. Fixed, `SHIP-TREE-KEEP-1`, mutation-proven.

**Still not proven.** C33: no real PR has ever been opened — `origin` is removed from every
trial clone on purpose, so the run ends at `local-branch`. And Phase D's actual USP (two
workers exchanging a question and an answer) is untouched: step 14 lets two seats RUN at once;
the mailbox is what would make them TALK.

- [ ] **STOP. NO COMMIT.** Honoured — `HEAD` is still `85796ae`.


### Phase D — steps 12, 13, 15 and the exit (2026-09-23)

Full record: `.planning/STATE.md` → `PHASE D RECORD`. Live runs 7 and 8 each stopped short and each named a
defect no test could see (CC ordering, #72; a question to a seat with no turn, #73); run 9 closed the loop.

- [ ] Rule 8 — Playwright on a quiet host.
- [ ] **STOP. NO COMMIT.** Honoured — `HEAD` is still `85796ae`.

---

## Phase G — pixel parity with the approved sketchbook mockup (opened 2026-10-01)

**Goal.** The renderer (`src/`) renders every surface defined by
`docs/mockups/missionalpha-sketchbook.html` identically: same layout, spacing, type, colour and
states, at the mockup's own breakpoints. This is proven by a mockup-vs-app screenshot diff under
the suite's `STRICT` comparator.
Data, stores, SSE and IPC are unchanged; only markup and CSS move.

**Scope.** `src/`, `test/visual/` (parity spec + fixtures), this section. `electron/`, CSP and
dependencies are untouched (fonts are self-hosted files, not packages).

### Decisions taken with the BOSS (2026-10-01)

| # | Question | Decision |
|---|---|---|
| D-1 | 12px type floor vs mockup 10–11px labels | Match the mockup; floor reversed (ADR G-1) |
| D-2 | Fonts under `font-src 'self'` | Self-host OFL woff2 (latin) for Bebas Neue, Jost, Inter, Caveat in `src/fonts` |
| D-3 | Landing page / mockup switcher | Landing ported as in-app splash before setup; switcher dropped (scaffolding) |
| D-4 | "Live" switcher button | Not a view. Strip chip bound to the real SSE state; the Command-center Activity "Pause" freezes the rendered stream only |
| D-5 | App-only surfaces / parity data | Kept and restyled in the same tokens; parity diff covers mockup-defined surfaces, fed the mockup dataset via fixtures |

### ADR G-1: Reverse the 12px type floor

**Status:** Accepted (BOSS, D-1) · **Date:** 2026-10-01

**Context.** Phase 8 (`docs/superpowers/specs/type-scale.md`) set an absolute 12px floor for
legibility. The approved mockup uses 10px (`.625rem`) and 11px (`.6875rem`) for eyebrows, chips,
column heads and labels. Exact parity and the floor cannot both hold.

**Options.**
- **A. Match the mockup.** Exact parity. Uppercase tracked Jost at 10–11px is harder to read,
  especially at low vision or at a desk-length distance.
- **B. Keep the floor.** Legible, but every small label diffs.
- **C. Raise the mockup to 12px first.** Both properties hold, but the approved artefact changes.

**Decision.** A.

**Consequences.**
- The `type-scale.md` floor and its grep guard no longer describe the product. The guard is
  rewritten to assert the mockup's ladder, so the floor is not left as a stale rule that a
  future reader re-enforces.
- **Accessibility trade-off, named.** Sub-12px uppercase labels fall below common legibility
  guidance. Contrast (≥4.5:1, indigo on cream) and browser zoom (rem units) are preserved as
  mitigations. The size itself is accepted.

### ADR G-2: One ported stylesheet, mockup class names in JSX

**Status:** Accepted · **Date:** 2026-10-01

**Context.** Styling today is Tailwind utilities, `helm.css` (1,001 lines) and `bos.css`
(3,190 lines).

**Options.**
- **A. Port the mockup CSS verbatim** to `src/theme/sketchbook.css`; components emit the mockup
  DOM and class names.
- **B. Re-create it in Tailwind.**
- **C. A skin layer over helm/bos.**

**Decision.** A. B and C cannot converge to a zero-pixel delta: B drifts on rounding and
ordering, C fights specificity forever.

**Consequences.**
- Every ported surface loses its helm/bos rules and Tailwind classes in the same story, so no
  surface is ever dual-styled.
- Token values in `src/theme/tokens.css` become the mockup's `:root`.

### ADR G-3: Parity is a mockup-baselined screenshot diff

**Status:** Accepted · **Date:** 2026-10-01

**Decision.**
- `test/visual/parity.spec.mjs` renders the mockup (`file://`) with a pinned clock, a seeded
  `Math.random`, the switcher hidden and the harness's `FREEZE_CSS`, and stores those captures
  as the baselines.
- It then renders the app through `installHermetic` with `__fixtures__/parity.json`, which
  encodes the mockup's example dataset, and compares with the unchanged `STRICT`
  (`maxDiffPixels 40`, `threshold .012`).
- The comparator is proven to fire: a one-token colour change on a ported surface must turn
  the spec red, and the failing run is recorded here.

### Stories (each closes only on its own parity capture + suites)

| # | Story | Surfaces | Close evidence |
|---|---|---|---|
| G0 | Parity harness | `parity.spec.mjs`, mockup capture, `parity.json`, sensitivity proof | Spec runs; red on a planted 1-token delta |
| G1 | Foundation | fonts, tokens, `sketchbook.css`, ADR G-1 guard rewrite | `test:unit` green, fonts load under CSP |
| G2 | Shell | TitleBar, BosSidebar (BOS_NAV), StatusStrip, mobile tabs, live-ops dock | parity: shell @ 375/768/1024/1440 |
| G3 | Command center | readiness, doctor, stat row, Ventures, Needs you, Activity (+Pause) | parity |
| G4 | Inbox | queue, filters, bulk bar, cards, review pane (diff, APPLY, questions), auto-approved | parity |
| G5 | Stories / Jobs | 8-stage + 9-status boards, story + job modals, Jira picker | parity |
| G6 | Missions | roster, State/Pipeline board, chat pane, modes, proposal card | parity |
| G7 | CEO brief | Captain console, Agent log | parity |
| G8 | Agents | Captain band, station grid, ledger, agent drawer, station modal | parity |
| G9 | Workflows, Schedule, Outputs | table + drawer, timeline, artifacts + bundle | parity |
| G10 | Vault, Accounts, Roadmap | graph, tiles, files, viewer, station memory; engines, form, rows; roadmap | parity |
| G11 | Overlays | Settings, utility drawer, ⌘K, skills palette, swarm, preflight, toast | parity |
| G12 | Splash + setup | landing splash, onboarding (see O-1) | parity |
| G13 | App-only surfaces | token restyle of surfaces with no mockup counterpart | regression capture |
| G14 | Exit | re-baseline matrix/jobboard/determinism; `test:unit`/`test:runtime`/`test:electron` exit codes; review; `gsd-validate-phase` | this section's exit record |

### Open questions (block the story named)

- **O-1 (G12).** The app's onboarding is a 5-card product tour ("Chat is the cockpit" …
  "Watch the Team board"). The mockup's setup is 5 different steps (Welcome / Engines /
  Account / Project / Ready) whose engine check was simulated. Parity changes onboarding
  content and wiring, not only visuals. Awaiting the BOSS.

### Skill sequence actually used (appended as each runs)

1. principal-standard (PES intake, G0 ledger) · 2. sp-using-superpowers · 3. engineering:testing-strategy
(the plan above) · 4. engineering:system-design (placement + ADR G-2 options) · 5. anthropic-skills:architecture
(ADRs G-1..G-3).

- [ ] **STOP. NO COMMIT.** Standing rule: nothing is committed or pushed until the BOSS says so.

- **D-6 (resolves O-1, 2026-10-01).** Onboarding carries the mockup's five steps and exact
  visuals: Welcome / Engines / Account / Project / Ready.
  - **Engines:** "Detect engines" calls the existing preflight engine check.
  - **Project:** writes the existing Settings → Workspace folder.
  - No simulated results anywhere in the flow.
- **D-7 (2026-10-01): mockup layout, real data.** The red parity run showed the mockup's
  content model differs from the app's. Example: the Command center stats are mockup
  "Active jobs / Need you / Shipped today / Spend today" vs app "Decisions / Records /
  Deliveries / PRs".
  - The app adopts the mockup's exact elements and labels.
  - Each element binds to the real field that answers it, and `parity.json` makes those real
    fields produce the mockup's text.
  - An element with no real source (spend $, disk %, Inbox SLA timers, …) renders the
    mockup element with an honest "—", never an invented number. Each such element is a
    listed gap naming the runtime field it needs; `agent-runtime/` stays out of scope.
- **G0 red (2026-10-01).** `parity center-desktop`: 1,242,464 px (0.96) differ. The
  comparator fires on a real delta; the baseline capture was checked by eye as the mockup
  cockpit at the frozen clock.

### Phase G — G0 · G1 · G2 record (2026-10-01)

**G0: parity harness — CLOSED.**
- `test/visual/parity.spec.mjs` captures the mockup (`file://`, harness `FREEZE_JS` +
  `FREEZE_CSS`, timers cleared, switcher hidden) as the baseline on every run, then compares
  the app under the unchanged `STRICT` comparator.
- `test/visual/parity-fixtures.mjs` builds the app's answers from the RECORDED `api.json`
  (real shapes, mockup values patched in) and layers them over `installHermetic`.
- It also stubs two Electron-only signals for the browser render: preflight docker via a
  bridge exposing only `onPreflight`, and one `breaker.state` frame.
- **Sensitivity is proven inside the suite.** `comparator catches plant-colour` (563 px) and
  `plant-spacing` (2,244 px) run under `test.fail()`, so they go red if the comparator ever
  stops seeing a one-token change.
- `mask` = regions owned by a later story. `honesty` = mockup text that would be false in the
  app; it is blanked in both captures and written to the test annotations.

**G1: foundation — CLOSED.**
- Four OFL woff2 files (latin) in `src/fonts`, declared as the Google CSS declares them.
- `src/theme/sketchbook.css` is the mockup `<style>` verbatim minus the 6 switcher rules,
  prefixed by a `.sk` scope that reverts the Tailwind-preflight properties the mockup relied
  on as browser defaults.
- No class or custom-property collisions with the app (both measured: 0).
- `src/theme/DESIGN.md` is the locked system (hallmark redesign, multi-page flow; placed in
  `src/` because the repo root is out of scope).

**G2: shell — CLOSED.**
- TitleBar, BosSidebar (`.sb`, BOS_NAV order, `stationBadge` dots), StatusStrip, mobile
  tabs and the dock frame are ported.
- `App.tsx` root is now `.shell.sk` → `.body` → `.content`, and the sprite is generated JSX.
- Evidence:
  - parity shell 1440/1024/768/375 ✓, plants ✓;
  - `lint` 0, `typecheck` 0, `test:unit` 612/612 (exit 0), `build` 0.
- Decisions made inside G2:
  - **D-8.** Default theme is cream regardless of the OS (the mockup has no
    `prefers-color-scheme` rule). `resolveInitialTheme` → stored, else `"light"`.
  - **D-9.** The ambient PulseGlobe backdrop is removed from the shell: decorative, no mockup
    counterpart, and painted under mockup surfaces. (Disclosed to the BOSS; reversible.)
  - **D-10.** The Electron title bar keeps the 76px traffic-light inset under
    `[data-shell="electron"]`, keyed on the preload's `isPackaged`. A browser render equals
    the mockup; the framed window must clear the OS controls.
  - **D-11.** "N deliveries await you · M need you" = code-shaped pending items vs all
    pending items. `src/lib/inboxTally.ts` is TDD'd red→green (5 tests), and the mutant
    "drop the pending filter" was watched failing, then restored byte-identical.
- Findings on the way:
  - **Split JSX text kerns differently from the mockup's single text node.** Every port
    emits the mockup's text-node boundaries (template literals).
  - The `src/` HTML-sink guard (`test:unit`) caught a `dangerouslySetInnerHTML` sprite; it
    was replaced by generated JSX. The guard was right.
  - My zsh-split loop trap (Waahyu addendum #27) recurred once on the font download and was
    caught: nothing was written.
- **Honesty deltas so far:** the strip's right text drops the mockup's "· example data", and
  the rail's `.sb-note` second line says what is true instead of "example data played by a
  script".

**Open:** `test/visual/` (parity spec + fixtures) sits outside the literal Phase G scope list
(`src/`, `electron/`, plans). It is the only place the screenshot-diff acceptance criterion
can run. Raised with the BOSS.

### Phase G — per-tab parity loop (2026-10-02)

Scope amended by the BOSS: `test/visual/` in scope; `index.html` preload Lato → Inter; the
PulseGlobe restored (app-only surfaces are kept, D-5). Tabs come from the mockup's own `NAV`
array (12 pages + 4 actions) and match the app's `BOS_NAV` 1:1 (`__screenshots__/tabset.json`).
Evidence per tab: `test/visual/tab-audit.spec.mjs` (`TAB_AUDIT=1`), 4 breakpoints × 2 frames
(first viewport, scrolled to the end), STRICT comparator, artifacts in
`test/visual/__screenshots__/{mockup,app,diff}/`, verdicts in `__screenshots__/results.md`.
Excluded and listed per row: the honesty delta, each tab's D-7 data deltas, `[data-app-only]`.

| # | Tab | Verdict | Cycles | Notes |
|---|---|---|---|---|
| 1 | Command center | **MATCH** 8/8 | 3 | Port of `.ptop`, readiness `.alert`, Doctor card, `.tiles`, Ventures/Needs-you `.row-btn` lists, Activity `<details>`; DockSwarm (G11 dock renderer); dock clamped to the viewport on load/resize (pre-existing bug); `.sr-only` spans escaped the stream's clipping and stretched `.content` by 617px (fixed: `position:relative` on the list); feed-row entering motion ported. Data deltas: readiness detail, per-venture active, Bypass/seats, stream rows, spend (mockup total is timing-dependent). |
| 2 | Inbox | **ESCALATED** (top 4/4 MATCH · end 0/4) | 3 | Ported `.ptop`+score chip, Queue card, `.bulkbar` (always shown, as the mockup), kind filters (`INBOX_KIND_FILTERS`, TDD), `.wb` list of `.dcard`s + inline review (mobile overlay removed: the mockup reviews inline), review per kind (diff `.diff` boxes, typed APPLY, spine, numbered answers), Auto-approved `<details>`. App-only kept: work queue, source filters, cluster rows, bulk reject, injection/trust/source/assignee. **Real bug fixed (TDD):** `clusterModel.at()` did `Number(isoString)` = NaN, so the live Inbox was never newest-first. Open: the mockup keeps Request changes / Reject enabled and validates the note on click; the app disables them until a note exists, so they render faded in the end frame. Handoff prompt issued. |
| 3 | Stories | **MATCH** 8/8 | 2 | `.seg` Stories/Jobs, `.kb` board of `Kcol` columns (gate "you · N"), `.kcard`s; Jobs pane ported (header + Pick from Jira toggling the existing picker + job `.kcard`s). `agoLabel` (TDD). Data delta: a story has no owner field, so owner reads "—" (same shape). App-only kept: New story, open-question chip. Open (sub-states, not in this capture): Jira picker internals and the story/job detail dialogs (G11 overlays). |
| 4 | Missions | **ESCALATED** (2/8 MATCH: laptop-end, mobile-top) | 3 | New `MissionsPage` (roster card, State board by watch badge, Pipeline = `JobColumns`, chat card); `ChatPane` restyled to the mockup chat card (`.chat-h` ×2, `.seg` modes as a radiogroup, native tier `<select>`, `.bubble`s, `.composer2`, proposals as `.propose`); `UsageMeter` → `.meter` ring; `RightPanel` → `card chatpane rp` + Feed disclosure. Removed with the old 3-zone cockpit: mobile pane tabs, chat width drag/collapse, JS composer drag (native `resize: vertical`), mount autofocus (focus theft). App-only kept: Add agents, transport/quota/new-session chips, attachments. Data deltas: model ("—"), loop step + heartbeat age, usage %, conversation. Open: in the On-watch column a card above Sr Frontend renders ~5px shorter in the app (desktop/laptop/tablet top); tablet-end header band and mobile-end 11px strip unresolved. Now-unused: `KanbanBoard`, `KanbanColumn`, `AgentRoster`, `ModelTierPicker`, `SwarmHero` dock variant (deletion awaits approval). |
| 5 | CEO brief | **MATCH** 8/8 | 3 | `.console` (dial `#i-captain`, textarea, Ask, enabled as drawn; an empty ask says why), Agent-log card with the 24h / 7-day `.seg` (`getBriefLog(hours)`, now user-selectable) and `.feed-row`s. Honesty: the mockup says the Captain answers with a verdict; this Captain files and routes, and the line says so (same length, so it wraps the same). Data delta: outcome dots. App-only kept: Last-brief chip, needs-review deep link. |

**Determinism fix (all tabs).** The mockup's ambient simulation ticks every 2.6s from page load; its phase against a capture was random, so a baseline held 1 or 2 extra events depending on machine load (seen as 8 vs 9 brief rows). Both captures now mark the document hidden the moment onboarding ends — the simulation's own guard — so the baseline is identical every run. Tabs 1–5 re-audited on it: Stories 8/8, CEO brief 8/8, Inbox and Missions unchanged (escalated), **Command center 7/8**: on the new baseline its activity rows wrap differently at 375px (mobile-end, ratio 0.04). A 4th cycle on a closed tab needs the BOSS's approval; held.
| 6 | Agents | **MATCH** 8/8 | 2 | Captain band (`.captain`, `#i-captain`, three stats, Open brief), `.stations` of `.station` cards (role icon well, watch chip, "Station 0N · role", blurb, model · mode · heartbeat), New station in the divider, new `DeckLedger` (`table.tbl`: Agent/Tier/Model/Mode/Watch/Heartbeat/Spend today, sortable). Model is REAL: the operator's per-agent choice (`loadAgentModel`, sent with the agent's next run) — also used on Missions. App-only kept: the Phase 6 delivery metrics as extra ledger columns, the Captain's watch + unreachable notes. Harness: the pointer is parked at (0,0) before every capture (a leftover hover was painting a ledger row in the mockup). |
| 7 | Workflows | **MATCH** 8/8 | 2 | `table.tbl` (Workflow/Cadence/Owner/Last run/Next/State): `cadenceText` (title case; weekly names the weekday of `next_run`), `nextText` (paused / in N min / HH:MM), last run via `agoLabel` with an outcome dot, state chip active/paused only. Data delta: the runtime's cadence hour is whole, so the mockup's "Daily · 09:30" is "Daily · 09:00". Harness (cycle 2): hidden text still sized its auto-layout column and moved columns 2–6 by 0.02–0.11px (measured in the mockup itself), so delta cells inside tables are also collapsed to zero width in BOTH captures (`COLLAPSE`). App-only kept: the "N active" header chip. Open (sub-state, not in this capture): the workflow drawer. |
| 8 | Schedule | **MATCH** 8/8 | 2 | Rewritten to the mockup: `.ptop` (Automation, "today's watch, hour by hour", Today's watch chip, clock), one `.card > .tl` of `.tl-row`s (UTC time · `.row-btn` with avatar, title, station, state chip) and the `.nowline` before the first slot ahead; a row still opens the workflow drawer. New `watchSlots` (TDD, 4 tests, mutation-proven on the done rule and the weekday rule) replaces `scheduleBuckets`: every timed cadence at its hour (2×daily twice), "(paused)" / "(Mondays)" qualifiers as the mockup words them, and a chip that claims done only when the runtime recorded a run at or after the slot (else missed); paused and off-day weekly slots say paused / not today instead of upcoming. The static "‹ day · UTC ›" label is gone (it was a disclosed non-control). Cycle 2: the app's row is a `<button>`, which does not inherit letter-spacing (0.16px) — titles set 3px tighter; `.sk .tl .row-btn{letter-spacing:inherit}`. Fixture: the mockup's seven slots are not its five workflows (two story windows, an evening summary), so the Schedule capture runs on its own seven-cadence runtime state. Data deltas: 09:30 (whole-hour runtime), the two window titles, the not-today and paused chips. Mockup defect reproduced: at 375px a long title runs under its chip. Now unused: the `.bos-sched-*` rules in `bos.css`. |
| 9 | Outputs | **MATCH** 8/8 | 3 | Rewritten to the mockup: `.ptop` ("what the team made", clock) and a `.grid2` of the Artifacts card (`li.row-btn`: outputs icon well, mono name, "kind · station · age", size) and the Audit bundle card (JSON/CSV `.seg`, `.diff` box with the file name, Download, `<pre>`). D-7: a produced record carries no station and no size, so both read "—"; the file name is the server's own (`mission-audit-<UTC day>.<format>`); the `<pre>` shows the bundle's real shape (mirrors the P8 export in `agent-runtime/server.mjs`), NOT a preview, because fetching the export records an artifact server-side and a preview on page open would put a download nobody made into the registry. A failed download says so inline. The old per-row Download (it fetched today's JSON whatever the row) is gone; the format choice now drives the one Download. Cycles 2–3 (harness): the delta texts ("—" vs "Docs" / "2.1 KB", the longer server file name) wrapped on different words at 375px, so they are collapsed in BOTH captures (`COLLAPSE`), as on Workflows. Data deltas: the age line + size, the file name, the bundle body. Now unused: `outputRow`, `generatorRow`, `whenLabel` (still tested), the `.bos-out-*` rules. |
| 10 | Knowledge vault | **MATCH** 8/8 | 2 | Rewritten to the mockup: `.ptop` ("The log", "what the team remembers", records chip, clock), the `.field` search ("Search the log"; 250ms debounce, 2-char minimum, Esc clears — kept), and a `.vsplit`: Memory graph card (the mockup's 520×300 SVG: spokes from the centre, `g.node` buttons with aria-pressed, Enter/Space), `.ntiles`, Files card (`button.row-btn`: node chip, title, "station · age", open), the record card (path, title, body, "Filed by … · HH:MM"; the list's first record opens by default, as the mockup's viewer does), and the Station memory card (`StationMemoryPanel` restyled: Station select, Memory `.field-ta`, Save memory, "Saved at HH:MM"). D-7: every count is `/vault/stats`; the runtime's six nodes take the mockup's six graph places, decisions at the centre in both; the record path is the real one, `vault/<venture>/<node>/<id>.md`; node radius grows 4px a record as drawn, capped at 6 so a busy node cannot cover its neighbours. App-only kept: the condenser chip, the short-query hint, the memory character count vs the server cap, approver/limit errors. Cycle 2: the mockup's initial vault holds 8 records (r7, r8 were missed in cycle 1's fixture). Data deltas (and collapsed where they size a column): node names, record chips, record ages (the server lists newest first), the record path. Residual: 24px of SVG anti-aliasing at desktop-top, under STRICT's 40. Now unused: `MemoryGraph.tsx`, `RecordViewer.tsx`, the `.bos-vault-*` rules. |
| 11 | Accounts | **MATCH** 8/8 | 3 | Rewritten to the mockup (972 → 473 lines, framer-motion and lucide out of the page): `.ptop` ("how the team signs in"), CLI engines card (`.engines` chips from GET /runtime/engines, found / not found), a `.grid2` of the Add account `form.card` (Provider select from the runtime's presets, Label, the "How it signs in" `.seg`, API key, Add account) and the Chat model card (`ChatModelPicker` restyled: a `.seg` of the real chat-account choices, unusable ones disabled with the reason, and the runtime's own sentence), then one `.acct` per account (Active / Set active, Probe, Edit, Remove). Kept, restyled: base URL and model fields (custom/openai), the optional identifier (app-only), inline edit with keep-the-key-when-blank, the measured standing + spend-cap sentences (app-only), notices. Behaviour changes, each to match the mockup and each honest: validation now runs on submit with a sentence (a button disabled-until-valid rendered faded); Remove is disabled on the active account ("Set another account active first"); a Claude account's Probe is drawn disabled with the reason (no endpoint to probe). Cycle 2: the mockup's API-key field is visible in Subscription mode — its `hidden` attribute loses to `.field{display:grid}` (a mockup CSS defect) — so the app always shows the field, and pasting a key switches the method to API key, so no key is ever silently ignored. Cycle 3 (harness): a `.seg` button sets its own font-size, so the collapse targets the buttons. Security: the key lives only in a password input (autocomplete off), is sent once, is never rendered (cards say "API key", the wire carries only `hasSecret`), and the form clears after a successful add. Data deltas: the engines sub, provider names, chat choices + sentence, provider initials, the account sub line (no key fragment, no Claude probe), the Claude Probe button, the key hint. |
| 12 | Roadmap | **MATCH** 8/8 | 1 | Rewritten to the mockup: `.ptop` ("how we got here", the one chip "read-only · mirrors the program plan", no clock — as drawn) and a `.list` of `li.rm` rows (code, title + summary, status chip). **Real defects fixed (TDD):** `BOS_ROADMAP` said "Pinned by a test" and no test existed (PES addendum §1); it also showed B7 "in progress" though the plan records it COMPLETE, and B6 "done" though S0 deleted the pipeline and content surfaces. New `bosRoadmap.test.ts` (4 tests) went red on the old data at assertion level, then green: B6 → `removed` (new status), B7 → `done`; `statusWord` (shipped / removed / in progress / planned) replaces `statusMark`. The mockup's statuses turned out to be the true ones. Data delta: titles and summaries mirror the program plan's phase headings; the mockup retells them (collapsed in both captures; codes and status chips compared). |

**Per-tab loop closed (12/12 tabs).** MATCH: Command center (7/8 on the determinism baseline; 4th cycle awaits approval), Stories, CEO brief, Agents, Workflows, Schedule, Outputs, Knowledge vault, Accounts, Roadmap. ESCALATED: Inbox, Missions (handoff prompts issued). Harness additions this stretch: `COLLAPSE` (delta text zero-width in both captures where it sizes a column or wraps), per-tab fixture scenarios (`buildParityFixtures(recorded, tab)`) for Schedule, Vault, Accounts.

**Phase-close review (code-reviewer + security-reviewer, read-only) and fixes.** Security: 0 CRITICAL/HIGH. Correctness: 1 HIGH, 13 MEDIUM. Fixed, each re-audited on the full 12-tab run (verdicts unchanged — no regressions):
- HIGH — `watchSlots` claimed "done" from `last_run`, which a manual Run-now and a failed dispatch also set, and a 2×daily's later slot set for both. Now: done only when `last_fired_slot === slot` and `last_status !== "error"`; new states `failed` and `no record`. Also: a 2×daily with no hour sits at 00:00/12:00 (the two live seeded sweeps had vanished); a weekly claims today only when today IS its slot. TDD: 4 new assertion-level reds on the old code, then green (14/14); the fired-slot rule mutation-proven.
- Vault: a live reload no longer blanks the open record; a stale "could not be opened" is cleared; counts read "—" (never 0) until the stats answer.
- Title bar + Command center Need-you: "—" until the first pending read (was a fabricated 0).
- Accounts: the only account can be removed even while active (a leaked key could not be revoked); a typed key is cleared on a provider or Subscription switch; Set active / Probe / Edit / Remove carry the account name for screen readers; a refused chat choice says so (was silent); the chat card no longer says "did not answer" while it is loading.
- Station memory: the system-prompt disclosure is back (app-only line) and "Saved at …" survives the save's own memory.changed re-read.
- Workflows: every time is UTC (the weekday and Next were local beside a UTC hour); the run outcome is spoken (sr-only word), not colour-only.
- Inbox: a deep-linked delivery is no longer replaced by auto-select; Approve with nothing ticked says why.
- Roadmap: B4's "15 seeded cadences" was stale (the seed has 7).
Not changed, for the BOSS: the mockup's own "oldest" = time left on the soonest SLA, and its "1 files" (both reproduced for parity); Missions Pipeline hides Blocked with no count; the `VITE_BOS=0` path lost ShellToggle; whole-card `aria-live` regions (the mockup's own markup); dead code listed in the delivery report.

**Gates (final code):** lint 0 · typecheck 0 · unit 627/627 · runtime 2858/2858 · electron 14/14 · build ✓ (main chunk 207.73 kB gz; HEAD 204.63 kB — the 194,560 B ceiling in code comments was already exceeded before Phase G; Phase G adds +3.10 kB) · full tab audit 85/96 frames MATCH.

**BOSS decisions round (2026-10-02).**
- **Agents page — root cause and status: FIXED, verified live.** `agent-runtime/.env` pointed `RUNTIME_TOKEN_DIR` at a per-user temp dir while the root `.env` (read by Vite/Electron) pointed at `~/.missionalpha`, which holds the real encrypted credential store. The runtime minted its token in one place and the app read it from another, so every token-gated call answered 401 and the page had no state to draw. Only that one line was changed, so both files now name `~/.missionalpha`. Live check (runtime + dev app): Agents shows the Captain band and 10 stations + 10 ledger rows; 50 of 50 runtime calls 200/201, zero 401. The runtime was then stopped with SIGTERM (it dispatches due cadences on boot); no orphan seats.
- **Inbox "oldest":** the label is kept and now reads the real oldest pending item's age (`queueSummary().oldestAt` from `createdAt`; TDD, red then green, 11/11). `soonestDue` now has no UI reader (still tested).
- **Dead code deleted after a zero-importer grep each:** `KanbanBoard`, `KanbanColumn`, `AgentRoster` (only a path string in recorded fixture data), `AgentLedger.tsx` (only a same-named type elsewhere), `MemoryGraph`, `RecordViewer`, `ShellToggle` (and the App comment that promised it), the `SwarmHero` dock variant, `outputRow`/`generatorRow`, and every `.bos-sched-*` / `.bos-out-*` / `.bos-vault-*` rule except `.bos-vault-retry` (still used by JobDetail/StoryDetail/StoryThread), plus the 7 section comments those rules left orphaned. **Not deleted, correcting the earlier list:** `ModelTierPicker` is imported and rendered by `AgentDrawer`. Still dead, not on the approved list: the `ViewToggle` component (its types are used), the `.bos-road-*` rules, `outputsClient.whenLabel`. Gates after deletion: lint 0 · typecheck 0 · unit 628/628 · runtime 2858/2858 · electron 14/14 · build ✓ (main 207.69 kB gz).
- **Command center cycle 4 (approved): MATCH 8/8.** The mobile-end gap was the activity rows: hidden runtime event words wrapped differently from the mockup's sentences and made the card 7px shorter. They are collapsed in both captures (`.who` sets its own font-size, so it is collapsed too).
- **Globe — root cause (diagnosing-bugs; no fix yet, awaiting design):** (1) every earlier "0×0 / does not render" observation came through the visual harness, whose `FREEZE_CSS` sets `canvas { visibility: hidden !important }` — the probe was blind. Proven: under real clock/rAF the scene issues ~34 draw calls a frame to the default framebuffer, `readPixels` finds 33,342 opaque pixels, and an isolated screenshot shows the constellation. A clear-to-red control proves headless WebGL paints. (2) In the real app it is still invisible: it is the P3 hero band (a 260px strip with negative margins and a bottom fade to the page colour) mounted at opacity 0.1, z-index −1, under the opaque sketchbook surfaces, so zero of its pixels reach the screen.
- **Correction (Inbox "oldest"):** the decision assumed the queue line was already masked; it was not. It had matched only because the old SLA-based value coincided with the mockup's example. Binding it to the real oldest age turned Inbox top frames red (4/8 → 0/8 on the full re-audit). It is now a declared data delta (`.qstrip .card-h .sub:last-child`, collapsed in both captures): Inbox back to 4/8. Full re-audit after this round: 86/96 frames MATCH (Command center 8/8; Inbox 4/8 and Missions 2/8 remain ESCALATED with handoff prompts).

**Landing + Setup (approved 2026-10-02, approach A + 6 amendments).** Spec: `docs/superpowers/specs/2026-10-02-landing-setup-spec.md` (32 ACs, 5 ADRs). Plan: `docs/superpowers/plans/2026-10-02-landing-setup-plan.md` (14 tasks). Progress is tracked in `STATUS.md` → "Landing + Setup".
- **Landing + Setup T12 (ADR-LS4): the old cockpit tour is deleted.** `src/components/onboarding/Onboarding.tsx` is gone after a zero-importer grep. **Its walkthrough content was removed**: "Chat is the cockpit", "Open a repo", "Pick a model per chat", "Plug in connectors", "Watch the Team board", and its "Try a first goal" button. ⌘K "Replay onboarding tour" now reopens the 5-step Setup; ⌘K "Show the welcome page" shows the Landing. `ma.onboarded.v1` is kept, so everyone who saw the old tour stays onboarded.

**Landing + Setup — Phases 5–8 closed (2026-10-02).**
- **Review fixes (Phase 8), test-first.** Each new E2E was RED on the old code, then GREEN.
  - H1: "Detect again" after "not found".
  - M1: Setup remounts fresh on every open (`key={setupRun}`).
  - M2: no raw `Error.message`. 401/403 → "The runtime refused this: it needs an approver seat."; anything else → "The runtime did not answer."; only the runtime's own 400 sentence is shown.
  - M3: ⌘K "Show the welcome page" closes Setup.
  - M4: the first-run check races 5 s → landing.
  - envPinned: the Project step says the choice will not apply, and Ready reads "pinned by the runtime's environment, not applied". Ready shows the server's realpath.
  - a11y: `aria-describedby` on the folder input only while the rule error shows. Back is disabled while busy. A radio group is one Tab stop. A failed detect keeps focus inside the dialog (final-review MEDIUM).
  - Response shapes are checked: engines + `spawnEngine`, accounts.
  - `folderOk` refuses `~user`.
- **agent-runtime (BOSS-approved scope extension):** `validateWorkspace` expands a leading `~` / `~/` to the home directory, so the mockup's "~/code/my-app" saves. Every existing path check runs on the expanded path; `~user` is not expanded.
  - TDD: 3 RED → GREEN, 28/28.
  - The `~user` guard was mutation-proven: `/^~/` → red. Restored md5-identical.
- **Gates:** lint 0 · typecheck 0 · unit 643/643 · runtime 2862/2862 · electron 14/14 · build ✓ (main 213.13 kB gz) · first-run E2E 35/35.
- **Full audit:** 116/128, recomputed from `results.md`.
  - Tabs: 86/96 (Inbox 4/8, Missions 2/8, both with the separate review agent).
  - Landing: 8/8. Setup: 22/24.
- **Reviews:** final code review 0 CRITICAL/HIGH. Security review 0 CRITICAL/HIGH; its two MEDIUMs are fixed (the `~` path, `errorOf` raw text).
**Escalation handoff: Setup step 3 (Account) and step 4 (Project) at 375px.** Three fix cycles are spent. These are the only two Landing+Setup frames that do not MATCH. Paste the prompt below into a fresh session:

> In /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha, two parity frames still fail at 375px only. Desktop, laptop and tablet MATCH for the same steps.
>
> **The two frames:**
> - setup-3-mobile-top (Account step): 3458 red px, 1532 differing.
> - setup-4-mobile-top (Project step): 205 red px, 74 differing.
>
> Run `TAB_AUDIT=1 ./node_modules/.bin/playwright test test/visual/tab-audit.spec.mjs -g "setup-3-mobile|setup-4-mobile" --config=playwright.config.mjs > out.log 2>&1; echo EXIT=$? >> out.log`. Then compare `test/visual/__screenshots__/{app,mockup,diff}/setup-{3,4}-mobile-top.png`.
>
> **Already ruled out:**
> - Element boxes are identical to sub-pixel precision.
> - Computed styles are identical except `text-rendering`. Setting it to `auto` inside `.ob` changed nothing (3458 → 3458), so that edit was reverted.
> - No data masks are involved: 0 data, 0 app-only.
>
> **Where the red is:** the glyphs of the radio-option labels (step 3) and the "BACK" button text (both steps).
>
> **Suspects, in order:**
> 1. The mockup's radios are inside a `<label>` with different whitespace or text nodes, so the inline text flow differs.
> 2. Letter-spacing on the `.btn` label resolves differently at the mobile font size.
> 3. Antialiasing from a fractional x-offset of the dialog at 375px (`.ob` width uses a calc).
>
> **Rules:**
> - Edit only `src/components/onboarding/Setup.tsx` and scoped `.sk .ob` rules in `src/index.css`.
> - Re-run all 24 setup frames afterwards: no regression allowed at other breakpoints.
> - Do not loosen the comparator (`maxDiffPixels` 40, `threshold` .012).
> - Do not commit.

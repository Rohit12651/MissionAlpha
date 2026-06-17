# Plan — Ship + Close the Autonomous Loop

**Slug:** `autonomous-loop`
**Author:** CEO agent + architect
**Status:** PLAN — `AWAITING_USER_DECISION`
**Date:** 2026-06-15
**Mode:** caveman (bus) · normal prose (this memo)

## Goal

Two things, in order:
1. **Ship** everything built this session (lots uncommitted) — lock it in.
2. **Close the loop:** BOSS gives a goal → CEO proposes dispatch → operator confirms → the target
   agent actually DOES the work (real Claude via subscription + F2b sandbox write) → operator
   confirms the diff → applied → agent reports DONE back to the BOSS feed. Today the pieces exist
   but aren't wired end-to-end: dispatch writes a command, but no agent picks it up and builds.

## What exists vs what's missing

| Have | Missing (this plan) |
|---|---|
| Boss console → CEO → dispatch (writes /api/command task) | nothing consumes the task into an agent work-run |
| Agent chat + F2b write (sandbox) + broker (diff→confirm→apply) | trigger F2b work-run FROM a dispatched task, not just manual chat |
| Heartbeat/sync bus, feed, audit | agent auto-reports DONE + result back to BOSS feed |

The gap = a **task runner**: turn a dispatched/INBOX task into an F2b work-run, surface the diff,
and on apply emit a DONE heartbeat + sync to BOSS.

---

## PHASE 0 — SHIP (lock in this session's work)

- **Owner:** senior-cicd-engineer (+ senior-code-reviewer gate).
- Steps:
  1. Review `git status` — large surface (Cycle1, Cycle2A, Boss console, F2a/b, auth). NOTE: repo
     may not be git-init'd — if not, `git init` first (ask BOSS before first commit).
  2. Ensure `.gitignore` covers: `agent-runtime/node_modules`, `agent-runtime/.env`,
     `agent-runtime/sandboxes`, `.runtime-token`, `/tmp` artifacts. (token already in tmp, out of repo.)
  3. senior-code-reviewer final pass on the new runtime + components.
  4. Commit in logical chunks (control-plane / session-history / chat-fork / security) OR one
     feature commit. Push + PR to a branch.
  5. **GATE:** BOSS approves commit/push (irreversible-ish, outward-facing).
- **Exit:** work committed + PR open. THEN proceed.

---

## PHASE 1 — architect: task-runner ADR

- **Owner:** architect. Blocks impl.
- Decide + write `docs/adr/ADR-018-task-runner.md`:
  - **Trigger:** how a dispatched task starts a work-run. Option A: poll `agent-status/INBOX/<agent>.md`
    for new `TOPIC=task` lines (dispatch already writes INBOX via consume_commands). Option B: a new
    runtime endpoint `POST /runtime/:id/run {task}` the dispatch UI calls directly. CEO leans **B**
    (explicit, synchronous, easier to surface progress) with A as a later autonomous mode.
  - **Work-run:** runtime spawns the agent (cli, write mode, sandbox) with the task as the prompt:
    "You are <agent>. Task: <text>. Edit files in your sandbox to accomplish it. Caveman bus style."
  - **Result:** run produces sandbox diff (existing /changes) → surfaced as proposed changes.
  - **Report-back:** on apply, runtime (or UI) writes a heartbeat `DONE_CYCLE` + sync `agent→BOSS`
    "task done: <summary>" so it lands in the live feed + Boss console.
  - **Auto vs gated:** default = operator confirms the diff (F3, keep human in loop). Optional
    "auto-apply" policy per agent (off by default) for trusted low-risk paths.
- **Exit:** ADR approved; contracts defined.

---

## PHASE 2 — senior-backend-1: task-runner endpoint

- Add `POST /runtime/:agentId/run {task}` to `agent-runtime/server.mjs` (token+host gated, like
  /apply). Seeds sandbox, spawns cli write-mode with a task-framed prompt, streams progress over SSE
  (reuse stream), on close emits a `run-complete` event with the changed-file list.
- Bound by MAX_INFLIGHT (existing). Audit the run.
- **Exit:** curl: POST a task → agent edits sandbox → /changes shows the diff.

---

## PHASE 3 — senior-backend-2: report-back bridge

- On `/apply` success for a run, write to the swarm bus:
  - `agent-heartbeat.sh <agent> DONE_CYCLE "<task>" "<files>" "" "done"` (or via a runtime helper).
  - `agent-sync.sh <agent> BOSS task-done <ref> "done: <n files>, <summary>"` → appears in feed +
    Boss console inbox.
- So BOSS sees the result without leaving the console.
- **Exit:** apply → DONE heartbeat + BOSS sync verified in state.json/feed.

---

## PHASE 4 — senior-web-1: wire dispatch → run → review in UI

- BossConsole dispatch card "Confirm" (existing F3) now ALSO calls `POST /runtime/:id/run` per
  directive (not just /api/command) → shows per-agent run status (running → proposed changes → apply).
- Surface each agent's resulting diff inline in the Boss console (or deep-link to the agent drawer's
  proposed-changes panel).
- **Exit:** BOSS types goal → CEO proposes → confirm → agents run → diffs appear → BOSS applies →
  feed shows DONE. End-to-end in browser.

---

## PHASE 5 — senior-security-engineer: review the loop

- New `/run` endpoint = same write-surface risks as F2b → same gates (token, host, sandbox, broker,
  no auto-apply by default). Adversarial: task with injection ("edit package.json scripts") → config
  guard + path guard still hold. Auto-apply policy (if added) → extra scrutiny.
- **HARD gate:** no auto-apply of exec/config files ever.

---

## PHASE 6 — senior-qa: end-to-end tests

- E2E: dispatch a real task → agent writes sandbox → diff correct → apply → repo updated → DONE in
  feed. Negative: task tries to escape sandbox / touch secrets / change scripts → all blocked.
- Regression: manual chat + F2b + Cycle1/2 controls unbroken.
- **Exit:** TESTS_GREEN.

---

## PHASE 7 — memory-updater + CEO retro

- Persist loop decision + ADR-018 to memory. CEO retro: did the autonomous loop save operator time?
  false-apply rate? token cost per task?

---

## Dependency order
```
Phase0 SHIP (BOSS-gated) → Phase1 architect ADR → Phase2 run endpoint
  → Phase3 report-back ∥ Phase4 UI wiring → Phase5 security → Phase6 QA → Phase7 memory
```

## Acceptance (loop DONE when)
- [ ] Session work committed + PR'd (Phase 0).
- [ ] BOSS goal → CEO dispatch → confirm → agent runs real work in sandbox → BOSS reviews diff →
      apply → agent reports DONE in feed. No manual chat step needed.
- [ ] Every write still sandbox-isolated + broker-gated + token/host-secured + config/path-guarded.
- [ ] No auto-apply of exec/config files. Human-in-loop by default.
- [ ] tsc + lint + TESTS_GREEN + security sign-off.

## Non-goals
- Fully autonomous (no human confirm) apply — explicitly OUT; operator stays in loop.
- Multi-swarm (Cycle 3, separate).
- Bash/exec tools for agents (still off).

## CEO note
Phase 0 (ship) FIRST — protect the session's work before extending. Then the loop turns the swarm
from "talks + can write when chatted" into "BOSS sets goal → swarm executes → BOSS approves" — the
actual product. Human stays the gate (Bezos: one-way-door protection; you confirm every apply).

**ASK USER:** GO? And: is MissionAlpha git-init'd / where to push (Phase 0 needs a target)?

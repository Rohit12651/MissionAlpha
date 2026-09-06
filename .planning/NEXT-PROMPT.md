# NEXT SESSION — MissionAlpha, Milestone 2. Finish Phase 9, then Phase 10.

Repo: `/Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha` (change the session directory
there first; the desktop app may open in WaahyuPython — do not work there).

## READ FIRST, IN THIS ORDER

1. `.planning/STATE.md` — the live handoff. Newest at the BOTTOM (sessions 17, 17b, 17c, 18, 18b).
2. `docs/PES-ADDENDUM.md` — defect classes 14–24. Check each explicitly before claiming a
   control works. This session added #20 (an allow-list is ungated-by-default), #21 (a guard
   that blocks the tool), #22 (a mutation that does not fire), #23 (a seed that mirrors the
   design doc instead of the running system), #24 (`git worktree add` checks out committed config).
3. `docs/superpowers/specs/2026-09-02-manager-loop-design.md` + the operating-model HTML.
4. `.planning/phases/09-manager-loop/PLAN.md` (tasks 9.6/9.7 remain) and `10-hr/PLAN.md`.
5. `memory/SESSION_MEMORY.md` — last entry only.

## ⛔ THE ONE THING BLOCKING PHASE 9

**Task 9.0 is a BLOCKING checkpoint and it is still open.** `agent-runtime/manager-prompts.mjs`
header says `APPROVED-BY: _PENDING BOSS_`. The plan states "9.3+ do not run live before this."
The BOSS authorised the last session to run unattended, which is NOT the same as having read
the prompts — so the Manager has never been pointed at a live model.

**Ask the BOSS to read that file** (176 lines, four prompt builders). On approval, replace the
header line with `APPROVED-BY: BOSS <YYYY-MM-DD>` and run 9.6:

```bash
RUNTIME_MANAGER_DISPATCH=claude RUNTIME_BACKEND=cli RUNTIME_TOKEN_DIR="$HOME/.missionalpha" \
RUNTIME_PORT=3006 node agent-runtime/server.mjs
```

9.6 wants: paste the formatRelative brief → `loop_steps` show `Read`/`Grep` in the intake turn
→ the plan assigns tests to the `test` seat and nothing to the `ui` seat → the task reaches
HELD → a second brief where the order is wrong → a seat mails `blocked` → the Manager re-plans
→ both HELD. No human touch between paste and HELD except answering questions.

## STANDING MANDATES

* **NO git commits** until the BOSS says so. Assert the index the STRONG way —
  `git write-tree` == `git rev-parse HEAD^{tree}` — never the `.git/index` md5, which moves on
  every `git status`.
* **Regression contract BEFORE and AFTER, dev servers STOPPED**: runtime ≥ **2393/0** ·
  unit ≥ **563/0** · vendor 54/0 · electron 9/0 · visual 30 passed (1 record-only skip) ·
  tsc 0 · lint 0 · build ✓. Baseline log: `/tmp/ma-gates/p9-final.log`.
* Everything WIRED and shown on the running install. Boot with
  `RUNTIME_TOKEN_DIR="$HOME/.missionalpha"` — **the accounts live there**, and without it the
  engine reports "no active account is active". Active account: "Claude Max (CLI)".
* **PES applies** (`~/.claude/CLAUDE.md`, load `principal-standard`): scope ledger, TDD, gates
  G0–G8 with pasted evidence, security pass, adversarial review, delivery report ending in
  Known Gaps & Risks. "Done/fixed/passing" only with output shown.
* **Every new test is a RATCHET**: mutate → paste the red line → restore md5-identical → green.
  Match on values/AST, never source text.

## WHERE PHASE 9 ACTUALLY IS

Built, green, and proven WITHOUT a model: the Job store (migration v21, additive), the
job-scoped gate (`mintGate` takes storyId XOR jobId), the Manager state machine (26 tests), the
dispatcher in both modes (18 tests), the job routes + answer route, and the engine → Manager
signal. `JOBHTTP-12` walks a pasted brief to a resolved outcome with no model and no human.

Not proven: anything requiring a live Manager turn (see 9.0 above).

## THEN PHASE 10 (HR)

`10.1b` is the seam the Manager already calls: `createManager({hire})` defaults to
`{ok:false, error:"hiring is not wired until Phase 10"}`, and `MGR-WALK-4b` already proves the
Manager proceeds once a real `hire()` returns `{ok:true, agentId}`. So Phase 10 plugs into a
tested seam rather than changing the Manager.

The deterministic dispatcher ALREADY produces an unstaffed skill on demand: a brief containing
the word "notifications" yields a task with `skillsRequired:["notifications"]`, which no seed
seat holds (`MD-DET-4` pins this). That is 10.2's hire proof, available with no model.

## TRAPS ALREADY SPRUNG — do not rediscover

* **`needsAuth` in `server.mjs` is an ALLOW-LIST.** A new route is UNGATED BY DEFAULT. Phase 7
  shipped `GET /runtime/roster` public exactly this way. **Any route you add must go on that
  list AND get an HTTP test asserting 401 without a token** — model it on
  `agent-runtime/test/roster-http.test.mjs` or `mailbox-http.test.mjs`.
* **HTTP suites bind HARDCODED ports** (3961/3964/3967/3987/3993/3994/3995/3996/3998…). Two
  overlapping `npm run test:runtime` runs collide and produce phantom "server not healthy"
  failures. Check ports first; kill by PID from `lsof -iTCP:<port>`; never
  `pkill -f "node --test"` (addendum #19).
* **A test that shares the HTTP server races the earlier tests' backlog.** The heartbeat
  round-robins every live job and the engine has a concurrency cap, so a short poll fails for
  lack of a TURN, not for lack of the behaviour. `JOBHTTP-12` runs on its own server for this
  reason; three other windows were widened 20s → 60s after a measured 1-in-3 flake.
* **Config differs from the default you will test against.** 19 HTTP suites spawn the server
  with `RUNTIME_SEED_DIRS: "src"`. Check how the SUITES configure a value before trusting the
  default (addendum #7).
* **Backticks in a shell heredoc get eaten.** Three comments in this codebase were mangled that
  way this session. Use a python heredoc (`python3 - <<'PY'`) for any patch containing them.
* A stage takes 2–5 min on a live model. One quiet poll is not a hang.
* `gsd-executor` subagents have **no Skill tool** — put the PES/TDD/ratchet rules in the prompt
  verbatim. Never let two agents touch `server.mjs` at once. Never give an agent `worktree`
  isolation (the operator's ~306 uncommitted files vanish from its view).

## BOSS BLOCKERS — ask, do not work around

9.0 prompt approval (above) · `gh` not installed (PR rung → local branch; 14.0 gate) · Jira
credentials (13.0) · **the commit decision — ~306 dirty files, nothing committed all session.**

## DELIVERABLE

9.6 + 9.7 closed with live evidence, then Phase 10 per its exit gate: pasted before/after
gates, every ratchet's red line, live proofs, a PES report with Known Gaps & Risks, STATE.md
session 19 appended, and this file rewritten for Phase 11. **Say explicitly which
stages/controls have never run on a live model before you claim them.**

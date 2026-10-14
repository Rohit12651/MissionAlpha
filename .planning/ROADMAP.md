# Roadmap — Ruflo Adoption Program

Source of truth: CEO plan 2026-08-18 (`~/.gstack/projects/Rohit12651-MissionAlpha/ceo-plans/2026-08-18-ruflo-adoption.md`) + adoption-map HTML artifact. 15 items, 4 phases, 5 security laws. Zero ruflo dependencies ever land in package.json.

## Global mandates (every phase, no negotiation)

- **NO git commits until the BOSS explicitly says commit.** Work stays in the working tree; report diffs.
- **Regression gate before AND after every plan:** `npm run typecheck && npm run lint && npm run test:unit && npm run test:runtime` — all green. Anything broken by a task is fixed inside that task.
- **Everything WIRED:** every new capability emits on the SSE bus, renders in the UI, and runs without human intervention between decisions. No dead config, no orphan modules.
- **Security laws 1–5** (see CONTEXT.md) bind every task.
- **Skills per phase** are listed in each PLAN.md and are mandatory: superpowers chain (sp-test-driven-development, sp-verification-before-completion), security-review on sensitive paths, code-reviewer agent post-implementation, gstack `/qa` + `/review` as phase gates, hallmark → impeccable → taste-skill (+ emil-design-eng for motion) on every UI surface, caveman/headroom/codeburn for token ops, mem-search for prior-art recall.
- **Model policy:** build on Opus 5 (caveman mode); independent verification pass per phase on Fable 5.
- **Verification is per the HTML map:** a phase is done only when every pin on the adoption map for that phase demonstrably works end-to-end.

## Phases

| # | Phase | Items | Status | Depends on |
|---|-------|-------|--------|------------|
| 1 | Engine Room | 1 hooks · 2 cadence workers · 3 tier routing · E5 doctor | Planned | — |
| 2 | Intelligence | 4 learning loop · 5 vault retrieval · 6 cross-model review · E6 skill budget | Planned | Phase 1 |
| 3 | Security Hardening | 7 metaharness · E1 trust scoring · E2 PII scrub · E4 injection heuristics | Planned | Phase 1 (E1/E4 build on adapters; 7 standalone) |
| 4 | Heavy Tail | E3 encryption at rest · E8 anti-drift policy · E7 graph ranking | Planned | Phase 2 (E7 behind item 5), Phase 3 |
| 5 | Loop Repair | D3 snapshot base · D1 scoped quality gate · D4 terminal refusals · D5 stage retry · D6 story controls · D7 live queue strip · D8 doctor throughput · D9 chat error honesty | **Done 2026-08-24** — see `docs/superpowers/specs/2026-08-24-loop-repair-design.md` | — (repairs the loop every other phase runs on) |

## Phase gates

- **Phase 1 exit:** ≥3 self-minted low-band Deliveries/day flowing; measured token delta on 10 mechanical tasks; `doctor` green (or red with actionable findings) in CLI + cockpit; regression suite green.
- **Phase 2 exit:** success signatures stored on approve; retrieval injects fenced top-k on repeat task shapes; review stage runs on a different provider than build; skill prompt budget enforced; regression green.
- **Phase 3 exit:** self-grade score live in cockpit and drops on deliberate perms weakening; adapter trust visible on Delivery cards; PII detectors + injection heuristics pass fixture suites; regression green.
- **Phase 4 exit:** DB+vault encrypted at rest with tested key-recovery; stall detection mints escalation Delivery; PageRank ranking measurably reorders retrieval; regression green.
- **Phase 5 exit (met):** an engine task reaches HELD with a diff containing ONLY the agent's own work; approve → apply → commit lands on the task branch; a story walks idea → requirements → design gate → plan → build driven from the UI; a transient provider failure is retried with no human in the loop; `doctor` reports `fail` when nothing completes and `ok` when something does. Regression: runtime 2008+/0 · unit 536/0 · vendor 54/0 · electron 9/0 · tsc 0 · lint 0.

---

# Milestone 2 — The Manager Loop (2026-09-02)

Source of truth: `docs/superpowers/specs/2026-09-02-manager-loop-design.md` + the working
model page `docs/superpowers/specs/2026-09-02-operating-model.html` (BOSS-approved).
Goal: MissionAlpha works exactly like that page — one door, a Manager who reads the ticket
and the code, assigns by skill, hires through HR, workers that talk, one yes from BOSS,
then a PR. Every agent runs as a real `claude -p` session with tools (the Claude CLI road).

Global mandates from Milestone 1 stand: NO commits until BOSS says; regression contract
before and after every plan (runtime ≥ 2068/0 · unit ≥ 551/0 · vendor 54/0 · electron 9/0
· visual 30/0 · tsc 0 · lint 0 · build ✓, dev servers stopped); everything WIRED and shown
on the running install; PES delivery report per phase with Known Gaps & Risks.

| # | Phase | Delivers | Status | Depends on |
|---|-------|----------|--------|------------|
| 6 | Foundation fixes | defects #1 snapshot attribution · #2 stall clock · #3 deploy cap · #4 tier override · seat context diet · apply decides Delivery | Planned | 5 |
| 7 | Roster + skill lock | roster.json · per-seat writeScope enforced in broker · allowedTools per seat · SKILL bodies in prompt | Planned | 6 |
| 8 | Mailbox | file mailbox · mail_send/mail_read MCP tools · router · rules · thread rendering | Planned | 7 |
| 9 | Manager loop | Job/Task store · intake reads repo · clarify once · plan · assign by skill · manage | Planned | 8 |
| 10 | HR by Manager | hire-request/hire-done · roster persistence · roster.changed · new-hire card | Planned | 9 |
| 11 | Review + ship | Manager review · one summary · job-approval gate · path-selective apply · ma/job branch · PR | Planned | 9 |
| 12 | Ash + Board | chat seat = Ash · POST /runtime/jobs · Job board · read-only watching | Planned | 10, 11 |
| 13 | Jira in/out | connector · pick/watch tickets · comment + transition on ship | Planned | 12 |
| 14 | Hardening | deterministic paste→shipped test · doctor checks · unattended week · PRs/week metric | Planned | 12, 13 |

Exit for the milestone: **5 jobs pasted → shipped as PRs in one week, unattended between
BOSS decisions, zero operator-tree incidents, all suites green.**

---

## CARRIED BACKLOG — must appear in every next plan (added 2026-09-07, BOSS instruction)

Phases 6–14 are BUILT and COMMITTED (`62312d5`, `16af47b`, `8117369`). The table above
still reads "Planned" for all of them — it is stale and is corrected here, not rewritten,
so the original commitment stays auditable.

Actual status: 6–12 CLOSED and proven live · 13 CLOSED with the live half unproven ·
14 OPEN on 14.3 alone.

Every one of the items below is a KNOWN GAP carried out of Milestone 2. No next plan may
be written without carrying this table forward and either closing an item or restating
why it stays open.

| # | Gap | Why it matters | Size | Blocked on |
|---|-----|----------------|------|------------|
| C1 | reject→re-plan on resume | You reject a plan; the rejection is recorded but the job does not re-plan on resume. It sits. First rejection hits this. | Small | nothing |
| C2 | corrected `reviewPrompt` never run live | The prompt never told the model the diff was UNAPPLIED. Fixed and unit-tested; the one live chain used the OLD text. | Tiny | one live job |
| C3 | Phase 13 live Jira | Connector works against a fake Jira only. Never pointed at a real instance. | Medium | BOSS token — the agent never sees it |
| C4 | 14.3 unattended week | The milestone exit criterion. 5 jobs Mon → shipped as PRs, 0 incidents, suites green Fri. | 5 days | BOSS participation |
| C5 | `missionalpha-prproof` repo | Disposable PR-rung proof repo still in the BOSS account. | Tiny | `gh auth refresh -s delete_repo` |
| C6 | 3 stray `ma/job/*` branches | Left by Phase 11 proofs. | Tiny | nothing |
| C7 | `JobApprovalCard.tsx` | Named in the Phase 11 plan, never built. Approval runs through the generic path. | Small | nothing |
| C8 | Ash no-tool notice unproven live | The adapter-road notice that stops Ash writing `create_job(...)` as prose. Unit-tested only. | Tiny | one live chat |
| C9 | Ash MCP wiring unit-untested | `ashMcpServers()` merge into `--mcp-config` has no unit test. | Small | nothing |
| C10 | Jira `nextPageToken` never followed | Paging past page 1 is written but never exercised. | Small | C3 |
| C11 | addendum #44 seatless commit rung | Disclosed in the addendum, never closed. | Small | nothing |
| C12 | addendum #39 zero-commit ship | A ship that produces no commits is not refused. | Small | nothing |
| C13 | 1076 failures / 44 pending in the live queue | Accumulated from earlier runs. Triage before new work lands on top. | Medium | nothing |
| C14 | `server.mjs` is 401 KB | One file every phase touches. It is why Phases 6–14 could not be split into per-phase commits. | Large | nothing |

### Closed since this table was written (2026-09-07)

Nothing in C1-C14 yet. One item NOT on the list was found and closed: the scope-breach message
was composed, stored, then dropped before the screen (`queueModel.ts:126` + `queue.mjs:172`),
and the out-of-scope retry brief told the agent it had produced no diff. Spec + plan + delivery
report: `docs/superpowers/specs/2026-09-07-write-scope-visibility-design.md`. Defect classes
57-60 appended to `docs/PES-ADDENDUM.md`.

Two NEW items for the next plan, from that work:

| # | Gap | Why it matters | Size |
|---|-----|----------------|------|
| ~~C15~~ | ~~Visual baselines not re-run after the Roster moved off the squad board~~ **CLOSED 2026-09-17** — 21 baselines refreshed at load ~10, validated 32/0 on the same tree. Uncommitted (Rule 0). Evidence: STATE.md | The snapshots still show the old layout; Playwright needs a quiet host | Small |
| C16 | `npm run test:runtime` dirties a TRACKED file (`.claude/agents/notifications-engineer.md`) | `write-tree == HEAD^{tree}` reports a false negative after every contract run — addendum #60 | Small |
| C17 | **Load-sensitive** shell mount — `inbox @ dark`, `schedule @ light`, `outputs @ light` fail `waitForShell` (45 s) when host load is above roughly 35–50; pass at ≤ 33 (added 2026-09-17, redefined same day after 4 runs) | Fail @96, fail @22→58, pass @10, pass @14→33. No red loop at producible load → no fix attempted (`diagnosing-bugs` Phase 1). Not a route bug: the routes match pixel-for-pixel at low load. Rule: run `test:visual` at load < 30 | Small–Medium |

| C18 | `resume()` refuses only on `queued`; a task in `building` is mid-flight in the engine and a resume during that window still orphans the goal. Real fix is goal cancellation, not a wider refusal (added 2026-09-17, G7 Q2 partial) | A blocked job resumed while a worker is mid-task re-plans over live work; the eventual `done` names a row that no longer exists and is dropped | Medium | nothing |
| C19 | The phase-exit gate ran a SUBSET of `npm run test:runtime`. `SEAT-12` was red from Phase A Step 1 through the Phase B exit and neither gate saw it. Fixed here; the LESSON is the carried item — every phase exit runs all 204 files, output to a FILE, never piped through `tail` (added 2026-09-17, addendum #62) | Two "regression green" claims were made against a command that did not run the failing test | Small | nothing |

| C20 | The visual specs loop light/dark, but the Helm skin paints dark regardless of `data-theme`, so each pair is BYTE-IDENTICAL (md5-verified, `.planning/B-VALIDATION.md` L1). Half the theme assertions are redundant and the suite cannot say so (added 2026-09-17, addendum #18 shape) | A reader counting new baselines counts double; the day a light mode lands, nothing reports that the parameter was inert | Small | nothing |

| C21 | Sequential dispatch costs PARALLELISM. Phase C task 9 puts one task in flight so ordering is real, but a two-seat job no longer runs two seats at once. Phase D ("a team that talks") needs a ready-set rule — dispatch every task whose predecessors are done — not a strict chain (added 2026-09-18) | The USP is two workers talking; a strict chain makes that impossible by construction | Medium | Phase D |
| C22 | `onHireDone` dispatches directly instead of through `dispatchNext`, so a hire landing mid-job can put a second task in flight alongside the sequential one (added 2026-09-18) | Not wrong today — the hired task was parked, not ordered — but it is the one write path that bypasses the sequencing rule | Small | nothing |

| C23 | **BOUNDED 2026-09-19, still not reproduced.** `reapStuck()` ends any task held past 2x its watchdog (kill child → mark handle → normal retry path); a running task now arms its own wake, which nothing did before. Tests ENG-REAP-1/2, three mutations. Cause never found; this bounds the class, not the bug. Originally: (2026-09-18): three red-capable loops against the real engine all came back GREEN, and live run 2 fired the watchdog correctly. Now OBSERVABLE — `task-dispatch`/`task-watchdog`/`task-failed` traces plus `engine.inFlight` on /runtime/health. A claimed engine task can stall forever: `leaseUntil: None`, `engineState: EDITING`, no process, no spawn log line, `inflight` leaked. `RUNTIME_STEP_TIMEOUT_MS` (300 s) never fires; the Manager's 15-min stall clock is the only backstop (added 2026-09-18, live run) | This is what stopped the Phase C live run. A dispatch that produces neither a process nor an error is invisible until a job times out | **Large** | nothing |
| C24 | The engine's "no active account" refusal reaches the BOSS as `task … failed: terminal failure` — a fixable config precondition reads as an opaque failure (added 2026-09-18, live run) | Cost the first live run entirely; the operator cannot act on what they cannot see | Small | nothing |
| C25 | `RUNTIME_TOOLS` defaults to `none`, so workers silently cannot write while health reports ok (added 2026-09-18, live run) | A runtime that looks healthy and plans jobs but can never finish one | Small | nothing |
| C26 | The Manager's own worktree branch accumulates commits, so the stale-branch guard refuses to recreate it and every later manage turn runs blind to the repo (added 2026-09-18, live run) | The Manager reviews and re-plans without being able to read the code | Medium | nothing |
| C27 | `a job in 'planned' cannot go to 'awaiting-you'` — an unhandled transition reachable from the live loop (added 2026-09-18, live run) | A tick dies; the job survives but the turn is lost | Small | nothing |

| ~~C28~~ | **CLOSED 2026-09-18**, proven live (run 3: `writeScope:["README.md"]`, first real commit). `stepPaths()` only matched tokens containing a `/`, so a ROOT-LEVEL filename (`README.md`) yields no paths. The hire is then scoped by skill-name guess, and HIRE-CORR-2's scope check has nothing to check — the seat is hired for a file it can never write (added 2026-09-18, live run 2, defect in Phase C task 8) | Cost every attempt of one task in live run 2: `empty-diff … README.md (out-of-scope)`. A job with any root-level file in its plan cannot ship | Small | nothing |
| C29 | The unit-test gate runs `node --test` without `--experimental-strip-types`, so it cannot run this repo's OWN `.ts` tests: `ERR_UNKNOWN_FILE_EXTENSION ".ts"`. A seat that writes a correct TypeScript test is failed by the gate (added 2026-09-18, live run 2) | Cost the other task in live run 2. Any job whose plan includes a TS test is unshippable | Small | nothing |

| C30 | A re-plan through the PLAN stage (not the reorder path) calls `setTasks` with fresh rows, orphaning commits already on `ma/job/<id>`. Run 4: branch carried 2 commits, `summary.ship.commits` recorded 1, task titles no longer matched either (added 2026-09-19, live run 4) | With commit-as-you-go the job redoes work already committed, and `ship()` cannot account for commits it does not know about | Medium | nothing |
| ~~C29~~ | ~~The unit-test gate cannot run `.ts` tests~~ **WITHDRAWN 2026-09-19** — not a product defect. `.env` already sets `RUNTIME_SANDBOX_IMAGE=node:24-alpine`; my live-run harness did not source it and fell back to `node:20-alpine`. Fix reverted to a zero diff; the `--experimental-*` ban stands. Run 4 with the right image ran `.ts` tests to real assertions | — | — | — |

| C31 | Isolating a live run needs BOTH `RUNTIME_ROSTER_FILE` **and** `RUNTIME_AGENTS_DIR`. `factory.mjs:62` defaults the persona dir to the RUNTIME's own repo (`join(REPO_ROOT, ".claude", "agents")` where REPO_ROOT is the module's location, not `RUNTIME_REPO_ROOT`), so a hire wrote `repo-edit-engineer.md` into the operator's tree during live run 4 even though the roster override worked (added 2026-09-19) | A run pointed at another repo still mutates MissionAlpha's own working tree. Found by the agent appearing in an unrelated session's agent list | Small | nothing |

| C32 | The ship gate's TREE PIN was inert in production: `server.mjs` wired only `createJobBranch`/`commitTask`/`openJobPr` into the Manager's `pr` dep, so `pr?.treeOf` was undefined and DIFF-3 recorded `"tree": null`. Fixed and pinned by DIFF-WIRED-2 — but the pin itself has never been exercised live (added 2026-09-19, found in run 5's shipped summary) | "What you approved is what ships" was unenforced in every live run so far. Third instance of proven-at-the-seam / unwired-at-the-server this phase | Small | run 6 |
| C33 | The PR rung is still unexercised live. Every run removed the clone's `origin` for safety, so the best possible outcome was `local-branch`. `openJobPr` has never actually opened a PR in a live run (added 2026-09-19) | Phase C's stated exit wants `outcome === "pr"`; what exists is the agreed-upon substitute | Medium | a disposable remote |

C15 is now confirmed for ALL THREE visual specs (every `*-snapshots` dir last committed in `62312d5`, 2026-09-06; the roster and queue strip moved 2026-09-07). Evidence and diffs: STATE.md Phase A addendum, 2026-09-17.

Recommended order for the next plan: **C1, C2** first (real holes in something the BOSS
touches immediately), then **C13** (triage the queue), then C5/C6 (cleanup), then C3/C4
when the BOSS is available.

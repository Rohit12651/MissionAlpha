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

Recommended order for the next plan: **C1, C2** first (real holes in something the BOSS
touches immediately), then **C13** (triage the queue), then C5/C6 (cleanup), then C3/C4
when the BOSS is available.

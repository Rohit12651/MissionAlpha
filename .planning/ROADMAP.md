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

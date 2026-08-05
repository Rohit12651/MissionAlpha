# Story-Pipeline Program — the software engineer's day, end to end

**Date:** 2026-08-04 · **Status:** PLANNED, NOT STARTED · **Commit policy: NO git commit/push/stash/reset/checkout until BOSS says so. Working tree IS the deliverable. Deletions are working-tree only, reversible via snapshots.**

## Locked concept (BOSS, 2026-08-04)

MissionAlpha = **one software-engineering team running the full SDLC on a story, with two human taps** (design-ok, release-accept). Spec = BOSS's two ASCII diagrams + Kimi 8-step workflow (theater stripped) + approved mockup `missionalpha-story-pipeline-mockup.html`. **SE agents ONLY — every business agent/module goes.** Story = the unit: Idea → Requirements (clarify-loop) → Design (gate:YOU) → Plan → Build (parallel) → Review+QA (auto gates) → Deploy+Watch → Accept (gate:YOU). Runs continuously without intervention between gates.

## The team (10 seats — existing pool personas re-used, ZERO exotic new agents)

| Seat | Station id | Source |
|---|---|---|
| Tech lead / chat interface | `tech-lead` | existing captain + boss-console re-personaed (replaces CEO persona) |
| PM / analyst | `pm-analyst` | new persona, existing spawn machinery |
| Architect | `architect` | existing pool persona |
| Sr backend | `sr-backend` | existing senior-backend pool persona |
| Sr frontend | `sr-frontend` | existing senior-web pool persona |
| Reviewer | `reviewer` | existing senior-code-reviewer pool persona |
| QA | `qa` | existing senior-qa pool persona |
| DevOps | `devops` | existing senior-cicd pool persona |
| SRE / monitor | `sre` | thin persona over cadence + health checks |
| Docs | `docs-writer` | thin persona (release notes + vault memory) |

**DELETED (working tree):** coo/cmo/sales station seeds + personas; `leads.mjs`, `content.mjs` modules + routes + their tests; PipelinePage/ContentPage/LeadDrawer/BriefEditor UI files (already unlinked in P6 — now removed); business skills from SKILL_CATALOG (content-writing, social-post-*); business cadences (daily-rollup/anomaly-flag/scan-competitors/lead-scorer/inbox-triage/content-brief-builder) → replaced by SE cadences (nightly-regression, stuck-story-sweep, monitor-tick). SSE names `lead.moved`/`content.changed` stay RESERVED in the closed catalog (removing wire-contract names is riskier than leaving them dormant — disclosed).

## Non-negotiable ground rules (every phase — carried verbatim from CC-Primitives, all held there)

- PES end to end; evidence rule; gates build→lint+tsc→tests→security→runtime→adversarial self-review.
- **Opus 4.8 builds (caveman full; Sonnet 5 allowed for mechanical sweeps) · Fable 5 independently verifies.** headroom+caveman both lanes; codeburn at phase close; `headroom learn` after debug-heavy phases.
- NO git commit/push/stash/reset/checkout. BOSS's stash@{0} + ma/task/* untouched. Ports: :3004 BOSS vite, :3005 packaged NEVER, :3006 dev runtime restartable, :3016/:396x disposable verify.
- Snapshot `../ma-snapshots/SP-S{n}-<date>.tgz` + SESSION_MEMORY exit block + plan checkbox per phase. mem-search before each phase.
- Do not break current functionality; broken-found = fix+test+report in-phase. sr-security BLOCKING on sensitive paths (spawn, gates, **deploy executor — highest risk of program**, story intake).
- Context exhaustion → handoff block in SESSION_MEMORY → fresh session resumes from this plan.
- Verification battery per exit: lint 0/0 · tsc 0 · unit (client) · runtime (serial) · vendor · electron · build+bundle ≤205KB gz · browser proof on UI phases (disposable ports) · code-reviewer pass · delivery report w/ Known Gaps.

## CEO-review (embedded): key decisions

1. **Reuse engine as Build stage vs new executor** → REUSE (proven, security-approved; new = months + new attack surface). Risk: engine is goal/task-shaped → mitigated by storyId tagging, not refactor.
2. **Deploy = configurable allowlisted command vs real cloud integration** → COMMAND (`factory/deploy.json`: cmd allowlist + cwd + health URL), approver-gated, argv-array no-shell. Cloud/gh integration later; gh PR stage degrades gracefully until `gh auth` (BOSS open item). Risk: command exec = program's top security surface → dedicated sr-security review, S8 re-review.
3. **Clarify-questions via Inbox vs new chat surface** → INBOX delivery type `question` (existing decide machinery, SLA, SSE) + answer box. No new surface.
4. **CEO agent fate** → replaced by `tech-lead` as the chat seat (BOSS = the only executive; matches Kimi org where CEO is human). Disclosed: boss-console system prompt rewritten, dispatch protocol kept.

## Phase S0 — Purge business remnants + seat the SE team

- [x] Delete stations/modules/pages/skills/cadences listed above (files deleted; snapshots = rollback). Sweep every import/route/test referencing them; runtime tests referencing leads/content routes rewritten to assert 404/absence.
- [x] `seed-stations.mjs` → seeds the 10 SE seats (personas from `.claude/agents` pool where present); capabilityIndex updated; factory registry migration for renamed seats.
- [x] boss-console persona → tech-lead (dispatch protocol preserved); Chat header/copy updated.
- [x] SE cadences seeded (disabled-by-default except stuck-story-sweep).
- [x] Full battery + browser click-through of every remaining page (no orphan refs).

**Skills:** principal-standard · refactor-cleaner · sp-verification-before-completion · code-reviewer · mem-search. **Builder:** Sonnet 5 (mechanical) + Opus 4.8 (seed/persona surgery). **Exit:** battery green · zero grep hits for deleted ids outside RESERVED SSE names + SESSION_MEMORY/docs · snapshot SP-S0.

## Phase S1 — Story core (backend spine)

- [x] TDD. Migration v15: `stories` (id, title, idea, spec, design_ref, stage, status, answers, createdAt, updatedAt) + `story_log` (storyId, seq, stage, event, ref, ts).
- [x] `stories.mjs` store: create/get/list/advance/reject w/ **closed stage machine** (8 stages, legal transitions only, reject→targeted back-stage); log every transition.
- [x] REST: POST/GET `/runtime/stories`, GET `/runtime/stories/:id`, POST `/runtime/stories/:id/advance|reject` (approver POST, viewer GET — needsAuth + routeNeedsApprover). SSE `story.changed` {id, stage} — closed catalog ×4 + both equality tests.
- [x] Wire proof: full lifecycle via curl on real boot.

**Skills:** principal-standard · sp-test-driven-development · security-review (intake validation: length caps, scrub idea/spec at rest) · code-reviewer. **Builder:** Opus 4.8. **Exit:** unit+wire green · battery · sr-security PASS · snapshot SP-S1.

## Phase S2 — Requirements + Design stages (agents produce artifacts, gates land in Inbox)

- [x] Pipeline driver `pipeline.mjs`: on stage entry, dispatch the stage's agent via EXISTING spawn path (read-only class); capture artifact (markdown) → vault record + story ref; auto-advance on artifact unless gate.
- [x] Stage 2: `pm-analyst` → requirement spec; clarifying questions → Inbox delivery type `question` w/ answer box; answers stored on story; unanswered = story `waiting-you` (SLA reuses existing sweep).
- [x] Stage 3: `architect` → design doc → Inbox delivery type `design-approval` (**gate:YOU**); approve→stage 4, request-changes→re-run w/ notes.
- [x] Inbox: delivery kinds get gate chips + answer/approve UI (minimal — full UI polish in S6).
- [x] Wire proof w/ deterministic spawner: question→answer→spec; design→approve→advance.

**Skills:** principal-standard · sp-test-driven-development · security-review (question/answer text scrubbed, prompt-injection review of artifacts fed forward) · code-reviewer. **Builder:** Opus 4.8. **Exit:** battery · gates proven at wire · sr-security PASS · snapshot SP-S2.

## Phase S3 — Plan + Build stages (existing engine slotted in)

- [x] Stage 4: `tech-lead` decomposes approved design → engine goals (existing enqueueGoal) tagged `storyId`; per-seat parallel goals (backend/frontend) with file-scope hints; plan artifact logged.
- [x] queue/engine: tasks carry storyId (additive column/field); GET `/runtime/stories/:id` aggregates its tasks + loop steps; story Build panel data complete.
- [x] Stage advance: all story goals terminal → stage 6 (or fail-policy: N terminal-failures → story `blocked` + Inbox alert).
- [x] Wire proof: approved design → tasks spawned → diffs → holds → story reflects.

**Skills:** principal-standard · sp-test-driven-development · sp-subagent-driven-development (decompose semantics) · code-reviewer. **Builder:** Opus 4.8. **Exit:** battery · storyId threading proven · snapshot SP-S3.

## Phase S4 — Quality gates (tests, agent review, QA) — the autonomy teeth

- [x] **Unit-test gate in the engine**: post-diff, run repo's configured test cmd (`factory/quality.json`: testCmd, e2eCmd, timeout) INSIDE the worktree (argv array, no shell, output captured+scrubbed→loop steps). Fail → structured feedback becomes a fix task (bounded retries) — the red→green loop.
- [x] **Reviewer gate**: `reviewer` station reviews the story's combined diff → verdict artifact; blockers → fix tasks; pass → next.
- [x] **QA gate**: e2eCmd if configured (playwright), else SKIP recorded honestly in story log (never silent).
- [x] **PR stage (best-effort)**: existing pr.mjs when `gh auth` present; else local branch note + disclosed skip. (BOSS open item: `brew install gh && gh auth login`.)
- [x] Wire proof incl. deliberate failing test → fix loop → green.

**Skills:** principal-standard · sp-test-driven-development · security-review (**test/e2e cmd execution — allowlisted, worktree-cwd-locked, env-stripped**) · sp-systematic-debugging · code-reviewer. **Builder:** Opus 4.8. **Exit:** battery · red→green loop proven · sr-security PASS (BLOCKING) · snapshot SP-S4.

## Phase S5 — Ship + watch (deploy, monitor, auto bug-story, docs)

- [x] Stage 7: `docs-writer` → release notes + vault memory update; release delivery (**gate:YOU**) = notes + diffstat + task list; accept → deploy; reject → targeted back-stage.
- [x] **Deploy executor** (`deploy.mjs`): allowlisted cmd from `factory/deploy.json`, approver-gated route, argv-array, cwd-locked, output scrubbed→story log, health-URL check after. Default config = local preview deploy. **Program's top security surface — dedicated blocking review.**
- [x] Monitor: `sre` cadence (monitor-tick) polls health URL + error log pattern; spike/window breach → auto-create bug story linked to origin (dedupe window) → pipeline runs it. The 🔧 loop closes.
- [x] Wire proof: accept→deploy(cmd runs)→health ok→monitor detects injected failure→bug story minted.

**Skills:** principal-standard · sp-test-driven-development · security-review + senior-security-engineer (**BLOCKING on deploy executor**) · code-reviewer. **Builder:** Opus 4.8. **Exit:** battery · full ship+watch wire proof · sr-security PASS · snapshot SP-S5.

## Phase S6 — Stories UI (mockup made real)

- [x] hallmark first (component-scope, existing dark-cockpit tokens, zero palette drift) → build: Stories list (kanban by stage) + Story detail (spine tracker w/ amber human gates, stage panels, Build panel w/ per-agent loop steps, gates panel, clarify Q&A thread) + Inbox gate chips/answer box polish. bosNav: +`stories` (Missions folds in — board keeps living under Stories). SSE `story.changed` live.
- [x] React Query NOT introduced (repo pattern = effect+nonce — established P5). A11y: tracker aria, gates announced, reduced-motion.
- [x] impeccable+taste audit pass applied; react-reviewer BLOCKING; live browser proof (disposable ports): create story via UI → watch spine advance → answer question → approve design → see build steps → accept release.

**Skills:** principal-standard · hallmark → impeccable → taste-skill · emil-design-eng (tracker motion) · react-reviewer · preview_* verification. **Builder:** Opus 4.8 (Sonnet sweeps). **Exit:** battery · browser proof end-to-end · audits clean · snapshot SP-S6.

## Phase S7 — Autonomy soak (a story ships itself, two taps only)

- [x] Throwaway repo + deterministic spawner: seed story via API → runs unattended through ALL stages; console proof only two human interventions (scripted approvals via API at the two gates); ≥1 clarify-question loop; ≥1 failing-test fix loop; deploy cmd fires; injected error → bug story auto-minted and built.
- [x] Real-CLI leg IF `claude login` done (BOSS blocker from CC-P7, still open) — else parked, disclosed loudly.
- [x] Stability: ≥45min unattended, 0 crashes, RSS flat, quota respected; babysit monitoring; evidence pack in SESSION_MEMORY.

**Skills:** principal-standard · babysit · sp-systematic-debugging · codeburn. **Exit:** soak evidence · snapshot SP-S7.

## Phase S8 — Hardening + final sweep

- [x] sr-security cumulative (BLOCKING): deploy/test executors re-review, story intake fuzz, gate bypass attempts, artifact prompt-injection chain, two-seat 403s on every new mutation route.
- [x] UI polish audit; bundle ≤205KB gz or justified; electron smoke; `docs/qa/SP-FINAL-SWEEP-<date>.md`; delivery report w/ Known Gaps; headroom learn + codeburn; **WAIT for BOSS commit decision.**

**Skills:** principal-standard · senior-security-engineer (BLOCKING) · qa/review (gstack) · sp-verification-before-completion. **Exit:** all green w/ evidence · sweep doc · snapshot SP-S8.

## Program risks (disclosed up front)

1. **Deploy/test command execution** — top attack surface; allowlist+argv+cwd-lock+approver+blocking reviews; still a real risk class.
2. **`claude login` expired (open BOSS item)** — real-model legs park until re-auth; deterministic spawner proves machinery.
3. **`gh` unauthed (open BOSS item)** — PR stage degrades to disclosed skip.
4. **Deleting business modules may break hidden couplings** — S0 runs the FULL battery + page click-through before anything new builds.
5. **Uncommitted tree** — snapshots are sole rollback; discipline is a hard gate.

## Order & resume

S0→S1→S2→S3→S4→S5→S6→S7→S8. Fresh-context resume = this file + SESSION_MEMORY tail.

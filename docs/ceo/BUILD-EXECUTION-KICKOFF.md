# BUILD EXECUTION KICKOFF — start here in a FRESH session

**Author:** CEO (Claude) · **Date:** 2026-06-18 · **Status:** READY TO BUILD
**Why this file:** `master-roadmap.md` is the *what/why*. This is the *do-it-now* for a clean context window. The prior session hit context limits — this hands the new session pure execution, zero re-planning.

## THE ONE GOAL (acceptance test the BOSS will run)
> BOSS opens the app → types a goal: **"create a project"** (e.g. a small web app) → an agent (or swarm) scaffolds it end-to-end → BOSS sees the files, reviews the diff, applies → project lands in repo. **Auto-chained where safe, approval-gated where risky.**

Everything below serves that test. **Do not push code until the BOSS has tested it** (explicit BOSS order).

## GROUND TRUTH (verified by code read 2026-06-18 — do NOT rebuild these)
- Loop is LIVE: `agent-runtime/server.mjs` — `POST /runtime/:id/run` (L800-849) → write-mode sandbox → `GET /changes` (L438) → `POST /apply` broker (L469) → `reportBack` (L523).
- Security live: token auth (L107), host/origin gates (L119/126), `applyAllowed` (L401), `configGuardViolation` (L420), egress scrub, AES broker (`factory.mjs`).
- Model tiers live: `resolveTier` (L38), `/run` + `/chat` accept `{model}`; thread persistence `persistThread` (L167).
- Sandbox = copy at `/tmp/missionalpha-sandboxes/<id>` (`seedSandbox` L350) — NOT a git worktree yet, NOT an exec boundary.
**Extend around this code. Never rewrite the proven loop/broker/guards.**

## BUILD ORDER (each = its own CEO→architect→build→security→QA→memory cycle; ship + test each before the next)

| Order | Stage | Delivers (toward "create a project") | Hard gate |
|---|---|---|---|
| 1 | **S1 Engine** | Auto-chain the loop so a goal runs to completion without manual clicks; git worktree per task; task queue; retry/rollback; auto-apply policy (exec/config still gated) | sandbox/worktree escape, fork-bomb — `senior-security-engineer` + `cso` |
| 2 | **S2 finish** | Usage meter (tokens + context%, **subscription = no $**, like Claude Code `/context`) + session fork/resume | model-param injection |
| 3 | **S2.5 MCP** | SPIKE first (`.mcp.json`/`--mcp-config` injection into `claude -p`), then connector panel + per-agent allowlist + AES creds | cred leak, MCP cmd injection — HEAVY |
| 4 | **S3 Review** | Deep diff (untruncated, highlight, search) + inline comment→revise + PR generation + conflict resolution + tabs-per-session | PR/push token scope |
| 5 | **S3.5 Full tool loop** | REAL OS-level sandbox (container default) — escape suite passes BEFORE broker; full Bash/exec; approval UX (once/session/deny); kill-switch; audit | **HEAVIEST — sandbox escape, independent adversarial pass** |
| 6 | **S4 Polish** | Onboarding, settings/theming, command palette, audit-trail UI, CI regression | — |
| 7 | **S6 Verify** | One golden-path e2e ("create a project" full flow) + adversarial sweep + green regression | final sign-off |

Deferred (NOT this program): Desktop/Tauri (gaps #16-20), Enterprise (#21,23,24).

## AGENTS & SKILLS (use the named roster — fire automatically, never ask)
- Per build phase, run Superpowers: `sp-brainstorming` → `sp-writing-plans` → `sp-test-driven-development` → `sp-executing-plans` → `sp-verification-before-completion` → `sp-requesting-code-review`.
- Owners: `architect` (ADRs 024+), `senior-backend-1` (loop/scheduler/models/MCP), `senior-backend-2` (worktree/PR/persistence/tool-broker), `senior-web-1/2` (UI), `principal-db-engineer` (stores), `principal-ux-design` + `impeccable`/`emil-design-eng`/`hallmark` (design), `senior-security-engineer` + `security-review`/`cso` (every gate), `senior-qa` + `webapp-testing`/`playwright` (tests), `senior-code-reviewer` (merge gate), `memory-updater` (persist).
- Library/API truth: `context7` before writing against git/Docker/MCP/Claude SDK.

## DEFINITION OF DONE (per stage)
`tsc` clean + lint clean + `TESTS_GREEN` (unit+integration+e2e+adversarial, all prior tests re-run) + `senior-security-engineer` sign-off + `senior-code-reviewer` clear + `memory-updater` persisted. Stage is independently shippable. **No half-stages.**

## NEW-SESSION FIRST MOVE (paste this as the first task)
> "Read `docs/ceo/master-roadmap.md` + `docs/ceo/BUILD-EXECUTION-KICKOFF.md`. Execute Build Order #1 (S1 Engine) end-to-end: architect writes ADRs 024-029 as deltas on the live loop, then build (TDD), security gate, QA, memory. Do not rewrite the proven loop/broker/guards. Do not push code. Target acceptance: a BOSS goal auto-chains to a completed, diff-reviewable change. Then stop and report for my test."

## REFERENCE TARGET (the BOSS's north star)
MissionAlpha = **Claude Code, end to end, in one app**: chat-first, per-chat Claude tier, MCP connectors, full approved tool loop, swarm orchestration. Already wraps `claude -p` → this is alignment, not a pivot. Model that experience on Claude Code itself.

## RULES (BOSS, non-negotiable)
1. Do NOT push code until BOSS tests it.
2. No half-completed stages — finish + test each before moving on.
3. Claude only (no GPT/Gemini). Models: Opus/Sonnet/Haiku.
4. Exec boundary = real sandbox (container), NEVER a worktree.
5. Update memory at the end of each stage.

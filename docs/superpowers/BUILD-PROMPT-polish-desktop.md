# Build Prompt — Polish + Desktop (F1, F2, F4)

> Paste the block below into a FRESH Claude Code session to build F1 → F2 → F4.
> Companion spec: `docs/superpowers/plans/2026-06-21-polish-and-desktop.md`.

---

```
You are building 3 features for MissionAlpha (agent-swarm orchestrator). Work in the repo:
/Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha   (branch: feat/multimodal-input)

READ FIRST (the spec — do not skip):
docs/superpowers/plans/2026-06-21-polish-and-desktop.md

Build F1 → F2 → F5 → F4 from that plan, STRICTLY ONE AT A TIME, in that order. A feature is done
only when its Exit Gate passes; do NOT start the next until the current gate is green.

MANDATORY skills/agents (CLAUDE.md) — see the "Skill + Agent map" table in the plan. For EVERY
phase, in this order:
  1. sp-writing-plans  — task-0: expand the feature into an executable RED/GREEN sub-plan with
     real code + exact commands (the plan is a SPEC, NOT line-runnable). Save it to
     docs/superpowers/plans/.
  2. sp-subagent-driven-development — execute the sub-plan task-by-task.
  3. sp-test-driven-development — every code step is RED → GREEN → commit.
  4. The per-phase specialist agents from the map:
       F1: performance-engineer + node-specialist + security-reviewer
       F2: claude-code-guide + node-specialist + security-reviewer
       F5: architect + node-specialist + security-reviewer
       F4: electron-pro + impeccable (+ frontend-design) + webapp-testing + security-reviewer
  5. sp-verification-before-completion — before claiming the feature done.
NEVER free-code a phase. Fire sp-writing-plans first, then the agents. Delegate heavy edits to
subagents to keep the main context lean.

HARD CONSTRAINTS (verified — breaking these = wrong):
- agent-runtime/server.mjs MAX_INFLIGHT is at :166 and RUNTIME_MAX_INFLIGHT env override ALREADY
  exists — F1 changes the DEFAULT (cpu-derived) + optional dynamic backoff, keep the shared
  inflight counter + quota guard + 429 cap. Audit ALL inflight sites, not a subset.
- The boss/CEO thread is MOCKED (server.mjs:371 mockCeoReply) — F2 work + its live-check REQUIRE
  RUNTIME_BACKEND=cli; web tools must be appended OUTSIDE the TOOLS="none" branch or they're stripped.
- Tokens/fonts live in src/index.css (NOT src/styles/tokens.css — that file does not exist).
- F4 packaged-mode has TWO breaks that kill chat if missed: (a) runtime base URL (no vite proxy),
  (b) the auth token — /api/runtime-token is a vite DEV-ONLY middleware, so the built app 401s on
  everything unless Electron main reads RUNTIME_TOKEN_DIR/.runtime-token and exposes it to the
  renderer via contextBridge. Both are required for the F4 Exit Gate.
- F4 host deps: the app still needs `claude` on PATH + Docker daemon + auth — add a preflight
  screen, scope = dev-machine Tier-1, degrade gracefully when Docker is down.
- F5: REPO_ROOT is hardcoded (guards.mjs:14, NOT env). Make it RUNTIME_REPO_ROOT (default =
  MissionAlpha). Generalize SEED_DIRS (keep APPLY_DENY/CONFIG_GUARD/PUBLIC_DENY for the new root);
  worktree falls back to copy-sandbox for a non-git target; keep TOKEN_DIR outside any root +
  `../` containment. Build F5 BEFORE F4 so the desktop ships with target-repo support.

PROCESS:
- Security-sensitive paths (F1 fork-bomb, F2 egress, F4 Electron hardening) MUST pass a
  security-reviewer agent before commit.
- Commit per GREEN with clear conventional messages. Do NOT push or open a PR unless I say so.
- Do NOT touch unrelated in-flight work in the repo; stage only the files you change.
- After each feature: report the Exit Gate result with proof (test counts, build, live checks),
  then STOP and wait for my GO on the next feature.

Verify continuously: `cd agent-runtime && npm test` (currently 259 pass), `npx tsc --noEmit`,
`npm run build`. For F4, visually verify the Docker-Desktop look + Lato in the running/packaged app.

Start with F1: read the plan, write F1's sub-plan via sp-writing-plans, show it to me, then build.
```

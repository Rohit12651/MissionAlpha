# Phase 1: prove the ticket → PR loop (Approach A)

**Date:** 2026-10-14 · **Branch:** feat/multi-provider-credentials · **Decision:** D1 = A (user, 2026-10-14)

## Goal
MissionAlpha takes 10 real tickets on a real repo with a real GitHub remote and opens real PRs. We measure how many reach a PR with green CI and how many a human would merge as-is. Phase 2 is built from where it fails, not from a feature list.

## Why this, not more features
- Devin's value is one loop done reliably: ticket → own environment → code → **runs its own tests** → PR → reviewer → fix → human merge.
- MissionAlpha has the pipeline in code (request → plan → build → review → approve → ship, `manager.mjs`, `engine.mjs`, `pr.mjs`), but:
  - No real PR has ever been opened (C33).
  - Planning and review are rule-based by default.
  - The worker cannot run shell commands or tests (`server.mjs:292`, worker tools are Read/Glob/Grep/Write/Edit).
  - The running code is mostly uncommitted (143 modified + 47 untracked).
- **Feature freeze for this phase:** no new stations, seats, UI tabs or integrations until the exit criteria below are met.

## Steps (each: action → check)

| # | Step | Action | Check that proves it |
|---|---|---|---|
| 1 | Land the tree | Commit the uncommitted A–E runtime work in logical commits, including `.claude/agents/ceo.md` and the electron port/token fix. Push the branch. | A clean clone of the pushed branch passes `npx tsc --noEmit`, the unit suite (incl. JC-6) and the runtime suite. CI runs green on GitHub. |
| 2 | Desktop reaches runtime | Verify the electron runtime-env fix live. | `electron:dev` shows live data on Command Center; no "The runtime did not answer". Screenshot as proof. |
| 3 | AI mode by default | `RUNTIME_MANAGER_DISPATCH=claude` becomes the default for real runs. Deterministic mode stays for tests only. | A new job's plan and review come from a model turn, visible in the run inspector. |
| 4 | Worker can run its own checks | Allow `Bash` for the worker inside its worktree, under `worker-jail` + sandbox. Allowlist: test, lint, typecheck and build commands from `repo-scripts.mjs`, plus read-only git. No `git push`, no network installs. | New tests: a worker turn can run `npm test` in its worktree. `git push`, `curl` and writes outside the worktree are refused. |
| 5 | Test gate fails closed | When no tests ran, or Docker is down, the gate reports `no-tests` / `gate-unavailable`, never `pass`. | New tests for both cases. The review gate shows the reason to the human. |
| 6 | Proving-ground repo | A private repo with a small real app, a test suite, and CI on GitHub Actions. `gh` authenticated with repo scope. | `gh repo view` works. CI passes on `main`. |
| 7 | 10 graded tickets | 3 bug fixes, 3 small features, 2 test-writing, 1 dependency upgrade, 1 refactor. Each ticket has a written acceptance check. | Tickets exist (Jira or created via API) before any run. |
| 8 | Run and record | Run all 10. For each, record: reached PR? CI green? review findings? merge as-is / merge after edits / reject, time, model cost, failing stage plus its named reason. | `docs/plans/phase1-scorecard.md` filled from real runs, linking each PR. |

## Exit criteria (all required)
- **At least 6/10** tickets open a real PR with green CI.
- **At least 4/10** are mergeable without human edits.
- **Zero silent failures:** every failed run names its stage and reason in the UI and in the audit log.
- Clean checkout green; CI green on GitHub.

## Phase 2 (ordered later by the scorecard, not now)
Candidates, all from the Devin teardown:
- Clean-context reviewer separate from the planner.
- CI-watch + auto-fix loop.
- Answering PR comments.
- Environment snapshot per repo.
- Vault/memory read into worker prompts.
- Human plan-approval gate for jobs.
- Parallel tasks on the default roster.
- Browser self-test.

## Failure modes to watch
| Codepath | Failure | Today | Phase 1 fix |
|---|---|---|---|
| Test gate | No related tests → passes | Silent pass | Step 5: fail closed with a named reason |
| Test gate | Docker down | Fails the gate | Step 5: `gate-unavailable`, shown to the human |
| Worker shell | Agent runs a destructive or network command | n/a (no shell today) | Step 4: allowlist + jail + tests |
| `gh pr create` | Auth or scope missing | Never exercised | Step 6: `gh auth status` preflight already in `pr.mjs`; error surfaces at ship |
| Long task | Stall (C23, cause unknown) | 600 s reaper | Record each occurrence in the scorecard; root-cause if it hits a ticket |
| Strategy step (Claude mode) | `ceo.md` missing → blocks | Untracked file | Step 1 commits it |

## Not in scope (phase 1)
- New UI, stations, integrations.
- Splitting `server.mjs`.
- Multi-tenant / VM sandboxing.
- Pricing.
- Linear / Slack intake.

## Needs your decision
1. Approve committing and pushing the uncommitted work (step 1).
2. Proving-ground repo: new private repo vs. an existing one (step 6).
3. Worker shell scope (step 4).

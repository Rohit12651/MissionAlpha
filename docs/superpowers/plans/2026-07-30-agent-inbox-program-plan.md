# Agent Inbox — End-to-End Program Plan (P0–P10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Each phase MUST open by generating its own bite-sized task doc via `sp-writing-plans` (saved to `docs/superpowers/plans/YYYY-MM-DD-inbox-P<N>.md`) before any code is written.

**Goal:** Turn MissionAlpha into a real-time, end-to-end working Agent Inbox product — every agent's finished work arrives as a Delivery, gets risk-routed, human-approved, becomes a PR, and everything is wired to communicate autonomously — without breaking any existing flow.

**Architecture:** Runtime (`agent-runtime/`, Node) grows a SQLite-backed Delivery engine + an SSE event bus; the React app (Vite :3004) subscribes once and every surface (badge, board, feed, review pane) updates push-driven. Approve reuses the proven F2b broker → git worktree branch → PR. Queue/retry/auto-chain keep agents working with zero human intervention; humans only decide.

**Tech Stack:** React 19 · Vite 5 · TS strict · Tailwind · Framer Motion · Node 20 (mjs) · better-sqlite3 (WAL) · SSE · `claude -p` subscription CLI · `gh` CLI · Electron 33.

**Design target:** `docs/mockups/helm-inbox-merged-mockup.html` (Helm brass/ink skin + Inbox engine). Spec: `docs/ceo/MISSION-INBOX-master-spec.md`.

---

## 0. BOSS's 11 points → where each is enforced (NO NEGOTIATION — compliance map)

| # | BOSS point | Enforced by |
|---|---|---|
| 1 | Detailed phased plan w/ skills per phase | This doc — §Skills block inside every phase |
| 2 | Each phase built by **Opus 4.8 in caveman mode** w/ CLAUDE.md skills | §1 Model Protocol; every phase's Build lane |
| 3 | Not just UI — full backend, real-time working app | P2 (engine), P4 (autonomy), wiring contract §2; every phase has Backend+Frontend+Wiring lanes |
| 4 | Test/validate/verify each phase w/ skills + **Fable 5** | §3 Verification Protocol; Gate lane in every phase |
| 5 | **No commits until told** | §4 Commit Policy — global hard rule |
| 6 | Every mentioned feature works | Exit criteria are runtime-verified behaviors, not code-exists checks |
| 7 | Everything WIRED, communicating, works without human intervention | §2 Real-time Wiring Contract + P4 autonomy phase; "wired proof" item in every phase's exit |
| 8 | Add what BOSS forgot | §5 Added-by-brain items (feature flags, rollback, DB backup, error states, onboarding, docs, secrets, packaging) |
| 9 | Don't break current flows; fix broken ones | P0 baseline phase + §6 Regression Suite re-run at EVERY phase exit |
| 10 | Every point addressed | This table + self-review at doc end |
| 11 | Use `~/.claude/CLAUDE.md` + skills every phase | PES gates + skill chains named per phase; headroom/caveman/claude-mem always-on |
| 12 | No loose ends — production-grade, 100%, autonomous while BOSS sleeps | §7 Production-Grade Definition + autonomous execution mandate; every phase exit = zero known loose ends or they're in the phase report as BLOCKING |
| 13 | Context window dies → continue in new session; never burn tokens | §8 Continuation Protocol (SESSION_MEMORY handoff + plan checkboxes = resume state); headroom (already wired), caveman full, codeburn per session, lean subagent prompts (paths not file dumps) |
| 14 | Fable 5 verify lane ALSO runs headroom/caveman/codeburn | §1 amended — token discipline applies to BOTH lanes, no exception for verification |

---

## 1. Model Protocol (applies to every phase)

- **Build lane — `claude-opus-4-8`, `/caveman full` first action.** All implementation sessions/subagents run Opus 4.8. Caveman on the bus and in chat; code/commits/ADRs normal prose (per PROTOCOL.md).
- **Verify lane — `claude-fable-5`.** After Opus reports phase TESTS_GREEN, a separate Fable 5 session runs §3 Verification Protocol. Fable never patches; it verifies, files findings, returns phase to Opus if any gate fails.
- **Session bookkeeping (every session):** headroom already wraps `claude` (do not re-setup). After heavy debugging: `headroom learn`. After session: `codeburn` check. Memory: `memory-updater`/claude-mem persists decisions + `docs/SESSION_MEMORY.md` per phase.
- **Library rule:** before touching an unfamiliar API (better-sqlite3, SSE, `gh`, fs.watch, Electron Notification) → context7 MCP docs first (Operating Discipline 9/9b).

## 2. Real-time Wiring Contract (point 7 — defined once, honored everywhere)

Single event bus. Nothing in the UI ever needs a manual refresh; nothing in the runtime waits for a human except a **decision**.

```
GET /runtime/events   (SSE, token+host gated, auto-reconnect w/ Last-Event-ID)
  event: delivery.created   data: Delivery            → badge++, list insert, native notification
  event: delivery.decided   data: {id,status,by}      → badge--, card state, board DONE, feed line
  event: task.queued|started|retried|failed|done      → queue panel, station note
  event: agent.state        data: {id,state,task}     → roster dots, kanban card glide
  event: usage.tick         data: {agentId,tokens,ctx}→ usage meter
  event: policy.autoapplied data: {id,reasons}        → auto section + audit
```

> **AMENDMENT — 2026-07-30 — `task.done` added to the catalog.** Approved by Fable in BOSS's absence during the P4 security-hardening pass; recorded here rather than applied silently.
> **Reason:** the v1 catalog had no success-terminal name, so a task reaching DONE left the queue *silently*. `QueueStrip` could only learn of it from its own 400ms debounced re-truth fetch, i.e. the strip rendered finished work as still-running for up to ~0.4s on every completion — the one state the operator watches most. `task.done` closes that gap.
> **Blast radius:** additive only. Emitted from `queue.update()` on the `→ done` transition under the SAME emit-on-persist rule and the SAME 7-scalar `wire()` allow-list as `task.failed`, guarded on the previous status so it fires exactly once. Catalog stays closed — `events.mjs` `EVENT_NAMES`, `src/lib/useRuntimeEvents.ts` `RUNTIME_EVENT_NAMES` and ADR-052 §2 were updated together, and both catalog-equality tests assert the new list. No other name added or renamed.

- UI subscribes ONCE (`src/lib/useRuntimeEvents.ts`); existing 2s state.json poll stays as fallback (never removed — decoupled watcher principle).
- Runtime side: every mutation (mint, decide, queue transition, retry, auto-apply) emits on the bus in the same function that persists it — no dual paths.
- Autonomy loop (no human needed): scheduler tick → queue dispatch (≤MAX_INFLIGHT) → agent runs in worktree → Delivery minted → risk router → (low+policy: auto-apply+audit) | (else: waits in Inbox) → on approve: apply→PR→reportBack→auto-chain next queued task. Humans appear ONLY at the decision step.

## 3. Verification Protocol (point 4 — run by Fable 5 at every phase exit)

PES gates in order, evidence required, failing gate = phase returned:
1. **Build:** `npm run build` exit 0.
2. **Lint+typecheck:** `npm run typecheck` 0 errors; eslint (fixed in P0) 0 warnings.
3. **Tests:** `npm run test:unit && npm run test:runtime` green + phase's new tests + **§6 regression suite** green.
4. **Security pass:** `security-review` skill on any endpoint/exec/credential change; senior-security-engineer sign-off where the phase table says so; block on CRITICAL/HIGH.
5. **Runtime verification:** boot the REAL stack (`npm run dev` + `agent-runtime` + sim) and execute the phase's exit criteria in the browser (playwright/agent-browser/webapp-testing), screenshots captured.
6. **Adversarial self-review:** `/code-review` (code-reviewer agent) + caveman `cavecrew-reviewer` on the diff; sev≥Medium findings resolved.
7. **Report:** PES delivery report w/ Known Gaps & Risks → appended to `docs/SESSION_MEMORY.md`. Reserved words ("done/passing/fixed") only with the evidence above.

## 4. Commit Policy (point 5 — global hard rule)

- **NO `git commit` / `git push` until BOSS says commit.** No exceptions, including the sp-writing-plans per-task "Commit" steps — those steps are REPLACED program-wide by "**Checkpoint:** `git add -A && git status` review; leave staged".
- Work accumulates in the working tree; each phase ends with a clean `git status` review listing exactly what it touched. When BOSS says commit: one conventional commit per phase, in phase order.
- Mid-program safety (uncommitted work is fragile): phase exits create a tarball snapshot `../ma-snapshots/P<N>-<date>.tgz` (outside repo). BOSS may waive.

## 5. Added-by-brain items (point 8 — things BOSS didn't list, now in scope)

1. **Feature flag `VITE_INBOX`** (default ON in dev): new shell surfaces mount behind it → current cockpit untouched if flag off. Kill-switch for point 9.
2. **Rollback per phase:** snapshot tarballs (§4) + flag = instant revert path.
3. **DB safety:** SQLite WAL + `data/` gitignored 0600 + `POST /runtime/admin/backup` (copies db to snapshots dir).
4. **Error/empty/loading states** for every new surface (Inbox empty, SSE disconnected banner w/ auto-retry, review-pane load fail).
5. **Onboarding update:** first-run adds "Open a repo" + "Your Inbox" steps (P5).
6. **Docs debt:** ADR-051 (Delivery engine), ADR-052 (event bus), ADR-053 (risk router), ADR-054 (ingestion adapters); README rewrite at P10.
7. **Secrets:** `gh` token stays in gh's own keychain — runtime shells out to `gh`, never stores tokens; adapters' config holds only bot-name patterns. Egress scrub extended to new SSE bus.
8. **Electron packaging check** (P10): better-sqlite3 native rebuild via electron-builder verified on macOS arm64.
9. **Time/clock discipline:** SLA deadlines stored absolute UTC; UI renders countdown (no server tick drift).
10. **Notification dedupe** (one per delivery, re-notify only on SLA half-life).

## 6. Regression Suite (point 9 — re-run at EVERY phase exit, grows monotonically)

Baseline flows that must stay green (captured/fixed in P0, scripted as playwright + curl where possible):
R1 chat streams (boss + agent, cli backend) · R2 boss dispatch → F3 gate → commands on bus · R3 F2b sandbox → /changes → gated /apply → file lands + reportBack DONE · R4 factory author→create→agent on board · R5 board kanban/heartbeat/feed/globe live from state.json · R6 sessions browser + replay scrubber · R7 skills palette · R8 settings/theme · R9 runtime auth (no-token 401, evil-host 403) · R10 tsc 0 + unit + runtime tests.

## 7. Production-Grade Definition (point 12 — what "no loose ends" means, checkable)

A phase is NOT done while any of these exist: stubbed function, mock data in a live path, TODO comment introduced by this program, feature that works only via curl but not UI (or vice versa), error path that logs nothing, endpoint without auth gate, UI state without empty/loading/error variants, test that is skipped, regression item red, or undocumented behavior change. Anything genuinely deferrable is written in the phase report as BLOCKING/DEFERRED with reason — silence about a gap is the violation (PES rule 4/5).

## 8. Continuation Protocol (point 13 — surviving context-window death)

- Resume state lives in three durable places, updated continuously: (1) this plan's phase checkboxes/status lines, (2) `docs/SESSION_MEMORY.md` (append per phase: what shipped, evidence, next step), (3) claude-mem observations via memory-updater.
- New session bootstrap = read plan doc §status + SESSION_MEMORY tail + `git status`. No re-derivation of decided things (Operating Discipline 8).
- Token discipline both lanes (points 13+14): headroom wrap (already active, do not re-setup), `/caveman full` first action every session incl. Fable 5 verify sessions, codeburn check at session end, subagents receive file PATHS + exact task — never pasted file bodies, Explore/investigator agents for search instead of main-thread file dumps.

## PROGRAM STATUS (live — updated every phase)

- [x] P0 baseline & guardrails — COMPLETE 2026-07-30. Gates: lint 0/0 (was 46/5, eslint newly real), tsc 0, unit 100/100 (was 9/9 fail), runtime 329/329 (297 orphaned tests wired in), vendor 6/6, build ✓5.4s. Fixed: IPv6 proxy hijack (stale vite killed + 7 targets→127.0.0.1), launch entry, stale comment. Docs: BASELINE + REGRESSION. Known gaps: index bundle 236KB gz near budget (P10); `test:runtime` boots real server in exec-loop tests (slow-ish 12s, acceptable).
- [x] P1 debt burn-down — COMPLETE 2026-07-30 (Fable verify lane passed). All 7 asks live + browser-verified; in-lane adversarial/security review APPROVE (review agents 529'd twice). Gates: lint 0/0 · tsc 0 · unit 113 · runtime 335 · vendor 28 · build ✓. Bundle 236→175KB gz. Skills 3,165/60 sources. Snapshot ../ma-snapshots/P1-2026-07-30.tgz. Deferred: interrupted-marker visual on cli backend (P2 verify).
- [x] P2 delivery engine + event bus — COMPLETE 2026-07-30. SQLite Delivery engine + SSE bus live; approve→broker→reportBack proven; sr-security NEEDS-FIX(2 HIGH) → all 8 fixes + 12 tests + RED-proof, live PoC probes now 404/400 w/ runtime alive. Gates: lint 0/0, tsc 0, unit 113, runtime 411, vendor 28, build 5.06s. Snapshot ../ma-snapshots/P2-2026-07-30.tgz.
- [x] P3 inbox UI + notifications — COMPLETE 2026-07-30. Inbox live + push-driven; APPROVE→real file→reportBack→badge proven in browser; flag-off kill-switch verified. Gates: lint 0/0, tsc 0, unit 150, runtime 414, vendor 28, build 5.13s, index 178KB gz. Deferred: playwright harness (P10), risk/SLA chips (P6), font vendoring.
- [x] P4 autonomy queue/retry/auto-chain — COMPLETE 2026-07-30 (build + Fable verify + sr-security). SECURITY_APPROVED, no blockers; 1 MED + 4 LOW hardened; task.done catalog amendment (Fable-approved, disclosed); ADR-052 PRECONDITION-052.1 (no per-client SSE scoping → BLOCKER at P9). AUTONOMY PROVEN LIVE IN BROWSER: enqueue → fail → auto-retry → exhaust → failure Delivery in Inbox → Dispatch fix → re-enqueue → 3 auto-attempts → new failure Delivery pushed, ZERO human between steps (BOSS point 7). Build lane also fixed 2 autonomy-killers only visible by booting (no backoff wake; approve never advanced the queue) + maxPerAgent 2→1 + reconcile pre-state claims. Gates: lint 0/0, tsc 0, unit 178, runtime 487, vendor 28, build 5.03s, index 178.28KB gz. Snapshot ../ma-snapshots/P4-2026-07-30.tgz. Deferred: queue store still file-backed (OQ-027.3), task.done unproven against a live cli agent, GlobeCanvas/missionSkills per-chunk sizes → P10.
- [x] P5 any-repo/worktrees/PRs — COMPLETE 2026-07-30 (build + Fable verify + sr-security 2 rounds). Worktrees + commit→push→PR ladder live. 1st review NEEDS-FIX (CRIT case-insensitive $HOME bypass + 2 HIGH) → all 10 fixed; re-review SECURITY_APPROVED; 3 MED+2 LOW residuals closed; MED-1 re-proven safe. Gates: lint 0/0, tsc 0, unit 184, runtime 606, vendor 28, build 5.75s, 179.37KB gz. NEEDS BOSS: brew install gh + gh auth login. Snapshot ../ma-snapshots/P5-2026-07-30.tgz.
      EXISTS-vs-ADDED audit first: worktrees (ADR-026) were ALREADY live end-to-end — per-task `git worktree add`, branch `ma/task/<id>`,
      pinned base SHA, argv-only git, hooks neutralized, copy-sandbox fallback for non-git, cleanup on every terminal state, 11 tests.
      F5 had already made REPO_ROOT/SEED_DIRS env-configurable. ADDED: `workspace.mjs` (validated + persisted 0600 workspace) ·
      gated `GET/POST /runtime/workspace` · `pr.mjs` approve→commit→push→`gh pr create` ladder w/ honest mode recording ·
      DB migration v3 (prUrl/mode/branch) · `worktree.release()` (fixed a REAL bug: `onOperatorApplied` would `git branch -D` the
      commit it just approved) · Settings Workspace section w/ gh indicator · Onboarding "Open a repo" step · branch + PR link in the Inbox.
      DEVIATION (disclosed): a remote-less repo gets a local BRANCH, not a merge (the plan said "merged") — an unattended merge into the
      checked-out branch has no reviewer in the path. Branch naming kept as `ma/task/<id>`, NOT renamed to `ma/<agent>/<slug>`.
      Gates: lint 0/0 · tsc 0 · unit 184 · runtime 551 · vendor 28 · build 5.38s · index 179.37KB gz (≤190).
      LIVE PROOF on throwaway $TMPDIR repos + a fake bare remote (:3991, never a real remote/PR): validation rejects $HOME // /symlink-to-$HOME/
      nested-worktree/non-git (400 each, nothing persisted) · restart picks up the persisted workspace · real worktree in `git worktree list` ·
      approve → real commit on `ma/task/<id>` (conventional prefix, agent co-author, NO AI attribution), live working tree UNTOUCHED, worktree
      released, BRANCH KEPT, engine → DONE "operator-approved (branch kept)" · gh absent → mode 'branch' + honest reason · fake gh → mode 'pr'
      with the branch really pushed to the throwaway remote. KNOWN GAP: `gh` is not installed on this machine, so rung (a) is proven by an
      injected/fake gh, never against real GitHub.
- [x] P6 risk router/policy/SLA — COMPLETE 2026-07-30 (build + Fable verify + sr-security 2 rounds). Auto-apply live behind 4 deny-by-default gates + un-trickable classifier + case-insensitive deny-list w/ un-removable floor; auto-approve OFF by default; SLA drift-free. 1 HIGH (deny case-sensitivity, same class as P5 CRIT) + 1 MED fixed → SECURITY_APPROVED. Gates: lint 0/0, tsc 0, unit 192, runtime 674, vendor 28, build 5.49s, 181.17KB gz. Snapshot ../ma-snapshots/P6-2026-07-30.tgz.
- [x] P7 universal ingestion — COMPLETE 2026-07-30 (build + Fable verify + sr-security SECURITY_APPROVED, no CRIT/HIGH). GitHub PR adapter + Claude Code sessions adapter live; external deliveries triple-gated against auto-apply; claude-code read-only server-403; all 9 threats clean; LOW (path scrub) + INFO closed. Gates: lint 0/0, tsc 0, unit 196, runtime 709, vendor 28, build 4.95s, 183.61KB gz. NEEDS BOSS: gh install+auth for real-GitHub loop. Snapshot ../ma-snapshots/P7-2026-07-30.tgz.
- [x] P8 usage meter + audit export — COMPLETE 2026-07-30 (build + Fable verify). Tokens+context% per agent/thread/tier on the bus (usage.tick now emitted); audit export JSON|CSV streamed+scrubbed+gated. NO DOLLARS proven 3 ways (dist grep, body grep, test asserts). Gates: lint 0/0, tsc 0, unit 204, runtime 726, vendor 28, build 5.22s, 185.31KB gz. Gap→P10: usage meter visual not browser-driven (preview 721px + mock est-only); data path fully tested. Snapshot ../ma-snapshots/P8-2026-07-30.tgz.
- [x] P9 second seat — COMPLETE 2026-07-30 (build + Fable verify + sr-security 3 rounds). Users/roles/sessions/assignment; roles enforced server-side; solo zero-login unchanged; 052.1 resolved. 1 HIGH (role-gate under-scope, viewer→engine-mutations) fixed across 2 re-rounds → SECURITY_APPROVED. Gates: lint 0/0, tsc 0, unit 210, runtime 765, vendor 28, build 6.78s, 187.96KB gz. Snapshot ../ma-snapshots/P9-2026-07-30.tgz.
- [x] P10 dogfood + polish + hardening — COMPLETE 2026-07-30 (build + Fable verify). Electron pipe-hang fixed (RED-proven), globe lazy-split, dogfood scoreboard (live real data), empty/error states, reset:dev, README rewrite, ADR 051-054 as-built, FINAL-SWEEP. Gates: lint 0/0, tsc 0, unit 211, runtime 773, vendor 28, electron 9, build 6.39s, index 187.58KB gz. Snapshot ../ma-snapshots/P10-2026-07-30.tgz. Deferred (BOSS-operated): gh install→real-PR proof, dogfood week, dmg build.

---

# PHASES

Format per phase: Goal → Files → Lanes (Backend/Frontend/Wiring) → Skills chain → Exit criteria (runtime-verified) → Security. Every phase implicitly: Opus 4.8 caveman build lane, Fable 5 verify lane (§3), regression re-run (§6), checkpoint-not-commit (§4), memory persist, phase task-doc first (`sp-writing-plans`).

---

## P0 — Baseline, fix-broken, guardrails  (effort S)

**Goal:** Know exactly what works today; fix what's already broken; erect the safety rails so P1+ can't silently break the app.

**Files:** Create `docs/qa/BASELINE-2026-07-30.md`, `docs/qa/REGRESSION.md`, `e2e/regression.spec.ts` (playwright, R1–R9 as executable where feasible). Modify `package.json` (fix aspirational `lint` — install eslint@^9 + typescript-eslint flat config OR change script to `tsc --noEmit`; decide by trying eslint first), `.env.example` (document all runtime env vars incl. new ones reserved: RUNTIME_DB_PATH).

**Lanes:** Backend: boot runtime all 3 backends (mock/cli), curl-verify R9. Frontend: boot dev+sim, walk R1–R8 in browser. Wiring: none new — record how state.json poll + /runtime proxy currently connect (baseline diagram in BASELINE doc).

**Skills chain:** `smart-explore` (codebase re-orient) → `mem-search` (recall prior decisions) → `sp-verification-before-completion` (baseline evidence discipline) → `silent-failure-hunter` (sweep existing fetch/poll error handling — fix any swallowed errors found) → gstack `/qa-only` (structured QA pass) → `webapp-testing`+`playwright` (script the regression spec) → `/code-review` on any fixes.

**Exit criteria (runtime-verified):** R1–R10 all pass and are written into REGRESSION.md with exact commands; every pre-existing failure found is either fixed+tested or logged in BASELINE doc with BOSS-visible severity; `npm run lint` actually runs clean; `e2e/regression.spec.ts` green headless.

**Security:** none new. No commit.

---

## P1 — Debt burn-down: the 7 BOSS asks  (effort S–M)

**Goal:** Every open README ask works. Trust for daily use.

**Files:** Modify `agent-runtime/server.mjs` (child-process registry + `POST /runtime/:id/stop` — SIGTERM→2s→SIGKILL, thread marked interrupted, SSE-ready), `src/components/workspace/ChatPane.tsx` (pending/loading indicator between send and first token + Stop button wired to /stop), `src/components/skills/SkillPalette.tsx` + `src/lib/missionSkills.ts` + `scripts/vendor-skills.mjs` + `scripts/gen-skills.mjs` (full 1800+ catalog: generate `src/data/skills.gen.json` from `~/.claude` skill roster, virtualized list, grouped, searchable), `src/components/KanbanBoard.tsx`/`AgentDrawer.tsx` (delete-agent control, hidden for `ceo` + built-ins guard via registry check, F3 confirm-gated), `src/components/factory/AgentFactory.tsx` (Add-Agent placed beside CREATE; manual skill add during create via SkillPicker), `src/components/factory/CreateAgentFlow.tsx` (CEO-assembles-team: "Describe the job" → CEO proposes agent set via authorSpec-style ```team block → BOSS confirm → batch create).

**Lanes:** Backend: /stop endpoint (needsAuth gated), inflight registry keyed by agentId. Frontend: all 7 surfaces. Wiring: Stop button → /stop → thread state → UI reflects "interrupted" without refresh (poll now; SSE retrofit in P3).

**Skills chain:** `sp-writing-plans` (P1 task doc) → `sp-test-driven-development` (stop endpoint + team-block parser tests FIRST) → context7 (child_process signals) → UI touches: `hallmark` → `impeccable craft` → `taste-skill` → `emil-design-eng` (loading shimmer ≤300ms, reduced-motion) → `security-review` (/stop is process control: verify token gate, no pid injection, only registry children killable) → `/code-review` + `cavecrew-reviewer` → gstack `/qa` → `sp-verification-before-completion`.

**Exit criteria:** Browser-verified: mid-stream Stop kills generation <2s and chat recovers; send shows loader instantly; skills list shows real count (≥1800) and search stays 60fps; delete removes agent from board+registry (ceo undeletable); create-agent w/ manually-added skills persists; "CEO picks team" proposes ≥2 agents and creates them on confirm; regression suite green.

**Security:** senior-security-engineer sign-off on /stop. No commit.

---

## P2 — Delivery engine + event bus (the backend heart)  (effort M)

**Goal:** Every completed agent run mints a Delivery in SQLite; decisions execute through the existing broker; every mutation broadcasts on a real-time SSE bus.

**Files:** Create `agent-runtime/db.mjs` (better-sqlite3 open/WAL/migrations table; schema: deliveries + events_log per master-spec §3 + `docs/ceo/MISSION-INBOX-master-spec.md` SQL), `agent-runtime/deliveries.mjs` (mint/list/get/decide/feedback; patches persisted to `data/patches/<id>/`), `agent-runtime/events.mjs` (SSE broadcaster: client registry, heartbeat ping 25s, Last-Event-ID replay from events_log), `agent-runtime/__tests__/deliveries.test.mjs`, `__tests__/events.test.mjs`. Modify `agent-runtime/server.mjs` (routes: `GET /runtime/events`, `GET /inbox`, `GET /inbox/:id`, `POST /inbox/:id/approve|reject|request-changes` — all needsAuth; mint hook where /run completes (reuse /changes diff walk); approve → existing `applyChanges()` → `reportBack()`; request-changes → feedback→`/run`), `agent-runtime/package.json` (dep better-sqlite3), `.gitignore` (`agent-runtime/data/`).

**Lanes:** Backend: everything above. Frontend: none (P3). Wiring: bus is born here — mint/decide emit `delivery.created/decided`; contract tests assert emit-on-persist atomicity.

**Skills chain:** `sp-writing-plans` → `sp-brainstorming` (short: id scheme, event replay semantics) → context7 (better-sqlite3, SSE spec) → `sp-test-driven-development` (db + mint + decide + SSE replay tests FIRST — node --test) → `sp-systematic-debugging` if flake → `security-review` + `claude-code-security-review` posture (new mutating endpoints, event bus egress scrub — SECRET_RE applied to every SSE payload) → `/code-review` + `typescript-reviewer`-grade pass on mjs → gstack `/review` → `sp-verification-before-completion`.

**Exit criteria (curl-verified, no UI yet):** dispatch a real `/run` → row in deliveries table + `delivery.created` observed on an open SSE connection <500ms after run completes; `POST approve` applies file to repo (F2b path), emits `delivery.decided`, agent hits DONE_CYCLE on the board feed; `request-changes` re-runs agent with feedback in prompt; restart runtime → deliveries survive, SSE Last-Event-ID replays missed events; all auth-gate adversarial curls 401/403; tests green.

**Security:** MANDATORY senior-security-engineer review (mutating endpoints + broker touchpoint). ADR-051 + ADR-052 written (architect voice). No commit.

---

## P3 — Inbox UI + notifications (the merged mockup, live)  (effort M)

**Goal:** The Helm merged mockup becomes the real default surface: Inbox with risk chips, SLA timers, review pane w/ full diff, typed-confirm, Approve/Request-changes/Reject — all push-driven.

**Files:** Create `src/lib/inboxClient.ts` (token fetch pattern cloned from `factoryClient.ts`), `src/lib/useRuntimeEvents.ts` (SSE subscribe + reconnect + fallback flag), `src/components/inbox/InboxPanel.tsx`, `DeliveryCard.tsx`, `ReviewPane.tsx`, `RiskChip.tsx`, `SlaTimer.tsx`, `AutoApprovedStrip.tsx`, `src/theme/helm.css` (brass/ink token set as `data-theme="helm"`, additive — existing themes untouched). Modify `src/components/ViewToggle.tsx` (Board ⇄ Inbox, Inbox default when flag on), `src/components/cockpit/RightPanel.tsx` (Review tab), `src/components/shell/TitleBar.tsx` + `StatusStrip.tsx` (badge), `src/App.tsx` (mount behind `VITE_INBOX`), `electron/main.cjs` + `preload.cjs` (native Notification + dock badge via existing missionAlpha bridge), `e2e/inbox.spec.ts`.

**Lanes:** Backend: none new (P2 serves). Frontend: all above. Wiring: badge/list/pane react to SSE only (poll fallback behind disconnect banner); notification fires on `delivery.created` w/ dedupe (§5.10); Approve in UI → P2 endpoint → board card glides to DONE + feed line appears with NO refresh anywhere.

**Skills chain:** `sp-writing-plans` → design stack IN ORDER: `hallmark` (structure, anti-slop, Helm direction locked) → `impeccable` (`craft` build, `animate` motion, then `audit`+`polish`) → `taste-skill`/`soft-skill` (premium whitespace/feel) → `emil-design-eng` (≤300ms, ease-out enters, transform/opacity only, reduced-motion path for SLA pulse) → `frontend-design` base scaffolding → `sp-test-driven-development` (component tests: risk chip mapping, SLA formatter, typed-confirm gating; lib tests in `src/lib/__tests__/`) → context7 (EventSource reconnect patterns) → `webapp-testing`+`playwright` (e2e: full loop) → `ai-writing-auditor` (UI copy) → `/code-review` + react-reviewer-grade pass → gstack `/design-review` + `/qa` → `sp-verification-before-completion`.

**Exit criteria (browser-verified, screenshots dark+light+helm):** queue task → Delivery card appears via SSE + macOS notification + badge increments, all <1s after run completes; open card → full diff (no 4KB truncation); high-risk Approve disabled until typed APPLY; approve → repo file + PR-less apply + board DONE + feed line, zero manual refresh; request-changes feedback becomes agent's next run; reject discards sandbox; SSE kill → banner + poll fallback keeps app usable → reconnect replays missed deliveries; 375px width usable; a11y: focus trap in review pane, ESC closes, contrast AA; regression green (flag off = old shell identical).

**Security:** review pane renders diffs as TEXT (no innerHTML — XSS guard; the mockup's innerHTML pattern explicitly banned in production code). No commit.

---

## P4 — Autonomy: queue · retry · auto-chain  (effort M)

**Goal:** Point 7 fully realized: BOSS queues N tasks and walks away; agents work in parallel, fail, retry, self-heal, and stack Deliveries — zero human intervention until decisions.

**Files:** Modify/extend existing `agent-runtime/queue.mjs` (durable task table in SQLite: queued/running/retry/failed/done; per-agent serial, cross-agent parallel ≤MAX_INFLIGHT; survives restart), `agent-runtime/self-heal.mjs` (error classifier: transient→1 auto-retry; permanent→failure Delivery "agent stuck — needs you"), `agent-runtime/scheduler.mjs` (tick: dispatch next queued when agent free; auto-chain on delivery.decided=approved), `agent-runtime/server.mjs` (`POST /runtime/queue` {agentId,task}, `GET /runtime/queue`; emit task.* events), `src/components/inbox/QueueStrip.tsx` (queue visibility in Inbox), tests `__tests__/queue.test.mjs` (incl. kill-restart resume test).

**Skills chain:** `sp-writing-plans` → `sp-test-driven-development` (queue state machine tests FIRST: transitions, restart resume, retry exhaustion → failure delivery) → `sp-systematic-debugging` (any race) → `sp-dispatching-parallel-agents` pattern awareness for MAX_INFLIGHT semantics → `silent-failure-hunter` (retry path must never swallow) → `security-review` (queue endpoint gated; task text 2000-char cap reused) → `/code-review` → gstack `/qa` → `sp-verification-before-completion`.

**Exit criteria:** queue 5 tasks across 3 agents via UI → close laptop metaphor (no interaction 10 min) → 5 Deliveries waiting (or failure Deliveries where agent genuinely stuck); kill -9 runtime mid-run → restart → queue resumes, no lost/duplicated tasks (test proves); approve a delivery → next queued task for that agent dispatches automatically (auto-chain observed on bus); MAX_INFLIGHT respected under load (6th concurrent /run → queued not spawned); regression green.

**Security:** sr-security pass on queue endpoint. ADR-027/028 updated to as-built. No commit.

---

## P5 — Any repo · worktrees · real PRs  (effort M)

**Goal:** Point it at ANY git repo in one click; agent work happens on real branches in git worktrees; Approve produces a real GitHub PR (or local branch merge when no remote).

**Files:** Modify/extend `agent-runtime/worktree.mjs` (worktree add `ma/<agent>/<task-slug>` from repo root; replaces copy-sandbox for git repos; copy-sandbox stays as fallback for non-git dirs), `agent-runtime/server.mjs` (workspace config: `POST /runtime/workspace` {repoPath} w/ validation git-repo+realpath+not-home-root; seed/apply/CONFIG_GUARD paths become workspace-relative), `agent-runtime/pr.mjs` (create: on approve, commit on branch (worktree) + `gh pr create --fill` when remote+gh auth; graceful degradation ladder PR→local-branch→apply-only, surfaced in Delivery), `src/components/settings/SettingsPanel.tsx` (repo picker + gh status indicator), `src/components/onboarding/Onboarding.tsx` ("Open a repo" step), Delivery schema migration (add pr_url, mode). Tests: worktree lifecycle, path validation adversarial, pr degradation ladder (gh mocked).

**Skills chain:** `sp-writing-plans` → `sp-using-git-worktrees` (the skill literally covers this domain — read before design) → context7 (`gh` CLI, git worktree) → `sp-test-driven-development` → **`security-review` + `claude-code-security-review` MANDATORY** (repo path traversal, worktree escape, commit identity, gh token isolation — token never touches runtime storage or browser; runtime shells `gh` argv-array no shell) → `/code-review` → gstack `/qa` + `/careful` (conservative execution mode for the apply-path refactor) → `sp-verification-before-completion`.

**Exit criteria:** clone a fresh public repo → Settings→pick it → queue task → agent works in `git worktree list`-visible worktree → Delivery → approve → REAL PR opens on GitHub with correct diff (screenshot + `gh pr view` evidence); same flow on repo w/o remote → local branch `ma/...` merged; non-git folder → copy-sandbox fallback works; CONFIG_GUARD still refuses package.json script changes; all P0 regression on MissionAlpha's own workspace still green; adversarial path tests (.. / symlink / home root) rejected.

**Security:** sr-security sign-off blocking. ADR-026 updated as-built. No commit.

---

## P6 — Risk router · policy · SLA  (effort S–M)

**Goal:** Anti-approval-fatigue: deliveries auto-classified; BOSS-editable policy decides auto-approve (low) vs human (med) vs typed-confirm (high); SLA timers escalate; all audited.

**Files:** Create `agent-runtime/risk.mjs` (pure heuristic classifier — path patterns [auth/payment/infra/.env/ci=HIGH; src=MED; tests/docs=LOW], diff size bumps, new-dependency detector (package.json/pyproject diff), kind; returns {score,band,reasons}), extend `agent-runtime/policy.mjs` (bands→behavior from `factory/policy.json`; auto-approve LOW **default OFF**; always-human deny-list overrides everything), `agent-runtime/scheduler.mjs` (SLA sweep: half-life re-notify, expiry → `delivery.expired` event + visual escalate), `src/components/settings/PolicyEditor.tsx` (band behavior + deny-list editor, F3-gated save), Delivery mint calls risk at creation. Tests: classification matrix table-driven (≥20 cases), policy precedence, SLA sweep.

**Skills chain:** `sp-writing-plans` → `sp-brainstorming` (risk taxonomy vs master-spec) → `sp-test-driven-development` (matrix FIRST) → `security-review` (auto-apply path is the scariest surface in the program: verify deny-list cannot be bypassed, policy file schema-validated, audit line on every auto-apply) → `impeccable`+`emil` (SLA pulse motion, escalation states) → `/code-review` → gstack `/cso` (security-officer pass on policy semantics) → `sp-verification-before-completion`.

**Exit criteria:** docs-only delivery under policy(low=auto) applies itself + lands in Auto strip + audit line w/ reasons; same delivery w/ policy OFF waits in Inbox; auth-file delivery always demands typed APPLY regardless of policy; SLA hits half-life → exactly one re-notification; expiry → card escalates visually + event on bus; policy edits require F3 confirm and reload live (no restart); regression green.

**Security:** sr-security BLOCKING sign-off on auto-apply. ADR-053. No commit.

---

## P7 — Universal ingestion (the moat)  (effort M–L)

**Goal:** One inbox for every vendor: external agent PRs (Cursor/Codex/Devin — all deliver as GitHub PRs) and local Claude Code sessions appear as Deliveries beside swarm work.

**Files:** Create `agent-runtime/adapters/github.mjs` (poll `gh pr list --json` every 60s for configured bot authors; mint source:"github-pr" Deliveries w/ diff via `gh pr diff`; decide: approve→`gh pr review --approve` (+optional merge per policy), request-changes→`gh pr review --request-changes -b <feedback>`, reject→close w/ comment; state sync both directions — PR merged externally → delivery auto-decided), `agent-runtime/adapters/claude-sessions.mjs` (fs.watch `~/.claude/projects/<workspace-slug>/` → parse session transcripts → read-only source:"claude-code" Deliveries [visibility only, no decide actions v1]), `agent-runtime/adapters/index.mjs` (adapter lifecycle, per-adapter enable flags), Settings: adapter config UI (bot-name patterns, poll interval). Modify inbox UI: source chips + filters already designed (P3) — wire real sources. Tests: adapter mint idempotency (same PR never duplicates), decision routing, watcher debounce.

**Skills chain:** `sp-writing-plans` → context7 (`gh` json fields, fs.watch caveats macOS) → `sp-test-driven-development` (idempotent mint + routing tests, gh mocked) → `security-review` (external content is UNTRUSTED: PR titles/bodies sanitized before UI, never into prompts unsanitized; scrub on ingest; adapter cannot decide high-risk without human regardless of policy) → `silent-failure-hunter` (poll failures must surface as adapter-status, not vanish) → `/code-review` → gstack `/qa` → `sp-verification-before-completion`.

**Exit criteria:** open a bot-authored PR on the connected repo → Delivery appears (≤poll interval) w/ source chip + real diff; approve from MissionAlpha → PR approved on GitHub (evidence: `gh pr view`); request-changes posts the feedback as PR review; merge PR on GitHub directly → delivery flips decided on the bus; run a Claude Code session in the workspace → session Delivery visible read-only; duplicate-mint test proves idempotency; adapter failure (gh logged out) → visible adapter-status banner, app unaffected; regression green.

**Security:** sr-security sign-off (untrusted external content + outbound gh actions). ADR-054. No commit.

---

## P8 — Usage meter · audit export  (effort S)

**Goal:** Tokens + context% per agent/thread/tier live on screen (Claude-Code `/context` style, never dollars); one-click audit bundle.

**Files:** Extend `agent-runtime/usage.mjs` (parse `claude -p` stream-json usage fields when present; else chars/4 estimate flagged `est:true`; accumulate per thread/agent/day in SQLite; emit `usage.tick`), wire `src/components/workspace/UsageMeter.tsx` (exists — connect to bus + per-thread view), `agent-runtime/server.mjs` (`GET /runtime/audit/export?from&to` → JSON+CSV bundle: deliveries+decisions+risk reasons+AUDIT.log lines+usage; streamed, token-gated), `src/components/audit/AuditTrailPanel.tsx` (export button + date range). Tests: usage accumulation, export shape, estimate flagging.

**Skills chain:** `sp-writing-plans` → `sp-test-driven-development` → context7 (claude CLI stream-json schema) → `impeccable`+`taste-skill` (meter visual: calm, glanceable) → `dataviz` skill for the meter/sparkline treatment → `security-review` light (export endpoint gated, scrubbed) → `/code-review` → `sp-verification-before-completion`.

**Exit criteria:** two chats on different tiers → meter shows diverging real token counts (or flagged estimates) live via bus; export downloads a bundle that opens in Numbers/Excel and contains today's deliveries w/ decisions + reasons; no dollar signs anywhere; regression green. No commit.

---

## P9 — Second seat  (effort M)

**Goal:** Approving is not-only-Rohit: two local users, roles, assignment — single-user mode stays default so nothing changes for BOSS solo.

**Files:** Create `agent-runtime/users.mjs` (local accounts: name+scrypt hash in SQLite; session cookie httpOnly SameSite=Strict; roles approver|viewer), `src/components/auth/LoginGate.tsx` (mounts ONLY when >1 user exists — single-user default keeps current zero-login flow), assignment: Delivery schema migration (assignee), `ReviewPane` assignee picker + @mention in feedback, `delivery.decided` carries real decidedBy. Tests: authz matrix (viewer cannot decide), cookie flags, assignment routing.

> **BLOCKER inherited from ADR-052 — read before writing any P9 code.** SSE replay and fan-out have **no per-client scoping**: every subscriber receives every event, and `Last-Event-ID` replays the whole `events_log` regardless of who reconnects. That is acceptable today only because the runtime is single-principal + loopback (ADR-052 "Preconditions"). The moment a second seat exists, user B's `EventSource` would stream user A's Delivery titles, summaries and task text. P9 **must** land per-client event scoping (filter at emit/fan-out AND at replay, by the subscriber's identity) in the same phase as `users.mjs` — it is not a follow-up. sr-security sign-off for P9 must explicitly cover it.

**Skills chain:** `sp-writing-plans` → `sp-test-driven-development` (authz matrix FIRST) → **`security-review` + `claude-code-security-review` MANDATORY** (session fixation, cookie flags, timing-safe compare reuse, role bypass attempts) → `impeccable` (login surface minimal, on-theme) → `/code-review` → gstack `/qa` → `sp-verification-before-completion`.

**Exit criteria:** two browsers, two users: delivery assigned to B is decided by B, audit shows B; viewer role sees Inbox but decide buttons absent AND server rejects direct curl decide (403); delete second user → app returns to zero-login flow identical to today; adversarial: forged cookie 401, role-escalation curl 403; regression green.

**Security:** sr-security blocking sign-off. No commit.

---

## P10 — Dogfood · polish · hardening (ship-grade)  (effort M)

**Goal:** MissionAlpha ships MissionAlpha through its own Inbox for one week, and the app reaches design/a11y/perf ship-grade.

**Files:** Create `src/components/inbox/Scoreboard.tsx` (weekly: Deliveries approved ÷ human-minutes — decision timestamps already in DB), `docs/adr/` as-built sweep, README.md rewrite (product = Agent Inbox; remove stale BOSS-notes section), `docs/qa/FINAL-SWEEP-<date>.md`. Modify: everything the audits demand.

**Lanes/Skills chain (this phase IS the skill gauntlet):** `sp-writing-plans` → dogfood setup (workspace = MissionAlpha repo itself; queue real M-backlog items through the Inbox) → design gates: `impeccable audit` + `impeccable polish` + `hallmark audit` (P/H/E/S/R/V scored, no AI-slop verdict) + `emil-design-eng` motion review + `taste-skill` final pass → `accessibility-tester`-grade WCAG 2.2 AA sweep (focus order, contrast, reduced-motion) → perf: gstack `/benchmark` (60fps board+inbox, bundle budget: app <300KB gz per web rules) → full e2e: `webapp-testing`+`playwright` golden path + **adversarial sweep** (every gate curl-attacked, SSE flood, malformed deliveries, giant diffs) → `ai-writing-auditor` + `content-quality-editor` (all UI copy + README) → Electron package check (§5.8: `npm run electron:build`, dmg boots, notifications work) → `/code-review` full-repo pass → gstack `/retro` → `sp-verification-before-completion` → final **PES delivery report** w/ Known Gaps & Risks.

**Exit criteria:** 7 consecutive days: ≥10 real Deliveries (MissionAlpha's own backlog) shipped through its own Inbox, scoreboard shows the ratio, recorded (screen capture); all audits pass w/ evidence in FINAL-SWEEP doc; a11y AA; 60fps; dmg builds+runs; zero console errors across golden path; regression suite (now R1–R10 + every phase's e2e) fully green; BOSS demo walkthrough delivered.

**Then and only then:** BOSS says commit → phase-ordered conventional commits land per §4.

---

## Self-review (skill-mandated)

**Spec coverage:** master-spec M0→M8 all mapped (M0→P1, M1→P2+P3, M2→P4, M3→P5, M4→P6, M5→P7, M6→P8, M7→P9, M8→P10) + P0 added for BOSS point 9. 11/11 BOSS points mapped in §0 table. ✓
**Placeholder scan:** no TBD/TODO; per-phase code-level detail intentionally deferred to each phase's mandated `sp-writing-plans` task doc (bite-sized TDD steps w/ full code) — that doc is a BLOCKING first deliverable of every phase, so no engineer ever codes from this program doc alone. ✓
**Type consistency:** Delivery schema single source = master-spec §3 SQL; P5 and P9 migrations extend it (pr_url, mode, assignee) — migration files own truth thereafter. Event names in §2 match every phase's usage. ✓
**Commit-step conflict:** sp-writing-plans default "commit each task" is overridden program-wide by §4 (BOSS point 5) — phase task docs must use Checkpoint steps instead. ✓

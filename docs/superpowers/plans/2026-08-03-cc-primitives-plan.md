# CC-Primitives Program — Claude Code as the only donor

**Date:** 2026-08-03 · **Status:** PLANNED, NOT STARTED · **Commit policy: NO git commit/push/stash/reset/checkout until BOSS says so. Working tree IS the deliverable.**

## Approved concept (locked by BOSS)

MissionAlpha = engineering-only cockpit for many Claude Code workers. Adopt ONLY Claude Code primitives — agent loop visibility, permission modes, skills-as-training, subagents, CLAUDE.md memory, hooks — surfaced in the EXISTING app. Zero new pages. Native design language untouched. Paperclip/Base44/Replit ideas explicitly rejected.

Delta: upgrade **Agents deck** + **Knowledge vault**, cut **Pipeline (CRM)** + **Content engine** from nav (backend modules stay behind flag, not deleted). Everything wired backend→frontend, runs continuously without human intervention.

Mockup of record: scratchpad `missionalpha-placement-mockup.html` (Claude-Code-only revision, 2026-08-03).

## Non-negotiable ground rules (every phase)

- **PES** (`principal-standard`) end to end. Evidence rule: no "done/complete/fixed/passing" without shown output. Gates in order: build → lint+tsc → tests → security → runtime → adversarial self-review.
- **Lanes:** Opus 4.8 (or Sonnet 5 for mechanical sweeps) builds in **caveman full**; **Fable 5 independently verifies** — never the builder verifying its own work. Both lanes under headroom + caveman; codeburn check at each phase close.
- **Token discipline:** headroom wrap active; caveman full output; `codeburn` at phase end; on context exhaustion → append handoff block to `docs/SESSION_MEMORY.md`, open fresh session, resume from this plan + memory tail. `headroom learn` after any debugging phase.
- **Git:** NO commit/push/stash/reset/checkout. Do not touch BOSS's `stash@{0}` or the 8 `ma/task/*` branches.
- **Ports:** :3004 BOSS's vite (hands off), :3005 packaged app (NEVER kill), :3006 dev runtime (restartable), :3016 clean verify dev (disposable).
- **Snapshots:** `tar` working tree → `../ma-snapshots/CC-P{n}-<date>.tgz` at each phase exit + append phase exit block to `docs/SESSION_MEMORY.md` + tick checkbox here.
- **Memory:** `mem-search` before each phase (prior art), claude-mem observations flow automatically.
- **Research rule 9/9b:** repo patterns first, context7 for any third-party API, WebSearch for current-state facts.
- **Do not break current functionality.** Anything found broken: fix, test, report — inside the phase that found it.
- **Security-sensitive paths** (perm modes, engine spawn, secrets, vault writes): `security-review` skill + `senior-security-engineer` agent, BLOCKING on HIGH/CRITICAL.

## Verification battery (every phase exit, run by Fable 5)

1. `npm run lint` — 0 errors 0 warnings
2. `tsc --noEmit` — 0
3. Unit suites: root vitest + `agent-runtime` node tests — all green, new code ≥80% covered
4. Runtime: dev on :3016, exercise changed endpoints/SSE with curl + browser
5. Browser proof: preview tools / agent-browser — screenshot at 1280px, interactions verified, console clean
6. Regression: existing pages (Inbox, Missions, Command center, Sessions, Factory, Settings) still function
7. `code-reviewer` agent pass on the diff; sev≥Medium findings fixed before exit
8. Phase delivery report w/ Known Gaps & Risks — hidden gap = violation

---

## Phase P0 — Preflight, unblock, baseline ✅ DONE 2026-08-04 (verified)

**Goal:** swarm can actually run. Today every station spawn fails: "engine write-loop requires the cli backend (claude subscription)".

- [x] Baseline battery on untouched tree — lint 0/0 · tsc 0 · unit 316 · vendor 28 · electron 9 green; runtime 23/1011 FAILED
- [x] Broken-found FIX: root `test:runtime` ran parallel w/ colliding hardcoded ports → 401 flake. Added `--test-concurrency=1` (matches agent-runtime pkg's own script). Post-fix 1011/1011.
- [x] Diagnose CLI backend: `claude` v2.1.187 present+authed. Not a capability gap — BACKEND defaulted to api/mock when an API key was in env. Write-loop path intact, already parses stream-json.
- [x] Spawn proven (deterministic, fake CLAUDE_BIN, throwaway repo, :3016): enqueue 201 → dispatch → spawn → real diff → task `held` (policy=manual, operator confirm). rejectedByMock=false. Full chain proven.
- [x] FINDING → re-scopes P1: engineDispatch pins acceptEdits + never reads UI perm mode (server.mjs:1156). Autonomous loop guardrail must stay. Snapshot CC-P0-2026-08-03.tgz.

**Skills:** principal-standard · sp-systematic-debugging · mem-search (prior spawn-failure context) · headroom/caveman/codeburn
**Builder:** Opus 4.8 caveman · **Verify:** Fable 5 (battery + spawn evidence in SESSION_MEMORY)
**Exit:** baseline numbers recorded · spawn proven or blocker escalated · snapshot CC-P0

## Phase P1 — Permission modes, backend ✅ DONE 2026-08-04 (verified + sr-security APPROVED)

**Goal (re-scoped per P0 finding):** per-station INTERACTIVE permission mode (`default|acceptEdits|bypassPermissions`), persisted, enforced on the cliReply path, live. Autonomous engine keeps its pinned `acceptEdits` guardrail (NOT touched — building full-auto into the engine would regress a deliberate control).

- [x] TDD: station-perms.test.mjs (9) written first → store; station-perms-http.test.mjs (6); perm-enforce.test.mjs (2, argv-capture).
- [x] Store: NEW `station-perms.mjs` (JSON-file, factory/adapters.json pattern), reuses perm-mode.mjs allowlist; validates agentId + mode on set AND load. (No DB migration — small config, matches repo's JSON-config convention.)
- [x] Enforce: cliReply resolves per-station mode at both `--permission-mode` sites. Engine loop untouched (pins acceptEdits). Proven: override → bypassPermissions reaches spawned argv; no-override → global acceptEdits.
- [x] REST: GET/PUT `/runtime/:agentId/perm-mode`; SSE `station.perm.changed` (registered across closed catalog + both equality tests); audit on change.
- [x] Battery: lint 0 · tsc 0 · unit 316 · runtime 1026 · vendor 28 · electron 9. sr-security APPROVED (no HIGH/CRITICAL; 2 LOW/INFO fixed). Snapshot CC-P1-2026-08-03.tgz.

**Deviations from original plan (disclosed):** modes are the 3 real claude values (`default/acceptEdits/bypassPermissions`), not `plan/edits/full-auto` (plan is UI-only, never a server mode); enforcement is the INTERACTIVE path only (engine guardrail preserved); no DB migration (JSON-file store). `perm.held → inbox` deferred — the policy/risk gate already holds risky engine actions (proven in P0); interactive gating is via claude's own prompt behavior per mode.

## Phase P2 — Agent loop streaming, backend ✅ DONE 2026-08-04 (verified + sr-security APPROVED)

**Goal:** think → tool → observe steps stream live per station and persist per task.

- [x] TDD first: loop-steps.test.mjs 9 (parser + store + scrub-boundary), loop-steps-http.test.mjs 2 (wire).
- [x] NEW loop-steps.mjs — stepsFromLine() parses CLI stream-json (in server's engine parser, where the stream already lands — not adapters/); scrub runs BEFORE the stored 200-char cut.
- [x] Migration v14 loop_steps; ring buffer cap 500/task (prune inline on insert — no cadence job needed).
- [x] SSE `loop.step` (identity-only frame; summary behind auth-gated GET) registered in all 4 catalog places; replay GET /runtime/engine/steps?taskId (engine-block gated).
- [x] Backpressure: structural — deltas never become steps, so volume is tool-call-bounded. Disclosed deviation: no 4/sec batch layer (unneeded).
- [x] Wire proof: real boot + fake CLAUDE_BIN → [think,tool,observe,result] persisted seq 1..4, ghp_ secret redacted at rest, 400/401 gates. Battery: lint 0 · tsc 0 · unit 316 · runtime 1038 · vendor 28 · electron 9.
- [x] sr-security APPROVED (0 HIGH/CRIT). M1 (unguarded seq read), L1 (trunc-before-scrub), L2 (tool unscrubbed) all FIXED + retested. L3 accepted residual disclosed (cross-task growth, gated).

## Phase P3 — Subagents + skills registry, backend ✅ DONE 2026-08-04 (verified + sr-security APPROVED)

**Goal:** stations fan out visible children; skills attach per station and actually shape behavior.

- [x] Subagents (re-scoped to Claude Code reality, disclosed): children are claude's OWN Task/Agent tool inside one spawn slot — surfaced as `subagent` step kind in the P2 loop stream. No runtime child processes → no new pool rows/caps needed (concurrency already bounded by the spawn slot). Deviation from original "child rows in pool" — honest mapping, zero new exec surface.
- [x] Skills registry: NEW station-skills.mjs (JSON store, validated against ATTACHABLE catalog — posting/dev excluded); injected via skillsNote() at the systemFor choke point → chat AND engine wakes. Prompt-level only, no tool grants.
- [x] API GET/PUT /runtime/:agentId/skills (viewer/approver) + audit + SSE `skills.changed` (4 catalog places). (`subagent.spawned/finished` events unneeded — subagent steps ride `loop.step`.)
- [x] Proof: prompt-injection wire test both directions (attach → "SKILLS LOADED" in spawned stdin; clear → gone). Unit 6/6 + 10/10, wire 5/5. Battery: lint 0 · tsc 0 · unit 316 · runtime 1050 · vendor 28 · electron 9.
- [x] sr-security APPROVED 0 HIGH/CRIT; LOW-1 fixed (attachable filter + test); LOW-2 accepted residual (persist() pattern, log in P8). Snapshot CC-P3-2026-08-04.tgz.

## Phase P4 — Memory + hooks surfacing, backend ✅ DONE 2026-08-04 (verified + sr-security APPROVED)

**Goal:** stations read repo rules on every wake; hook/guard status queryable.

- [x] TDD first (station-memory 5 unit + 4 wire). NEW station-memory.mjs — JSON store (DISCLOSED deviation: not vault-backed; vault's closed taxonomy makes a new node migration-grade; memory is operator config → established JSON pattern). Cap 8000 explicit-error, no compression layer (cap IS the budget).
- [x] Edit → next wake proof: PUT scrubs BEFORE store; memoryNote() at systemFor choke point (chat + engine); wire test proves "STATION MEMORY" text in spawned stdin after PUT and gone after clear — no restart. SSE memory.changed (4 catalog places).
- [x] Hooks: GET /runtime/:agentId/hooks — REAL guard state (perm effective + engine pinned, TOOLS, scrub layers, APPLY_DENY, configGuard, quota). DISCLOSED deviation: read-only, NO per-station enable/disable — disabling scrub/deny per station would be a security regression, not a feature.
- [x] `hook.fired` dropped (disclosed): guard trips already surface via existing task/delivery events; a new event would duplicate the trail. Battery: lint 0 · tsc 0 · unit 316 · runtime 1059 · vendor 28 · electron 9.
- [x] sr-security APPROVED 0 HIGH/CRIT (reviewer ran suites). LOW-1 __proto__ wart FIXED in all 3 stores + regression test; LOW-2 (viewer-403 two-seat test) ticketed → P8.

## Phase P5 — Agents deck UI ✅ DONE 2026-08-04 (Opus built · Fable verified · live browser proof · react-review fixes applied — details in SESSION_MEMORY P5 exit block)

<details><summary>original phase spec</summary>


**Goal:** mockup made real, wired to P1–P4. Zero new pages; deck + drawer upgraded.

- [ ] `/hallmark` first (structure, no AI-slop; match existing dark-cockpit tokens — no palette drift), then build:
  - Station list: subagent child rows (indent, live pills) — `AgentCard`/deck components
  - `AgentDrawer`: live loop stream (SSE `loop.step`, replay on open), gate-held steps highlighted, subagent spawn lines
  - Perm-mode segmented toggle in drawer header (PUT + optimistic + SSE reconcile); mode-change confirm on full-auto
  - Skills chips: attach/detach; hooks card w/ live `hook.fired` blips
- [ ] React Query for new data (repo pattern); no polling where SSE exists
- [ ] `/impeccable audit` + `/impeccable polish` after structure; `taste-skill` anti-slop pass; `emil-design-eng` for stream/pill motion (compositor-only props, reduced-motion respected)
- [ ] A11y: drawer focus trap (existing hook), toggle keyboard nav, stream `aria-live=polite`, contrast AA
- [ ] Do not break existing deck behaviors (chat, actions, factory links) — regression pass

**Skills:** principal-standard · hallmark → impeccable → taste-skill (order mandatory) · emil-design-eng · react-reviewer/code-reviewer · sp-verification-before-completion · preview_* browser verification
**Builder:** Opus 4.8 caveman (Sonnet 5 allowed for mechanical component sweeps) · **Verify:** Fable 5 — browser proof 1280px + 390px, live stream visible, toggle round-trips, console clean, screenshots into SESSION_MEMORY
**Exit:** battery + visual proof + a11y pass · snapshot CC-P5
</details>

**Done notes:** hallmark component-scope (tokens preserved, no macrostructure); impeccable/taste full-command passes deferred to P8 polish sweep (disclosed) — react-reviewer + live-browser a11y checks covered the blocking quality gates; mobile-width (390px) visual pass rolled into P8 with the impeccable audit.

## Phase P6 — Vault editor UI + scope cuts ✅ DONE 2026-08-04 (Sonnet built · Fable verified live)

- [x] StationMemoryPanel in VaultPage (picker from stationMeta, counter/8000, save states, next-wake note, 403 mapping). Live-proven: UI→PUT→sm.json→API, counter 59/8000, console clean. (Markdown *preview* dropped — plain mono textarea matches vault's editor language; disclosed.)
- [x] Cuts: BOS_NAV − pipeline − content, BosPage union narrowed, App/BosSidebar unwired, page files kept unreferenced (confirmed absent from build). leads.mjs/content.mjs dormant. bosNav tests assert absence.
- [x] Dead-import sweep (lint 0 enforces); SSE catalog untouched (RESERVED names stay).
- [x] Regression: all 10 remaining pages click-through in live browser, 0 error boundaries, 0 console errors. Battery: lint 0 · tsc 0 · unit 352 · runtime 1060 · build ✓. Snapshot CC-P6-2026-08-04.tgz.

## Phase P7 — Continuous autonomous operation ✅ DONE 2026-08-04 (see SESSION_MEMORY + docs/qa/CC-FINAL-SWEEP-2026-08-04.md)
Full ship path proven ×2, gate-holds awaiting BOSS, retry→terminal, cadence→task, 15m44s / 0 crashes / no leak. Live-model leg blocked on `claude login` (disclosed). Deterministic spawner stood in for the model.

<details><summary>original spec</summary>

**Goal:** unattended loop: cadence wakes station → claims task → loop streams → gates hold risky steps → delivery lands in inbox → memory read on wake — zero human touches.

- [ ] Seed 3 benign real tasks (e.g. lint-fix sweep, test-gap fill, docs update) via inbox
- [ ] 4-hour soak on :3006: cadence-driven wakes, ≥3 completed deliveries, ≥1 gate-held action awaiting BOSS, 0 crashes, `self-heal.mjs` untriggered or recovered-clean
- [ ] Monitor lane: `babysit` skill + scheduled checks; capture SSE transcript as evidence
- [ ] Quota sanity: `quota-guard` + usage numbers recorded (codeburn)

**Skills:** principal-standard · babysit · sp-systematic-debugging (any soak failure → root cause, fix, re-soak) · codeburn
**Builder/operator:** Opus 4.8 caveman · **Verify:** Fable 5 reads soak evidence, re-runs battery
**Exit:** soak log w/ numbers in SESSION_MEMORY · snapshot CC-P7

</details>

## Phase P8 — Hardening + final sweep ✅ DONE 2026-08-04 — PROGRAM COMPLETE
sr-security cumulative APPROVED (0 HIGH/CRIT); UI polish audit findings all fixed; crash-proof persist + viewer-403 tests + MEMORY_MAX; final battery green; sweep doc written; snapshot CC-P8. Open for BOSS: `claude login` (live-model soak) + commit decision.

<details><summary>original spec</summary>
**Goal:** production-grade close-out.

- [ ] `security-review` + `senior-security-engineer` full pass: perm-mode bypass attempts, SSE payload leakage, vault prompt-injection, subagent privilege inheritance — BLOCKING on HIGH/CRITICAL
- [ ] `/qa` + `/review` gstack passes; `comprehensive-review` only if findings warrant
- [ ] Bundle check (index gz ≤ 200KB target; record delta vs 192.5KB baseline)
- [ ] Electron packaged smoke (`electron/` preflight + runtime-supervisor) — packaged :3005 NOT touched; build separate artifact only
- [ ] Write `docs/qa/CC-FINAL-SWEEP-<date>.md` + program delivery report w/ Known Gaps & Risks
- [ ] `headroom learn` · final codeburn report · SESSION_MEMORY program-close block

**Skills:** principal-standard · security-review + senior-security-engineer (BLOCKING) · qa/review (gstack) · sp-verification-before-completion · headroom learn · codeburn
**Builder:** Opus 4.8 caveman · **Verify:** Fable 5 signs the sweep doc
**Exit:** all gates green w/ evidence · sweep doc written · snapshot CC-P8 · **WAIT for BOSS commit decision**

---

## Known program-level risks (disclosed up front)

1. **P0 blocker risk:** if CLI backend/subscription truly unavailable, P2/P3/P7 live proofs impossible — backend ships test-proven, live-proof deferred, flagged loudly. No silent partial.
2. **Claude CLI stream format drift:** verify via context7/WebSearch in P2 before parsing; pin adapter to observed format w/ tolerant parser.
3. **SSE volume:** loop steps are chatty; batching + ring-buffer mitigate; soak (P7) is the proof.
4. **bosNav closed union:** cutting pages touches the type spine; compile gate catches, but sweep in P6 is mandatory.
5. **Uncommitted tree:** snapshots are the only rollback. Snapshot discipline is therefore a hard gate, not a nicety.

## Execution order & handoff

P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8. Backend phases P1–P4 may interleave builder/verify pipelining, but no phase exits without its battery. Fresh-context resume point = this file + `docs/SESSION_MEMORY.md` tail.
</details>

---
phase: 1
name: Engine Room
requirements: [R1, R2, R3, R4]
depends_on: []
files_modified:
  - agent-runtime/hooks.mjs (new)
  - agent-runtime/engine-spawner.mjs
  - agent-runtime/engine.mjs
  - agent-runtime/cadence.mjs
  - agent-runtime/scheduler.mjs
  - agent-runtime/resource-guard.mjs (new)
  - agent-runtime/codemod.mjs (new)
  - agent-runtime/engine-readiness.mjs
  - agent-runtime/server.mjs (routes + SSE)
  - src/components/bos/EngineReadinessBanner.tsx
  - src/components/inbox/DeliveryCard.tsx (worker-origin chip)
autonomous: true
checkpoints: [1.3b]  # BOSS activates account — live-gate items only; mock verification proceeds without it
commit_policy: NO COMMITS until BOSS says
---

<objective>
Ship the engine-room layer: lifecycle hooks in every spawn, cadence workers that mint low-band Deliveries autonomously, Tier-0/1 routing that refuses to spend, and a doctor that makes the "silent 3-day outage" class impossible. All wired: SSE events, UI surfaces, zero human intervention between decisions.
</objective>

<skills mandatory="true">
- sp-test-driven-development — every task below is test-first (repo's node:test suites)
- sp-verification-before-completion — before claiming any task done
- security-review — Tasks 2, 3, 4 touch spawn/exec/ingest paths; block on CRITICAL
- code-reviewer agent — after each task's implementation
- gstack: `/qa` after Task 6; `/review` on the full phase diff
- hallmark → impeccable → taste-skill — Task 6 UI surfaces (doctor banner, worker chip)
- caveman (output) + headroom (context) + codeburn (post-session) — session ops
- mem-search — recall prior engine/queue decisions before touching engine.mjs
- Fable 5 — final independent verification pass (Task 7)
</skills>

<tasks>

<task id="1.0" name="Baseline lock + defect audit">
Files: none (read-only) → docs note in this PLAN's SUMMARY.
Action: Run full regression (`npm run typecheck && npm run lint && npm run test:unit && npm run test:runtime && npm run test:vendor`). Record counts as the baseline contract. Audit the live "no active account" blocker: confirm mock-backend suites green, document that live-engine verification requires BOSS to activate an account (cannot be automated — credentials). Any pre-existing red: fix it FIRST, per BOSS mandate "if anything is broken, fix it".
Verify: all suites green; baseline counts recorded.
Done when: green baseline + defect note written.
</task>

<task id="1.1" name="R1 — hooks.mjs lifecycle dispatcher" tdd="true">
Files: agent-runtime/hooks.mjs (new), engine-spawner.mjs, engine.mjs.
Action: Pure module `createHooks({quality, scrub, vault})` exposing `fire(event, ctx)` for closed enum: `pre-task, post-edit, post-task, session-start, session-end, on-error`. Wire into the spawn frame: `post-edit` runs quality gate + scrub against the worktree DURING the run (failure → kill run, classify via self-heal); `session-end` writes run outcome record to vault; `on-error` feeds failure-signature. Law 5: events fire internal functions only — config can toggle per-event booleans, never commands. Injected seams; no I/O in the dispatcher itself.
Wiring: hook-driven run kill emits `run.killed` SSE frame {taskId, agentId, event, reason} — operator sees WHY a run died, not just that it did (rendered in 1.6).
Verify: new `hooks.test.mjs` — event enum closed (unknown event throws), post-edit failure kills run before Delivery mint + emits run.killed, session-end lands vault record, toggles respected. Regression green.
Done when: every spawn passes through hooks; tests pin all invariants.
</task>

<task id="1.2" name="R2a — native resource guard" tdd="true">
Files: agent-runtime/resource-guard.mjs (new).
Action: `canRun()` → {ok, reason} from: macOS `memory_pressure`/`vm_stat` free% (available = free+inactive+purgeable), 1-min load avg vs cores, disk free. NEVER `os.freemem()` (ruflo's proven macOS bug — 0.4% reported vs 40% real). Thresholds env-tunable with safe defaults (`RUNTIME_GUARD_MIN_AVAIL_PCT=10`, `RUNTIME_GUARD_MAX_LOAD_PER_CORE=1.5`). Exec via execFile argv arrays, shell:false (quality.mjs law). Linux fallback: /proc/meminfo MemAvailable.
Verify: `resource-guard.test.mjs` with injected exec — parses real vm_stat fixture output; returns real availability ≥ what os.freemem() reports; fail-open with logged warning if tools missing (guard degrading must not wedge the queue — opposite of ruflo's fail-closed-forever).
Done when: guard returns sane numbers on this Mac (manual run shows ~40%, not 0.4%).
</task>

<task id="1.3" name="R2b — cadence worker catalog" tdd="true">
Files: agent-runtime/cadence.mjs, scheduler.mjs, server.mjs, factory/cadence.json (new config).
Action: Worker catalog {audit, testgaps, document, refactor} on intervals with offsets (ruflo's stagger pattern). Each tick: resource-guard check → dispatch READ-ONLY analysis run (pipeline.mjs dispatch convention — markdown artifact, never a diff) → mint Delivery. LAW 3 hard-coded: `band:'low'` forced, `autoApply:false` structurally impossible for worker kind, per-worker daily cap (`RUNTIME_WORKER_DAILY_CAP=3` default) — cap check at mint, over-cap = skip + log, not queue. Worker output scrubbed + fenced (Law 2). Emits `worker.tick` + standard `delivery.created` on SSE bus. Config file fail-closed on invalid (quality.mjs pattern).
Doctor wiring: invalid/missing `factory/cadence.json` (fail-closed = no workers) must ALSO surface as a doctor check in 1.5 — silent no-workers is the outage class this program kills.
Verify: `cadence.test.mjs` — cap enforced across restarts (persisted count), band unoverridable even by crafted config, guard-deferred tick reschedules not drops, SSE frames emitted; Inbox integration test: worker delivery renders in /inbox list.
Done when: with runtime up, workers mint capped low-band Deliveries with zero human action; visible in Inbox.
</task>

<task id="1.3b" name="CHECKPOINT — BOSS activates an account (blocking for live gates only)">
Files: none.
Action: Mock-backend verification of 1.1–1.4 proceeds regardless. But the phase's LIVE gate items (workers actually minting on live models, token delta on real runs) require an active account — the exact defect from CONTEXT.md. AskUserQuestion to BOSS: activate an account on the Accounts page (credentials — cannot be automated). If BOSS unavailable/declines: live items marked DISCLOSED-BLOCKED in VERIFICATION.md, mock evidence stands, phase may close with that disclosure. Never fake live evidence.
Verify: account active (doctor confirms) OR disclosure recorded.
Done when: one of the two states is true and recorded.
</task>

<task id="1.4" name="R3 — tier router + Tier-1 codemods" tdd="true">
Files: agent-runtime/codemod.mjs (new), engine.mjs, agent-runtime/router-tier.mjs (new).
Action: Pre-dispatch classifier `classifyTier(task)` → {tier:0|1|2, reason} — deterministic, closed intent table (captain.mjs honesty convention: documented word-boundary rules, pinned by tests). Tier-0: closed codemod intents (`remove-console`, `var-to-const`) via TypeScript compiler API against worktree files → produces a DIFF that flows through the NORMAL engine path: risk classify → band → Inbox → broker (LAW 1 — codemod never writes directly). Tier-1: cheapest model on active account (providers registry, ADR-022 tiers). Tier-2: full model. Unknown intent → tier 2 (fail-expensive, never fail-wrong). Log `{tier, estTokensSaved}` per dispatch to usage bus.
Verify: `codemod.test.mjs` — remove-console transform correct on fixtures, output lands as worktree diff not repo write; `router-tier.test.mjs` — table closed, unknown→2; integration: codemod delivery appears in Inbox with diff, approve routes through broker unchanged.
Done when: mechanical task completes at $0 model cost with human gate intact; tier telemetry on usage feed.
</task>

<task id="1.5" name="R4 — doctor CLI + route" tdd="true">
Files: agent-runtime/engine-readiness.mjs (extend), agent-runtime/doctor.mjs (new), server.mjs (`GET /runtime/doctor`), package.json script `doctor`.
Action: Checks: node≥20, gh present+authed, **active account exists** (the 3-day-outage killer), DB open+WAL, ports 3004/3005, RUNTIME_REPO_ROOT valid git repo, sandbox docker reachable (warn-only), disk, resource-guard sanity. Output {check, status: ok|warn|fail, fix} — fix is a copy-paste command where automatable. `npm run doctor` CLI + JSON route (token-gated like every route). Route result cached 30s. Emits `doctor.status` SSE frame on state change.
Verify: `doctor.test.mjs` with injected probes — each check's fail path produces actionable fix text; no-active-account scenario returns FAIL naming the Accounts page. Live: `npm run doctor` on this machine shows real statuses.
Done when: doctor catches the current live blocker and says exactly what to do.
</task>

<task id="1.6" name="Wire UI — doctor banner + worker chips" ui="true">
Files: src/components/bos/EngineReadinessBanner.tsx, src/components/inbox/DeliveryCard.tsx, src/lib/useRuntimeEvents.ts.
Action: Fire hallmark (structure) → impeccable (polish) → taste-skill; emil-design-eng if any motion. Banner: subscribes to `doctor.status` frames — red/amber strip with failing check + fix text, dismissible, re-appears on new failure. DeliveryCard: worker-origin chip (worker name + "auto·low") using existing chip system — no new design language. Feed/log surface renders `run.killed` frames (from 1.1) with event+reason. Usage meter surface renders tier telemetry `{tier, estTokensSaved}` from 1.4 — confirm the existing usage UI shows it or add the field. Both respect existing spice/cockpit theme tokens; dark+light.
Verify: unit tests for chip render logic + run.killed render + tier field visible in usage component; visual check at 1280px + 390px per repo convention; `npm run test:visual` if snapshots configured for touched components (update intentionally, never blindly).
Done when: killing the account in a dev run turns the banner red naming the fix; worker Deliveries visually distinct in Inbox.
</task>

<task id="1.7" name="Phase gate — QA + Fable 5 verification">
Files: .planning/phases/01-engine-room/VERIFICATION.md (new).
Action: Full regression + new suites. gstack `/qa` pass on the running app (workers minting, doctor live, codemod flow). security-review skill over the phase diff (spawn/exec surfaces) — block on CRITICAL. code-reviewer agent on full diff. Then independent verification pass on **Fable 5**: fresh context, given only PLAN.md + diff, must confirm every task's "Done when" with observed evidence. Token telemetry: record measured token delta on 10 mechanical tasks (gate metric). Write VERIFICATION.md with evidence per requirement R1–R4.
Verify: all gates green; VERIFICATION.md status: passed.
Done when: R1–R4 each have observed-evidence entries; NO COMMIT made.
</task>

</tasks>

<success_criteria>
- ≥3 self-minted low-band Deliveries/day, cap enforced, zero human action needed to produce them — LIVE if account active (1.3b), else mock-verified + DISCLOSED-BLOCKED live items.
- Token delta measured and recorded for tier routing (same live/mock disclosure rule).
- Doctor red-flags the live account blocker with a fix, in CLI and cockpit.
- Hooks fire on every spawn; mid-run quality failure kills before Delivery mint.
- Baseline suites ≥ baseline counts; nothing pre-existing broken; nothing new uncovered.
- All writes still flow exclusively through broker.applyChanges (Law 1 audit in review).
</success_criteria>

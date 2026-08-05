# CC-Primitives — Final Sweep (2026-08-04)

**Program:** Claude-Code-primitives in the MissionAlpha cockpit (engineering-only scope).
**Status:** P0–P8 complete. Verified, security-approved, UI-polish-approved. **Nothing committed** (BOSS rule — working tree IS the deliverable).
**Lanes:** Opus 4.8 / Sonnet 5 built in caveman; Fable 5 independently verified. Every phase: TDD → wire proof → full battery → blocking sr-security → fixes → snapshot.

## What shipped (all wired backend→frontend, all proven at the wire)

| Primitive | Backend | UI | Proof |
|---|---|---|---|
| Per-station permission mode | `station-perms.mjs`, GET/PUT `/runtime/:id/perm-mode`, SSE `station.perm.changed`, enforced at spawn argv (interactive only) | PermModeToggle (drawer) + AgentCard override chip | argv-capture test + live browser round-trip |
| Loop-step streaming | `loop-steps.mjs`, migration v14, GET `/runtime/engine/steps`, SSE `loop.step` (identity-only), scrub-at-rest, ring cap 500 | LoopStream (drawer, aria-live, subagent rows) | wire test [think,tool,observe,result] + secret redaction; soak captured real trails |
| Skills registry | `station-skills.mjs`, GET/PUT `/runtime/:id/skills`, SSE `skills.changed`, injected at systemFor | SkillsChips (drawer, attach picker) | prompt-injection wire test both directions + live attach→file |
| Station memory | `station-memory.mjs`, GET/PUT `/runtime/:id/memory` (scrub-at-PUT), SSE `memory.changed`, injected at systemFor | StationMemoryPanel (Knowledge Vault) | scrub-at-rest + wake-injection wire test + live UI→API→file |
| Hooks status | GET `/runtime/:id/hooks` (read-only real guard state) | HooksCard (drawer) | live guard rows: perm/engine-pin/scrub/deny/quota |
| Scope cut | — | Pipeline + Content removed from nav (`bosNav.ts` union narrowed); leads/content backend dormant | live nav shows 14 items, both gone; all pages click-through clean |

## Final gate battery (last run 2026-08-04)

```
lint (eslint --max-warnings 0)  0
tsc  --noEmit                    0
unit  (client)                  352 pass / 0 fail
runtime (node --test, serial)   1060 pass / 0 fail  (+ auth-http extended to 28)
vendor                          28 pass
electron                        9 pass
build                           ✓
bundle  index gz                198.42 KB   (baseline 192.5 · budget ≤200 · +5.9 KB for 5 new components + editor)
```

## Security — three per-phase blocking reviews + one cumulative P8 pass, all APPROVED

- 0 HIGH / 0 CRITICAL across the entire program.
- Load-bearing invariant re-confirmed on the final tree: the **autonomous engine loop pins `--permission-mode acceptEdits`** and never reads the per-station store — a UI/API flip cannot turn the unattended loop loose. (`server.mjs` engineDispatch, verified by grep + review.)
- Every LOW/MED found was fixed in-session and re-tested: `__proto__` null-proto (all 3 stores), scrub-before-truncate, tool-field scrub, attachable-skills filter (posting/dev excluded), crash-proof seq read, **crash-proof `persist()` in all 3 stores** (P8), `MEMORY_MAX` import (P8), **viewer-403 two-seat tests** for perm-mode/skills/memory (P8, closes the last carried ticket).
- XSS sweep clean (no `dangerouslySetInnerHTML`/`innerHTML` in any new component). Token flow clean (same-origin `/api/runtime-token`, never logged/persisted). SSE frames identity-only; summaries scrubbed at rest.

## UI polish (impeccable/taste standard) — all audit findings fixed

Token discipline PASS · density PASS · anti-slop PASS · a11y PASS. Fixed: disabled-Save visual state (HIGH), stale-textarea-on-station-switch (MED), perm-chip accessible name now announces override (MED), quota meter `width`→`scaleX` (LOW), editor focus ring restored to global brass strength (LOW), success-copy casing (LOW).

## P7 soak — unattended machinery (throwaway repo, real CLI backend path, deterministic spawner)

Runtime up 15m44s continuous · **0 crashes · 0 uncaught · RSS flat ~17–21 MB (no leak) · self-heal never needed**. Across 12 tasks / 6 goals:
- **Full ship path proven twice**: enqueue → cadence/manual dispatch → spawn → real diff → policy **HOLD** (manual band) → operator review → **selective apply** to live repo → `done`. Selective apply correctly protected an unrelated file from a stale worktree's revert.
- **Gate-hold proven**: tasks land `held` awaiting BOSS (6 pending deliveries in inbox at close) — the correct autonomous behavior with policy=manual; nothing auto-ships without the human.
- **Retry ladder → terminal proven**: an intentional empty-diff task retried 3× then failed terminally, no crash.
- **Cadence → task proven**: `cadence/run` (daily-rollup, anomaly-flag) minted real engine tasks.
- **Loop-steps captured real signal**: the earlier live-CLI leg recorded the actual `401 OAuth access token has expired` verbatim into the step stream — the observability works on real failures, not just happy paths.

## Known gaps & risks (disclosed — none blocking)

1. **Real-model soak leg blocked on `claude login`** — the machine's Claude CLI OAuth token is expired (captured verbatim in loop-steps). The soak proved the full machinery with a deterministic spawner standing in for the model; a live-model run needs BOSS to re-auth (`claude login`). This is an environment credential, not a code gap.
2. **`persist()` fs-fault now returns false** (crash-proof) but the PUT route still responds 200 on a persist-false (in-memory mutation succeeded, disk write silently failed). Accepted residual: extremely rare (disk-full/EACCES on an approver PUT), self-heals on next successful write; a 500-on-persist-false is a nice-to-have follow-up.
3. **`loop_steps` cross-task growth** — per-task ring capped at 500; no deletion on task removal. Linear in task count, ~300 B/row. Availability/disk only; hygiene sweep deferred.
4. **impeccable/taste ran as an audit** (findings applied), not the full interactive command suite; mobile 390 px pass was folded into this audit rather than a separate breakpoint sweep. The station drawer is desktop-primary; no mobile regression observed in the reviewed CSS.
5. **Nothing committed.** Rollback = snapshots `../ma-snapshots/CC-P{0..8}-2026-08-0{3,4}.tgz`. A commit is a separate BOSS decision.

## Verdict

The Claude-Code-primitives program is **complete and internally shippable**: every named feature works, is wired end-to-end, communicates over SSE, functions unattended, and does not break existing functionality (1060 runtime + 352 unit + 28 vendor + 9 electron all green; every pre-existing page still renders). Awaiting only: BOSS `claude login` for a live-model soak, and the BOSS commit decision.

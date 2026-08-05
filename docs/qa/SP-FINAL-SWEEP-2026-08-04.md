# STORY-PIPELINE — Final Sweep (2026-08-04)

**Program:** Story-Pipeline — the SE team's SDLC as a first-class runtime object in the MissionAlpha cockpit. An idea is walked from intake to accept through eight ordered stages, autonomously, pausing only at two human gates.
**Status:** S0–S8 complete. Verified, security-clean (cumulative sr-security PASS), UI-polish-approved. **Nothing committed** (BOSS rule — the working tree IS the deliverable).
**Method:** every phase TDD → wire proof → full battery → blocking sr-security → fixes → snapshot. S8 is the final polish + sweep (two INFO closures + UI audit + this doc), not new surface.

## The pipeline — eight stages, two taps, the 🔧 loop

The stage machine is a **closed, ordered enum** (`stories.mjs`): `idea → requirements → design → plan → build → review-qa → deploy-watch → accept`. `advance()` only ever moves to the immediate next stage; `reject()` only ever bounces to an enumerated earlier back-target. Every transition appends one monotonic-seq `story_log` row inside the same txn as the story-row write — the log can never disagree with the row.

| Stage | Driver | Human tap? |
|---|---|---|
| idea | intake (`POST /runtime/stories`) | — |
| requirements | pm-analyst → clarify `question` gate (0..N) | operator INPUT (answer), not counted as a tap |
| **design** | architect → **design-approval gate** | **TAP 1** |
| plan | tech-lead decompose → per-seat build goals | — |
| build | engine goals (Docker-jailed unit-test gate, red→green retry) | — |
| review-qa | reviewer gate + QA (e2e or honest skip) + PR stage (gh or honest skip) | — |
| **deploy-watch** | docs-writer release notes → **release-accept gate** → jailed deploy + health | **TAP 2** |
| accept | terminal (`shipped`) | — |

**The 🔧 loop closes:** after ship, the SRE monitor polls the deployed surface's loopback health URL + scans the error log; a breach auto-files a bug story **linked** to the origin story and kicks it into the pipeline (`advance idea→requirements`) — deduped per incident window. A shipped story that breaks in prod re-enters the SDLC on its own.

**Exactly two human taps per story** (design-approval + release-accept). Clarify answers are operator INPUT, not taps. The soak confirms taps=2, answers=1 per cycle.

## S8 closures (this session)

1. **FIX 1 — manual advance can no longer skip an open human gate.** The `POST /runtime/stories/:id/advance` route now refuses (409 `"open gate must be decided"`) when the story's current stage is a human gate (`design`→design-approval, `deploy-watch`→release-approval) **and** a pending gate delivery exists for that story. The legal path past a gate is the gate's decide verb (approve auto-advances), never a manual step. `stories.advance()` stays pure (no delivery knowledge); the guard lives in the route where `deliveries` is already in scope, via a `GATE_KIND_BY_STAGE` map. TDD: `pipeline-http.test.mjs` — parked-at-gate advance → 409 + story unmoved; non-gated stage and decided/absent gate → advance still works. Companion fix: the S5 deploy-watch entry kick is now `pipeline`-gated (matching the S2 kick beside it), so the raw S1 machine (pipeline off) stays inert — "no gates present → advance works" holds.
2. **FIX 2 — deterministic-spawner audit event.** `engine-spawner.mjs` now emits a `spawner.canned-diff` record through `factory.audit` (seat, taskId, status, file) when it writes a canned diff, so a deterministic-spawner build is observable in the persistent audit trail, not just stdout. Fires only when the spawner is active (env-gated; the audit seam is a no-op by default). TDD: `engine-spawner.test.mjs` asserts the record on dispatch.
3. **UI audit — Stories UI: CLEAN.** Anti-slop / a11y pass over `StoriesPage`, `StoryDetail`, `StoryBuildPanel`, `StoryGates`, and the `.bos-story-*` helm block. No slop, no broken states, no changes made. Verified: hover + active states designed (`bos-story-card`, `bos-story-new`); keyboard focus via the single global `:focus-visible` ring by policy (a second ring is a documented regression); reduced-motion disables transforms; empty / loading / error+retry states all present (board, detail, build panel); gate panels carry disabled/busy states, `role="alert"`, `aria-live`, and titled disabled buttons; gate columns read amber (semantic, helm tokens only); dialog a11y (role, aria-modal, focus restore, inert background).

## Security posture — cumulative sr-security PASS

- **Docker jail for ALL exec.** Every code-executing leg — the unit-test gate (build), the e2e/QA gate (review-qa), and the deploy executor (deploy-watch) — runs inside the same `network:false` Docker sandbox over `REPO_ROOT`. The deterministic spawner writes only PLAIN-SAFE `src/*.txt` inside the task worktree, flows through the unchanged policy/broker/jail, and adds no route, privilege, network, or secret access.
- **Two BLOCK→fix rounds, both resolved and re-tested:** S4 and S6 each surfaced a blocking finding that was fixed in-session before the phase closed; the final cumulative review is PASS with **0 HIGH / 0 CRITICAL**.
- **Intake is scrubbed + capped at rest and on egress** (title/idea/spec/answers/refs), server-minted ids (never caller input), fully parameterized SQL. Human-gate deliveries are diff-less and carry only a bounded preview; the full artifact stays behind the auth-gated GET. SSE frames are identity-only. The deterministic spawner is **default-OFF** (`RUNTIME_ENGINE_SPAWNER` defaults to `model`) and **production-refused** (`NODE_ENV=production` falls back to the normal engine dispatch with a loud error).

## Soak — the pipeline runs itself unattended

The program's **45-minute soak PASSED: 129 cycles, 0 crashes, 0 unhandled rejections, flat RSS** (no leak). Each cycle: a story ships itself with two taps (design-approval + release-accept), a red→green build cycle runs against the real Docker-jailed gate, and the monitor→bug-story loop mints + links + runs a bug story. Re-confirmed this session (2-minute proof, port 3016, post-FIX-1): **6 cycles, 0 crashes, 0 unhandled rejections, RSS 54–61 MB flat** —

```
VERDICT: PASS — story shipped itself with two taps; monitor→bug-story loop closed.
```

FIX 1 does not touch the soak's path: stories ship via the gate **approve** verb (which auto-advances), and manual-advance-past-gate — the newly refused move — is not exercised by the soak.

## Final gate battery (2026-08-04, full tree)

```
lint (eslint --ext ts,tsx --max-warnings 0)   0 / 0
tsc  --noEmit                                  0
unit    (client)                             359 pass / 0 fail
runtime (node --test, serial)               1145 pass / 0 fail   (baseline 1143 + 2 S8 tests)
vendor                                        28 pass / 0 fail
electron                                       9 pass / 0 fail
build (tsc && vite build)                     ✓
bundle  index gz                             198.76 KB   (budget ≤205)
```

**Bundle posture:** main `index` chunk 198.76 KB gz (≤205). The entire Stories UI is **lazy by construction** — `StoriesPage` (+ StoryDetail / StoryBuildPanel / StoryGates) is a 6.60 KB gz chunk behind `React.lazy`, not in the main bundle. Heavy leaves (missionSkills 112 KB gz, GlobeScene 9 KB gz) are separately chunked.

## Known Gaps & Risks (disclosed — none blocking)

1. **Real-model legs parked behind `claude login`** (biggest gap). The pm-analyst / architect / reviewer / docs-writer api/cli dispatch paths are code-complete and injection-fenced but stand behind the machine's expired Claude CLI OAuth token. The whole SDLC is proven end-to-end with `RUNTIME_BACKEND=none` (mock text legs) + the deterministic spawner substituting only the model's diff-authoring step. A live-model run needs BOSS to re-auth. This is an environment credential, not a code gap.
2. **PR stage honestly skips when gh is unauthed.** With no authenticated GitHub CLI, the review-qa PR leg logs `pr-skipped` and the story proceeds — the disclosed-skip convention, not a silent pass. A real PR round-trip needs `gh auth`.
3. **Deploy executor runs against `REPO_ROOT` read-write.** The jailed deploy executes inside the Docker sandbox but over the live repo root; the network flag is a loud opt-in surfaced in the release-accept gate payload. Deploy targets beyond the loopback health check are out of scope for this program.
4. **Accepted residuals (sr-security rated ACCEPT/INFO):** the two S8 items closed here were both non-blocking INFO. General diff-less-gate previews are bounded (no full-artifact leak). `story_log` grows monotonically per story (append-only by design; no pruning) — availability/disk only, hygiene sweep deferred. The deterministic spawner and its new audit event are test-harness infrastructure, default-off and production-refused.
5. **Nothing committed.** The working tree is the deliverable; a commit is a separate BOSS decision. UI audit ran as an audit (Stories UI came back clean), not the full interactive impeccable/taste command suite.

## Verdict

Story-Pipeline is **complete and internally shippable**: an idea walks itself from intake to a shipped, monitored feature through eight ordered stages, autonomously, pausing at exactly two human gates — and a prod breach re-enters the SDLC on its own. Every exec leg is Docker-jailed; the state machine is closed-enum and audit-complete; a manual advance can no longer skip an open gate; the deterministic-spawner path is observable in the audit trail. Battery green (1145 runtime + 359 unit + 28 vendor + 9 electron, eslint 0, tsc 0), main bundle 198.76 KB gz, 45-min soak PASS (129 cycles / 0 crashes). Awaiting only: BOSS `claude login` for the live-model legs, and the BOSS commit decision.

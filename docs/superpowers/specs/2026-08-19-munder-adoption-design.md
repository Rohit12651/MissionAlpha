# Munder Adoption Program — design spec

Date 2026-08-19/20 · BOSS-approved scope: all 7 pins (A1–A7) from the adoption mockup
(`docs/mockups/munder-adoption-mockup.html`), analysis in
`.planning/MUNDER-DIFFLIN-ADOPTION-ANALYSIS.md`. Autonomy mandate: build, wire, test,
verify — NO COMMITS. Source patterns ported from `WaahyuTools/munder-difflin` (MIT code);
no munder file is vendored, no dependency added.

## Baseline contract (observed 2026-08-19, Node 26.6.0)

| Gate | Floor |
|---|---|
| `npm run test:runtime` | **1831 / 0** |
| `npm run test:unit` | **514 / 0** |
| `npm run test:vendor` | **54 / 0** |
| `npx tsc --noEmit` / `npm run lint` | **0 / 0** |

Any phase that lowers these is a regression and blocks.

## Ground-truth corrections vs .planning/STATE.md (audited this session)

R14 anti-drift, R3 tier-routing, R5 success-signatures, R9 metaharness, R10 trust,
R11 pii, R12 inject-detect: **already built AND wired** in `server.mjs`. R6 (vault-embed)
and R13 (crypto-at-rest) still missing. Therefore: A2 is **not** R14 — it complements it
(anti-drift catches *silence*; the breaker catches *active runaway*). A4 unblocks R6-quality
retrieval by bounding vault growth. A5 extends live `station-skills.mjs` with the R8 budget.

## Non-negotiable conventions (from repo law, all 7 phases)

1. Every repo write stays behind `broker.applyChanges`. No new write path.
2. New SSE names land in **ONE catalog change**: `events.mjs EVENT_NAMES` + client
   `RUNTIME_EVENT_NAMES` + both catalog-equality tests, same edit.
   New names: `breaker.state`, `usage.transcript`, `vault.condensed`, `engine.roster`,
   `run.output`. Identity-only payloads; detail behind gated GETs.
3. Machine-minted rows: capped per day via `worker-cap.mjs` (one CAP_ID per class),
   diff-less via `deliveries.mintFailure` only, never auto-apply (Law 3 structural).
4. Hooks are internal module functions registered from source (Law 5).
5. Pure modules, injected seams, header comments state invariants, tests pin them.
6. Scrub: server-owned chain only; no second SECRET_RE.
7. No dollars anywhere new; tokens + context % only (`spend.mjs` owns the sole exception).

## Phase designs

### P1 (A2) breaker.mjs — graduated runaway ladder
Port of munder `breaker.ts` policy: levels `healthy→steering→constrained→stopped`;
velocity = Δ of consecutive cumulative output-token samples (never one sample as an
increment); trip on (a) error storms (`on-error` hook count/beat), (b) token velocity with
zero persisted loop steps, (c) turn wall-clock over budget; one level per beat, never jump;
de-escalate one level per healthy beat; `hardStop` OFF by default → ladder caps at
`constrained`. Enforcement wiring: `engineHooks.register("pre-task","breaker-gate",…)`
vetoes new turns for `constrained|stopped` agents; entering `constrained` mints ONE
diff-less escalation Delivery per episode (workerCap id `breaker`); beat rides the ONE
periodic timer (SLA sweep). SSE `breaker.state {agentId, level, reason}` on level change
only. UI: StatusStrip breaker chip (worst level + count).

### P2 (A3) transcript.mjs — ground-truth usage
Reads `~/.claude/projects/<projectKey(cwd)>/*.jsonl`, sums assistant `message.usage`
per session (input/output/cache/context), incremental by (file, offset/mtime). Carries the
munder projectKey lesson: BOTH dashing rules (current: every non-alphanumeric → `-`,
including leading; legacy POSIX: leading slash dropped, only `/`→`-`) probed, pinned by
test — an absent dir reads as "no transcripts yet", so a silent key drift is months of
dead data. Emits `usage.transcript {sessions, inputTokens, outputTokens, contextPct}` on
change; detail behind gated `GET /runtime/usage/transcripts`. UI: UsageMeter
"source: transcripts" row/badge. Tokens + ctx% only.

### P3 (A4) vault-reflect.mjs — bounded vault memory
Per (venture, node): when live records exceed budget (count > `REFLECT_KEEP_K` + bytes >
budget), condense the oldest tail into ONE rolling `summary-<node>` record via injected
`summarizeFn` (production: engine `enqueueGoal`? NO — deterministic first: extractive
summarizer, pure), through this ladder: cold backup copy of every evicted file →
verify-don't-trust gate (summary must reference ≥60% of evicted record titles; byte budget
respected; scrub clean) → vault.write(summary) → move evicted originals to
`vault/.cold/<venture>/<node>/` (never deleted) → any failed check = zero mutation +
`condense-abort` log. Pinned-flagged records (`pinned: true` in frontmatter) never evicted.
In-process interval (macOS TCC lesson: never launchd). SSE `vault.condensed {venture,
node, evicted, bytesBefore, bytesAfter}`. UI: Vault page condensation status line.

### P4 (A5) station-skills budget — R8
Live `station-skills.mjs` + `readSkillCatalog` already cap list length (12) and curated
set (32). Missing: the PROMPT-CHARS budget. Add `skillsBudget()` accounting: composed
skills text per station measured at `systemFor` compose; enforce `SKILL_PROMPT_BUDGET`
(default 6000 chars) with `truncateAtBoundary` + explicit disclosure line
"(k of n skills included; budget)". `GET /runtime/:id/skills` gains `{budgetUsed,
budgetMax, trimmed}`. Reuses `skills.changed` frame. UI: budget meter in station drawer
skills section.

### P5 (A1) providers/cli-engines.mjs — engine preset table
Port of munder `agentProvider.ts` SHAPE (not its capability booleans — capability stays
probed per Principle 0): frozen preset rows for claude/codex/agy/grok/kimi/qwen/opencode/
crush/pi/copilot/custom with {id, label, bin, modelFlag, autoFlag, resumeFlag|
resumeSubcommand, promptDelivery: flag|positional|type-into-tui, installCmd (trusted
constant), docsUrl}. `detectEngines()` probes PATH (`which`, execFile, no shell).
`GET /runtime/engines` returns presets × detection. Doctor gains an engines check
(informational). SSE `engine.roster {detected, total}` on boot + refresh. Spawn stays
Claude-CLI (the proven path); presets drive the *table and detection* now, the spawn
switch later — spawning engines not installed on this machine is not provable here and is
NOT claimed. UI: Settings/StatusStrip engine roster chips.

### P6 (A6) run-inspector — read-only window
Per-task ring buffer (64 KB cap, scrub-on-append) fed from the engineDispatch child's
existing stdout/stderr handlers; throttled SSE `run.output {taskId, agentId, bytes}`
(≥1s between frames per task); text behind gated `GET /runtime/engine/runs/:taskId/output`.
No node-pty, no new dependency — headless `claude -p` runs have no TTY to emulate, the
bytes already flow through server handlers. UI: "Inspect run" pane reachable from the
escalation/failure Delivery card + station drawer; read-only by construction (no write
route exists).

### P7 (A7) adapters/slack.mjs — ingress
Follows `adapters/index.mjs` contract (normalize + strict save + fail-closed load):
`slack: {enabled, channelAllowlist, capPerDay}`. `POST /runtime/ingress/slack`:
HMAC v0 signature verify (`SLACK_SIGNING_SECRET` env; timestamp ±300s replay window;
timingSafeEqual), URL-verification challenge answered, allowlisted channel + event shape →
`deliveries.mintExternal` (source `slack`, triple-gated like github/claude-code, never
auto-apply) + optional ack via `response_url` (scrubbed, https-only, slack.com host pinned).
workerCap id `slack-ingress`. Signature/replay/cap/allowlist pinned by tests with injected
transport; LIVE Slack round-trip requires a workspace app + secret — disclosed, not claimed.

## Sequencing

P1 → P2 → P3 → P4 → P5 → P6 → P7, one SSE-catalog edit made once during P1 (all 5 names,
RESERVED until each phase makes its name LIVE — the repo's own convention). Full suites
after every phase; final sweep + security pass + delivery report at P8.

## Explicitly out of scope

node-pty / xterm; Pixi floor & avatars (license); file-mailbox hive; voice; Monaco;
`munderdifflin://` protocol; any munder dependency; any git commit.

## Known risks

- Working tree already carries 166 dirty files from prior sessions — phases add to it;
  nothing is staged/committed, per mandate.
- Slack live path and non-claude engine spawns are built + mock-tested, not live-proven
  on this machine (no token; CLIs absent). Stated on the report, not papered over.
- `summarizeFn` v1 is extractive (deterministic), not LLM-grade prose; upgrade seam exists.

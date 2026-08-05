# ADR-054 — Universal Ingestion Adapters (one Inbox for every vendor — the moat)

- **Status:** ACCEPTED — IMPLEMENTED (as-built). Written retroactively 2026-07-30 in P10 to pay the ADR-054 documentation debt that P7 deferred (program plan §5.6). The decision itself shipped in **P7** — `agent-runtime/adapters/github.mjs`, `claude-sessions.mjs`, and `index.mjs` already carry `// P7 / ADR-054` headers in code.
- **Date:** 2026-07-30 (as-built record; implementation dated to P7, same day)
- **Slug:** `ingestion-adapters`
- **Plan:** Agent Inbox Program **P7 — Universal ingestion** (`docs/superpowers/plans/2026-07-30-agent-inbox-program-plan.md`; also `2026-07-30-inbox-P7.md`)
- **Deciders:** architect, senior-backend-1 (owner), **senior-security-engineer (untrusted external content + outbound gh actions)**
- **Builds on:** ADR-051 (`deliveries.mintExternal` + external `source` values), ADR-052 (bus surfaces external deliveries), ADR-053 (external deliveries still risk-classified), ADR-026/pr.mjs (`gh` argv runner + `safeEnv`)

## Context

The moat is a single inbox for every agent vendor. Cursor, Codex and Devin all end their loop at "a PR to review", so one GitHub-PR integration covers all three; local Claude Code sessions are the operator's own work and belong in the same list. External content is **untrusted**, and outbound `gh` actions touch a real remote — so this is a security-first adapter layer, not just a poller.

## Decision

### 1. GitHub PR adapter (`adapters/github.mjs`)

Polls `gh` for PRs authored by configured bot accounts, mints each as a `source='github-pr'` Delivery (diff via `gh pr diff --patch`, risk-classified by the P6 router). The three decide verbs map back to `gh`: approve → `gh pr review --approve` (+ optional merge per policy), request-changes → `gh pr review --request-changes -b <feedback>`, reject → close with comment. **State sync is two-way**: a PR merged/closed directly on GitHub reconciles the matching Delivery on the next poll. Idempotent by `repo#number@head-sha` — the same PR at the same sha never mints twice.

### 2. Claude Code sessions adapter (`adapters/claude-sessions.mjs`)

Watches `~/.claude/projects/<workspace-slug>/` for session transcript `*.jsonl` files and surfaces **finished** sessions as `source='claude-code'` **read-only** Deliveries (v1 is visibility only — no decide actions). macOS `fs.watch` fires many events per write, so the watcher is **debounced** and only ingests a transcript once its mtime has been stable past the window. Idempotent per session id.

### 3. Adapter lifecycle + config (`adapters/index.mjs`)

Owns per-adapter enable flags and config (bot-name patterns, poll interval, workspace slug) in the BOSS-editable, schema-validated `factory/adapters.json` (path overridable via `RUNTIME_ADAPTERS_FILE`), and aggregates adapter **status** so a poll failure surfaces as a visible banner rather than a silent vanish or crash. **Fail-closed**: a missing/corrupt config → all adapters disabled; `save()` validates strictly before touching disk, and enabling an adapter without its required config is rejected.

## As-built (2026-07-30)

Shipped in **P7** as designed; all three modules live with the security notes embedded in code. Tests: `agent-runtime/test/adapters-github.test.mjs`, `adapters-claude-sessions.test.mjs`, `adapters-index.test.mjs`, `deliveries-external.test.mjs` (P7 gates: unit 196, runtime 709, vendor 28). P7 security review returned **SECURITY_APPROVED with no CRITICAL/HIGH** — all 9 threat vectors clean; a LOW (audit read-path scrub inconsistency) + an INFO were closed.

**The external triple-gate (the headline as-built fact):** an external Delivery can **never** auto-apply, enforced three independent ways —
1. `deliveries.mintExternal()` never calls `maybeAutoApply` (`deliveries.mjs:467+`),
2. the server `maybeAutoApply` refuses `source !== 'swarm'`,
3. `deliveries.autoApprove` refuses `source !== 'swarm'`.

Read-only for `claude-code` is enforced both client-side (decide buttons hidden) and server-side (`deliveries.decide` refuses a `claude-code` row → 403).

**Deviation / known limitation (disclosed):** `gh` is **not installed on this machine**, so every `gh` interaction in tests runs through an **injected runner**, and the real-GitHub loop (approve → PR actually approved on github.com) is **UNPROVEN-HERE** — same posture as the P5 PR ladder. Closing it requires `brew install gh && gh auth login` (BOSS action item; to be exercised in P10 dogfood). The GitHub-PR ingest cadence is therefore proven only against mocked `gh` output.

## Security invariants

| Attack | Vector | Mitigation |
|---|---|---|
| Command injection via PR/session content | untrusted title/body/author/diff | every `gh` call is an argv array, `shell:false`; content is never interpolated into a shell |
| Prompt injection | external text fed to an agent | external content is NEVER fed into an agent prompt — display-only after scrub |
| Secret leak at rest / on egress | token-shaped strings in PR/transcript | `mintExternal` scrubs (`SECRET_RE` + extended shapes + control chars) at rest and on egress |
| gh token theft | adapter reading/storing the token | token stays in gh's own keychain; `safeEnv` strips `*_TOKEN`/`*_KEY`/`*_SECRET` from the child env; adapter never reads/stores/logs it |
| External Delivery auto-applies | policy misconfig | triple-gate above — `source !== 'swarm'` refused in three places |
| Duplicate mint | repeated polls / watch storms | idempotent by `repo#number@head-sha` (GitHub) / session id (Claude); watcher debounced + mtime-stable |
| Silent adapter failure | gh logged out, network down | surfaces as a visible adapter-status banner; fail-closed config |

## Open questions

- **OQ-054.1:** Claude Code sessions are visibility-only in v1; whether to add decide/act on them (beyond read) is deferred.
- **OQ-054.2:** the real-GitHub round-trip is unproven until `gh` is installed and authed (see Deviation above).

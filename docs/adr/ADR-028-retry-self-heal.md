# ADR-028 — Retry / Self-Heal (bounded retry, worktree rollback, operator escalation)

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `retry-self-heal`
- **Plan:** STAGE 1 — Extend the Engine (gap #4 retry / self-heal)
- **Deciders:** architect, senior-backend-1 (owner), senior-security-engineer (consulted)
- **Plugs into:** ADR-024 (FAILED transitions + idempotency), ADR-026 (worktree rollback), ADR-027 (attempts/maxAttempts)

## Context

The loop has **no failure handling**. If a `claude` child errors (`child.on("error")` L625), exits without producing a diff, or an `/apply` is rejected, the step just ends — the operator sees a dropped SSE or an empty `/changes` and must notice and re-fire manually. There is no detection, no bounded retry, no rollback of the partial work, and no escalation when a step is genuinely stuck.

GAP #4: **failure detection → bounded retry with backoff → rollback (discard the worktree) → operator escalation when retries exhaust.** It ties directly into ADR-024's `FAILED` state and idempotency (§4), ADR-026's worktree-discard rollback, and ADR-027's `attempts`/`maxAttempts`/`failed` status.

**Hard boundary:** retry must be **idempotency-safe** — a retry must never double-apply (ADR-024 §4). Rollback is **discard-only** (remove the worktree); it never reverts the live repo, because in S1 a `FAILED` step never reached `APPLIED` in a half-written state (apply is atomic per file and the engine only retries pre-apply failures). Escalation reuses the existing bus path (`reportBack`-style), never a new external channel.

## Decision

### 1. New module — `agent-runtime/self-heal.mjs`

```
ADDED   : agent-runtime/self-heal.mjs    — detection classifier + retry policy + escalation
REUSED  : ADR-024 FAILED state + idemKey (§4/§5)   — retry produces a NEW attempt
REUSED  : ADR-026 worktree.remove (git worktree remove --force + branch -D)  — rollback
REUSED  : ADR-027 attempts / maxAttempts / status='failed'  — bound + terminal
REUSED  : reportBack (server L523) shell-writer pattern  — escalation to the bus/board
REUSED  : scheduler releaseSlot (ADR-025)  — freed on every FAILED, no slot leak
```

### 2. Failure detection (concrete signals → kind)

The classifier maps each detection source (ADR-024 §5) to a `kind`, recorded in `task.error.kind` (ADR-027 schema):

| `kind` | Detected from | Retryable? |
|---|---|---|
| `spawn` | `child.on("error")` (L625) — binary missing, EAGAIN | yes (transient) |
| `no-output` | `child.on("close")` (L626) with empty `acc` AND `listChanges` `[]` | yes (model produced nothing) |
| `empty-diff` | `DIFFED`: `listChanges` (L438) returns `[]` when a change was expected | yes (re-prompt) |
| `timeout` | engine watchdog in `EDITING` (ADR-024 §5) → child killed (ADR-025) | yes |
| `apply-rejected` | `applyChanges` (L469) returns all `{ok:false}` — path not allowed / `CONFIG_GUARD` protected key / symlink / escapes-repo | **NO — do not retry** (§4) |
| `crash` | runtime restarted mid-step; reconcile finds non-terminal record (ADR-024 §4) | yes (re-attempt from QUEUED) |

### 3. Bounded retry with backoff

- `maxAttempts` default **3** (ADR-027 field). On a retryable `FAILED`, if `attempts < maxAttempts`: rollback (§5), increment `attempts`, re-enqueue a **new attempt** (new `idemKey` because `attempt` is part of the hash — ADR-024 §4; new worktree + branch because the hex suffix differs — ADR-026 §3), status back to `queued`.
- **Backoff:** exponential with jitter — `delay = min(BASE * 2^(attempt-1), MAX) ± jitter`, `BASE` 2s, `MAX` 60s. The task carries a `notBefore` timestamp; `claimNext` (ADR-027 §5) skips tasks whose `notBefore` is in the future. No busy-spin.
- **Re-prompt enrichment (self-heal):** on `empty-diff`/`no-output`, the re-attempt's task prompt is augmented server-side with a terse note ("prior attempt produced no diff; make the concrete file edit now") — bounded, scrubbed, appended to the existing `/run` prompt template (L838). This is the only "self-heal" intelligence; it does not change tools, scope, or guards.

### 4. Non-retryable: apply rejections are NOT retried

`apply-rejected` means a guard fired — `applyAllowed` (L401), `CONFIG_GUARD` (L420), `APPLY_DENY` (L80), symlink/realpath (L496–510). **Retrying cannot change a guard's verdict** (the guards are deterministic for the same content), and silently re-attempting a guard-blocked change would be a guard-hammering pattern. So `apply-rejected` → **immediate terminal `failed` + escalate** (no retry). The operator sees *why* (the broker's `{error}` string, e.g. `protected key changed: scripts`) and decides. This keeps F2b loud, never silent.

### 5. Rollback = discard the worktree (never revert the repo)

Rollback on every retryable `FAILED` and on terminal `failed`/`cancelled`:

```
worktree.remove(stepId)  →  git worktree remove --force <path>  +  git branch -D <branch>   (ADR-026 §6)
```

- This **discards** all sandboxed work for the failed attempt. It does **not** touch the live repo.
- Why no repo revert is needed in S1: a `FAILED` step never reached a half-applied repo state. `apply-rejected` failed *before* writing (the broker rejects, then nothing is written). The only path that writes is `applyChanges` success → `APPLIED` → not a failure. (A crash *during* a multi-file apply is handled by ADR-024 §4's `APPLYING` marker + diff-reconvergence, not by repo revert — `applyChanges` per-file writes are deterministic re-runs.)
- The fresh retry attempt creates a **new** worktree from the pinned `BASE_REF` (ADR-026 §2), so it starts clean — no carry-over from the failed attempt.

### 6. Operator escalation (retries exhausted)

When `attempts >= maxAttempts` (or `apply-rejected`, §4): status → terminal `failed` (ADR-027), and escalate via the **existing bus path** — the same shell-writer pattern as `reportBack` (L523), with the same arg sanitization (strip `[\x00-\x1f"'`|$=]` L530):

```
spawn("bash", [agent-heartbeat.sh, <safeId>, "BLOCKED", "task failed: <kind> after <n> tries", "-", "", "needs BOSS"], …)
spawn("bash", [agent-sync.sh, <safeId>, "BOSS", "task-failed", "-", "<scrubbed reason>"], …)
```

- This surfaces the failure to the kanban/board + the BOSS console — the same channels `reportBack` uses for DONE_CYCLE, so the operator sees stuck work without polling.
- The failed task record (ADR-027 §7) is retained for review; the goal chain is **paused** (ADR-024 §3 — N+1 not enqueued) so a downstream step never runs on a missing predecessor. Operator can re-queue manually or abort the goal.

### 7. Idempotency tie-in (ADR-024)

- Each retry is a distinct attempt with a distinct `idemKey` (attempt in the hash). The dedupe (ADR-027 §6) therefore does NOT collapse a legitimate retry, but DOES collapse an accidental double-submit of the same attempt.
- A crash mid-step (`kind:crash`) is reconciled by ADR-024 §4: `DISPATCHED`/`EDITING`/`APPLYING` records are resolved by the diff-reconvergence check before any retry, so retry never double-applies.

## Security invariant (sr-security — consulted)

**INVARIANT: retry never weakens a guard, never re-attempts a guard rejection, never double-applies, and never reverts the live repo. Rollback is worktree-discard only. Escalation reuses the sanitized bus path.**

| Attack | Vector | Mitigation |
|---|---|---|
| Guard-hammering via retry | retry an `apply-rejected` until it slips | `apply-rejected` is NON-retryable → immediate terminal failure (§4); guards deterministic anyway |
| Double-apply on retry/crash | retry re-runs a completed apply | new `idemKey` per attempt + ADR-024 §4 reconvergence; `applyChanges` deterministic |
| Infinite retry (cost/quota DoS) | unbounded re-spawn | `maxAttempts` cap + exponential backoff + `notBefore` gate; each attempt still consumes a bounded slot (ADR-025) |
| Slot leak on failure | FAILED step never releases slot | `releaseSlot` on every terminal incl. FAILED/timeout/cancel (ADR-025 §3) |
| Repo corruption via "rollback" | rollback writes to repo | rollback is `git worktree remove` only — never touches `REPO_ROOT` |
| Escalation bus injection | crafted error string breaks board markdown | reuse `reportBack` arg sanitization (L530) — strip metachars; argv-array spawn (no shell) |
| Carry-over from failed attempt | retry reuses dirty worktree | retry builds a NEW worktree from pinned `BASE_REF` (ADR-026 §2) |

## Consequences

**Positive** — transient failures self-heal within bounds; guard rejections fail loud and escalate (never silently retried); rollback is trivial + safe (worktree discard); operators are notified via the existing board/BOSS channels; no slot leaks, no double-apply, no infinite retry.

**Negative / accepted** — re-prompt enrichment is heuristic (a model that keeps producing empty diffs still exhausts to escalation — acceptable, it surfaces to the operator). Bounded retries add latency on flaky turns (backoff). `failed` records accumulate (bounded by ADR-027 retention).

**Observability** — `task.error.kind` + `attempts` per task; BLOCKED/task-failed bus events on exhaustion; retro can aggregate failure kinds.

## Alternatives rejected

1. **Retry apply rejections** — guards are deterministic; retrying is guard-hammering and would mask a real policy block. Non-retryable (§4).
2. **Revert the live repo on failure** — unnecessary (FAILED never reaches a half-applied state in S1) and dangerous (a revert is itself an unguarded repo write). Rollback = worktree discard only.
3. **Unbounded retry until success** — cost/quota DoS, can mask a genuinely broken task. Bounded + backoff + escalate.
4. **Silent failure (status quo)** — operator never learns a step died. Escalation via the existing bus is mandatory.
5. **New escalation channel (email/webhook)** — added surface for zero S1 benefit; the board + BOSS console already exist via `reportBack`. Reuse it.

## Open questions (need BOSS decision before build)

- **OQ-028.1 (BOSS):** `maxAttempts` default — 3 (proposed) vs 2 while the loop is new and we'd rather escalate fast?
- **OQ-028.2 (BOSS):** on goal-chain failure, default to **pause + escalate** (proposed) or **abort the whole goal**? Pause lets the operator re-queue one step; abort is cleaner but loses prior steps' context.

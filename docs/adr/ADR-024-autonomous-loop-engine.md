# ADR-024 — Autonomous Loop Engine (orchestrator over the live /run→/changes→/apply→reportBack handlers)

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `autonomous-loop-engine`
- **Plan:** STAGE 1 — Extend the Engine (gap #1 auto-chain)
- **Deciders:** architect, senior-backend-1 (owner), senior-security-engineer (consulted)
- **Builds on:** ADR-022 (model tiers), F2b permission broker (`agent-runtime/server.mjs` L341–542)

## Context

The autonomous loop in `agent-runtime/server.mjs` is **live and proven** but **stops one step short of autonomy**. Today a BOSS goal becomes work like this:

1. Operator `POST /runtime/:id/run` (L800–849) — write-mode only (`TOOLS==="write"` else 400, L802); 429 if `inflight>=MAX_INFLIGHT` (L807); builds a TASK prompt (L838); calls `handleChat` (L846).
2. `handleChat` (L633) → for cli backend, `seedSandbox(agentId)` (L647) then `cliReply(...)` (L648) streams SSE; the agent edits its sandbox copy.
3. Operator **manually** `GET /runtime/:id/changes` (L762→`listChanges` L438) to see the diff.
4. Operator **manually** `POST /runtime/:id/apply` (L771→`applyChanges` L469) — the broker re-validates every path, then `reportBack` (L523) fires the bus heartbeat.

GAP #1 (auto-chain): **steps 3 and 4 are manual clicks, per step, per agent.** A multi-step goal ("create a project") means the operator hand-cranks `/changes` + `/apply` for every step, and there is no machinery to chain step N+1 after step N completes. There is no state, no idempotency, no failure handling — just a request/response per turn.

This ADR adds an **engine that drives the loop** — `QUEUED→…→DONE` — by *orchestrating the existing handlers*, never reimplementing them. It is the **spine**: ADR-025 (scheduler), 026 (worktree isolation), 027 (task queue), 028 (retry/self-heal), 029 (auto-apply policy) all plug into the state machine defined here.

**Hard boundary (BOSS + sr-security):** the loop, broker, and guards are not rewritten. The engine is a NEW module that *calls* `listChanges`, `applyChanges`, `reportBack` and the `/run` dispatch path. It MUST NOT bypass `applyAllowed` (L401), `CONFIG_GUARD` (L83/L420), `APPLY_DENY` (L80), the token/host/origin gates (L107/119/126), or `MAX_INFLIGHT` (L133). Execution (Bash) stays OFF in S1.

## Decision

### 1. New module — `agent-runtime/engine.mjs`

The engine is a **NEW** in-process orchestrator. It owns the state machine, idempotency keys, and chaining. It **REUSES** every existing handler by direct function call (same process, ESM import), or via the existing HTTP route where the dispatch must share the inflight counter (see §6).

```
ADDED   : agent-runtime/engine.mjs        — state machine + chaining + idempotency
ADDED   : agent-runtime/engine-store/     — durable run records (atomic write+rename)
REUSED  : seedSandbox (server L350)       — sandbox prep  [→ ADR-026 swaps for worktree]
REUSED  : handleChat / cliReply (L633/548)— agent dispatch (write-mode, SSE)
REUSED  : listChanges (server L438)       — DIFFED state input
REUSED  : applyChanges (server L469)      — GATING/APPLY — the ONLY write-to-repo path
REUSED  : reportBack (server L523)        — REPORTED state side-effect (bus heartbeat)
REUSED  : resolveTier (server L38)        — tier per step (ADR-022)
REUSED  : MAX_INFLIGHT / inflight (L133)  — backpressure (shared, never bypassed)
```

To make `listChanges`/`applyChanges`/`reportBack`/`seedSandbox`/`handleChat` callable from `engine.mjs`, server.mjs gains a small `export {…}` of those existing functions. **No logic change to any of them** — export-only. This ADR does not touch their bodies.

### 2. The state machine (the spine)

Each unit of work is a **step** (one agent, one sandbox/worktree, one diff, one gate decision). A **goal** is an ordered chain of steps. Steps move through exactly these states:

```
QUEUED ──dispatch──▶ DISPATCHED ──spawn ok──▶ EDITING ──claude close──▶ DIFFED
                                                                          │
                                       ┌──────────────────────────────────┤
                                       │ listChanges → []                  │ listChanges → [changes]
                                       ▼                                   ▼
                                 FAILED(empty-diff)                      GATING ──policy(ADR-029)──┐
                                                                          │                        │
                                                            auto-apply ◀──┤                        ├──▶ HELD (await operator confirm)
                                                                          ▼                                       │
                                                                     APPLIED ◀───────operator POST /apply─────────┘
                                                                          │
                                                                          ▼
                                                                     REPORTED ──reportBack fired──▶ DONE
```

Plus terminal/transition states:

```
FAILED   — any unrecoverable error (spawn error, non-zero exit, empty-diff-when-expected,
           apply rejection, timeout). Owns the error payload. → ADR-028 may RETRY (new attempt).
HELD     — diff valid but policy says hold; awaits operator /apply. Not a failure.
CANCELLED— operator/scheduler killed the step (→ ADR-025 cancellation).
```

State definitions (each is persisted — §4):

| State | Entered when | Action taken | Exit |
|---|---|---|---|
| `QUEUED` | step created (from goal or chain) | none | scheduler picks it (ADR-025) |
| `DISPATCHED` | scheduler claims a slot | prep isolation (`seedSandbox`/worktree), call `handleChat` write-mode | spawn ok → `EDITING`; spawn err → `FAILED` |
| `EDITING` | `claude` child running | drain SSE to a per-step log; watchdog timer armed | child close → `DIFFED`; timeout → `FAILED` |
| `DIFFED` | child closed | call `listChanges(agentId)` (or git-diff per ADR-026) | changes>0 → `GATING`; changes==0 → `FAILED(empty-diff)` |
| `GATING` | diff present | evaluate ADR-029 policy over the diff | auto-eligible → `APPLIED` (engine calls `applyChanges`); else → `HELD` |
| `HELD` | policy held | surface to board/UI; wait | operator `/apply` → `APPLIED`; operator reject → `CANCELLED` |
| `APPLIED` | `applyChanges` returned ≥1 ok | record results; the broker already did all re-validation | → `REPORTED` |
| `REPORTED` | apply ok | `reportBack(agentId, summary)` (DONE_CYCLE heartbeat) | → `DONE` or chain next step |
| `DONE` | step + (if last) goal complete | mark goal status; emit DONE_CYCLE | terminal |
| `FAILED` | see detection list | record error; hand to ADR-028 | RETRY → new attempt in `QUEUED`; exhausted → escalate |
| `CANCELLED` | killed | discard isolation (ADR-026 cleanup) | terminal |

**Critical invariant: `APPLIED` is reachable ONLY by calling `applyChanges` (L469).** The engine never writes to `REPO_ROOT` itself. `GATING`'s auto-apply branch and `HELD`'s operator-confirm branch converge on the *same* `applyChanges` call, so `applyAllowed`/`CONFIG_GUARD`/`APPLY_DENY`/symlink/realpath checks run **identically** whether the apply was automatic or operator-clicked. Auto-apply changes *who clicks*, never *what is allowed*.

### 3. Auto-chaining of multi-step goals

A goal carries an ordered list of step specs (the planner that produces them is out of scope here — S1 accepts a literal step list from the BOSS dispatch or the CEO `dispatch` block; the durable backlog is ADR-027). The engine chains:

```js
// pseudocode — engine.mjs, NOT implementation
onStepTerminal(step) {
  if (step.state === "DONE" && step.chain.next) {
    enqueue(step.chain.next, { parentStepId: step.id, idemKey: derive(step.chain.next) });
  }
  if (step.state === "FAILED") handByPolicy(step);   // → ADR-028
  if (allStepsDone(step.goalId)) markGoalDone(step.goalId);
}
```

- Chaining is **strictly sequential within a goal** (step N+1 enqueues only after step N reaches `DONE`). Independent goals run in parallel via the scheduler (ADR-025).
- A `HELD` step **pauses the chain** — step N+1 is not enqueued until the held step is operator-applied (`APPLIED`→`DONE`) or rejected (`CANCELLED` → goal fails or branches per ADR-028).
- Acceptance criterion (BOSS): a goal "create a project" with safe `src/*` steps auto-chains to a completed, diff-reviewable change with **zero manual clicks** when policy = auto-safe (ADR-029), and **holds** the moment any step touches a CONFIG_GUARD/APPLY_DENY path.

### 4. Idempotency & re-entrancy (crash/retry must not double-apply)

This is the highest-risk correctness requirement: a retry (ADR-028) or a runtime crash mid-`APPLIED` must never apply the same change twice or skip a chain link.

Every step carries an **idempotency key** `idemKey` = stable hash of `(goalId, stepIndex, attempt, agentId, taskText)`. Run records are persisted **before** each side-effecting transition and updated **after**, using the same **atomic write+rename** pattern the existing scripts use (`reportBack`, thread persistence L179):

```
write engine-store/runs/<idemKey>.tmp  →  fsync  →  rename → runs/<idemKey>.json
```

Re-entrancy guards per transition:

- **DISPATCHED:** if a record already shows `DISPATCHED`/`EDITING` for this `idemKey` on restart, the prior `claude` child is gone (children die with the process) → reset to `QUEUED` for a fresh attempt. No repo write happened, safe.
- **APPLIED (the dangerous one):** the engine writes a `pre-apply` marker `{idemKey, state:"APPLYING", paths}` *before* calling `applyChanges`, and a `post-apply` marker with the broker results *after*. On restart:
  - record at `APPLYING` (crashed mid-apply) → **do not blindly re-apply.** Re-run `listChanges`; if the sandbox/worktree diff vs repo is now empty for those paths, the apply already landed → mark `APPLIED`. If diff still present, the apply did not complete → safe to re-call `applyChanges` (it is itself idempotent: it overwrites dest with sandbox content, deterministic). This makes apply **at-least-once that converges to exactly-once-effect** because `applyChanges` is a pure content copy of validated paths.
  - record at `APPLIED`/`REPORTED`/`DONE` → no-op (already complete).
- **REPORTED:** `reportBack` is fire-and-forget and idempotent-enough (a duplicate DONE_CYCLE heartbeat is cosmetically harmless on the board). Still gated behind the `APPLIED→REPORTED` transition marker so a crash loop can't spam the bus.

The `idemKey` is also the dedupe key shared with the task queue (ADR-027 §dedupe) so the same goal step submitted twice collapses to one run record.

### 5. Failure transitions (detection sources)

The engine detects failure from these concrete signals (full handling in ADR-028):

| Signal | Source | → State |
|---|---|---|
| spawn error | `child.on("error")` in `cliReply` (L625) surfaced to engine | `FAILED(spawn)` |
| non-zero / abnormal close | `child.on("close")` (L626) with empty `acc` + no diff | `FAILED(no-output)` |
| empty diff when change expected | `listChanges` returns `[]` at `DIFFED` | `FAILED(empty-diff)` |
| apply rejection | `applyChanges` returns all `{ok:false}` (path not allowed / protected key / symlink) | `FAILED(apply-rejected)` |
| timeout | engine watchdog fires in `EDITING` | `FAILED(timeout)` → kill child (ADR-025 cancellation) |

`FAILED` records the structured error and hands to ADR-028. Rollback (worktree discard) and escalation live there.

### 6. Backpressure — share the existing counter, never bypass it

The engine MUST respect `MAX_INFLIGHT`/`inflight` (L133). The dispatch into `EDITING` spawns a `claude` child exactly like `/run` does, so it consumes the same budget. Two acceptable wirings (ADR-025 picks one):

- (preferred) the engine dispatches **through the existing `/run` route** over loopback with the runtime token, so the route's own 429 (L807) and `inflight++`/`res.on("close")` decrement (L842–845) apply unchanged; OR
- the engine calls `handleChat` directly **after** acquiring a slot from a shared semaphore that wraps the same `inflight` integer (exported), incrementing/decrementing with identical semantics.

Either way the cap is one number for the whole process. **The engine never spawns a `claude` child outside that budget.** ADR-025 owns slot acquisition, fairness, and cancellation.

### 7. Observability

- Per-step state log: `engine-store/runs/<idemKey>.json` carries the full state history with timestamps.
- A new read-only `GET /runtime/engine/runs` (host+token gated, same `needsAuth` family L754) surfaces run records to the board (scrubbed via `scrub` L266). Read-only — no new write surface.
- Every `DONE` already emits a DONE_CYCLE heartbeat via `reportBack` (unchanged). `HELD` and `FAILED` emit analogous status sync to the bus so the board shows stuck/blocked work.

## Security invariant (sr-security — consulted; HARD gate deferred to ADR-026/029)

**INVARIANT: the engine adds orchestration only. Every write to the live repo still flows through `applyChanges` (L469) and is re-validated by `applyAllowed`/`CONFIG_GUARD`/`APPLY_DENY` with no relaxation. Automation changes the *trigger*, never the *check*.**

| Attack | Vector | Mitigation |
|---|---|---|
| Engine writes repo directly | new module bypasses broker | engine has NO file-write to `REPO_ROOT`; `APPLIED` reachable only via `applyChanges` (L469). Code review gate. |
| Double-apply on crash | retry/restart re-runs apply | `APPLYING`/`APPLIED` markers + diff-reconvergence check (§4); `applyChanges` is a deterministic content copy |
| Backpressure bypass (fork-bomb) | engine spawns outside `inflight` | dispatch shares the existing counter/route 429 (§6); never spawns off-budget |
| Auto-apply widens scope | engine auto-applies a guarded path | auto-apply and operator-apply converge on the SAME `applyChanges`; ADR-029 can only relax *who triggers*, guards unchanged |
| Chain runs past a held risky step | N+1 dispatched while N HELD | chain strictly waits for `APPLIED`/`DONE`; `HELD` pauses the chain (§3) |
| Token/host bypass via internal route | engine calls /run without auth | engine uses the same runtime token + loopback host; `needsAuth` (L754) still gates |

## Consequences

**Positive** — a BOSS goal auto-chains to a completed, diff-reviewable change with zero clicks on safe steps; durable run records survive restart; no double-apply; the broker remains the single choke point. Tiny blast radius on the live code: server.mjs change is export-only.

**Negative / accepted** — a new in-process module to maintain; engine-store adds disk state (bounded, atomic). Sequential-within-goal chaining trades throughput for safety (independent goals still parallelize via ADR-025). Apply is at-least-once-converging-to-exactly-once-effect rather than transactional — accepted because `applyChanges` is a deterministic content copy, not an incremental mutation.

**Observability** — per-step state history; `GET /runtime/engine/runs`; HELD/FAILED bus sync alongside the existing DONE_CYCLE heartbeat.

## Alternatives rejected

1. **Reimplement diff/apply inside the engine** — duplicates the security-critical broker; two code paths to keep guard-equivalent forever. Rejected hard: BOSS boundary + sr-security. Engine REUSES `applyChanges`.
2. **Engine writes to repo, broker only validates async** — splits the write from the check; the exact F2b posture this protects. No.
3. **In-memory-only run state** — a crash mid-apply loses the idempotency record → double-apply risk. Rejected; atomic write+rename persistence required.
4. **Drive everything as separate HTTP requests with no shared state machine (status quo + a script)** — no idempotency, no crash recovery, no chaining contract. That's the gap.
5. **Bypass `MAX_INFLIGHT` for engine-internal dispatch ("it's trusted")** — reopens the fork-bomb/quota surface (sr-security #6). No; one shared counter.

## Open questions (need BOSS / security decision before build)

- **OQ-024.1 (BOSS):** does the S1 planner produce step lists, or does S1 only chain explicitly-listed steps from the dispatch block? (Affects whether `engine.mjs` needs a goal-decomposition input or just an ordered array.)
- **OQ-024.2 (security):** dispatch wiring — internal `/run` HTTP call (clean auth reuse, slight overhead) vs direct `handleChat` + exported semaphore (faster, more surface). Recommend the HTTP route; needs sr-security sign-off in ADR-025.

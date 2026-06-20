# ADR-025 — Parallel Dispatch Scheduler (operator-loop fan-out over MAX_INFLIGHT)

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `parallel-dispatch-scheduler`
- **Plan:** STAGE 1 — Extend the Engine (gap #2 parallel dispatch)
- **Deciders:** architect, senior-backend-1 (owner), senior-security-engineer (consulted)
- **Plugs into:** ADR-024 (state machine spine), ADR-022 (model tiers)

## Context

The runtime already bounds concurrency: `MAX_INFLIGHT` (L133, default 4) and the `inflight` counter, incremented per `/chat` (L744) and per `/run` (L842), decremented on `res.on("close")` (L745/843). `/run` returns **429** when `inflight>=MAX_INFLIGHT` (L807). This is a hard, proven backpressure control (sr-security #6: fork-bomb/quota guard).

GAP #2 (parallel dispatch): there is **no scheduler**. The operator fans out work by firing N `/run` requests; excess ones 429 and are simply dropped — the work is lost, there is no queue, no fairness, no retry-on-429, no cancellation of an in-flight task. The engine (ADR-024) produces `QUEUED` steps but nothing **claims** them against the slot budget.

This ADR adds the **scheduler**: it pulls `QUEUED` steps (from the backlog, ADR-027), claims slots against the **same** `inflight` budget (never a parallel budget), dispatches them into ADR-024's `DISPATCHED→EDITING`, enforces fairness across agents, and supports cancellation/kill of an in-flight `claude` child.

**Hard boundary:** the scheduler **shares** `MAX_INFLIGHT`/`inflight` — it does not introduce a second counter, does not bypass the 429, does not spawn `claude` children off-budget. It is a NEW module that feeds the existing dispatch path.

## Decision

### 1. New module — `agent-runtime/scheduler.mjs`

```
ADDED   : agent-runtime/scheduler.mjs    — slot acquisition, fairness, cancellation
REUSED  : MAX_INFLIGHT / inflight (L133) — the ONE concurrency budget, shared
REUSED  : /run route 429 + inflight++/decrement (L807/842–845) — dispatch path
REUSED  : engine.mjs state machine (ADR-024) — QUEUED→DISPATCHED transition
REUSED  : ADR-027 backlog                — source of QUEUED steps
```

### 2. Shared slot budget (NOT a second counter)

The scheduler does not own a budget; it **borrows** the existing one. server.mjs exports a tiny slot API around the existing integer — **no new limit, no logic change to the cap**:

```js
// pseudocode over the EXISTING `inflight`/MAX_INFLIGHT (L133) — engine/scheduler call these
function tryAcquireSlot() {            // returns false if inflight>=MAX_INFLIGHT (same test as L807)
  if (inflight >= MAX_INFLIGHT) return false;
  inflight++;                          // identical to L744/842
  return true;
}
function releaseSlot() { inflight = Math.max(0, inflight - 1); }  // identical to L746/844
```

The `/chat` and `/run` routes keep their own `inflight++` / `res.on("close")` decrement **unchanged** — they remain the canonical pattern. When the engine dispatches via the internal `/run` route (ADR-024 §6 preferred wiring), it inherits the route's 429 + decrement for free and the scheduler simply does not over-fire (it dispatches only as many as `tryAcquireSlot` allows, then waits). The exported `tryAcquireSlot`/`releaseSlot` exist for the direct-call wiring and to let the scheduler *peek* capacity before pulling from the backlog.

**Invariant: total concurrent `claude` children = `inflight` ≤ `MAX_INFLIGHT`, across chat + run + engine, always.**

### 3. Dispatch loop (the fan-out)

```
loop (tick on: step enqueued | slot released | cancellation):
  while tryAcquireSlot():
    step = backlog.claimNext(fairness)        # ADR-027 atomic claim; null if none ready
    if !step: releaseSlot(); break            # nothing to do — give the slot back
    engine.dispatch(step)                      # ADR-024 QUEUED→DISPATCHED→EDITING
                                               #   on child close OR error → releaseSlot()
```

- `releaseSlot()` is called exactly once per acquired slot, on `claude` child close/error (tied to the same `res.on("close")`/`child.on("close")` lifecycle that already decrements). The engine guarantees one release per dispatch even on `FAILED`/timeout.
- 429 is no longer a dropped request: the scheduler simply doesn't claim more than capacity, and re-ticks when a slot frees. The operator-facing `/run` can still 429 for *direct* manual fire (unchanged), but engine-driven work is queued, never dropped.

### 4. Fairness — priority + round-robin within priority

`backlog.claimNext(fairness)` (ADR-027 provides the store; this ADR specifies the selection policy):

1. **Priority first** — pick from the highest non-empty priority band (ADR-027 priorities: `high > normal > low`).
2. **Round-robin by agentId within a band** — track `lastServed` per agentId; among ready steps at the top band, pick the agent least-recently-served. Prevents one chatty agent (e.g. a long chain) from starving peers.
3. **Per-agent slot cap** — at most `MAX_PER_AGENT` (default `ceil(MAX_INFLIGHT/2)` = 2) concurrent steps per agentId, so a single agent can never hold all 4 slots. Configurable via `RUNTIME_MAX_PER_AGENT`.
4. **FIFO tiebreak** — within agent+priority, oldest `createdAt` first.

Tier (ADR-022) does not affect scheduling priority — tier is the *model*, priority is the *queue band*; orthogonal.

### 5. Cancellation / kill of an in-flight task

Today there is no way to stop a running `claude` child except dropping the SSE connection. The scheduler adds explicit cancellation:

- Engine tracks the live `child` handle (from `cliReply` L586) per in-flight step in a `Map<stepId, child>`.
- `POST /runtime/engine/cancel {stepId}` (NEW route, `needsAuth` family — host+origin+token, added to the L754 regex) → engine looks up the child → `child.kill("SIGTERM")`, then `SIGKILL` after a 5s grace.
- On kill: state → `CANCELLED` (ADR-024), `releaseSlot()`, and the isolation is discarded (sandbox/worktree cleanup — ADR-026 `git worktree remove --force`). **No partial diff is ever applied** — `CANCELLED` never transits to `APPLIED`.
- Scheduler-initiated cancellation (e.g. goal aborted by operator) uses the same path for every step in the goal.

Cancellation is **kill-only** — it never reaches into the repo. Anything the killed agent wrote stays in its discarded sandbox/worktree and is removed.

### 6. Backpressure surfacing

- `GET /runtime/engine/runs` (ADR-024 §7) shows queued vs in-flight counts so the board renders "3/4 slots busy, 7 queued".
- The health endpoint (L985) gains `inflight` + `maxInflight` + `queued` (read-only, no new write surface).

## Security invariant (sr-security — consulted)

**INVARIANT: the scheduler shares the single `inflight`/`MAX_INFLIGHT` budget. It never creates a second concurrency limit, never spawns a `claude` child off-budget, and never bypasses the 429 control. Cancellation is kill-only and never writes to the repo.**

| Attack | Vector | Mitigation |
|---|---|---|
| Fork-bomb / quota abuse | scheduler spawns beyond cap | `tryAcquireSlot` is the SAME `inflight<MAX_INFLIGHT` test (L807); one shared counter |
| Slot leak (eventual deadlock) | acquired slot never released | exactly-one `releaseSlot` per dispatch on child close/error/timeout/cancel; watchdog (ADR-024 §5) guarantees terminal |
| Starvation | one agent monopolizes slots | per-agent cap (MAX_PER_AGENT) + round-robin (§4) |
| Cancel writes partial diff | killed mid-edit applies garbage | `CANCELLED` cannot transit to `APPLIED`; worktree discarded (ADR-026) |
| Unauthorized cancel | random local process kills tasks | `/runtime/engine/cancel` in `needsAuth` family (L754) — token+host+origin |
| Queue flooding (memory DoS) | unbounded QUEUED steps | backlog capacity bound (ADR-027 §capacity); over-cap submissions rejected |

## Consequences

**Positive** — work is queued, not dropped on 429; N concurrent steps up to the proven cap; fairness prevents starvation; explicit cancellation with safe cleanup. Zero change to the actual concurrency limit — same blast radius as today on the dangerous dimension.

**Negative / accepted** — a tick-driven loop to maintain; per-agent cap can leave a slot idle if only one agent has ready work (accepted — anti-starvation > max throughput). Exporting `tryAcquireSlot`/`releaseSlot` widens the in-process API surface (mitigated: trivial wrappers over the existing integer, code-review gated).

**Observability** — slots busy/free + queued depth on the board and `/runtime/health`.

## Alternatives rejected

1. **Separate scheduler concurrency budget** — two counters drift; the real fork-bomb guard (sr-security #6) is `MAX_INFLIGHT`. One budget only. No.
2. **Retry-on-429 from the operator** — pushes backpressure to the client, loses work on disconnect, no fairness. The scheduler owns capacity-aware claiming instead.
3. **Unbounded parallel dispatch ("let the OS schedule")** — reopens the exact fork-bomb/quota surface the cap closes. No.
4. **Cancel by dropping SSE only (status quo)** — leaves the `claude` child running (orphaned cost), no cleanup, no state. Explicit kill + cleanup required.
5. **Pure FIFO (no fairness)** — a long multi-step chain starves every other agent. Priority + round-robin + per-agent cap.

## Open questions (need BOSS / security decision before build)

- **OQ-025.1 (BOSS):** default `MAX_PER_AGENT` — `ceil(MAX_INFLIGHT/2)`=2, or allow one agent to use all 4 when no peers are queued? (Throughput vs strict fairness.)
- **OQ-025.2 (security):** confirm dispatch wiring with ADR-024 OQ-024.2 (internal `/run` HTTP vs direct `handleChat`+semaphore). The HTTP route reuses 429/decrement verbatim; recommend it.

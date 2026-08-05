# ADR-027 — Task Queue / Backlog (durable file-based store, migration-ready)

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `task-queue-backlog`
- **Plan:** STAGE 1 — Extend the Engine (gap #5 task queue / backlog)
- **Deciders:** architect, **principal-db-engineer (owner)**, senior-backend-1 (consulted)
- **Plugs into:** ADR-024 (engine consumes/produces tasks), ADR-025 (scheduler claims tasks), ADR-028 (retry updates attempts)

## Context

The engine (ADR-024) produces `QUEUED` steps and the scheduler (ADR-025) needs a place to **pull ready work, claim it atomically, and persist status across restarts**. Today there is no backlog at all — `/run` (L800) is fire-and-forget; excess work 429s and is lost (L807). Run state (ADR-024 §4) is per-step under `engine-store/runs/<idemKey>.json`, but there is no **queue** abstraction: nothing orders work by priority, dedupes resubmissions, or bounds capacity.

GAP #5: a **durable, file-based task queue / backlog** — crash-safe, migration-ready to a real DB later, owned by principal-db-engineer. It must use the **same atomic write+rename** crash-safety the codebase already relies on (thread persist L179, `reportBack` bus writes) and must dedupe on the engine's idempotency key (ADR-024 §4) so a goal step submitted twice collapses to one task.

The store deliberately mirrors the existing on-disk conventions: gitignored dir under `agent-runtime/`, `0o600` file mode (like L173/180), `safeId`-style key sanitization (L144/346), bounded size — so the eventual DB migration is a straight schema port.

## Decision

### 1. Owner & module

```
ADDED   : agent-runtime/queue.mjs         — backlog API (enqueue/claimNext/update/dedupe)
ADDED   : agent-runtime/engine-store/tasks/<taskId>.json  — durable task records (gitignored, 0o600)
ADDED   : agent-runtime/engine-store/tasks/index.json     — claim index (atomic, ordered)
REUSED  : atomic write+rename pattern (thread persist L179; tmp→fsync→rename)
REUSED  : safeId sanitization style (L144/346/531) for taskId/keys
REUSED  : idemKey (ADR-024 §4) as the dedupe key
OWNER   : principal-db-engineer builds the store; this ADR specs schema/priorities/statuses/dedupe/capacity
```

Migration-ready: the JSON record schema **is** the future table schema; `queue.mjs` exposes a narrow interface (`enqueue`, `claimNext`, `update`, `get`, `findByIdemKey`, `counts`) so the backing store can swap file→SQLite/Mongo without touching the engine/scheduler.

### 2. Task record schema (= future DB row)

```jsonc
{
  "taskId":      "task_<12hex>",        // server-minted, primary key
  "idemKey":     "<sha256 hex>",        // ADR-024 §4 — UNIQUE; dedupe key
  "goalId":      "goal_<12hex>",        // groups a multi-step chain
  "parentTaskId":"task_… | null",       // chain ref: this step's predecessor
  "chainNext":   "task_… | null",       // chain ref: successor enqueued on DONE (ADR-024 §3)
  "stepIndex":   0,                       // ordinal within the goal
  "agentId":     "senior-web-1",          // [a-z0-9_-] validated (matches route regex L708)
  "tier":        "sonnet",                // ADR-022 tier key (resolved at dispatch via resolveTier L38)
  "task":        "…goal text… (≤4000)",   // same cap as /run (L822)
  "priority":    "normal",                // enum: high | normal | low
  "status":      "queued",                // enum below (§4)
  "attempts":    0,                        // incremented by ADR-028 on each retry
  "maxAttempts": 3,                        // ADR-028 bound
  "createdAt":   "ISO8601",
  "updatedAt":   "ISO8601",
  "claimedAt":   "ISO8601 | null",        // set on atomic claim (lease)
  "leaseExpiry": "ISO8601 | null",        // claim lease — reclaim if a worker dies (§5)
  "result":      "summary string | null", // on done (mirrors reportBack summary L532)
  "error":       { "kind":"…", "msg":"…" } // on failed (ADR-028 detection kinds)
}
```

All free-text fields (`task`, `result`, `error.msg`) are **scrubbed** via the existing `scrub` (L266) before persist and before any egress through `/runtime/engine/runs` (ADR-024 §7). `agentId` is validated against the same `[a-z0-9_-]{1,64}` class the routes use (L708).

### 3. Priorities

`high | normal | low` (default `normal`). Selection is ADR-025 §4: highest non-empty band first, round-robin by agentId within a band, FIFO tiebreak. Priority is a **queue band only** — it does not change the model tier (ADR-022) and does not relax any apply guard.

### 4. Status enum (mirrors ADR-024 states, queue-side projection)

```
queued     → ready to claim
claimed    → leased by the scheduler/engine (in DISPATCHED…REPORTED)
held       → ADR-024 HELD (awaiting operator /apply); NOT claimable, NOT done
done        → ADR-024 DONE (terminal)
failed      → ADR-024 FAILED, retries exhausted (terminal) — escalated (ADR-028)
cancelled   → ADR-025 cancellation (terminal)
```

`held` is distinct from `claimed`/`queued`: a held task occupies no slot and is not re-claimable, but pauses its goal chain (ADR-024 §3). Only `queued` tasks (with expired/no lease) are claimable.

### 5. Atomic claim, lease, crash-safety

**Crash-safe write** (every mutation): `write tasks/<taskId>.json.tmp` → `fsync` → `rename` over the canonical file — the same atomicity guarantee the thread persist (L179) and bus scripts rely on. A crash mid-write leaves either the old file or the new file, never a torn one.

**Atomic claim** (the concurrency-critical op — multiple scheduler ticks must not double-claim):

- A single in-process `claimNext()` is serialized by the engine's run loop (one Node event loop, one scheduler — no cross-process race in S1), so claim = read top-of-band candidate → set `status:"claimed"`, `claimedAt`, `leaseExpiry = now + LEASE_MS` → atomic write → return. Because S1 is single-process, this is race-free without file locks.
- **Lease reclaim:** if a claimed task's `leaseExpiry` passes and its step is not terminal (worker died / runtime crashed mid-step), the startup reconcile + each tick treats it as reclaimable → reset to `queued` (attempts unchanged — the dispatch never reached `APPLIED`; ADR-024 §4 re-entrancy confirms no repo write). This is the queue-side mirror of ADR-024's `DISPATCHED→QUEUED` reset.
- **Migration note (principal-db-engineer):** the file claim relies on single-process serialization. The DB port MUST replace it with a real atomic claim (`UPDATE … WHERE status='queued' … RETURNING` / `findOneAndUpdate`) before any multi-process deployment. Documented as a migration gate.

**Index:** `tasks/index.json` holds an ordered list of `{taskId, priority, agentId, status, createdAt}` for fast band selection without reading every record; rebuilt from the record files on startup (source of truth = the per-task files, index = derived cache).

### 6. Dedupe (idempotency)

`enqueue` computes `idemKey` (ADR-024 §4) and calls `findByIdemKey` first. If a non-terminal task with that key exists → **return the existing taskId, do not create a duplicate.** This makes goal-step submission idempotent: a retried dispatch, a double-clicked operator action, or a crash-replay of the chainer all collapse to one task. Terminal tasks (done/failed/cancelled) do not block a fresh enqueue (a genuinely new attempt gets a new `idemKey` because `attempt` is part of the hash — ADR-024 §4).

### 7. Capacity bounds (DoS guard)

- `MAX_QUEUED` (default 500, `RUNTIME_MAX_QUEUED`) — total non-terminal tasks. `enqueue` over cap → reject `{error:"backlog full"}` (mirrors the 429 backpressure philosophy; never silently grows unbounded — sr-security #6 spirit).
- Per-goal step cap `MAX_STEPS_PER_GOAL` (default 50) — a runaway chain can't enqueue infinitely.
- Terminal records are **retained** (audit) but counted separately; a bounded reaper trims `done`/`cancelled` records older than `TASK_TTL` (default 7d) to keep the dir small. `failed` records are retained longer for escalation review.

## Security invariant (sr-security — consulted)

**INVARIANT: the backlog stores task metadata only. It grants no capability — it does not widen apply scope, does not store secrets, and all free-text is scrubbed. Capacity is bounded. The backlog never writes to the live repo; only `applyChanges` (L469) does.**

| Attack | Vector | Mitigation |
|---|---|---|
| Backlog flooding (disk/memory DoS) | unbounded enqueue | `MAX_QUEUED` + per-goal cap + TTL reaper (§7) |
| Secret persisted in task text | goal text contains a key | `scrub` (L266) on persist + egress; `0o600`, gitignored, outside any agent read scope |
| Double-claim → double-dispatch | two claims of one task | single-process serialized claim + lease (§5); DB port must use atomic claim (migration gate) |
| Stuck lease (work lost) | worker dies holding claim | lease expiry → reclaim to `queued` (§5) |
| Resubmit storm | same goal step enqueued repeatedly | `idemKey` dedupe (§6) collapses to one task |
| Tampered index escalates a task | edited `index.json` | index is a derived cache; per-task record files are source of truth; `priority`/`status` re-read from the record at claim |
| Injected agentId / path-y key | crafted `agentId` | validated `[a-z0-9_-]` (L708 class); `taskId` server-minted; filenames `safeId`-sanitized (L144) |

## Consequences

**Positive** — work is durable and survives restart; priority + fairness feed the scheduler (ADR-025); dedupe prevents storms; crash-safe via the proven atomic write+rename; a clean migration path to a DB (schema = record). principal-db-engineer owns one cohesive module.

**Negative / accepted** — file-based claim is single-process-only (explicit migration gate before any multi-process deploy); JSON-per-task means many small files (bounded by caps + reaper); the derived index must be kept consistent (rebuilt from records on startup, so a stale index self-heals).

**Observability** — `counts()` (queued/claimed/held/done/failed per priority) feeds `/runtime/engine/runs` (ADR-024 §7) and `/runtime/health`; failed-task retention enables escalation review (ADR-028).

## Alternatives rejected

1. **In-memory queue only** — lost on restart; no audit; double-apply risk if a chain replays without durable state. The atomic-persist store is required.
2. **Jump straight to a DB (SQLite/Mongo)** — premature for S1's single-process loop; adds a dependency + ops surface now. File store is migration-ready by design; DB is a clean later port.
3. **Reuse `engine-store/runs/<idemKey>.json` as the queue** — conflates run-state history with the claimable backlog; no priority/index/dedupe contract. Separate `tasks/` store with a narrow interface.
4. **No dedupe** — resubmits + crash-replays create duplicate work and re-dispatch the same step. `idemKey` dedupe is mandatory.
5. **Unbounded backlog** — disk/memory DoS (sr-security #6 spirit). Hard caps + reaper.

## Open questions (need BOSS / DB-owner decision before build)

- **OQ-027.1 (principal-db-engineer):** confirm `LEASE_MS` default (propose 10min — comfortably above the longest expected `claude` write turn) and the `TASK_TTL` retention (7d).
- **OQ-027.2 (BOSS):** is 500 a sensible `MAX_QUEUED` for S1, or smaller while the loop is proven? (Easy to raise once stable.)
- **OQ-027.3 (principal-db-engineer):** target DB for the eventual migration — SQLite (single-file, matches the local-loop model) vs the platform's MongoDB? Affects how literal the schema-port stays.

---

## AS BUILT (P4, 2026-07-30)

Status: **IMPLEMENTED** — `agent-runtime/queue.mjs`. Deltas from the proposal above:

1. **`task.*` emit-on-persist.** `createQueue({ emit })` announces every transition from the
   SAME function that writes it (ADR-052 §2): `enqueue` → `task.queued`, or `task.retried`
   when the record carries `attempts > 0` (i.e. the enqueue IS an ADR-028 retry);
   `claimNext` → `task.started`; `update({status:'failed'})` → `task.failed` with the
   classified `error.kind`; `reclaimExpiredLeases` → `task.queued`. A deduped enqueue emits
   nothing, so a double submit stays exactly-once. `done` / `held` / `cancelled` have **no**
   catalog name — the v1 event catalog is closed (program plan §2), so the UI learns those
   from the authoritative `GET /runtime/engine/runs` snapshot instead of an invented event.
   The emitter is swallowed inside `queue.mjs`: a bus fault can never break a queue write.
2. **`MAX_PER_AGENT` default is 1, not `ceil(MAX_INFLIGHT/2)`.** Program plan P4 requires
   **per-agent serial** execution — an agent must never run two steps at once in its own
   worktree. Cross-agent parallelism is unchanged and still bounded solely by the shared
   `MAX_INFLIGHT`. `RUNTIME_MAX_PER_AGENT` still overrides. (This supersedes ADR-025 §3's
   "default 2".)
3. **Store remains file-backed.** The program plan's P4 line said "durable task table in
   SQLite". Deferred deliberately: the file store already satisfies every P4 exit criterion
   (durable, crash-safe, atomic claim, restart-resume — proven by `test/autonomy.test.mjs`
   and a live `kill -9` probe), and OQ-027.3 is still open. The narrow interface this ADR
   specifies is what makes the port a later, behaviour-neutral change.

Resolved open questions: **OQ-027.1** — `LEASE_MS` 10 min shipped; `TASK_TTL` retention is
NOT implemented (no sweeper yet — see the P4 exit report's deferred list). **OQ-027.2** —
500 shipped. **OQ-027.3** — still open.

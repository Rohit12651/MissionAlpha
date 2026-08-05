# ADR-051 — Delivery Engine (SQLite-backed Delivery store — the Inbox's core record)

- **Status:** ACCEPTED — IMPLEMENTED (as-built 2026-07-30, shipped in P2; extended P5/P6/P7/P9)
- **Date:** 2026-07-30
- **Slug:** `delivery-engine`
- **Plan:** Agent Inbox Program **P2 — Delivery engine + event bus** (`docs/superpowers/plans/2026-07-30-agent-inbox-program-plan.md`)
- **Deciders:** architect, senior-backend-1 (owner), senior-security-engineer (consulted — mutating endpoints + broker touchpoint)
- **Builds on:** ADR-024 (engine state machine — `APPLIED` reachable ONLY via `applyChanges`), ADR-026 (worktree/broker paths), ADR-029 (auto-apply policy — `GATING`/`HELD`), `docs/ceo/MISSION-INBOX-master-spec.md` §3 (Delivery TS type)
- **Plugs into:** ADR-052 (event bus — every mutation defined here emits there)

## Context

Master-spec §3 names the `Delivery` object as the product's core record but only defines its shape as a TypeScript type — **no SQL exists yet anywhere in the repo** (checked: no `CREATE TABLE`, no `deliveries` schema). This ADR is where that schema is minted for the first time, derived field-by-field from the TS type — it is not a copy of a pre-existing SQL block.

Today's engine (ADR-024, **live**) reaches `DONE` and fires `reportBack()` (bus heartbeat, `server.mjs:581`), but there is no durable, queryable, decision-tracking record: no `GET /inbox`, no approve/reject/request-changes history, no per-Delivery audit linkage. `engine-store/runs/<idemKey>.json` (ADR-024 §4) is a **transient step record**, not a product-facing object. `GET /runtime/health` already reports `engine: {inflight, maxInflight, queue: engineQueue.counts()}` (`server.mjs:1893`) — this ADR **extends** that block, never replaces it.

**Hard boundary (same as ADR-024/029):** this ADR adds a NEW store + NEW routes. It does not touch `applyChanges`/`applyAllowed`/`CONFIG_GUARD`/`APPLY_DENY`/token-host-origin gates, and it does not let anything reach a repo write except through the existing broker.

## Decision

### 1. Storage — SQLite (better-sqlite3, WAL) vs ndjson vs Postgres

| Option | Verdict | Why |
|---|---|---|
| **SQLite via better-sqlite3, WAL** | **CHOSEN** | Embedded (ships inside the Electron app, no external process — master-spec §5 "no cloud dependency for the core loop"), synchronous API matches the codebase's existing sync-first persistence style (`guards.mjs`, `queue.mjs` atomic write+rename), gives real filtered queries (status/risk-band/source for the Inbox list) and real transactions (approve must atomically flip `status`+`decidedAt` before calling `applyChanges` — see §5) |
| ndjson (append-only file) | REJECTED | No filters — every `GET /inbox?status=pending` scan becomes a full-file parse; no transactions — the approve path needs an atomic pre/post-apply marker (ADR-024 §4 pattern) that ndjson can't give without hand-rolling a second WAL |
| Postgres | REJECTED | Kills the local-first invariant (master-spec §5); adds an external server dependency the Electron packaging (ADR program §5.8) has no story for; wrong footprint for a single-operator desktop tool |

`agent-runtime/db.mjs` opens `agent-runtime/data/mission.db` (`PRAGMA journal_mode=WAL`), mode `0600` (same posture as the `RUNTIME_TOKEN_DIR` file, `server.mjs:165`). `agent-runtime/data/` added to `.gitignore` (existing entries: `agent-runtime/threads/`, `agent-runtime/engine-store/` — this follows the same pattern).

### 2. Schema — `deliveries` + `events_log` + `schema_migrations`

`events_log` exists here because ADR-052 needs it for SSE replay — one migration set, one file, no second schema owner.

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  appliedAt  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id             TEXT PRIMARY KEY,            -- ULID (see §6)
  agentId        TEXT NOT NULL,
  taskId         TEXT,                        -- nullable; queue linkage (ADR-027)
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,                -- scrubbed before INSERT (§7)
  source         TEXT NOT NULL CHECK (source IN ('swarm','claude-code','github-pr','external')),
  kind           TEXT NOT NULL CHECK (kind IN ('code','doc','post','command')),
  diffFiles      INTEGER NOT NULL DEFAULT 0,
  diffAdditions  INTEGER NOT NULL DEFAULT 0,
  diffDeletions  INTEGER NOT NULL DEFAULT 0,
  changedPaths   TEXT NOT NULL DEFAULT '[]',   -- JSON array of relPaths; patch bodies live on disk (§3)
  riskScore      INTEGER,                       -- NULL until ADR-053 (P6)
  riskBand       TEXT CHECK (riskBand IN ('low','medium','high')),
  riskReasons    TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','changes_requested','expired','auto_approved')),
  slaDeadline    TEXT,                          -- ISO; NULL until ADR-053
  createdAt      TEXT NOT NULL,
  decidedAt      TEXT,
  decidedBy      TEXT,
  feedback       TEXT,
  auditRef       TEXT NOT NULL                 -- AUDIT.log line id (factory.audit, cockpit-feeds.mjs)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_status   ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_agent    ON deliveries(agentId);
CREATE INDEX IF NOT EXISTS idx_deliveries_created  ON deliveries(createdAt);

CREATE TABLE IF NOT EXISTS events_log (           -- ADR-052 Last-Event-ID replay backing
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,
  data       TEXT NOT NULL,                        -- JSON, scrubbed (§7)
  createdAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events_log(createdAt);
```

`riskScore`/`riskBand`/`slaDeadline` are nullable now and populated by ADR-053 — no migration needed when P6 lands, only a write-path change.

### 3. Patches on disk, not in the DB — `data/patches/<id>/`

`changedPaths` in the row is a small JSON array (paths only). The actual patch content is written to `agent-runtime/data/patches/<id>/<relPath>.patch`, mirroring the existing convention of keeping large content out of small state records (`engine-store` keeps run history small; sandbox content lives on disk, never inlined). `id` is a server-minted ULID (never user input, §6) so the directory name carries no path-traversal surface — `db.mjs` still resolves+realpath-contains under `data/patches/` defensively, matching `guards.mjs`'s `REPO_ROOT` containment posture. Perms `0600`/`0700`.

### 4. Mint point — `/run` completion, reusing the F2b `/changes` walk

`deliveries.mint()` is called from the SAME place ADR-024's engine already calls `listChanges` — the `DIFFED→GATING` transition (ADR-024 §2 table). No new diff logic: `deliveries.mjs` imports `listChanges` from `broker.mjs` (already exported, ADR-024 §1 REUSED list) and mints the row from its result, BEFORE the ADR-029 policy check runs, so `riskBand` (P6) can attach to an already-minted Delivery without a second mint path. For non-engine ad-hoc `/run`+manual `/changes` flows (if any survive), mint happens on first `GET /changes` returning non-empty for a taskId not yet minted — same function, same guard against double-mint (`UNIQUE`-by-construction since `id` is generated once per taskId and `taskId` is looked up before insert).

### 5. Verbs — approve / reject / request_changes

| Verb | DB effect | Side effect |
|---|---|---|
| **approve** | transaction: `status→'approved'`, `decidedAt`/`decidedBy` set | THEN calls the SAME `applyChanges` (broker, unchanged — ADR-024's invariant "APPLIED reachable only via applyChanges" holds) → on success, `reportBack()` (existing, unchanged) |
| **reject** | `status→'rejected'`, `decidedAt`/`decidedBy`/`feedback` set | sandbox/worktree discarded (reuses ADR-026 cleanup / ADR-024 `CANCELLED` transition); **no repo write** |
| **request_changes** | `status→'changes_requested'`, `feedback` stored | `feedback` text becomes the agent's next task: enqueues a new step for the SAME agent via the engine's existing chaining (ADR-024 §3, `chain.next`) — dispatched through the existing `/run` route per ADR-024 §6's preferred wiring, never a second dispatch path |

Crash mid-approve is handled the same way ADR-024 §4 already handles mid-apply: a pre-apply DB marker (`status='approved'`, applied-at-repo not yet confirmed) is written in the SAME transaction as the status flip; on restart, `engine.reconcile()` (already runs at boot, `server.mjs`) is extended to also sweep `approved` rows whose repo diff has already converged to empty (apply landed) vs. still present (safe to re-call `applyChanges` — deterministic content copy, ADR-024 §4). One reconcile sweep, not two.

### 6. ID scheme — ULID

Existing internal ids (`task_<hex>`, `goal_<hex>` — `queue.mjs`, `engine.mjs`, `randomBytes(6).toString("hex")`) stay unchanged; this ADR does not rename them. `Delivery.id` uses **ULID** instead, because Deliveries are user/audit-facing: they sort lexicographically by creation time in the Inbox list with no separate `ORDER BY createdAt` requirement, they appear in URLs (`/inbox/:id`) and P8 audit exports, and a monotonic-but-opaque id avoids the enumerable-counter feel of an autoincrement PK in an operator-visible surface.

### 7. Egress scrub — every payload, every path

`summary`, `feedback`, and any diff content ever serialized to a client (`GET /inbox`, `GET /inbox/:id`, exports) pass through the SAME `scrub()`/`SECRET_RE` already used for chat/audit egress (`server.mjs:426-438`). `deliveries.mjs` imports the shared scrub function — it does not fork a second implementation.

### 8. Interaction with the EXISTING engine/queue counters — extend, never rebuild

`deliveries.mjs` is a NEW module beside `engine.mjs`/`queue.mjs`/`policy.mjs` — it does not wrap or replace the engine's state machine. It observes the SAME transition points `reportBack()` already observes today. `GET /runtime/health`'s existing `engine: {...}` block gains an additive sibling key, e.g. `deliveries: db.counts()` — the `engine`/`queue` keys are untouched.

### 9. Failure-delivery concept (P4 hook — not implemented here)

Master-spec M2: "failed run → classified error → one auto-retry → then a **failure Delivery** ('agent stuck — needs you')." `self-heal.mjs` (ADR-028, already exists) will call `deliveries.mint()` with a diff-less row (`changedPaths: []`, `diffFiles/Additions/Deletions: 0`) once retry is exhausted. No schema change needed at P4 — the columns above already tolerate an empty diff. Documented here as a reserved hook; P2 does not wire `self-heal.mjs` to `deliveries.mjs`.

## Security invariants

| Invariant | Enforcement |
|---|---|
| All mutating routes (`approve`/`reject`/`request-changes`) gated | Same `needsAuth` set as `/apply` today (`tokenOk`+`originOk`+`hostOk`, `server.mjs:1383-1389`) — no new auth mechanism introduced |
| Egress never leaks secrets | Every payload through the shared `scrub()` (§7) before serialization |
| Deny-list "always-human" override | **RESERVED for ADR-053 (P6).** This ADR never writes `status='auto_approved'` — the engine only ever produces `pending` or an operator-driven terminal status. Writing that value is BLOCKED until ADR-053 ships with its own security sign-off |
| Patch/db file perms | `mission.db` and `data/patches/**` mode `0600`/`0700`; `agent-runtime/data/` gitignored |
| No repo write outside the broker | `approved` status alone does nothing — only the subsequent `applyChanges` call writes the repo, unchanged from ADR-024 |

## Consequences

**Positive** — one queryable Delivery store backs the Inbox, decisions, and P8 audit export without touching the proven engine/broker; patches stay off the hot DB path; ULID gives free time-ordering for a user-facing id.

**Negative / accepted** — a second persistence technology (`better-sqlite3`) enters the runtime alongside the file-based `engine-store`; WAL mode requires the same care around Electron packaging (native module rebuild, tracked in program plan §5.8) that `xlsx`/other native deps already need.

## Alternatives rejected

1. **Reimplement diff/apply inside `deliveries.mjs`** — same rejection as ADR-024 alt #1: duplicates the security-critical broker. No.
2. **Store patch bodies in the DB** — bloats WAL, slows every `GET /inbox` list query for content nobody asked for yet. Patches stay on disk (§3).
3. **Autoincrement integer PK for Delivery.id** — cheap but leaks operational volume (enumerable, guessable neighbors) to anyone with `/inbox/:id` access. ULID chosen (§6).
4. **Second reconcile sweep for approve-crash-recovery, separate from `engine.reconcile()`** — two recovery code paths to keep correct forever. Extends the existing one instead (§5).

## Open questions

- **OQ-051.1 (P4 owner):** does a `request_changes` feedback step attach to the SAME `goalId` as a chain continuation, or start a fresh goal? Affects P4's auto-chain semantics — deferred to that phase's `sp-writing-plans` task doc.

## As-built (2026-07-30)

Shipped in **P2** essentially as proposed, then extended across four later phases. Modules live: `agent-runtime/db.mjs` (better-sqlite3, `PRAGMA journal_mode=WAL`, `mission.db` mode `0600`, migrations table), `agent-runtime/deliveries.mjs` (`mint`/`list`/`get`/`decide`/feedback; patch bodies under `data/patches/<id>/`), and the `deliveries` + `events_log` + `schema_migrations` schema of §2. Mint hooks the same F2b `/changes` diff walk; approve routes through the unchanged broker `applyChanges` → `reportBack`; egress runs the shared `scrub()`. Tests: `agent-runtime/test/db.test.mjs`, `deliveries.test.mjs`, `inbox-http.test.mjs`, `deliveries-external.test.mjs` (part of the 411 runtime tests green at P2 exit).

**Security (P2):** senior-security-engineer returned **NEEDS-FIX (2 HIGH)**; all 8 fixes + 12 tests landed with RED-proof, and live PoC probes (`/inbox/%`, malformed id, unauth) returned 404/400/401 with the runtime alive. Re-signed SECURITY_APPROVED.

**Deviations / as-built vs proposal:**
- **`auto_approved` was write-blocked in P2** (Security invariants table: "BLOCKED until ADR-053 ships") and **unblocked in P6** when the risk router (`risk.mjs`) + per-band policy (`policy.mjs`) shipped. `riskScore`/`riskBand`/`riskReasons`/`slaDeadline` — nullable at P2 — are now populated at mint by the P6 classifier, exactly as §2's "no migration needed when P6 lands" predicted.
- **External sources added in P7.** The `source` CHECK already allowed `'claude-code'`/`'github-pr'`/`'external'`; `deliveries.mintExternal()` mints them and they can **never** auto-apply (`autoApprove` refuses `source !== 'swarm'`) — the external triple-gate documented in ADR-054.
- **Schema migrations extended the row, not replaced it:** P5 added `prUrl`/`mode`/`branch` (migration v3, PR ladder), P9 added `assignee` (advisory assignment). No table rebuilds.
- **Failure-Delivery hook (P4)** wired as reserved: `self-heal.mjs` mints a diff-less row on retry exhaustion — no schema change needed, as §9 anticipated.
- OQ-051.1 was resolved in P4's task doc (request-changes chains on the existing goal).

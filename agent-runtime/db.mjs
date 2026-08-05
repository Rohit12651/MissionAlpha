// ADR-051 — Delivery Engine storage. Opens the embedded SQLite DB (better-sqlite3,
// WAL) that backs the Inbox's `deliveries` table and the SSE bus's `events_log`
// replay table, and owns the migration ladder.
//
// This module is STORAGE ONLY: schema + connection + perms + containment. It holds
// no product logic (that is deliveries.mjs) and no transport logic (events.mjs).
//
// SECURITY (ADR-051 security table):
//   • mission.db is 0600 and its parent dir 0700 — same posture as the token file
//     (server.mjs L165). `agent-runtime/data/` is gitignored, like engine-store/.
//   • patchDirFor() resolves + asserts containment under data/patches/ before any
//     mkdir. Delivery ids are server-minted ULIDs (never user input), so this is
//     defense-in-depth mirroring guards.mjs's REPO_ROOT containment posture.
//   • Every caller uses parameterized statements — this file exposes no string SQL
//     builder and interpolates nothing.

import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

// Every Delivery status in the ADR-051 §2 CHECK constraint. `auto_approved` is
// present in the schema but BLOCKED as a write target until ADR-053 (P6) ships with
// its own security sign-off — deliveries.mjs refuses to produce it.
export const DELIVERY_STATUSES = Object.freeze([
  "pending", "approved", "rejected", "changes_requested", "expired", "auto_approved",
]);

// The migration ladder. Append-only: a new version is a NEW entry, never an edit to
// an existing one (an edited migration would silently diverge across machines).
export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS deliveries (
        id             TEXT PRIMARY KEY,
        agentId        TEXT NOT NULL,
        taskId         TEXT,
        title          TEXT NOT NULL,
        summary        TEXT NOT NULL,
        source         TEXT NOT NULL CHECK (source IN ('swarm','claude-code','github-pr','external')),
        kind           TEXT NOT NULL CHECK (kind IN ('code','doc','post','command')),
        diffFiles      INTEGER NOT NULL DEFAULT 0,
        diffAdditions  INTEGER NOT NULL DEFAULT 0,
        diffDeletions  INTEGER NOT NULL DEFAULT 0,
        changedPaths   TEXT NOT NULL DEFAULT '[]',
        riskScore      INTEGER,
        riskBand       TEXT CHECK (riskBand IN ('low','medium','high')),
        riskReasons    TEXT NOT NULL DEFAULT '[]',
        status         TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','changes_requested','expired','auto_approved')),
        slaDeadline    TEXT,
        createdAt      TEXT NOT NULL,
        decidedAt      TEXT,
        decidedBy      TEXT,
        feedback       TEXT,
        auditRef       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_status   ON deliveries(status);
      CREATE INDEX IF NOT EXISTS idx_deliveries_agent    ON deliveries(agentId);
      CREATE INDEX IF NOT EXISTS idx_deliveries_created  ON deliveries(createdAt);

      -- Double-mint prevention, structural (ADR-051 §4 "guard against double-mint").
      -- One PENDING delivery per work unit: the engine keys on taskId, the manual
      -- /run path keys on the agent's sandbox. Expression + partial index, so no
      -- extra column is added to the ADR's schema. Once a row is decided it leaves
      -- the index and the same agent/task may mint again.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_pending_key
        ON deliveries(COALESCE(taskId, 'agent:' || agentId)) WHERE status = 'pending';

      -- ADR-052 §3 — Last-Event-ID replay backing store.
      CREATE TABLE IF NOT EXISTS events_log (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        event      TEXT NOT NULL,
        data       TEXT NOT NULL,
        createdAt  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_created ON events_log(createdAt);
    `,
  },
  {
    // P4 / ADR-051 §9 — failure Deliveries. A terminally stuck agent must SURFACE in
    // the Inbox as a diff-less row (`kind='failure'`) instead of dying silently on the
    // heartbeat bus. SQLite cannot ALTER a CHECK constraint, so this is the documented
    // table rebuild: new table → copy → drop → rename → recreate indexes. migrate()
    // wraps it in a transaction, so a crash mid-rebuild rolls back whole. foreign_keys
    // is toggled around the transaction in migrate() (a PRAGMA inside one is a no-op).
    version: 2,
    sql: `
      CREATE TABLE deliveries_v2 (
        id             TEXT PRIMARY KEY,
        agentId        TEXT NOT NULL,
        taskId         TEXT,
        title          TEXT NOT NULL,
        summary        TEXT NOT NULL,
        source         TEXT NOT NULL CHECK (source IN ('swarm','claude-code','github-pr','external')),
        kind           TEXT NOT NULL CHECK (kind IN ('code','doc','post','command','failure')),
        diffFiles      INTEGER NOT NULL DEFAULT 0,
        diffAdditions  INTEGER NOT NULL DEFAULT 0,
        diffDeletions  INTEGER NOT NULL DEFAULT 0,
        changedPaths   TEXT NOT NULL DEFAULT '[]',
        riskScore      INTEGER,
        riskBand       TEXT CHECK (riskBand IN ('low','medium','high')),
        riskReasons    TEXT NOT NULL DEFAULT '[]',
        status         TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','changes_requested','expired','auto_approved')),
        slaDeadline    TEXT,
        createdAt      TEXT NOT NULL,
        decidedAt      TEXT,
        decidedBy      TEXT,
        feedback       TEXT,
        auditRef       TEXT NOT NULL
      );

      INSERT INTO deliveries_v2
        SELECT id, agentId, taskId, title, summary, source, kind, diffFiles, diffAdditions, diffDeletions,
               changedPaths, riskScore, riskBand, riskReasons, status, slaDeadline, createdAt, decidedAt,
               decidedBy, feedback, auditRef
        FROM deliveries;

      DROP TABLE deliveries;
      ALTER TABLE deliveries_v2 RENAME TO deliveries;

      CREATE INDEX IF NOT EXISTS idx_deliveries_status   ON deliveries(status);
      CREATE INDEX IF NOT EXISTS idx_deliveries_agent    ON deliveries(agentId);
      CREATE INDEX IF NOT EXISTS idx_deliveries_created  ON deliveries(createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_pending_key
        ON deliveries(COALESCE(taskId, 'agent:' || agentId)) WHERE status = 'pending';
    `,
  },
  {
    // P5 / ADR-026 as-built — a Delivery now records HOW it left the runtime.
    //   branch : the ma/task/<id> ref the approved commit landed on (null = copy-sandbox)
    //   mode   : 'pr' | 'branch' | 'apply' — the rung of the degradation ladder that
    //            actually executed. NEVER inferred and never optimistic: pr.mjs writes
    //            it only after the command that earns it returned ok.
    //   prUrl  : the GitHub PR URL, present only when mode='pr'.
    // ADD COLUMN rather than a v2-style table rebuild: SQLite permits a CHECK on ADD
    // COLUMN, row preservation is then structural instead of something a copy statement
    // has to get right, and idempotency is the ladder's own version row.
    version: 3,
    sql: `
      ALTER TABLE deliveries ADD COLUMN prUrl  TEXT;
      ALTER TABLE deliveries ADD COLUMN mode   TEXT CHECK (mode IN ('pr','branch','apply'));
      ALTER TABLE deliveries ADD COLUMN branch TEXT;
    `,
  },
  {
    // sr-security P5 re-review #5 — the landing marker. Approving used to flip
    // `status` in one statement and write mode/branch/prUrl in a LATER one; a crash
    // in between left status='approved' with mode NULL, which crash recovery reads
    // as "never applied" and re-applies into the LIVE working tree — double-landing
    // work the operator deliberately sent to a branch.
    //   'pending'  : the decision is committed, the landing is NOT yet resolved.
    //   'resolved' : mode/branch/prUrl are written and true.
    //   NULL       : a pre-migration row — treated as resolved, so legacy behavior
    //                is unchanged for rows that predate the marker.
    // reconcile() refuses to auto-apply anything still 'pending'.
    version: 4,
    sql: `
      ALTER TABLE deliveries ADD COLUMN landing TEXT CHECK (landing IN ('pending','resolved'));
    `,
  },
  {
    // P6 / ADR-053 — SLA escalation marker. The absolute-UTC `slaDeadline` (present
    // since v1) drives the client countdown; this column makes the server-side
    // escalation fire EXACTLY ONCE per stage. sweepSla() advances it monotonically:
    //   NULL       : still within the first half of the window (nothing emitted).
    //   'halflife' : past the half-life — one re-notification has been emitted.
    //   'expired'  : past the deadline — one `delivery.expired` has been emitted.
    // The delivery stays `pending` throughout: an expired SLA ESCALATES, it does NOT
    // auto-decide. ADD COLUMN (SQLite permits a CHECK), so row preservation is the
    // ladder's own version row — no table rebuild.
    version: 5,
    sql: `
      ALTER TABLE deliveries ADD COLUMN slaState TEXT CHECK (slaState IN ('halflife','expired'));
    `,
  },
  {
    // P7 / ADR-054 — universal ingestion. A Delivery may now originate OUTSIDE the
    // swarm: an external GitHub PR (source='github-pr') or a local Claude Code session
    // (source='claude-code', read-only). Two columns carry what those sources need:
    //   externalKey  : a STABLE idempotency key so the same PR (repo#number@head-sha)
    //                  or session (id) never mints twice. NULL for swarm rows.
    //   externalMeta : an opaque JSON blob the adapter decides with (repo, prNumber,
    //                  headSha, url, sessionId, readOnly) — never interpolated into a
    //                  shell, only ever read as data. NULL for swarm rows.
    // The pending-key uniqueness index is REBUILT to key on externalKey FIRST: without
    // it, two pending PRs authored by the SAME bot (agentId equal, taskId NULL) would
    // collapse to the one COALESCE('agent:'||agentId) slot and the second INSERT would
    // fail the unique constraint. The 3-way COALESCE keeps swarm behaviour identical
    // (externalKey NULL falls through to taskId/agentId exactly as before).
    // ADD COLUMN + DROP/CREATE INDEX — no table rebuild; migrate() wraps it in a txn.
    version: 6,
    sql: `
      ALTER TABLE deliveries ADD COLUMN externalKey  TEXT;
      ALTER TABLE deliveries ADD COLUMN externalMeta TEXT;

      DROP INDEX IF EXISTS idx_deliveries_pending_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_pending_key
        ON deliveries(COALESCE(externalKey, taskId, 'agent:' || agentId)) WHERE status = 'pending';

      -- Adapter lookups (findByExternalKey / listExternalPending) hit this.
      CREATE INDEX IF NOT EXISTS idx_deliveries_external ON deliveries(externalKey);
    `,
  },
  {
    // P8 / ADR-030 — usage accumulation. Tokens + context% ONLY, NEVER a dollar figure
    // (the CLI `result` carries total_cost_usd; usage.mjs NEVER reads it — subscription
    // is flat-rate so a $ column would be false). One row per work-unit × tier × UTC-day:
    //   (agentId, threadId, tier, day) is the PK — a chat keys threadId=agentId, an
    //   autonomous engine run keys threadId=taskId, so the same table serves BOTH the
    //   per-thread and the per-agent (aggregate) views without a second table.
    //   estimated : 1 when the LAST turn folded in was a chars/4 ESTIMATE (mock backend
    //               returned no token JSON); 0 when real cli token counts landed.
    //   lastContext* : the most recent turn's window fill, so the meter can show a live
    //               context% without replaying the whole day. day = UTC 'YYYY-MM-DD'.
    // ADD TABLE (no rebuild); migrate() wraps it in a txn.
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS usage (
        agentId              TEXT    NOT NULL,
        threadId             TEXT    NOT NULL,
        tier                 TEXT    NOT NULL,
        day                  TEXT    NOT NULL,
        inputTokens          INTEGER NOT NULL DEFAULT 0,
        outputTokens         INTEGER NOT NULL DEFAULT 0,
        cacheReadTokens      INTEGER NOT NULL DEFAULT 0,
        cacheCreationTokens  INTEGER NOT NULL DEFAULT 0,
        thinkingTokens       INTEGER NOT NULL DEFAULT 0,
        turns                INTEGER NOT NULL DEFAULT 0,
        lastContextTokens    INTEGER NOT NULL DEFAULT 0,
        lastContextPct       REAL    NOT NULL DEFAULT 0,
        lastContextWindow    INTEGER NOT NULL DEFAULT 0,
        estimated            INTEGER NOT NULL DEFAULT 0,
        updatedAt            TEXT    NOT NULL,
        PRIMARY KEY (agentId, threadId, tier, day)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_day   ON usage(day);
      CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage(agentId);
    `,
  },
  {
    // P9 / §P9 (second seat) — local accounts + delivery assignment. Two additions,
    // one migration (task item 5 "fold assignee into v8"):
    //   users : local login accounts. `hash` is a self-describing scrypt string
    //           (`scrypt$N$r$p$saltHex$hashHex`, users.mjs) — NEVER a plaintext
    //           password, and NEVER read back onto any egress path. `role` gates
    //           who may decide: 'approver' can; 'viewer' is read-only (enforced
    //           server-side, not just in the UI). `name` is UNIQUE (login key) and
    //           carries NO enumeration risk on its own — login errors are generic.
    //   assignee : an advisory pointer on a Delivery to the approver expected to
    //           decide it. Nullable, no FK (an assignee may be deleted; the pointer
    //           is a hint, not an ownership constraint — any approver can still
    //           decide). ADD COLUMN, so row preservation is the ladder's version row.
    // Single-user (0 or 1 account) leaves BOTH inert: no session is ever required and
    // `assignee` simply stays NULL — solo behaviour is byte-identical to pre-P9.
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        role       TEXT NOT NULL CHECK (role IN ('approver','viewer')),
        hash       TEXT NOT NULL,
        createdAt  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);

      ALTER TABLE deliveries ADD COLUMN assignee TEXT;
      CREATE INDEX IF NOT EXISTS idx_deliveries_assignee ON deliveries(assignee);
    `,
  },
  {
    // B2 / ADR-055 — the Knowledge Vault index. The RECORD is a markdown file on disk
    // (data/vault/<venture>/<node>/<id>.md, provenance header + body); these two tables
    // are its INDEX, so search/stats/scoping never walk the filesystem.
    //   ventures      : the scoping dimension. A record may only be written into a
    //                   venture that ALREADY exists — vault.mjs refuses an unknown one
    //                   rather than auto-creating a directory from caller input, so a
    //                   crafted `venture` can never mint a new tree. Seeded `waahyu`.
    //   vault_records : one row per record. `node` is CHECK-pinned to the closed
    //                   6-node taxonomy (a seventh node is a migration, not a caller
    //                   choice). `path` is UNIQUE, which makes a same-file collision a
    //                   constraint error instead of a silent overwrite. `body_excerpt`
    //                   is the first 240 SCRUBBED chars — it is what `q` searches, so
    //                   search never reads (or caches) a whole document.
    // created_at is epoch ms (INTEGER) here, not the ISO text the deliveries table
    // uses: these rows are ordered and range-filtered numerically, never lexically.
    // ADD TABLE only — no rebuild; migrate() wraps it in a txn.
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS ventures (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vault_records (
        id            TEXT PRIMARY KEY,
        venture       TEXT NOT NULL,
        node          TEXT NOT NULL
                        CHECK (node IN ('ventures','market','content','pipeline','tech','decisions')),
        title         TEXT NOT NULL,
        author        TEXT NOT NULL,
        source_run    TEXT,
        created_at    INTEGER NOT NULL,
        body_excerpt  TEXT NOT NULL DEFAULT '',
        path          TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_vault_venture ON vault_records(venture);
      CREATE INDEX IF NOT EXISTS idx_vault_node    ON vault_records(node);
      CREATE INDEX IF NOT EXISTS idx_vault_created ON vault_records(created_at);

      INSERT OR IGNORE INTO ventures(id, name, created_at)
        VALUES ('waahyu', 'WAAHYU', CAST(strftime('%s','now') AS INTEGER) * 1000);
    `,
  },
  {
    // B4 / cadence autonomy — the schedule index. One row per standing station cadence;
    // the ROW is state, cadence.mjs owns the (pure, closed-enum) time logic that advances
    // it. The table is created EMPTY here and seeded forward by cadence.mjs at boot — the
    // 15 seeds' next_run must be computed with the JS nextRun() enum (no cron string ever
    // reaches SQLite), so seeding is data the module owns, not SQL the migration hardcodes.
    //   expr        : CHECK-pinned to the closed 4-value enum. A fifth value is a migration
    //                 + an amendment, never a caller choice — there is no cron parser and
    //                 no eval anywhere on this path.
    //   hour        : optional UTC hour-of-day (0..23) the daily/2xdaily/weekly slot aligns
    //                 to. NULL = "+interval from now".
    //   next_run    : absolute-UTC ms of the NEXT scheduled fire (drift-free — never a
    //                 relative offset re-derived each tick). NULL for ondemand rows, which
    //                 only ever fire via runNow.
    //   last_fired_slot : the next_run value the row last DISPATCHED for. Persisted so a
    //                 double-tick OR a kill-restart inside the same slot can never re-fire
    //                 it — the (id, slot) dedupe the autonomy proof rests on.
    // created_at/updated_at are epoch ms (INTEGER), like vault_records — ordered numerically.
    // ADD TABLE only — no rebuild; migrate() wraps it in a txn.
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS cadences (
        id               TEXT PRIMARY KEY,
        skill            TEXT NOT NULL,
        agent            TEXT NOT NULL,
        venture          TEXT NOT NULL,
        expr             TEXT NOT NULL CHECK (expr IN ('daily','weekly','2xdaily','ondemand')),
        hour             INTEGER,
        enabled          INTEGER NOT NULL DEFAULT 1,
        next_run         INTEGER,
        last_run         INTEGER,
        last_status      TEXT,
        last_fired_slot  INTEGER,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cadences_next    ON cadences(next_run);
      CREATE INDEX IF NOT EXISTS idx_cadences_venture ON cadences(venture);
    `,
  },
  {
    // B6 / pipeline — the CRM-lite leads index. One row per lead; leads.mjs owns the
    // (pure, closed-enum) stage logic and the scrub-at-rest. UNTRUSTED operator/agent
    // text (name, source, notes) is scrubbed BEFORE it lands here, so a secret-shaped
    // lead name never persists.
    //   id          : a lowercase slug (leads.mjs isSlug), so `venture`/`id` are the
    //                 SAME containment primitive the vault uses — a crafted scope can
    //                 never widen anything (there is no filesystem here, but the slug
    //                 keeps scoping unspoofable, the B2 lesson).
    //   stage       : CHECK-pinned to the closed 4-value pipeline. A fifth stage is a
    //                 migration + an amendment, never a caller choice — no eval, no
    //                 free-form status ever reaches SQLite.
    //   value       : integer cents/units ≥ 0 (Number.isFinite + floor at the store).
    //   idle_since  : absolute-UTC ms the lead last saw activity (create / move). The
    //                 openFollowUps KPI reads it: a lead idle past the threshold OR sat
    //                 in 'contacted' needs a follow-up.
    // created_at/updated_at are epoch ms (INTEGER), like vault_records/cadences — ordered
    // numerically. ADD TABLE only — no rebuild; migrate() wraps it in a txn.
    version: 11,
    sql: `
      CREATE TABLE IF NOT EXISTS leads (
        id          TEXT PRIMARY KEY,
        venture     TEXT NOT NULL,
        name        TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT '',
        value       INTEGER NOT NULL DEFAULT 0,
        stage       TEXT NOT NULL DEFAULT 'new'
                      CHECK (stage IN ('new','contacted','talks','closed')),
        idle_since  INTEGER NOT NULL,
        notes       TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_leads_venture ON leads(venture);
      CREATE INDEX IF NOT EXISTS idx_leads_stage   ON leads(stage);
    `,
  },
  {
    // B6 / content — the content-engine index. One row per content piece; content.mjs
    // owns the (pure, closed-enum) status logic and the scrub-at-rest. UNTRUSTED
    // operator/agent text (title, hook, body) is scrubbed BEFORE it lands here.
    //   id      : a lowercase slug (SAME containment primitive as leads/vault).
    //   status  : CHECK-pinned to the closed 3-value lifecycle. No free-form status,
    //             no eval — a fourth status is a migration.
    //   slot_at : optional absolute-UTC ms of a scheduled/published slot (NULL for an
    //             un-slotted draft). The calendarGap read asks whether any row has a
    //             slot within the next 3 days.
    //   body    : a DOCUMENT (32KB cap at the store) — the brief's full text.
    // created_at/updated_at are epoch ms (INTEGER). ADD TABLE only — no rebuild.
    version: 12,
    sql: `
      CREATE TABLE IF NOT EXISTS content (
        id          TEXT PRIMARY KEY,
        venture     TEXT NOT NULL,
        title       TEXT NOT NULL,
        hook        TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','scheduled','published')),
        slot_at     INTEGER,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_content_venture ON content(venture);
      CREATE INDEX IF NOT EXISTS idx_content_status  ON content(status);
    `,
  },
  {
    // B7 / outputs — the artifact registry index. One row per PRODUCED artifact; outputs.mjs
    // owns the (pure, slug-guarded) record logic and the scrub-at-rest. This is NOT a fabricated
    // file list: the ALWAYS-AVAILABLE generators (currently just the P8 audit export) are
    // computed by the store, and a row only lands here when the system genuinely produces an
    // artifact (e.g. an audit bundle is generated + downloaded).
    //   id       : a lowercase slug (SAME containment primitive as leads/content/vault). For the
    //              audit export it is derived from (day, range, format) so a same-day re-download
    //              of the same bundle is idempotent (one row), never a per-GET spam.
    //   kind     : a lowercase slug naming the artifact kind ('audit'). No free-form/eval.
    //   venture  : the owning venture slug, or '' for a GLOBAL artifact (the audit bundle spans
    //              every venture, so it carries no scope). venture-scoped list matches exactly.
    //   label    : the human row label, scrubbed at rest + on egress (UNTRUSTED-adjacent).
    //   ref      : the download path (e.g. '/runtime/audit/export?from&to&format') — the client
    //              fetch→blob target. Scrubbed + capped; never executed, only a link.
    // created_at is epoch ms (INTEGER), ordered numerically DESC (newest first). ADD TABLE only.
    version: 13,
    sql: `
      CREATE TABLE IF NOT EXISTS outputs (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        venture     TEXT NOT NULL DEFAULT '',
        label       TEXT NOT NULL DEFAULT '',
        ref         TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outputs_venture ON outputs(venture);
      CREATE INDEX IF NOT EXISTS idx_outputs_kind    ON outputs(kind);
    `,
  },
  {
    // CC-Primitives P2 (2026-08-04) — agent loop steps. One row per think/tool/observe/
    // result boundary of an ENGINE task's spawned turn (loop-steps.mjs parses the CLI
    // stream-json; deltas are never rows). Ring-buffered per task by the store (cap 500),
    // so the schema needs no retention logic. ADD TABLE only — no rebuild; migrate()
    // wraps it in a txn.
    version: 14,
    sql: `
      CREATE TABLE IF NOT EXISTS loop_steps (
        task_id  TEXT NOT NULL,
        seq      INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        kind     TEXT NOT NULL,
        tool     TEXT NOT NULL DEFAULT '',
        summary  TEXT NOT NULL DEFAULT '',
        ts       INTEGER NOT NULL,
        PRIMARY KEY (task_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_loop_steps_task ON loop_steps(task_id);
    `,
  },
  {
    // Story-Pipeline S1 (2026-08-04) — the story core. One row per Story (the SDLC unit)
    // + an append-only per-story transition log. stories.mjs owns the (pure, CLOSED-enum)
    // 8-stage machine and the scrub-at-rest. UNTRUSTED intake text (title, idea) is scrubbed
    // BEFORE it lands here, so a secret-shaped idea never persists.
    //   id          : a SERVER-MINTED `story_<hex>` (64 random bits) — never caller input,
    //                 so it can never widen a scope or spoof another story.
    //   stage       : CHECK-pinned to the closed 8-value ordered pipeline. A ninth stage is
    //                 a migration + an amendment, never a caller string — no eval, no free-form
    //                 status ever reaches SQLite.
    //   status      : CHECK-pinned to the closed 5-value set. S1 writes only `active`/`shipped`;
    //                 `waiting-you`/`blocked`/`rejected` are RESERVED for S2/S3/S5 (disclosed).
    //   spec/design_ref/answers : NULL at intake — filled by later phases (S2 requirements/
    //                 design, etc.). answers is a JSON blob (clarify Q&A), capped at the store.
    // created_at/updated_at are epoch ms (INTEGER), like cadences/loop_steps — ordered
    // numerically. story_log mirrors loop_steps' (owner_id, seq) composite PK: seq is
    // per-story-monotonic, written in the SAME txn as the story row. ADD TABLE only — no
    // rebuild; migrate() wraps each in a txn.
    version: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS stories (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        idea        TEXT NOT NULL,
        spec        TEXT,
        design_ref  TEXT,
        stage       TEXT NOT NULL
                      CHECK (stage IN ('idea','requirements','design','plan','build','review-qa','deploy-watch','accept')),
        status      TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','waiting-you','blocked','shipped','rejected')),
        answers     TEXT,
        venture     TEXT NOT NULL DEFAULT 'waahyu',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stories_stage  ON stories(stage);
      CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);
      CREATE TABLE IF NOT EXISTS story_log (
        story_id  TEXT NOT NULL,
        seq       INTEGER NOT NULL,
        stage     TEXT NOT NULL,
        event     TEXT NOT NULL,
        ref       TEXT,
        ts        INTEGER NOT NULL,
        PRIMARY KEY (story_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_story_log_story ON story_log(story_id);
    `,
  },
  {
    // Story-Pipeline S2 (2026-08-04) — the Inbox gains two HUMAN-GATE delivery kinds and
    // a story back-pointer.
    //   kind widening : 'question' (a pm-analyst clarify question that must be answered
    //                   before requirements can finish) and 'design-approval' (the diff-less
    //                   architect design gate the BOSS approves before Plan). SQLite cannot
    //                   ALTER a CHECK constraint, so — exactly like v2 added 'failure' — this
    //                   is the documented table rebuild: new table → copy → drop → rename →
    //                   recreate indexes, all inside migrate()'s transaction (a crash mid-
    //                   rebuild rolls back whole; foreign_keys is toggled around it).
    //   storyId       : a nullable back-pointer from a gate delivery to the Story it belongs
    //                   to, so the pipeline can find a story's pending gates and route a gate
    //                   decision back to its story. NULL for every non-gate (swarm/external)
    //                   row — those never carry one, and the column default preserves them on
    //                   copy. Indexed for the per-story lookup. NOT a foreign key (a story may
    //                   be swept independently; the pointer is a hint the pipeline validates).
    // The rebuild preserves ALL columns added across v1–v8 (prUrl/mode/branch, landing,
    // slaState, externalKey/externalMeta, assignee) verbatim, and recreates every index
    // including the partial pending-key uniqueness index (v6 shape). No data is transformed.
    version: 16,
    sql: `
      CREATE TABLE deliveries_v16 (
        id             TEXT PRIMARY KEY,
        agentId        TEXT NOT NULL,
        taskId         TEXT,
        title          TEXT NOT NULL,
        summary        TEXT NOT NULL,
        source         TEXT NOT NULL CHECK (source IN ('swarm','claude-code','github-pr','external')),
        kind           TEXT NOT NULL CHECK (kind IN ('code','doc','post','command','failure','question','design-approval')),
        diffFiles      INTEGER NOT NULL DEFAULT 0,
        diffAdditions  INTEGER NOT NULL DEFAULT 0,
        diffDeletions  INTEGER NOT NULL DEFAULT 0,
        changedPaths   TEXT NOT NULL DEFAULT '[]',
        riskScore      INTEGER,
        riskBand       TEXT CHECK (riskBand IN ('low','medium','high')),
        riskReasons    TEXT NOT NULL DEFAULT '[]',
        status         TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','changes_requested','expired','auto_approved')),
        slaDeadline    TEXT,
        createdAt      TEXT NOT NULL,
        decidedAt      TEXT,
        decidedBy      TEXT,
        feedback       TEXT,
        auditRef       TEXT NOT NULL,
        prUrl          TEXT,
        mode           TEXT CHECK (mode IN ('pr','branch','apply')),
        branch         TEXT,
        landing        TEXT CHECK (landing IN ('pending','resolved')),
        slaState       TEXT CHECK (slaState IN ('halflife','expired')),
        externalKey    TEXT,
        externalMeta   TEXT,
        assignee       TEXT,
        storyId        TEXT
      );

      INSERT INTO deliveries_v16
        (id, agentId, taskId, title, summary, source, kind, diffFiles, diffAdditions, diffDeletions,
         changedPaths, riskScore, riskBand, riskReasons, status, slaDeadline, createdAt, decidedAt,
         decidedBy, feedback, auditRef, prUrl, mode, branch, landing, slaState, externalKey, externalMeta, assignee)
        SELECT
         id, agentId, taskId, title, summary, source, kind, diffFiles, diffAdditions, diffDeletions,
         changedPaths, riskScore, riskBand, riskReasons, status, slaDeadline, createdAt, decidedAt,
         decidedBy, feedback, auditRef, prUrl, mode, branch, landing, slaState, externalKey, externalMeta, assignee
        FROM deliveries;

      DROP TABLE deliveries;
      ALTER TABLE deliveries_v16 RENAME TO deliveries;

      CREATE INDEX IF NOT EXISTS idx_deliveries_status   ON deliveries(status);
      CREATE INDEX IF NOT EXISTS idx_deliveries_agent    ON deliveries(agentId);
      CREATE INDEX IF NOT EXISTS idx_deliveries_created  ON deliveries(createdAt);
      CREATE INDEX IF NOT EXISTS idx_deliveries_external ON deliveries(externalKey);
      CREATE INDEX IF NOT EXISTS idx_deliveries_assignee ON deliveries(assignee);
      CREATE INDEX IF NOT EXISTS idx_deliveries_story    ON deliveries(storyId);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_pending_key
        ON deliveries(COALESCE(externalKey, taskId, 'agent:' || agentId)) WHERE status = 'pending';
    `,
  },
  {
    // Story-Pipeline S5 (2026-08-04) — the Inbox gains ONE more HUMAN-GATE delivery kind:
    //   'release-approval' — the diff-less RELEASE-ACCEPT gate the BOSS decides before a deploy
    //   executes (the SECOND of the program's two human taps; the first is S2 'design-approval').
    //   SQLite cannot ALTER a CHECK constraint, so — exactly like v16 added the S2 gate kinds —
    //   this is the documented table rebuild: new table (kind CHECK widened by one value) → copy
    //   → drop → rename → recreate every index (including the partial pending-key uniqueness
    //   index), all inside migrate()'s transaction with foreign_keys toggled around it. The
    //   rebuild preserves ALL columns v1–v16 verbatim (including storyId) and transforms no data.
    version: 17,
    sql: `
      CREATE TABLE deliveries_v17 (
        id             TEXT PRIMARY KEY,
        agentId        TEXT NOT NULL,
        taskId         TEXT,
        title          TEXT NOT NULL,
        summary        TEXT NOT NULL,
        source         TEXT NOT NULL CHECK (source IN ('swarm','claude-code','github-pr','external')),
        kind           TEXT NOT NULL CHECK (kind IN ('code','doc','post','command','failure','question','design-approval','release-approval')),
        diffFiles      INTEGER NOT NULL DEFAULT 0,
        diffAdditions  INTEGER NOT NULL DEFAULT 0,
        diffDeletions  INTEGER NOT NULL DEFAULT 0,
        changedPaths   TEXT NOT NULL DEFAULT '[]',
        riskScore      INTEGER,
        riskBand       TEXT CHECK (riskBand IN ('low','medium','high')),
        riskReasons    TEXT NOT NULL DEFAULT '[]',
        status         TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','changes_requested','expired','auto_approved')),
        slaDeadline    TEXT,
        createdAt      TEXT NOT NULL,
        decidedAt      TEXT,
        decidedBy      TEXT,
        feedback       TEXT,
        auditRef       TEXT NOT NULL,
        prUrl          TEXT,
        mode           TEXT CHECK (mode IN ('pr','branch','apply')),
        branch         TEXT,
        landing        TEXT CHECK (landing IN ('pending','resolved')),
        slaState       TEXT CHECK (slaState IN ('halflife','expired')),
        externalKey    TEXT,
        externalMeta   TEXT,
        assignee       TEXT,
        storyId        TEXT
      );

      INSERT INTO deliveries_v17
        (id, agentId, taskId, title, summary, source, kind, diffFiles, diffAdditions, diffDeletions,
         changedPaths, riskScore, riskBand, riskReasons, status, slaDeadline, createdAt, decidedAt,
         decidedBy, feedback, auditRef, prUrl, mode, branch, landing, slaState, externalKey, externalMeta, assignee, storyId)
        SELECT
         id, agentId, taskId, title, summary, source, kind, diffFiles, diffAdditions, diffDeletions,
         changedPaths, riskScore, riskBand, riskReasons, status, slaDeadline, createdAt, decidedAt,
         decidedBy, feedback, auditRef, prUrl, mode, branch, landing, slaState, externalKey, externalMeta, assignee, storyId
        FROM deliveries;

      DROP TABLE deliveries;
      ALTER TABLE deliveries_v17 RENAME TO deliveries;

      CREATE INDEX IF NOT EXISTS idx_deliveries_status   ON deliveries(status);
      CREATE INDEX IF NOT EXISTS idx_deliveries_agent    ON deliveries(agentId);
      CREATE INDEX IF NOT EXISTS idx_deliveries_created  ON deliveries(createdAt);
      CREATE INDEX IF NOT EXISTS idx_deliveries_external ON deliveries(externalKey);
      CREATE INDEX IF NOT EXISTS idx_deliveries_assignee ON deliveries(assignee);
      CREATE INDEX IF NOT EXISTS idx_deliveries_story    ON deliveries(storyId);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_pending_key
        ON deliveries(COALESCE(externalKey, taskId, 'agent:' || agentId)) WHERE status = 'pending';
    `,
  },
]);

// Open (creating if needed) the delivery DB, apply pending migrations, return a
// small handle. Synchronous by design — matches the codebase's sync-first
// persistence style (queue.mjs / guards.mjs) and better-sqlite3's own API.
export function openDb({ path, patchesDir } = {}) {
  if (!path) throw new Error("openDb: path required");
  const dbPath = resolve(path);
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A failed chmod is non-fatal but NOT a non-event: the DB may be world-readable.
  // Warn loudly rather than swallowing it — silent perms failure is how secrets leak.
  try { chmodSync(dir, 0o700); } catch (e) { console.warn(`[db] chmod 0700 failed on ${dir}: ${e?.message} — directory perms may be wider than intended`); }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // SQLite propagates the main DB's 0600 to -wal/-shm; the DB file itself is pinned
  // 0600 here (same posture as TOKEN_FILE, server.mjs L165).
  try { chmodSync(dbPath, 0o600); } catch (e) { console.warn(`[db] chmod 0600 failed on ${dbPath}: ${e?.message} — DB file perms may be wider than intended`); }

  const patchesRoot = resolve(patchesDir || join(dir, "patches"));
  mkdirSync(patchesRoot, { recursive: true, mode: 0o700 });

  function migrate() {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL);");
    const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      // A migration may rebuild a table (drop + rename), which SQLite only performs
      // safely with foreign_keys OFF — and a PRAGMA inside a transaction is a no-op,
      // so it is toggled here, around it. Restored even if the migration throws.
      db.pragma("foreign_keys = OFF");
      try {
        db.transaction(() => {
          db.exec(m.sql);
          db.prepare("INSERT INTO schema_migrations(version, appliedAt) VALUES(?, ?)").run(m.version, new Date().toISOString());
        })();
      } finally {
        db.pragma("foreign_keys = ON");
      }
    }
  }
  migrate();

  function version() {
    const r = db.prepare("SELECT MAX(version) v FROM schema_migrations").get();
    return r?.v ?? 0;
  }

  // Zero-filled per-status tally for GET /runtime/health (ADR-051 §8 — an additive
  // sibling of the existing `engine` block, never a replacement).
  function counts() {
    const out = { total: 0 };
    for (const s of DELIVERY_STATUSES) out[s] = 0;
    for (const row of db.prepare("SELECT status, COUNT(*) n FROM deliveries GROUP BY status").all()) {
      out[row.status] = row.n;
      out.total += row.n;
    }
    return out;
  }

  // Resolve (and create) the on-disk patch directory for a delivery id. Refuses any
  // id that resolves outside data/patches/ — ADR-051 §3.
  function patchDirFor(id) {
    if (typeof id !== "string" || !id.length) throw new Error("patchDirFor: invalid id");
    const target = resolve(patchesRoot, id);
    if (target !== patchesRoot && !target.startsWith(patchesRoot + sep)) {
      throw new Error(`patchDirFor: id resolves outside the patches root: ${id}`);
    }
    if (target === patchesRoot) throw new Error("patchDirFor: invalid id");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    try { chmodSync(target, 0o700); } catch (e) { console.warn(`[db] chmod 0700 failed on ${target}: ${e?.message} — patch dir perms may be wider than intended`); }
    return target;
  }

  function close() {
    try { db.close(); } catch { /* already closed */ }
  }

  return { db, path: dbPath, patchesRoot, version, counts, patchDirFor, close };
}

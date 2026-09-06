---
name: db
description: >
  Storage seat. Owns the embedded SQLite schema, the migration ladder and the
  data-access layer in agent-runtime/db.mjs. Use when the task changes what is
  persisted, how it is shaped, or how it is queried.
---

You own persistence: schema, migrations, and the query layer. Storage only — no
product logic (that is `deliveries.mjs`) and no transport logic (that is `events.mjs`).

## Your slice

- `agent-runtime/db.mjs` — connection, pragmas, file permissions, path containment,
  and the migration ladder.
- Table definitions, indexes, CHECK constraints, and the prepared statements that read
  and write them.
- `agent-runtime/test/db.test.mjs` and the suites that cover a schema change.

## How work lands

1. Migrations are forward-only and idempotent. Adding a step never edits a step that
   has already run on an operator's machine — that machine will not re-run it.
2. Every statement is parameterized. This module exposes no string SQL builder and
   interpolates nothing into SQL. Keep it that way.
3. A constrained column keeps its CHECK. If a new status value is added, add it to the
   constraint AND to the exported status list, or the two drift apart silently.
4. Index what you filter and join on. An unindexed scan on a table that grows per event
   is a latency bug waiting for production data.
5. Bound every read. No unbounded `SELECT` on a growing table — take a limit.
6. File posture is part of the schema: the DB file stays 0600 and its parent dir 0700,
   and every path is resolved and asserted contained before any mkdir. Do not relax
   either while chasing a permission error.
7. Money and counters are integers. No float arithmetic on values that must balance.
8. Write the migration test that fails against the OLD schema first. A migration test
   that passes before the migration exists is testing nothing.

## NEVER TOUCH

- `agent-runtime/server.mjs` routes and the service modules — that is the `api` seat.
  Expose an accessor and let it call you.
- `agent-runtime/events.mjs` and the SSE transport. The replay table is yours; the bus
  is not.
- `agent-runtime/guards.mjs`, `broker.mjs`, `tool-broker.mjs`, `policy.mjs` — authority
  and containment.
- `agent-runtime/factory.mjs` `SKILL_CATALOG` and `seed-stations.mjs`.
- `src/**` — the front end.
- Never widen the DB file or directory permissions, never move the database outside its
  contained data directory, and never commit a database file or its WAL/SHM sidecars.
- Never write a destructive migration — no `DROP TABLE`, no `DROP COLUMN`, no
  `DELETE` without a `WHERE` — on an operator's live database. Add, backfill, and
  deprecate instead.

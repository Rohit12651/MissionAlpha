# Embedded Postgres State Layer + Quota Guard + Multi-Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ⚠️ **DEFERRED post-S6 (2026-06-19).** Do NOT build this whole plan now — re-platforming the verified, file-based state layer is a poor trade today. **Build only the quota guard** (file-based, no DB) — shipped separately as `agent-runtime/quota-guard.mjs`. **Atomic task claim** → only when concurrent/multi-process workers actually land (single runtime process today = no race hit). **Full DB / multi-project / export-import / plugins** → only on a real multi-user or multi-project need, or after observing file-race bugs in practice. This doc stays as the blueprint for that day.

**Goal:** Replace MissionAlpha's file-based runtime state with a local, zero-install **embedded Postgres** database — adding a real atomic task claim, a Claude-subscription **quota guard**, **multi-project isolation**, **export/import with secret scrubbing**, and a **lightweight plugin loader** — without breaking the existing security model (auth token, host guard, secret scrubber, apply broker) or losing the human-readable `agent-status` trail.

**Architecture:** A new `agent-runtime/db/` layer boots an embedded Postgres binary on first run (data dir **outside** the repo, consistent with the existing runtime-token-outside-repo decision), applies raw-SQL migrations tracked in a `schema_migrations` table, and exposes a small `pg` connection pool. Each file-backed entity (tasks, goals, threads, policy, connections, creds, registry, audit) gets a **repository module** (`db/repo/*.mjs`) with the same read/write surface the callers already use, so `server.mjs` swaps file calls for repo calls with minimal churn. The DB becomes the **single source of truth**; `agent-status/*.md` becomes a **generated read-only view** rendered from the DB. Every row carries a `project_id` for tenant isolation. The task claim moves from file-lease to `SELECT … FOR UPDATE SKIP LOCKED`, satisfying the contract already written in `queue.mjs:11-12`.

**Tech Stack:** Node.js (ESM `.mjs`), `embedded-postgres` (bundled binary, zero-install), `pg` (node-postgres driver), raw SQL migrations, `node:test` (`node --test --test-concurrency=1`). No ORM, no TypeScript build step in the runtime — matches the existing plain-`.mjs`, no-framework style.

---

## Design Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| DB engine | Embedded Postgres (`embedded-postgres` npm) | Local, zero-install, **concurrent writes** for the agent swarm; SQLite serialises writers |

> 📌 **Footnote (2026-06-19, corrected):** If a real DB is ever needed, use **SQLite (`better-sqlite3`, WAL mode)** — single file, in-process, ACID, ~few MB — **NOT** embedded Postgres. This is a single-user local app: the embedded-PG "concurrent writers" argument doesn't apply (one human, one runtime process), and the bundled native PG binary + cluster boot cuts against "runs on any laptop." SQLite WAL gives concurrent reads + one writer, which is plenty here. Treat embedded Postgres in the table above as superseded by SQLite for this app.
| Driver | `pg` (node-postgres) | Plain, no build step; matches `.mjs` runtime |
| Migrations | Raw SQL files + tiny `migrate.mjs` runner | No ORM/TS; matches hand-rolled style |
| Data dir | `${MA_DB_DIR}` (default `~/.missionalpha/db`) — **outside repo** | Consistent with runtime-token-outside-repo security decision |
| Task claim | `SELECT … FOR UPDATE SKIP LOCKED` | Real atomic claim required by `queue.mjs:11-12`; kills multi-proc race |
| Cost model | **Quota guard** (request count + rate-limit window + 429 backoff), single Claude account, subscription | No API-token dollars; scarce resource is Claude quota |
| Tenancy | `project_id` UUID on every row; default project auto-seeded | Multi-project isolation without a big-bang rewrite |
| `agent-status/*.md` | Generated **read-only** from DB | Keep human/git trail; remove file-state races |
| Mobile | None | Explicitly out of scope |
| Plugins | Lightweight in-process module loader | Cheap extensibility now; defer out-of-process workers |

## Scope Check

This spec spans several independently-shippable subsystems. It is organised into **phases**, each of which produces working, testable software on its own:

- **Phase 0** — DB foundation (boot, migrate runner, pool, schema v1). *Ship: server boots an embedded PG, migrations apply, health check passes.*
- **Phase 1** — Vertical slice: Task queue → Postgres with atomic claim. *Ship: tasks persist + claim atomically; file store removed for tasks.*
- **Phase 2** — Migrate remaining JSON entities (goals, threads, policy, connections, creds, registry, audit).
- **Phase 3** — Quota guard (request log + pre-call gate + 429 backoff).
- **Phase 4** — Multi-project isolation (`project_id` threading + scoped queries).
- **Phase 5** — Export / import with secret scrubbing.
- **Phase 6** — Lightweight plugin loader.
- **Phase 7** — `agent-status/*.md` as generated read-only view.

Recommended execution order is Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Phases 0 and 1 are prerequisites for everything; Phases 3–6 are independent of each other once Phase 4 lands. If you prefer, Phases 5–7 can be split into their own plans.

---

## File Structure

New files (all under `agent-runtime/`):

```
db/
  pg.mjs               # boot embedded Postgres, expose pool + query helpers, graceful shutdown
  migrate.mjs          # apply ordered SQL migrations, track in schema_migrations
  migrations/
    0001_init.sql       # schema_migrations, projects, tasks, goals, threads
    0002_factory.sql    # policy, connections, mcp_creds, registry, audit_log
    0003_quota.sql       # request_log (quota guard)
    0004_plugins.sql     # plugins registry
  repo/
    tasks.mjs           # task queue repository (atomic claim)
    goals.mjs           # goal plans repository
    threads.mjs         # conversation threads repository
    policy.mjs          # auto-apply policy repository
    connections.mjs     # MCP connections repository
    creds.mjs           # MCP creds repository
    registry.mjs        # factory agent registry repository
    audit.mjs           # factory audit repository
    quota.mjs           # request log + window counter
    projects.mjs        # project CRUD + default-project seed
    plugins.mjs         # plugin registry repository
  test-helper.mjs       # withTestDb(): boot throwaway embedded PG in tmpdir, migrate, teardown
quota-guard.mjs         # pre-call gate + exponential backoff wrapper around the Anthropic client
plugin-loader.mjs       # discover + import in-process plugin modules at boot
export-import.mjs       # pack/unpack a project (with secret scrubbing) to/from a portable JSON bundle
status-render.mjs       # render agent-status/BROADCAST.md + per-agent .md from DB (read-only view)
```

Modified files:

- `agent-runtime/server.mjs` — boot the DB before listening; swap file reads/writes for repo calls; wire quota guard around Claude calls; add `/projects`, `/export`, `/import` endpoints; render status view on heartbeat.
- `agent-runtime/queue.mjs` — becomes a thin shim over `db/repo/tasks.mjs` (keep the public surface; delete file-lease internals). *Or* delete and update callers; see Task 1.7.
- `agent-runtime/engine.mjs` — goal persistence via `db/repo/goals.mjs`.
- `agent-runtime/usage.mjs` — unchanged math; consumed by quota guard.
- `agent-runtime/factory.mjs` — registry/connections/creds/audit via repos.
- `agent-runtime/policy.mjs` — load/persist via `db/repo/policy.mjs` (keep HMAC signing).
- `agent-runtime/package.json` — add `embedded-postgres`, `pg`; add `db:migrate` script.

---

## Prerequisites

- [ ] **Step 0: Confirm Node + install deps**

Run:
```bash
cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha/agent-runtime
node -v   # expect v20+ (repo runs fine on installed v25)
npm install embedded-postgres pg
```
Expected: both packages added to `agent-runtime/package.json` dependencies, `node_modules` populated, no errors.

> **Note on `embedded-postgres` API** (verify in Task 0.1's smoke test — do not trust from memory): constructor `new EmbeddedPostgres({ databaseDir, user, password, port, persistent })`; lifecycle `await pg.initialise()` (only when data dir is empty), `await pg.start()`, `await pg.createDatabase(name)`, `pg.getPgClient()`; shutdown `await pg.stop()`. If any name differs, the Task 0.1 smoke test will fail loudly and you fix the wrapper in `db/pg.mjs` — callers never see the difference.

---

## Phase 0 — DB Foundation

### Task 0.1: Embedded Postgres boot wrapper

**Files:**
- Create: `agent-runtime/db/pg.mjs`
- Test: `agent-runtime/test/db-pg.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// agent-runtime/test/db-pg.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootDb, getPool, stopDb } from "../db/pg.mjs";

const dir = mkdtempSync(join(tmpdir(), "ma-pg-"));
after(async () => { await stopDb(); rmSync(dir, { recursive: true, force: true }); });

test("bootDb starts embedded postgres and answers a query", async () => {
  await bootDb({ dataDir: dir, port: 0 }); // port 0 -> wrapper picks a free port
  const pool = getPool();
  const { rows } = await pool.query("select 1 as ok");
  assert.equal(rows[0].ok, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db-pg.test.mjs`
Expected: FAIL — `Cannot find module '../db/pg.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// agent-runtime/db/pg.mjs
// Local embedded Postgres for MissionAlpha runtime state.
// Data dir lives OUTSIDE the repo (default ~/.missionalpha/db) — same posture
// as the runtime token. Zero-install: the binary ships with `embedded-postgres`.
import EmbeddedPostgres from "embedded-postgres";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import pg from "pg";

const DEFAULT_DIR = process.env.MA_DB_DIR || join(homedir(), ".missionalpha", "db");
const DB_NAME = "missionalpha";

let _embedded = null;
let _pool = null;

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function bootDb({ dataDir = DEFAULT_DIR, port } = {}) {
  if (_pool) return _pool;
  mkdirSync(dataDir, { recursive: true });
  const chosenPort = port && port > 0 ? port : await freePort();
  const fresh = !existsSync(join(dataDir, "PG_VERSION")) &&
    readdirSync(dataDir).length === 0;

  _embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "missionalpha",
    password: "missionalpha",
    port: chosenPort,
    persistent: true,
  });

  if (fresh) await _embedded.initialise();
  await _embedded.start();
  if (fresh) await _embedded.createDatabase(DB_NAME);

  _pool = new pg.Pool({
    host: "127.0.0.1",
    port: chosenPort,
    user: "missionalpha",
    password: "missionalpha",
    database: DB_NAME,
    max: 10,
  });
  // fail fast if the connection is wrong
  await _pool.query("select 1");
  return _pool;
}

export function getPool() {
  if (!_pool) throw new Error("bootDb() must be called before getPool()");
  return _pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function stopDb() {
  if (_pool) { await _pool.end(); _pool = null; }
  if (_embedded) { await _embedded.stop(); _embedded = null; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db-pg.test.mjs`
Expected: PASS. (First run is slow — the embedded binary initialises a cluster. Subsequent runs reuse it.)

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/db/pg.mjs agent-runtime/test/db-pg.test.mjs agent-runtime/package.json agent-runtime/package-lock.json
git commit -m "feat(db): embedded postgres boot wrapper with local data dir"
```

---

### Task 0.2: SQL migration runner

**Files:**
- Create: `agent-runtime/db/migrate.mjs`
- Create: `agent-runtime/db/migrations/0001_init.sql`
- Test: `agent-runtime/test/db-migrate.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// agent-runtime/test/db-migrate.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootDb, getPool, stopDb } from "../db/pg.mjs";
import { migrate } from "../db/migrate.mjs";

const dir = mkdtempSync(join(tmpdir(), "ma-mig-"));
after(async () => { await stopDb(); rmSync(dir, { recursive: true, force: true }); });

test("migrate applies 0001 and is idempotent", async () => {
  await bootDb({ dataDir: dir, port: 0 });
  const applied1 = await migrate();
  assert.ok(applied1.includes("0001_init"));
  const pool = getPool();
  const t = await pool.query(
    "select to_regclass('public.tasks') as t, to_regclass('public.projects') as p"
  );
  assert.ok(t.rows[0].t, "tasks table exists");
  assert.ok(t.rows[0].p, "projects table exists");
  const applied2 = await migrate(); // second run applies nothing
  assert.deepEqual(applied2, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db-migrate.test.mjs`
Expected: FAIL — `Cannot find module '../db/migrate.mjs'`.

- [ ] **Step 3a: Write the migration runner**

```js
// agent-runtime/db/migrate.mjs
// Tiny ordered-SQL migration runner. Each file in migrations/ named NNNN_name.sql
// is applied once, recorded in schema_migrations. No down-migrations (forward-only).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./pg.mjs";

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate() {
  const pool = getPool();
  await pool.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )`);
  const done = new Set(
    (await pool.query("select id from schema_migrations")).rows.map((r) => r.id)
  );
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
  const applied = [];
  for (const f of files) {
    const id = f.replace(/\.sql$/, "");
    if (done.has(id)) continue;
    const sql = readFileSync(join(MIG_DIR, f), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (id) values ($1)", [id]);
      await client.query("commit");
      applied.push(id);
    } catch (e) {
      await client.query("rollback");
      throw new Error(`migration ${id} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
```

- [ ] **Step 3b: Write the first migration (schema v1)**

```sql
-- agent-runtime/db/migrations/0001_init.sql
-- Core runtime state: projects (tenant), tasks (queue), goals (plans), threads (chat).

create extension if not exists "pgcrypto";  -- gen_random_uuid()

create table projects (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);

-- Goals = multi-step plans (engine.mjs)
create table goals (
  id          text primary key,
  project_id  uuid not null references projects(id) on delete cascade,
  agent_id    text not null,
  tier        text,
  priority    int not null default 0,
  steps       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create index goals_project_idx on goals (project_id, created_at);

-- Tasks = queued execution steps (queue.mjs). Atomic claim via FOR UPDATE SKIP LOCKED.
create table tasks (
  id            text primary key,
  project_id    uuid not null references projects(id) on delete cascade,
  goal_id       text references goals(id) on delete cascade,
  step_index    int not null default 0,
  agent_id      text not null,
  task          text not null,
  status        text not null default 'queued'
                 check (status in ('queued','claimed','running','done','failed','blocked')),
  attempts      int not null default 0,
  lease_expiry  timestamptz,
  claimed_by    text,
  result        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index tasks_claim_idx on tasks (project_id, status, created_at);

-- Threads = conversation history + usage rollup (server.mjs)
create table threads (
  id          text primary key,
  project_id  uuid not null references projects(id) on delete cascade,
  agent_id    text not null,
  messages    jsonb not null default '[]'::jsonb,
  usage       jsonb not null default '{}'::jsonb,
  forked_from text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index threads_project_idx on threads (project_id, agent_id);

-- Seed the default project so single-project usage needs no setup.
insert into projects (slug, name) values ('default', 'Default Project');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db-migrate.test.mjs`
Expected: PASS — both tables exist, second migrate returns `[]`.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/db/migrate.mjs agent-runtime/db/migrations/0001_init.sql agent-runtime/test/db-migrate.test.mjs
git commit -m "feat(db): forward-only SQL migration runner + schema v1 (projects/tasks/goals/threads)"
```

---

### Task 0.3: Test helper for throwaway DBs

**Files:**
- Create: `agent-runtime/db/test-helper.mjs`
- Test: `agent-runtime/test/db-helper.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// agent-runtime/test/db-helper.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "../db/test-helper.mjs";

test("withTestDb gives a migrated pool and tears down", async () => {
  await withTestDb(async (pool) => {
    const { rows } = await pool.query("select slug from projects where slug='default'");
    assert.equal(rows[0].slug, "default");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db-helper.test.mjs`
Expected: FAIL — `Cannot find module '../db/test-helper.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// agent-runtime/db/test-helper.mjs
// Boots a throwaway embedded Postgres in a tmpdir, migrates, runs fn(pool), tears down.
// Used by all repo tests so each gets an isolated, migrated DB.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootDb, getPool, stopDb } from "./pg.mjs";
import { migrate } from "./migrate.mjs";

export async function withTestDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ma-test-"));
  try {
    await bootDb({ dataDir: dir, port: 0 });
    await migrate();
    await fn(getPool());
  } finally {
    await stopDb();
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db-helper.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/db/test-helper.mjs agent-runtime/test/db-helper.test.mjs
git commit -m "test(db): withTestDb helper for isolated migrated test databases"
```

---

### Task 0.4: Boot DB from server startup + health endpoint

**Files:**
- Modify: `agent-runtime/server.mjs` (startup section + health route)
- Modify: `agent-runtime/package.json` (scripts)
- Test: `agent-runtime/test/db-health.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// agent-runtime/test/db-health.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "../db/test-helper.mjs";
import { dbHealth } from "../db/pg.mjs";

test("dbHealth reports ok when pool is live", async () => {
  await withTestDb(async () => {
    const h = await dbHealth();
    assert.equal(h.ok, true);
    assert.ok(typeof h.latencyMs === "number");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db-health.test.mjs`
Expected: FAIL — `dbHealth is not a function`.

- [ ] **Step 3a: Add `dbHealth` to `db/pg.mjs`**

```js
// append to agent-runtime/db/pg.mjs
export async function dbHealth() {
  const start = process.hrtime.bigint();
  await getPool().query("select 1");
  const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { ok: true, latencyMs };
}
```

- [ ] **Step 3b: Boot the DB during server startup**

In `agent-runtime/server.mjs`, locate the startup sequence that prints the banner and calls the listen function. **Before** the server starts listening, add:

```js
import { bootDb } from "./db/pg.mjs";
import { migrate } from "./db/migrate.mjs";
// ... inside the async startup, before server.listen:
await bootDb();
const appliedMigrations = await migrate();
if (appliedMigrations.length) {
  console.log(`[db] applied migrations: ${appliedMigrations.join(", ")}`);
}
```

Add a health route alongside the existing routes (follow the existing routing style in `server.mjs`):

```js
// GET /db/health  -> { ok, latencyMs }
import { dbHealth } from "./db/pg.mjs";
// in the request handler switch/dispatch for GET "/db/health":
const h = await dbHealth();
res.writeHead(200, { "content-type": "application/json" });
res.end(JSON.stringify(h));
```

- [ ] **Step 3c: Add migrate script to `agent-runtime/package.json`**

```json
"scripts": {
  "start": "node --env-file-if-exists=.env server.mjs",
  "test": "node --test --test-concurrency=1 test/*.test.mjs",
  "db:migrate": "node -e \"import('./db/pg.mjs').then(async m=>{await m.bootDb();const {migrate}=await import('./db/migrate.mjs');console.log(await migrate());await m.stopDb();})\""
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db-health.test.mjs`
Expected: PASS.

Then smoke-test the real boot:
Run: `npm start` (in `agent-runtime/`), then in another shell `curl -s localhost:PORT/db/health` (use the port the banner prints, with the auth token header the server requires).
Expected: `{"ok":true,"latencyMs":<small>}`. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/server.mjs agent-runtime/db/pg.mjs agent-runtime/package.json agent-runtime/test/db-health.test.mjs
git commit -m "feat(db): boot embedded postgres + run migrations on server startup; add /db/health"
```

**Phase 0 ship gate:** `npm start` boots, embedded PG comes up, migrations apply, `/db/health` returns ok. No behaviour change to agents yet.

---

## Phase 1 — Vertical Slice: Task Queue → Postgres (atomic claim)

This is the keystone: it proves the repository pattern end-to-end and fixes the multi-process claim race flagged in `queue.mjs:11-12`.

### Task 1.1: Tasks repository — enqueue + get

**Files:**
- Create: `agent-runtime/db/repo/tasks.mjs`
- Test: `agent-runtime/test/repo-tasks.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// agent-runtime/test/repo-tasks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "../db/test-helper.mjs";
import * as tasks from "../db/repo/tasks.mjs";

async function defaultProjectId(pool) {
  const { rows } = await pool.query("select id from projects where slug='default'");
  return rows[0].id;
}

test("enqueue then get returns the task with status queued", async () => {
  await withTestDb(async (pool) => {
    const projectId = await defaultProjectId(pool);
    await tasks.enqueue({ id: "task_1", projectId, agentId: "ceo", task: "plan launch" });
    const t = await tasks.get("task_1");
    assert.equal(t.id, "task_1");
    assert.equal(t.status, "queued");
    assert.equal(t.agent_id, "ceo");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/repo-tasks.test.mjs`
Expected: FAIL — `Cannot find module '../db/repo/tasks.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// agent-runtime/db/repo/tasks.mjs
// Task queue repository. Replaces file-per-task store (engine-store/tasks/*.json).
// Atomic claim via FOR UPDATE SKIP LOCKED — satisfies queue.mjs:11-12 contract.
import { query, getPool } from "../pg.mjs";

export async function enqueue({ id, projectId, goalId = null, stepIndex = 0, agentId, task }) {
  await query(
    `insert into tasks (id, project_id, goal_id, step_index, agent_id, task)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (id) do nothing`,
    [id, projectId, goalId, stepIndex, agentId, task]
  );
  return get(id);
}

export async function get(id) {
  const { rows } = await query("select * from tasks where id=$1", [id]);
  return rows[0] || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/repo-tasks.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/db/repo/tasks.mjs agent-runtime/test/repo-tasks.test.mjs
git commit -m "feat(db): tasks repository enqueue + get"
```

---

### Task 1.2: Atomic claim (FOR UPDATE SKIP LOCKED)

**Files:**
- Modify: `agent-runtime/db/repo/tasks.mjs`
- Modify: `agent-runtime/test/repo-tasks.test.mjs`

- [ ] **Step 1: Write the failing test (concurrent claim — no double-claim)**

Append to `agent-runtime/test/repo-tasks.test.mjs`:

```js
test("claimNext is atomic: 10 concurrent claims of 3 tasks yield 3 unique winners", async () => {
  await withTestDb(async (pool) => {
    const projectId = await defaultProjectId(pool);
    for (let i = 0; i < 3; i++) {
      await tasks.enqueue({ id: `c_${i}`, projectId, agentId: "ceo", task: `t${i}` });
    }
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        tasks.claimNext({ projectId, workerId: `w${i}`, leaseMs: 60000 })
      )
    );
    const won = claims.filter(Boolean).map((t) => t.id);
    assert.equal(won.length, 3, "exactly 3 claims succeed");
    assert.equal(new Set(won).size, 3, "no task claimed twice");
    const nulls = claims.filter((c) => c === null).length;
    assert.equal(nulls, 7, "the other 7 get null (nothing left)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/repo-tasks.test.mjs`
Expected: FAIL — `tasks.claimNext is not a function`.

- [ ] **Step 3: Implement `claimNext`**

Append to `agent-runtime/db/repo/tasks.mjs`:

```js
// Atomically claim the oldest queued (or lease-expired) task for a project.
// SKIP LOCKED means concurrent claimers never block or double-claim.
export async function claimNext({ projectId, workerId, leaseMs = 60000 }) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(
      `select id from tasks
         where project_id = $1
           and (status = 'queued'
                or (status in ('claimed','running') and lease_expiry < now()))
         order by created_at
         for update skip locked
         limit 1`,
      [projectId]
    );
    if (!rows.length) { await client.query("commit"); return null; }
    const id = rows[0].id;
    const upd = await client.query(
      `update tasks
          set status='claimed',
              claimed_by=$2,
              attempts=attempts+1,
              lease_expiry = now() + ($3 || ' milliseconds')::interval,
              updated_at=now()
        where id=$1
        returning *`,
      [id, workerId, String(leaseMs)]
    );
    await client.query("commit");
    return upd.rows[0];
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/repo-tasks.test.mjs`
Expected: PASS — 3 unique winners, 7 nulls.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/db/repo/tasks.mjs agent-runtime/test/repo-tasks.test.mjs
git commit -m "feat(db): atomic task claim via FOR UPDATE SKIP LOCKED (kills multi-proc race)"
```

---

### Task 1.3: Status transitions (running / done / failed / blocked)

**Files:**
- Modify: `agent-runtime/db/repo/tasks.mjs`
- Modify: `agent-runtime/test/repo-tasks.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `agent-runtime/test/repo-tasks.test.mjs`:

```js
test("markRunning/markDone update status and result", async () => {
  await withTestDb(async (pool) => {
    const projectId = await defaultProjectId(pool);
    await tasks.enqueue({ id: "s_1", projectId, agentId: "ceo", task: "x" });
    await tasks.claimNext({ projectId, workerId: "w", leaseMs: 60000 });
    await tasks.markRunning("s_1");
    assert.equal((await tasks.get("s_1")).status, "running");
    await tasks.markDone("s_1", { ok: true });
    const t = await tasks.get("s_1");
    assert.equal(t.status, "done");
    assert.deepEqual(t.result, { ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/repo-tasks.test.mjs`
Expected: FAIL — `tasks.markRunning is not a function`.

- [ ] **Step 3: Implement transitions**

Append to `agent-runtime/db/repo/tasks.mjs`:

```js
async function setStatus(id, status, result = null) {
  const { rows } = await query(
    `update tasks set status=$2, result=coalesce($3, result), updated_at=now()
      where id=$1 returning *`,
    [id, status, result]
  );
  return rows[0] || null;
}
export const markRunning = (id) => setStatus(id, "running");
export const markDone = (id, result) => setStatus(id, "done", result);
export const markFailed = (id, result) => setStatus(id, "failed", result);
export const markBlocked = (id, result) => setStatus(id, "blocked", result);

// Backlog view for dashboards / status render.
export async function listByProject(projectId, { status } = {}) {
  const { rows } = status
    ? await query(
        "select * from tasks where project_id=$1 and status=$2 order by created_at",
        [projectId, status])
    : await query(
        "select * from tasks where project_id=$1 order by created_at",
        [projectId]);
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/repo-tasks.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/db/repo/tasks.mjs agent-runtime/test/repo-tasks.test.mjs
git commit -m "feat(db): task status transitions + per-project backlog listing"
```

---

### Task 1.4: Swap `queue.mjs` internals to the repository

**Files:**
- Modify: `agent-runtime/queue.mjs` (replace file-lease internals; keep public surface)
- Modify: `agent-runtime/test/queue.test.mjs` (adapt to async repo-backed API)

- [ ] **Step 1: Read the current public surface**

Run: `grep -n "export" agent-runtime/queue.mjs`
Identify the exported function names callers use (e.g. `enqueue`, `claimNext`, `update`, `rebuild`, `all`). The shim must keep these names and signatures so `server.mjs`/`engine.mjs` callers do not change in this task.

- [ ] **Step 2: Update the queue test to expect repo-backed behaviour**

In `agent-runtime/test/queue.test.mjs`, replace any filesystem-store assertions (temp dirs, reading `engine-store/tasks/*.json`) with a `withTestDb` wrapper and assertions on repository round-trips. Keep the behavioural cases (fairness/round-robin, lease expiry, no double-claim). Example shape:

```js
import { withTestDb } from "../db/test-helper.mjs";
import { createQueue } from "../queue.mjs";
// each test: await withTestDb(async (pool) => { const q = createQueue({ projectId }); ... });
```

Run: `node --test test/queue.test.mjs`
Expected: FAIL — queue still uses the file store / old signature.

- [ ] **Step 3: Rewrite `queue.mjs` as a thin shim over the tasks repo**

Replace the file-lease internals (`persist`, `rebuild`, file paths, the in-memory index Map) with calls into `db/repo/tasks.mjs`. Preserve the exported names. The round-robin fairness that was implemented in `claimNext()` (L159) is now achieved by `created_at` ordering scoped per project; if strict per-agent round-robin is required, add `order by created_at` plus an agent-fairness tiebreak in a follow-up — note it in the test as a known simplification rather than silently dropping it.

```js
// agent-runtime/queue.mjs  (shim — public surface preserved)
import * as repo from "./db/repo/tasks.mjs";

export function createQueue({ projectId }) {
  return {
    enqueue: (t) => repo.enqueue({ ...t, projectId }),
    claimNext: (opts = {}) => repo.claimNext({ projectId, ...opts }),
    markRunning: repo.markRunning,
    markDone: repo.markDone,
    markFailed: repo.markFailed,
    markBlocked: repo.markBlocked,
    all: (opts) => repo.listByProject(projectId, opts),
    get: repo.get,
  };
}
```

> If existing callers used a module-level singleton rather than a factory, keep a default singleton bound to the default project for now: `export const queue = createQueue({ projectId: DEFAULT_PROJECT_ID })` — Phase 4 threads real project ids through. Resolve `DEFAULT_PROJECT_ID` via `db/repo/projects.mjs` `getDefaultProjectId()` (Task 4.1).

- [ ] **Step 4: Run the queue test to verify it passes**

Run: `node --test test/queue.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/queue.mjs agent-runtime/test/queue.test.mjs
git commit -m "refactor(queue): back queue with postgres tasks repo; preserve public surface"
```

---

### Task 1.5: Remove the file task store + verify full runtime test suite

**Files:**
- Delete: file-store helpers in `engine.mjs`/`queue.mjs` that wrote `engine-store/tasks/*.json` (only the now-dead code paths)
- Modify: `.gitignore` (stop tracking `engine-store/tasks` runtime data if tracked)

- [ ] **Step 1: Find dead file-store references**

Run: `grep -rn "engine-store/tasks" agent-runtime`
Expected: only references left should be in deleted code or comments. Remove dead writers/readers.

- [ ] **Step 2: Run the entire runtime suite**

Run: `cd agent-runtime && npm test`
Expected: PASS for all `test/*.test.mjs`. Investigate and fix any failure before continuing (do not skip).

- [ ] **Step 3: Manual smoke of the real loop**

Run: `npm start`, then drive one task through `/run` (the existing endpoint) using the auth token, and confirm the task appears in the DB:
Run: `psql "$(node -e "console.log('postgres://missionalpha:missionalpha@127.0.0.1:'+process.env.MA_DB_PORT+'/missionalpha')")" -c "select id,status from tasks;"`
(Or add a temporary `/tasks` debug route that calls `listByProject`.)
Expected: the task row exists with the expected status progression.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(queue): remove dead file task store; tasks now fully postgres-backed"
```

**Phase 1 ship gate:** tasks persist and claim atomically in Postgres, the concurrent-claim test proves no double-work, the file task store is gone, and the full runtime suite is green.

---

## Phase 2 — Migrate Remaining JSON Entities

Each entity below follows the **exact same pattern proven in Phase 1**: write a repo test with `withTestDb`, implement `db/repo/<entity>.mjs`, swap the caller in `server.mjs`/`factory.mjs`/`engine.mjs`/`policy.mjs` from file I/O to the repo, delete the dead file code, run `npm test`, commit. Migration `0002_factory.sql` adds the tables.

### Task 2.1: Migration 0002 — factory + policy + audit tables

**Files:**
- Create: `agent-runtime/db/migrations/0002_factory.sql`
- Test: extend `agent-runtime/test/db-migrate.test.mjs` to assert the new tables exist.

```sql
-- agent-runtime/db/migrations/0002_factory.sql

create table policy (
  project_id  uuid not null references projects(id) on delete cascade,
  agent_id    text not null,
  level       text not null check (level in ('manual','auto-safe','never')),
  sig         text not null,                 -- preserve existing HMAC signature
  updated_at  timestamptz not null default now(),
  primary key (project_id, agent_id)
);

create table connections (
  id          text primary key,             -- connId
  project_id  uuid not null references projects(id) on delete cascade,
  platform    text not null,
  handle      text,
  enc         text not null,                -- existing encrypted blob (unchanged crypto)
  created_at  timestamptz not null default now()
);

create table mcp_creds (
  id          text primary key,             -- credId
  project_id  uuid not null references projects(id) on delete cascade,
  enc         text not null,                -- existing encrypted blob
  created_at  timestamptz not null default now()
);

create table registry (
  id           text primary key,            -- agent id
  project_id   uuid not null references projects(id) on delete cascade,
  role         text,
  title        text,
  persona      text,
  skills       jsonb not null default '[]'::jsonb,
  tools        jsonb not null default '[]'::jsonb,
  integrations jsonb not null default '[]'::jsonb,
  created_by   text,
  created_at   timestamptz not null default now()
);

create table audit_log (
  id          bigserial primary key,
  project_id  uuid not null references projects(id) on delete cascade,
  ts          timestamptz not null default now(),
  event       text not null,
  data        jsonb not null default '{}'::jsonb
);
create index audit_project_ts_idx on audit_log (project_id, ts desc);
```

- [ ] Steps: add the migration → extend `db-migrate.test.mjs` with `to_regclass` checks for `policy`, `connections`, `mcp_creds`, `registry`, `audit_log` → run `node --test test/db-migrate.test.mjs` (PASS) → commit `feat(db): migration 0002 — factory/policy/audit tables`.

### Task 2.2: Audit repository (replaces `factory-audit.log`)

**Files:** Create `agent-runtime/db/repo/audit.mjs`; Test `agent-runtime/test/repo-audit.test.mjs`; Modify `factory.mjs` (`audit()`/`readAudit()`), `server.mjs` (`GET /factory/audit`).

- [ ] Test: append two events, `readRecent(projectId, 10)` returns them newest-first.

```js
// agent-runtime/db/repo/audit.mjs
import { query } from "../pg.mjs";
export async function record({ projectId, event, data = {} }) {
  await query("insert into audit_log (project_id, event, data) values ($1,$2,$3)",
    [projectId, event, data]);
}
export async function readRecent(projectId, limit = 100) {
  const { rows } = await query(
    "select ts, event, data from audit_log where project_id=$1 order by ts desc limit $2",
    [projectId, limit]);
  return rows;
}
```

- [ ] Swap `factory.mjs:audit()` to call `record()` (durable insert — fixes the no-fsync risk) and `readAudit()` to call `readRecent()`. Keep the same return shape the `/factory/audit` route expects. Run `npm test` → commit `feat(db): durable audit log in postgres (replaces append-only file)`.

### Task 2.3: Policy repository (keep HMAC)

**Files:** Create `db/repo/policy.mjs`; Test `test/repo-policy.test.mjs`; Modify `policy.mjs` (`load()`/`persist()`).

- [ ] Keep the **existing HMAC sign/verify** in `policy.mjs`; only change the storage backend from `policy.json` to the `policy` table. `persist()` upserts `(project_id, agent_id, level, sig)`; `load()` selects rows for the project, rebuilds the in-memory `{agentId: level}` map, and verifies the stored `sig` exactly as before. Test: persist then load returns the same map and passes verification; a tampered `level` fails verification. Run `npm test` → commit `feat(db): policy storage in postgres, HMAC verification preserved`.

### Task 2.4: Connections + creds repositories (encryption unchanged)

**Files:** Create `db/repo/connections.mjs`, `db/repo/creds.mjs`; Tests `test/repo-connections.test.mjs`, `test/repo-creds.test.mjs`; Modify `factory.mjs` load/save.

- [ ] The **encrypted blob (`enc`) crypto is unchanged** — only move it from `connections.json`/`mcp-creds.json` into the `connections`/`mcp_creds` tables. Test: save an encrypted connection, load it, decrypt with the existing routine, assert plaintext round-trips and the secret never appears in any non-`enc` column. Run `npm test` → commit `feat(db): MCP connections + creds in postgres (encryption unchanged)`.

### Task 2.5: Registry repository

**Files:** Create `db/repo/registry.mjs`; Test `test/repo-registry.test.mjs`; Modify `factory.mjs` (`loadRegistry()`/`saveRegistry()`).

- [ ] Move agent specs from `factory/registry.json` to the `registry` table. **Keep** writing the per-agent persona markdown to `.claude/agents/<id>.md` (it is consumed by the agent runtime as context, not as state) — only the registry index moves to the DB. Test: save spec → load → deep-equal (jsonb arrays round-trip). Run `npm test` → commit `feat(db): factory agent registry in postgres; persona files unchanged`.

### Task 2.6: Goals repository + engine swap

**Files:** Create `db/repo/goals.mjs`; Test `test/repo-goals.test.mjs`; Modify `engine.mjs` (`persistGoal()` + constructor hydration).

- [ ] `persistGoal()` upserts into `goals`; constructor hydration `select * from goals where project_id=$1` rebuilds the in-memory `goalPlans` Map. Test: persist a goal with 3 steps → hydrate fresh → steps array deep-equals. Run `npm test` → commit `feat(db): goal plans in postgres`.

### Task 2.7: Threads repository + server swap

**Files:** Create `db/repo/threads.mjs`; Test `test/repo-threads.test.mjs`; Modify `server.mjs` (`writeThreadRecord`, `loadThreads`, `getThreadRecord`, `persistThread`, `forkThread`, `rollupThreadUsage`).

- [ ] Move per-thread JSON (`threads/<id>.json`) into the `threads` table (`messages` jsonb, `usage` jsonb). Preserve: the **256KB trim** behaviour (trim oldest messages before write if the serialized `messages` exceeds the cap), the **usage rollup** embedded in `usage`, and **fork** (insert a new row with `forked_from`). Test: write thread → load → messages+usage round-trip; oversize thread is trimmed; fork creates a new id linked via `forked_from`. Run `npm test` → commit `feat(db): conversation threads + usage rollup in postgres`.

**Phase 2 ship gate:** every entity from the state map is Postgres-backed; `grep -rn "engine-store\|threads/.*json\|registry.json\|connections.json\|mcp-creds.json\|policy.json\|factory-audit.log" agent-runtime` returns only comments/migrations; full suite green.

---

## Phase 3 — Quota Guard (Claude subscription)

Reshape "budget" into a **quota guard**: count requests in a sliding window, block before exceeding the subscription's rate, and back off on `429`. No dollars, single Claude account.

### Task 3.1: Migration 0003 — request_log

**Files:** Create `agent-runtime/db/migrations/0003_quota.sql`; extend `db-migrate.test.mjs`.

```sql
-- agent-runtime/db/migrations/0003_quota.sql
create table request_log (
  id            bigserial primary key,
  project_id    uuid not null references projects(id) on delete cascade,
  agent_id      text not null,
  ts            timestamptz not null default now(),
  ok            boolean not null default true,    -- false if the call 429'd
  input_tokens  int not null default 0,
  output_tokens int not null default 0
);
create index request_log_window_idx on request_log (agent_id, ts desc);
create index request_log_project_idx on request_log (project_id, ts desc);
```

- [ ] Add migration → extend test with `to_regclass('public.request_log')` → run (PASS) → commit `feat(db): migration 0003 — request_log for quota guard`.

### Task 3.2: Quota repository — window counter

**Files:** Create `agent-runtime/db/repo/quota.mjs`; Test `agent-runtime/test/repo-quota.test.mjs`.

- [ ] **Step 1: Failing test**

```js
// agent-runtime/test/repo-quota.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "../db/test-helper.mjs";
import * as quota from "../db/repo/quota.mjs";

test("countInWindow counts only recent requests for an agent", async () => {
  await withTestDb(async (pool) => {
    const { rows } = await pool.query("select id from projects where slug='default'");
    const projectId = rows[0].id;
    await quota.logRequest({ projectId, agentId: "ceo", ok: true });
    await quota.logRequest({ projectId, agentId: "ceo", ok: true });
    await pool.query(
      "insert into request_log (project_id, agent_id, ts) values ($1,'ceo', now() - interval '10 hours')",
      [projectId]);
    const n = await quota.countInWindow({ agentId: "ceo", windowMs: 5 * 60 * 60 * 1000 });
    assert.equal(n, 2, "only the 2 recent requests count");
  });
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module`).

- [ ] **Step 3: Implement**

```js
// agent-runtime/db/repo/quota.mjs
import { query } from "../pg.mjs";
export async function logRequest({ projectId, agentId, ok = true, inputTokens = 0, outputTokens = 0 }) {
  await query(
    `insert into request_log (project_id, agent_id, ok, input_tokens, output_tokens)
     values ($1,$2,$3,$4,$5)`,
    [projectId, agentId, ok, inputTokens, outputTokens]);
}
export async function countInWindow({ agentId, windowMs }) {
  const { rows } = await query(
    `select count(*)::int as n from request_log
      where agent_id=$1 and ts > now() - ($2 || ' milliseconds')::interval`,
    [agentId, String(windowMs)]);
  return rows[0].n;
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(db): quota request log + sliding-window counter`.

### Task 3.3: Quota guard wrapper (pre-call gate + 429 backoff)

**Files:** Create `agent-runtime/quota-guard.mjs`; Test `agent-runtime/test/quota-guard.test.mjs`; Modify `server.mjs` (wrap every Anthropic call site).

- [ ] **Step 1: Failing test (gate blocks over-limit; backoff retries on 429)**

```js
// agent-runtime/test/quota-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "../db/test-helper.mjs";
import { guardedCall, QuotaExceeded } from "../quota-guard.mjs";
import * as quota from "../db/repo/quota.mjs";

test("blocks when window count >= max", async () => {
  await withTestDb(async (pool) => {
    const { rows } = await pool.query("select id from projects where slug='default'");
    const projectId = rows[0].id;
    for (let i = 0; i < 3; i++) await quota.logRequest({ projectId, agentId: "ceo" });
    await assert.rejects(
      () => guardedCall({ projectId, agentId: "ceo", maxPerWindow: 3, windowMs: 1e7 },
        async () => ({ ok: true })),
      QuotaExceeded);
  });
});

test("retries on 429 then succeeds, logging the 429 as ok:false", async () => {
  await withTestDb(async (pool) => {
    const { rows } = await pool.query("select id from projects where slug='default'");
    const projectId = rows[0].id;
    let calls = 0;
    const result = await guardedCall(
      { projectId, agentId: "ceo", maxPerWindow: 100, windowMs: 1e7, baseDelayMs: 1, maxRetries: 3 },
      async () => {
        calls++;
        if (calls === 1) { const e = new Error("rate"); e.status = 429; throw e; }
        return { ok: true };
      });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    const bad = await pool.query(
      "select count(*)::int n from request_log where ok=false and project_id=$1", [projectId]);
    assert.equal(bad.rows[0].n, 1);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module '../quota-guard.mjs'`).

- [ ] **Step 3: Implement**

```js
// agent-runtime/quota-guard.mjs
// Subscription-aware guard around Claude calls. Scarce resource = quota, not dollars.
// Pre-call: refuse if the agent's sliding-window request count >= maxPerWindow.
// On 429: exponential backoff + retry; log the 429 as ok:false so the window self-heals.
import * as quota from "./db/repo/quota.mjs";

export class QuotaExceeded extends Error {
  constructor(agentId, n, max) {
    super(`quota guard: ${agentId} at ${n}/${max} in window`);
    this.name = "QuotaExceeded";
    this.agentId = agentId;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function guardedCall(
  { projectId, agentId, maxPerWindow, windowMs, baseDelayMs = 500, maxRetries = 5 },
  fn
) {
  const n = await quota.countInWindow({ agentId, windowMs });
  if (n >= maxPerWindow) throw new QuotaExceeded(agentId, n, maxPerWindow);

  let attempt = 0;
  for (;;) {
    try {
      const out = await fn();
      const usage = out && out.usage ? out.usage : {};
      await quota.logRequest({
        projectId, agentId, ok: true,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
      });
      return out;
    } catch (e) {
      const is429 = e && (e.status === 429 || e.statusCode === 429);
      if (is429) await quota.logRequest({ projectId, agentId, ok: false });
      if (!is429 || attempt >= maxRetries) throw e;
      const wait = baseDelayMs * 2 ** attempt; // exponential backoff
      attempt++;
      await sleep(wait);
    }
  }
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Wire into `server.mjs`**

Find every site that calls the Anthropic SDK (e.g. `client.messages.create(...)` / `client.messages.stream(...)`). Wrap each in `guardedCall`:

```js
import { guardedCall } from "./quota-guard.mjs";
// read limits from env with safe defaults (tune to your Claude plan)
const MAX_PER_WINDOW = Number(process.env.MA_QUOTA_MAX_PER_WINDOW || 200);
const WINDOW_MS = Number(process.env.MA_QUOTA_WINDOW_MS || 5 * 60 * 60 * 1000); // 5h
// at each call site (projectId resolved for the agent's run):
const resp = await guardedCall(
  { projectId, agentId, maxPerWindow: MAX_PER_WINDOW, windowMs: WINDOW_MS },
  () => client.messages.create(params)
);
```

For streaming calls, wrap the **stream creation**; the `usage` totals are available on the final message event — log them via `quota.logRequest` after the stream completes (or rely on the `ok:true` log from `guardedCall` and update tokens in a follow-up). When `QuotaExceeded` is thrown, surface it to the caller as a soft "agent paused: quota" state (do not crash the loop) and let the scheduler retry on the next heartbeat.

- [ ] **Step 6: Run full suite + commit**

Run: `cd agent-runtime && npm test`
Expected: PASS.
```bash
git add agent-runtime/quota-guard.mjs agent-runtime/db/repo/quota.mjs agent-runtime/db/migrations/0003_quota.sql agent-runtime/server.mjs agent-runtime/test/quota-guard.test.mjs agent-runtime/test/repo-quota.test.mjs
git commit -m "feat(quota): subscription-aware quota guard (window gate + 429 backoff) around claude calls"
```

**Phase 3 ship gate:** a runaway agent is gated at `maxPerWindow`, 429s are retried with backoff and recorded, and the loop pauses instead of locking out the whole account.

---

## Phase 4 — Multi-Project Isolation

Every table already has `project_id`. This phase threads a real project through the runtime and proves isolation.

### Task 4.1: Projects repository + default-project resolver

**Files:** Create `agent-runtime/db/repo/projects.mjs`; Test `agent-runtime/test/repo-projects.test.mjs`.

- [ ] **Step 1: Failing test**

```js
// agent-runtime/test/repo-projects.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "../db/test-helper.mjs";
import * as projects from "../db/repo/projects.mjs";

test("default project exists; create + list", async () => {
  await withTestDb(async () => {
    const def = await projects.getDefaultProjectId();
    assert.ok(def);
    const p = await projects.create({ slug: "acme", name: "Acme" });
    const all = await projects.list();
    assert.ok(all.find((x) => x.slug === "acme"));
    assert.equal((await projects.bySlug("acme")).id, p.id);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```js
// agent-runtime/db/repo/projects.mjs
import { query } from "../pg.mjs";
let _defaultId = null;
export async function getDefaultProjectId() {
  if (_defaultId) return _defaultId;
  const { rows } = await query("select id from projects where slug='default'");
  _defaultId = rows[0].id;
  return _defaultId;
}
export async function create({ slug, name }) {
  const { rows } = await query(
    "insert into projects (slug, name) values ($1,$2) returning *", [slug, name]);
  return rows[0];
}
export async function list() {
  const { rows } = await query(
    "select * from projects where archived_at is null order by created_at");
  return rows;
}
export async function bySlug(slug) {
  const { rows } = await query("select * from projects where slug=$1", [slug]);
  return rows[0] || null;
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(db): projects repository + default-project resolver`.

### Task 4.2: Thread `project_id` through the runtime

**Files:** Modify `server.mjs`, `engine.mjs`, `queue.mjs` callers, scheduler.

- [ ] Resolve the active `projectId` per request/run. Source order: explicit `X-Project` header (validated against `projects`) → agent's home project from `registry` → `getDefaultProjectId()`. Replace the temporary default-project singletons from Phase 1/2 with the resolved id. Add a small middleware/helper `resolveProjectId(req)` in `server.mjs`. Every repo call that takes `projectId` receives the resolved value.

- [ ] Test (`test/multiproject.test.mjs`): enqueue task in project A and project B; `tasks.claimNext({ projectId: A })` never returns B's task; `audit.readRecent(A)` never shows B's events; `listByProject(A)` and `listByProject(B)` are disjoint. Run → PASS. Commit `feat(multiproject): resolve + thread project_id through runtime; prove isolation`.

### Task 4.3: Project management endpoints

**Files:** Modify `server.mjs` (add routes); Test `test/projects-api.test.mjs` (or curl smoke).

- [ ] Add authenticated routes (reuse the existing auth-token + host guard middleware — do **not** bypass them):
  - `GET /projects` → `projects.list()`
  - `POST /projects` `{slug,name}` → `projects.create(...)`
  - `GET /projects/:slug` → `projects.bySlug(...)`
- [ ] Each route must pass through the existing `requireAuth` + host/origin guard. Test isolation + auth (401 without token). Commit `feat(api): project CRUD endpoints (auth-gated)`.

**Phase 4 ship gate:** two projects in one install share zero data; all project routes are auth-gated; isolation test green.

---

## Phase 5 — Export / Import with Secret Scrubbing

### Task 5.1: Export a project to a portable bundle (scrubbed)

**Files:** Create `agent-runtime/export-import.mjs`; Test `agent-runtime/test/export-import.test.mjs`; reuse `agent-runtime/secret-scrub.mjs`.

- [ ] **Step 1: Failing test (export omits secrets)**

```js
// agent-runtime/test/export-import.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "../db/test-helper.mjs";
import * as projects from "../db/repo/projects.mjs";
import * as registry from "../db/repo/registry.mjs";
import * as creds from "../db/repo/creds.mjs";
import { exportProject } from "../export-import.mjs";

test("exportProject includes agents but scrubs encrypted creds", async () => {
  await withTestDb(async () => {
    const p = await projects.create({ slug: "acme", name: "Acme" });
    await registry.save({ id: "ceo", projectId: p.id, role: "CEO", title: "Chief", persona: "x" });
    await creds.save({ id: "cred1", projectId: p.id, enc: "ENCRYPTED_SECRET_BLOB" });
    const bundle = await exportProject("acme");
    assert.equal(bundle.project.slug, "acme");
    assert.ok(bundle.registry.find((a) => a.id === "ceo"));
    // creds present as references but enc blobs removed
    assert.ok(bundle.creds.every((c) => !("enc" in c)));
    const json = JSON.stringify(bundle);
    assert.ok(!json.includes("ENCRYPTED_SECRET_BLOB"), "no secret material in bundle");
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement export**

```js
// agent-runtime/export-import.mjs
// Pack a project (agents, skills, goals, tasks, registry) into a portable JSON bundle.
// Secret scrubbing: encrypted blobs (connections.enc, mcp_creds.enc) are stripped —
// the importer re-attaches credentials on the target instance.
import { query } from "./db/pg.mjs";
import * as projects from "./db/repo/projects.mjs";

const BUNDLE_VERSION = 1;

export async function exportProject(slug) {
  const project = await projects.bySlug(slug);
  if (!project) throw new Error(`unknown project: ${slug}`);
  const pid = project.id;
  const sel = async (sql) => (await query(sql, [pid])).rows;
  const registry = await sel("select * from registry where project_id=$1");
  const goals = await sel("select * from goals where project_id=$1");
  const tasks = await sel("select * from tasks where project_id=$1");
  const conns = await sel("select id, platform, handle, created_at from connections where project_id=$1");
  const creds = await sel("select id, created_at from mcp_creds where project_id=$1"); // enc omitted
  return {
    bundleVersion: BUNDLE_VERSION,
    project: { slug: project.slug, name: project.name },
    registry, goals, tasks,
    connections: conns,   // platform/handle refs, no enc
    creds,                // id refs only, no enc
  };
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(portability): export project to scrubbed portable bundle`.

### Task 5.2: Import a bundle (collision handling)

**Files:** Modify `agent-runtime/export-import.mjs`; extend test.

- [ ] **Step 1: Failing test**

```js
test("importProject creates a new project and remaps ids on slug collision", async () => {
  await withTestDb(async () => {
    const bundle = {
      bundleVersion: 1,
      project: { slug: "acme", name: "Acme" },
      registry: [{ id: "ceo", role: "CEO", title: "Chief", persona: "x", skills: [], tools: [], integrations: [] }],
      goals: [], tasks: [], connections: [], creds: [],
    };
    const first = await importProject(bundle);
    assert.equal(first.slug, "acme");
    const second = await importProject(bundle); // collision -> suffixed slug
    assert.notEqual(second.slug, "acme");
    assert.ok(second.slug.startsWith("acme-"));
  });
});
```

(Add `import { importProject } from "../export-import.mjs";` at the top of the test file.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement import**

```js
// append to agent-runtime/export-import.mjs
export async function importProject(bundle) {
  if (bundle.bundleVersion !== BUNDLE_VERSION)
    throw new Error(`unsupported bundle version: ${bundle.bundleVersion}`);
  let slug = bundle.project.slug;
  if (await projects.bySlug(slug)) slug = `${slug}-${shortRand()}`;
  const project = await projects.create({ slug, name: bundle.project.name });
  for (const a of bundle.registry) {
    await query(
      `insert into registry (id, project_id, role, title, persona, skills, tools, integrations, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [`${a.id}__${slug}`, project.id, a.role, a.title, a.persona,
       JSON.stringify(a.skills || []), JSON.stringify(a.tools || []),
       JSON.stringify(a.integrations || []), "import"]);
  }
  for (const g of bundle.goals) {
    await query(
      `insert into goals (id, project_id, agent_id, tier, priority, steps)
       values ($1,$2,$3,$4,$5,$6)`,
      [`${g.id}__${slug}`, project.id, g.agent_id, g.tier, g.priority || 0,
       JSON.stringify(g.steps || [])]);
  }
  // tasks/connections/creds intentionally re-created without secret material;
  // operator re-attaches credentials on the target instance.
  return project;
}
function shortRand() {
  // deterministic-enough unique suffix without Math.random in hot path
  return Date.now().toString(36).slice(-5);
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Add auth-gated endpoints + commit**

Add to `server.mjs` (behind existing auth + host guard): `GET /export/:slug` → `exportProject`, `POST /import` (body = bundle) → `importProject`. Run `npm test`. Commit:
```bash
git add agent-runtime/export-import.mjs agent-runtime/server.mjs agent-runtime/test/export-import.test.mjs
git commit -m "feat(portability): import scrubbed bundle with slug-collision handling; auth-gated endpoints"
```

**Phase 5 ship gate:** a project exports to a bundle that contains **zero secret material** (asserted), and imports into a fresh project with id remapping on collision.

---

## Phase 6 — Lightweight Plugin Loader

### Task 6.1: Migration 0004 + plugin loader

**Files:** Create `agent-runtime/db/migrations/0004_plugins.sql`, `agent-runtime/plugin-loader.mjs`; Test `agent-runtime/test/plugin-loader.test.mjs`.

```sql
-- agent-runtime/db/migrations/0004_plugins.sql
create table plugins (
  id          text primary key,
  enabled     boolean not null default true,
  config      jsonb not null default '{}'::jsonb,
  installed_at timestamptz not null default now()
);
```

- [ ] **Step 1: Failing test**

```js
// agent-runtime/test/plugin-loader.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins } from "../plugin-loader.mjs";

test("loadPlugins imports modules exposing register() and collects tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-plug-"));
  writeFileSync(join(dir, "hello.mjs"),
    `export function register(host){ host.addTool({ name:"hello", run:()=>"hi" }); }`);
  try {
    const host = { tools: [], addTool(t){ this.tools.push(t); } };
    const loaded = await loadPlugins({ dir, host });
    assert.deepEqual(loaded, ["hello.mjs"]);
    assert.equal(host.tools[0].name, "hello");
    assert.equal(host.tools[0].run(), "hi");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```js
// agent-runtime/plugin-loader.mjs
// Lightweight in-process plugin loader. Each plugin is an .mjs exporting
// register(host). The host exposes a minimal, capability-narrow surface
// (addTool, addRoute later). NOT out-of-process — defer that until needed.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadPlugins({ dir, host }) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort(); }
  catch { return []; }
  const loaded = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(resolve(join(dir, f))).href);
    if (typeof mod.register === "function") {
      await mod.register(host);
      loaded.push(f);
    }
  }
  return loaded;
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Wire into `server.mjs` boot + commit**

After the tool broker initialises, call `loadPlugins({ dir: process.env.MA_PLUGIN_DIR || join(homedir(), ".missionalpha", "plugins"), host })` where `host` exposes `addTool` into the existing tool registry. **Security note:** plugins run in-process with full trust — load **only** from the operator-owned `~/.missionalpha/plugins` dir, never from a project bundle import (do not auto-load plugins from imported bundles). Run `npm test`. Commit:
```bash
git add agent-runtime/plugin-loader.mjs agent-runtime/db/migrations/0004_plugins.sql agent-runtime/server.mjs agent-runtime/test/plugin-loader.test.mjs
git commit -m "feat(plugins): lightweight in-process plugin loader (operator dir only)"
```

**Phase 6 ship gate:** a sample plugin in `~/.missionalpha/plugins` registers a tool at boot; imported bundles never load plugins.

---

## Phase 7 — `agent-status/*.md` as Generated Read-Only View

Keep the human/git-readable trail; make it a render of the DB, not a source of state.

### Task 7.1: Status renderer

**Files:** Create `agent-runtime/status-render.mjs`; Test `agent-runtime/test/status-render.test.mjs`; Modify `server.mjs`/scheduler (call on heartbeat).

- [ ] **Step 1: Failing test**

```js
// agent-runtime/test/status-render.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTestDb } from "../db/test-helper.mjs";
import * as projects from "../db/repo/projects.mjs";
import * as tasks from "../db/repo/tasks.mjs";
import { renderBroadcast } from "../status-render.mjs";

test("renderBroadcast produces a markdown table from DB tasks", async () => {
  await withTestDb(async () => {
    const pid = await projects.getDefaultProjectId();
    await tasks.enqueue({ id: "t1", projectId: pid, agentId: "ceo", task: "plan" });
    const md = await renderBroadcast(pid);
    assert.match(md, /\| Agent \| State \| Task \|/);
    assert.match(md, /ceo/);
    assert.match(md, /plan/);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```js
// agent-runtime/status-render.mjs
// Render agent-status/BROADCAST.md from the DB. READ-ONLY view: nothing reads
// state back from these files; they exist for humans + git history.
import { writeFile } from "node:fs/promises";
import * as tasks from "./db/repo/tasks.mjs";

export async function renderBroadcast(projectId) {
  const rows = await tasks.listByProject(projectId);
  const header = "| Agent | State | Task |\n|---|---|---|";
  const body = rows
    .map((t) => `| ${t.agent_id} | ${t.status} | ${String(t.task).replace(/\n/g, " ").slice(0, 80)} |`)
    .join("\n");
  return `# BROADCAST (generated — do not edit)\n\n${header}\n${body}\n`;
}

export async function writeBroadcast(projectId, path) {
  const md = await renderBroadcast(projectId);
  await writeFile(path, md, "utf8");
  return path;
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Call on heartbeat + stop reading files as state**

In the scheduler/heartbeat path, replace any code that **wrote** BROADCAST.md/SCHEDULER.md as state with a call to `writeBroadcast(projectId, "agent-status/BROADCAST.md")`. Confirm nothing **reads** `agent-status/*.md` back into runtime logic: `grep -rn "agent-status/" agent-runtime` should show only writes (the renderer) and the external heartbeat script. Add a `> generated` banner so humans don't hand-edit. Run `npm test`. Commit:
```bash
git add agent-runtime/status-render.mjs agent-runtime/server.mjs agent-runtime/test/status-render.test.mjs
git commit -m "feat(status): render BROADCAST.md as read-only view from DB; remove file-as-state reads"
```

**Phase 7 ship gate:** BROADCAST.md is regenerated from the DB on each heartbeat, no runtime code reads `agent-status/*.md` for state, and the file-bus race is gone.

---

## Final Verification

- [ ] **Full suite:** `cd agent-runtime && npm test` → all green.
- [ ] **No file-state leftovers:** `grep -rn "engine-store\|threads/.*\.json\|registry\.json\|connections\.json\|mcp-creds\.json\|policy\.json\|factory-audit\.log" agent-runtime` → only comments/migrations/deleted-path notes.
- [ ] **Security intact:** confirm `requireAuth`, host/origin guard, `secret-scrub.mjs`, and `broker.mjs` apply-guards are still invoked on `/run`, `/apply`, `/projects`, `/export`, `/import`. New endpoints must not bypass them.
- [ ] **Isolation:** the Phase 4 multiproject test proves zero cross-project data.
- [ ] **Quota:** the Phase 3 tests prove gating + 429 backoff.
- [ ] **Portability:** the Phase 5 test proves bundles carry no secret material.
- [ ] **DB location:** confirm data lives under `~/.missionalpha/db` (or `MA_DB_DIR`), **outside** the repo, and `.gitignore` excludes any stray runtime data.
- [ ] **Onboarding doc:** add a short `docs/STATE.md` describing the DB layer, env vars (`MA_DB_DIR`, `MA_DB_PORT`, `MA_QUOTA_MAX_PER_WINDOW`, `MA_QUOTA_WINDOW_MS`, `MA_PLUGIN_DIR`), and the export/import flow.

---

## Self-Review Notes (author)

- **Spec coverage:** State→Postgres (Phases 0–2, 7), Quota guard (Phase 3), Multi-project + isolation (Phase 4), Export/import + scrubbing (Phase 5), Plugins (Phase 6). Mobile explicitly excluded. ✔
- **Type/name consistency:** repo function names are referenced consistently across phases (`enqueue`, `get`, `claimNext`, `markRunning/Done/Failed/Blocked`, `listByProject`; `getDefaultProjectId`; `logRequest`, `countInWindow`; `exportProject`, `importProject`; `renderBroadcast`, `writeBroadcast`; `loadPlugins`). ✔
- **Known simplifications flagged, not hidden:** per-agent round-robin fairness becomes `created_at` ordering (Task 1.4 note); streaming-call token logging may land in a follow-up (Task 3.3 note). ✔
- **Embedded-postgres API risk:** isolated in `db/pg.mjs` and caught by the Task 0.1 smoke test before anything depends on it. ✔

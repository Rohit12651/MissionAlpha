// ADR-051 §1/§2/§3 — the SQLite Delivery store's foundation: WAL open, 0600 perms,
// idempotent migration ladder, zero-filled counts, patch-dir containment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, MIGRATIONS } from "../db.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "ma-db-"));

test("openDb creates the file in WAL mode with 0600 perms and runs migrations", () => {
  const root = tmp();
  try {
    const file = join(root, "data", "mission.db");
    const h = openDb({ path: file });
    assert.equal(h.db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(statSync(file).mode & 0o777, 0o600, "db file must be 0600");
    assert.equal(statSync(join(root, "data")).mode & 0o777, 0o700, "data dir must be 0700");
    assert.equal(h.version(), MIGRATIONS[MIGRATIONS.length - 1].version);
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migrations are idempotent — re-open applies nothing new", () => {
  const root = tmp();
  try {
    const p = join(root, "mission.db");
    const a = openDb({ path: p });
    const v1 = a.version();
    a.db.prepare("INSERT INTO events_log(event,data,createdAt) VALUES(?,?,?)").run("agent.state", "{}", new Date().toISOString());
    a.close();
    const b = openDb({ path: p });
    assert.equal(b.version(), v1, "version unchanged on re-open");
    assert.equal(b.db.prepare("SELECT COUNT(*) n FROM schema_migrations").get().n, MIGRATIONS.length);
    assert.equal(b.db.prepare("SELECT COUNT(*) n FROM events_log").get().n, 1, "existing data survives re-migration");
    b.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the deliveries schema enforces the ADR-051 CHECK constraints", () => {
  const root = tmp();
  try {
    const h = openDb({ path: join(root, "mission.db") });
    const ins = (over = {}) => {
      const r = { id: "01J0000000000000000000000A", agentId: "a1", taskId: null, title: "t", summary: "s", source: "swarm", kind: "code", changedPaths: "[]", riskReasons: "[]", status: "pending", createdAt: "2026-07-30T00:00:00.000Z", auditRef: "delivery:x", ...over };
      return h.db.prepare(
        `INSERT INTO deliveries(id,agentId,taskId,title,summary,source,kind,changedPaths,riskReasons,status,createdAt,auditRef)
         VALUES(@id,@agentId,@taskId,@title,@summary,@source,@kind,@changedPaths,@riskReasons,@status,@createdAt,@auditRef)`,
      ).run(r);
    };
    ins();
    assert.throws(() => ins({ id: "01J0000000000000000000000B", agentId: "a2", source: "bogus" }), /CHECK/i, "bad source rejected");
    assert.throws(() => ins({ id: "01J0000000000000000000000C", agentId: "a3", kind: "bogus" }), /CHECK/i, "bad kind rejected");
    assert.throws(() => ins({ id: "01J0000000000000000000000D", agentId: "a4", status: "bogus" }), /CHECK/i, "bad status rejected");
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the pending unique index blocks a double-mint and frees up after a decision", () => {
  const root = tmp();
  try {
    const h = openDb({ path: join(root, "mission.db") });
    const ins = (id, agentId, taskId) => h.db.prepare(
      `INSERT INTO deliveries(id,agentId,taskId,title,summary,source,kind,changedPaths,riskReasons,status,createdAt,auditRef)
       VALUES(?,?,?,'t','s','swarm','code','[]','[]','pending',?,'delivery:x')`,
    ).run(id, agentId, taskId, new Date().toISOString());
    ins("01J0000000000000000000000A", "bob", null);
    assert.throws(() => ins("01J0000000000000000000000B", "bob", null), /UNIQUE/i, "second pending row for the same agent refused");
    ins("01J0000000000000000000000C", "bob", "task_abc123"); // distinct work unit — allowed
    h.db.prepare("UPDATE deliveries SET status='approved' WHERE id=?").run("01J0000000000000000000000A");
    ins("01J0000000000000000000000D", "bob", null); // previous one decided → re-mint allowed
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("counts() zero-fills every status and totals correctly", () => {
  const root = tmp();
  try {
    const h = openDb({ path: join(root, "mission.db") });
    const c0 = h.counts();
    assert.deepEqual(c0, { pending: 0, approved: 0, rejected: 0, changes_requested: 0, expired: 0, auto_approved: 0, total: 0 });
    h.db.prepare(
      `INSERT INTO deliveries(id,agentId,taskId,title,summary,source,kind,changedPaths,riskReasons,status,createdAt,auditRef)
       VALUES('01J0000000000000000000000A','bob',NULL,'t','s','swarm','code','[]','[]','pending','2026-07-30T00:00:00.000Z','delivery:x')`,
    ).run();
    assert.equal(h.counts().pending, 1);
    assert.equal(h.counts().total, 1);
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("patchDirFor creates a 0700 dir for a minted id and refuses a traversing one", () => {
  const root = tmp();
  try {
    const h = openDb({ path: join(root, "mission.db"), patchesDir: join(root, "patches") });
    const d = h.patchDirFor("01J0000000000000000000000A");
    assert.ok(existsSync(d));
    assert.equal(statSync(d).mode & 0o777, 0o700);
    assert.throws(() => h.patchDirFor("../evil"), /outside/i);
    assert.throws(() => h.patchDirFor("/etc"), /outside/i);
    assert.throws(() => h.patchDirFor(""), /invalid/i);
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── P4 / ADR-051 §9 — failure Deliveries need kind='failure' ────────────────
const insertSql = `INSERT INTO deliveries (id, agentId, taskId, title, summary, source, kind, changedPaths, riskReasons, status, createdAt, auditRef)
   VALUES (?, ?, ?, ?, 's', 'swarm', ?, ?, '[]', 'pending', ?, 'delivery:x')`;

test("P4 migration v2 widens the kind CHECK to accept 'failure'", () => {
  const root = tmp();
  try {
    const h = openDb({ path: join(root, "m2.db") });
    // The ladder is append-only, so this asserts "v2 has been applied", not "v2 is
    // the last rung" — P5 adds v3 above it and must not invalidate this case.
    assert.ok(h.version() >= 2);
    h.db.prepare(insertSql).run("01ARZ3NDEKTSV4RRFFQ69G5FA0", "a1", null, "t", "failure", "[]", new Date().toISOString());
    assert.equal(h.db.prepare("SELECT kind FROM deliveries WHERE id = ?").get("01ARZ3NDEKTSV4RRFFQ69G5FA0").kind, "failure");
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P4 migration v2 still accepts the four original kinds", () => {
  const root = tmp();
  try {
    const h = openDb({ path: join(root, "m2k.db") });
    let i = 0;
    for (const k of ["code", "doc", "post", "command"]) {
      h.db.prepare(insertSql).run(`01ARZ3NDEKTSV4RRFFQ69G5F0${i++}`, `agent${i}`, null, "t", k, "[]", new Date().toISOString());
    }
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM deliveries").get().n, 4);
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P4 migration v2 still rejects an unknown kind", () => {
  const root = tmp();
  try {
    const h = openDb({ path: join(root, "m2b.db") });
    assert.throws(
      () => h.db.prepare(insertSql).run("01ARZ3NDEKTSV4RRFFQ69G5FA1", "a1", null, "t", "wat", "[]", new Date().toISOString()),
      /constraint/i,
    );
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P4 migration v2 preserves v1 rows and the pending-unique index survives the rebuild", () => {
  const root = tmp();
  try {
    const p = join(root, "m2c.db");
    const h1 = openDb({ path: p });
    h1.db.prepare(insertSql).run("01ARZ3NDEKTSV4RRFFQ69G5FB0", "a1", "task_abcdef", "kept", "code", '["x.ts"]', new Date().toISOString());
    h1.close();
    const h2 = openDb({ path: p });
    const row = h2.db.prepare("SELECT * FROM deliveries WHERE id = '01ARZ3NDEKTSV4RRFFQ69G5FB0'").get();
    assert.equal(row.title, "kept");
    assert.equal(row.changedPaths, '["x.ts"]');
    assert.equal(row.status, "pending");
    assert.throws(
      () => h2.db.prepare(insertSql).run("01ARZ3NDEKTSV4RRFFQ69G5FB1", "a1", "task_abcdef", "dup", "code", "[]", new Date().toISOString()),
      /constraint/i,
      "the partial unique index must survive the table rebuild",
    );
    h2.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── P5 — migration v3: prUrl / mode / branch ─────────────────────────────────
test("migration v3 adds prUrl/mode/branch and is idempotent", () => {
  const root = tmp();
  try {
    const path = join(root, "m.db");
    let h = openDb({ path });
    // The ladder is append-only; assert v3's effect (>= 3), not a frozen head version.
    assert.ok(h.version() >= 3, "at least migration v3 applied");
    const cols = h.db.prepare("PRAGMA table_info(deliveries)").all().map((c) => c.name);
    for (const c of ["prUrl", "mode", "branch"]) assert.ok(cols.includes(c), `${c} present`);
    const firstVersion = h.version();
    h.close();
    // Re-open: the ladder must not re-run (append-only + version row in the same txn) —
    // one version row per applied migration, and the head is unchanged on reopen.
    h = openDb({ path });
    assert.equal(h.version(), firstVersion);
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM schema_migrations").get().n, firstVersion);
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migration v3 preserves pre-v3 rows", () => {
  const root = tmp();
  try {
    const path = join(root, "m.db");
    const h1 = openDb({ path });
    h1.db.prepare(
      `INSERT INTO deliveries (id, agentId, title, summary, source, kind, changedPaths, riskReasons, status, createdAt, auditRef)
       VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV','a1','t','s','swarm','code','["src/x.ts"]','[]','pending','2026-07-30T00:00:00.000Z','delivery:x')`,
    ).run();
    // Rewind to a pre-v3 DB shape: drop the columns' version row AND the columns.
    h1.db.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
    for (const c of ["prUrl", "mode", "branch"]) h1.db.exec(`ALTER TABLE deliveries DROP COLUMN ${c};`);
    h1.close();

    const h2 = openDb({ path });
    assert.ok(h2.version() >= 4, "re-migrated to at least v4");
    const row = h2.db.prepare("SELECT * FROM deliveries WHERE id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'").get();
    assert.equal(row.agentId, "a1");
    assert.equal(row.status, "pending");
    assert.equal(row.prUrl, null);
    assert.equal(row.mode, null);
    assert.equal(row.branch, null);
    h2.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── sr-security P5 re-review #5 — migration v4: the landing marker ───────────
test("migration v4 adds `landing`, defaults it NULL, and CHECK-constrains it", () => {
  const root = tmp();
  try {
    const path = join(root, "m4.db");
    const h = openDb({ path });
    assert.ok(h.version() >= 4, "at least migration v4 applied");
    assert.ok(h.db.prepare("PRAGMA table_info(deliveries)").all().map((c) => c.name).includes("landing"));
    const ins = (landing) => h.db.prepare(
      `INSERT INTO deliveries (id, agentId, title, summary, source, kind, changedPaths, riskReasons, status, createdAt, auditRef, landing)
       VALUES (?, 'a1','t','s','swarm','code','[]','[]','approved','2026-07-30T00:00:00.000Z','delivery:x', ?)`,
    ).run(landing === null ? "01ARZ3NDEKTSV4RRFFQ69G5FA0" : `01ARZ3NDEKTSV4RRFFQ69G5FA${landing[0].toUpperCase()}`, landing);
    ins(null);
    ins("pending");
    ins("resolved");
    assert.throws(() => h.db.prepare(
      `INSERT INTO deliveries (id, agentId, title, summary, source, kind, changedPaths, riskReasons, status, createdAt, auditRef, landing)
       VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAZ','a1','t','s','swarm','code','[]','[]','approved','2026-07-30T00:00:00.000Z','delivery:x','bogus')`,
    ).run(), /CHECK/i);
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── P6 / ADR-053 — migration v5: the SLA escalation marker ──────────────────
test("migration v5 adds `slaState`, defaults it NULL, and CHECK-constrains it", () => {
  const root = tmp();
  try {
    const h = openDb({ path: join(root, "m5.db") });
    assert.ok(h.version() >= 5, "at least migration v5 applied");
    assert.ok(h.db.prepare("PRAGMA table_info(deliveries)").all().map((c) => c.name).includes("slaState"));
    // distinct agentIds so the pending-unique index (keyed on agent:<id>) does not collide.
    const ins = (id, agent, slaState) => h.db.prepare(
      `INSERT INTO deliveries (id, agentId, title, summary, source, kind, changedPaths, riskReasons, status, createdAt, auditRef, slaState)
       VALUES (?, ?, 't','s','swarm','code','[]','[]','pending','2026-07-30T00:00:00.000Z','delivery:x', ?)`,
    ).run(id, agent, slaState);
    ins("01ARZ3NDEKTSV4RRFFQ69G5F00", "a0", null);       // NULL allowed (inside first half)
    ins("01ARZ3NDEKTSV4RRFFQ69G5F01", "a1", "halflife");
    ins("01ARZ3NDEKTSV4RRFFQ69G5F02", "a2", "expired");
    assert.throws(() => ins("01ARZ3NDEKTSV4RRFFQ69G5F03", "a3", "bogus"), /CHECK/i);
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mode CHECK rejects an unknown value and accepts the three ladder rungs", () => {
  const root = tmp();
  try {
    const h = openDb({ path: join(root, "m.db") });
    h.db.prepare(
      `INSERT INTO deliveries (id, agentId, title, summary, source, kind, changedPaths, riskReasons, status, createdAt, auditRef)
       VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAW','a1','t','s','swarm','code','[]','[]','pending','2026-07-30T00:00:00.000Z','delivery:y')`,
    ).run();
    assert.throws(
      () => h.db.prepare("UPDATE deliveries SET mode='wat' WHERE id='01ARZ3NDEKTSV4RRFFQ69G5FAW'").run(),
      /CONSTRAINT/i,
    );
    for (const m of ["pr", "branch", "apply"]) {
      h.db.prepare("UPDATE deliveries SET mode=? WHERE id='01ARZ3NDEKTSV4RRFFQ69G5FAW'").run(m);
    }
    h.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

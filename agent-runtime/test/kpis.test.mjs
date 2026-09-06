// B5 / Command Center — the cross-venture KPI aggregator (kpis.mjs). PURE READ over
// the delivery DB: no mutation, no emit, no filesystem. These tests pin the honest-
// numbers contract (hallmark gate 56):
//   • decisionsToday + deliveriesApproved are decided-in-window, CROSS-VENTURE (the
//     deliveries table has no venture column — labeled crossVenture:true).
//   • recordsWritten is venture-scoped when a venture is given, aggregate otherwise.
//   • openFollowUps is GONE as of S0 (its leads-store source was deleted);
//     venture-scoped, 0 is an honest 0 (no leads), never {pending:true} anymore.
//   • ventures[].records is the venture's live vault size; ventures[].pending is the
//     cross-venture pending-delivery count (labeled, same caveat).
//   • Empty DB → all zeros, never null. Window clamped 1h..90d (finite + floor first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import { kpis, clampWindow } from "../kpis.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const tmp = () => mkdtempSync(join(tmpdir(), "ma-kpis-"));

// Direct-insert seed helpers — precise timestamp control the store APIs don't give us.
function seedVenture(db, id, name = id, createdMs = NOW - 10 * DAY) {
  db.prepare("INSERT OR IGNORE INTO ventures(id,name,created_at) VALUES(?,?,?)").run(id, name, createdMs);
}
function seedRecord(db, id, venture, createdMs, node = "tech") {
  db.prepare(
    "INSERT INTO vault_records(id,venture,node,title,author,created_at,body_excerpt,path) VALUES(?,?,?,?,?,?,?,?)",
  ).run(id, venture, node, `t-${id}`, "boss", createdMs, "", `/v/${venture}/${node}/${id}.md`);
}
let dseq = 0;
function seedDelivery(db, { status, createdIso, decidedIso = null }) {
  const n = dseq++;
  const id = `01ABCDEFGHJKMNPQRSTVWXYZ${String(n).padStart(2, "0")}`.slice(0, 26);
  // A distinct taskId per row so two PENDING rows never collide on the partial
  // pending-key unique index (COALESCE(externalKey, taskId, 'agent:'||agentId)).
  db.prepare(
    `INSERT INTO deliveries(id,agentId,taskId,title,summary,source,kind,status,createdAt,decidedAt,auditRef)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, "pm-analyst", `task-${n}`, "t", "s", "swarm", "code", status, createdIso, decidedIso, "ref");
  return id;
}

function withDb(fn) {
  const root = tmp();
  const h = openDb({ path: join(root, "data", "mission.db") });
  try { return fn(h.db); } finally { h.close(); rmSync(root, { recursive: true, force: true }); }
}

const iso = (ms) => new Date(ms).toISOString();

// ── clampWindow — finite + floor + clamp 1h..90d ─────────────────────────────
test("clampWindow: non-finite / non-positive falls back to the 7d default", () => {
  assert.equal(clampWindow(NaN), 7 * DAY);
  assert.equal(clampWindow(undefined), 7 * DAY);
  assert.equal(clampWindow(0), 7 * DAY);
  assert.equal(clampWindow(-5), 7 * DAY);
});

test("clampWindow: clamps to [1h, 90d] and floors a fractional input", () => {
  assert.equal(clampWindow(30 * 60_000), HOUR, "below 1h clamps up to 1h");
  assert.equal(clampWindow(1000 * DAY), 90 * DAY, "above 90d clamps down to 90d");
  assert.equal(clampWindow(2 * DAY), 2 * DAY, "in-range passes through");
  assert.equal(clampWindow(HOUR + 0.9), HOUR, "floors before clamping");
});

// ── empty DB → all zeros, never null ─────────────────────────────────────────
test("empty DB: every metric is zero, only the seeded venture", () => {
  withDb((db) => {
    const k = kpis({ db, nowMs: NOW, windowMs: DAY });
    assert.equal(k.decisionsToday, 0);
    assert.equal(k.recordsWritten, 0);
    assert.equal(k.deliveriesApproved, 0);
    assert.equal(k.pendingDeliveries, 0);
    assert.equal(k.openFollowUps, undefined, "S0 — the leads-sourced metric is REMOVED, not shipped as a permanent 0");
    assert.equal(k.crossVenture, true);
    // migration v9 seeds `waahyu`; it lists with zero records and zero pending.
    assert.deepEqual(k.ventures, [{ id: "waahyu", name: "WAAHYU", records: 0, pending: 0 }]);
  });
});

// S0 — the openFollowUps metric and its leads-store source are DELETED. There is no
// replacement assertion to write here: the field's absence is asserted above, and the
// honest-zero behaviour of the surviving metrics is covered by the empty-DB case.

// ── decisions + approvals are decided-in-window and cross-venture ────────────
test("decisionsToday counts human decisions in the window; auto_approved + pending excluded", () => {
  withDb((db) => {
    const inWin = iso(NOW - 2 * HOUR);
    seedDelivery(db, { status: "approved", createdIso: iso(NOW - 3 * HOUR), decidedIso: inWin });
    seedDelivery(db, { status: "approved", createdIso: iso(NOW - 3 * HOUR), decidedIso: inWin });
    seedDelivery(db, { status: "rejected", createdIso: iso(NOW - 3 * HOUR), decidedIso: inWin });
    seedDelivery(db, { status: "changes_requested", createdIso: iso(NOW - 3 * HOUR), decidedIso: inWin });
    // auto_approved is a decision with NO human — excluded from decisionsToday AND approved.
    seedDelivery(db, { status: "auto_approved", createdIso: iso(NOW - 3 * HOUR), decidedIso: inWin });
    // pending has no decision yet — excluded.
    seedDelivery(db, { status: "pending", createdIso: iso(NOW - 3 * HOUR) });
    // decided BEFORE the window — excluded.
    seedDelivery(db, { status: "approved", createdIso: iso(NOW - 3 * DAY), decidedIso: iso(NOW - 2 * DAY) });

    const k = kpis({ db, nowMs: NOW, windowMs: DAY });
    assert.equal(k.decisionsToday, 4, "2 approved + 1 rejected + 1 changes_requested in window");
    assert.equal(k.deliveriesApproved, 2, "only status='approved' in window (auto_approved excluded)");
    assert.equal(k.pendingDeliveries, 1);
  });
});

test("decisions are cross-venture: the venture scope never filters them", () => {
  withDb((db) => {
    seedDelivery(db, { status: "approved", createdIso: iso(NOW - 3 * HOUR), decidedIso: iso(NOW - 2 * HOUR) });
    const all = kpis({ db, nowMs: NOW, windowMs: DAY });
    const scoped = kpis({ db, nowMs: NOW, windowMs: DAY, venture: "waahyu" });
    assert.equal(all.deliveriesApproved, 1);
    assert.equal(scoped.deliveriesApproved, 1, "a venture scope does not change cross-venture decisions");
    assert.equal(scoped.decisionsToday, all.decisionsToday);
  });
});

// ── recordsWritten — windowed, venture-scoped when given ─────────────────────
test("recordsWritten counts vault rows in the window; venture scopes it", () => {
  withDb((db) => {
    seedVenture(db, "acme", "Acme");
    seedRecord(db, "r1", "waahyu", NOW - 2 * HOUR);
    seedRecord(db, "r2", "waahyu", NOW - 5 * HOUR);
    seedRecord(db, "r3", "acme", NOW - 1 * HOUR);
    seedRecord(db, "r4", "waahyu", NOW - 3 * DAY); // outside the 1d window

    const all = kpis({ db, nowMs: NOW, windowMs: DAY });
    assert.equal(all.recordsWritten, 3, "3 records inside the window, across ventures");
    const scoped = kpis({ db, nowMs: NOW, windowMs: DAY, venture: "waahyu" });
    assert.equal(scoped.recordsWritten, 2, "waahyu wrote 2 inside the window");
    const acme = kpis({ db, nowMs: NOW, windowMs: DAY, venture: "acme" });
    assert.equal(acme.recordsWritten, 1);
  });
});

test("a non-slug venture degrades to aggregate rather than filtering to empty", () => {
  withDb((db) => {
    seedRecord(db, "r1", "waahyu", NOW - 2 * HOUR);
    const bad = kpis({ db, nowMs: NOW, windowMs: DAY, venture: "../etc" });
    assert.equal(bad.recordsWritten, 1, "malformed scope is treated as 'all', not sent to SQL");
  });
});

// ── ventures roster — records = live size (all-time), pending = cross-venture ─
test("ventures roster: records is the venture's all-time size, pending is cross-venture", () => {
  withDb((db) => {
    seedVenture(db, "acme", "Acme");
    seedRecord(db, "r1", "waahyu", NOW - 2 * HOUR);
    seedRecord(db, "r2", "waahyu", NOW - 3 * DAY); // all-time count includes out-of-window rows
    seedRecord(db, "r3", "acme", NOW - 1 * HOUR);
    seedDelivery(db, { status: "pending", createdIso: iso(NOW - HOUR) });
    seedDelivery(db, { status: "pending", createdIso: iso(NOW - HOUR) });

    const k = kpis({ db, nowMs: NOW, windowMs: DAY });
    const waahyu = k.ventures.find((v) => v.id === "waahyu");
    const acme = k.ventures.find((v) => v.id === "acme");
    assert.deepEqual(waahyu, { id: "waahyu", name: "WAAHYU", records: 2, pending: 2 });
    assert.deepEqual(acme, { id: "acme", name: "Acme", records: 1, pending: 2 });
    assert.equal(k.pendingDeliveries, 2, "cross-venture pending, same value on every venture row");
  });
});

// ── window clamp is applied inside kpis (not just the route) ──────────────────
test("kpis clamps a sub-1h window up to 1h before computing `since`", () => {
  withDb((db) => {
    const k = kpis({ db, nowMs: NOW, windowMs: 30 * 60_000 });
    assert.equal(k.windowMs, HOUR);
    assert.equal(k.since, iso(NOW - HOUR));
  });
});

test("kpis requires a db handle", () => {
  assert.throws(() => kpis({ nowMs: NOW, windowMs: DAY }), /db handle/);
});

// ── Phase 14 · task 14.2 — the milestone's number ────────────────────────────
//
// M2-LIVE is "≥ 5 jobs shipped as PRs in one week". Nothing on the board showed it, so the
// target could not be read off the running system at all.
//
// TWO figures, and keeping them apart is the point: a job shipped as a LOCAL BRANCH (no `gh`)
// is shipped, but it is not a PR. Collapsing them would report the branch-only fallback as a
// PR — the same overclaim the ship ladder itself refuses to make.

test("KPI-JOB-1: shipped jobs are counted, and PRs are counted SEPARATELY", () => {
  const db = openDb({ path: join(tmp(), "mission.db") }).db;
  const now = NOW;
  const ins = db.prepare(
    `INSERT INTO jobs(id,title,brief,repo,source,externalKey,status,questions,answers,summary,prUrl,blockedOn,createdAt,updatedAt)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // two shipped with a PR, one shipped as a branch only, one still building
  ins.run("job_a", "a", "b1", null, "paste", null, "shipped", "[]", null, null, "https://github.com/x/y/pull/1", null, now, now);
  ins.run("job_b", "b", "b2", null, "paste", null, "shipped", "[]", null, null, "https://github.com/x/y/pull/2", null, now, now);
  ins.run("job_c", "c", "b3", null, "paste", null, "shipped", "[]", null, null, null, null, now, now);
  ins.run("job_d", "d", "b4", null, "paste", null, "building", "[]", null, null, null, null, now, now);

  const k = kpis({ db, windowMs: 7 * 86_400_000, nowMs: now });
  assert.equal(k.jobsShipped, 3, "a branch-only ship is still a ship");
  assert.equal(k.prsShipped, 2, "a branch-only ship is NOT a PR — counting it as one is the overclaim");
});

test("KPI-JOB-2: a job shipped BEFORE the window is outside it", () => {
  const db = openDb({ path: join(tmp(), "mission.db") }).db;
  const now = NOW;
  const old = now - 30 * 86_400_000;
  db.prepare(
    `INSERT INTO jobs(id,title,brief,repo,source,externalKey,status,questions,answers,summary,prUrl,blockedOn,createdAt,updatedAt)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("job_old", "old", "b", null, "paste", null, "shipped", "[]", null, null, "https://x/pull/9", null, old, old);
  const k = kpis({ db, windowMs: 7 * 86_400_000, nowMs: now });
  assert.equal(k.jobsShipped, 0, "last month's work must not be reported as this week's");
  assert.equal(k.prsShipped, 0);
});

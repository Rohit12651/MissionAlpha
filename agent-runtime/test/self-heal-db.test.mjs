// PHASE 2 TASK 2.3 — SELF-HEALING, PROVEN AGAINST REAL DATABASE ROWS.
//
// The retry ladder is already exercised in autonomy.test.mjs, but at the SEAM: it asserts
// against the `onTerminalFailure` callback the engine calls. That proves the engine INTENDS
// to page the operator; it does not prove a row the Inbox can actually read ever lands.
// This project has twice shipped a feature whose last hop was missing (the PATCH route the
// server 405'd, bulk-decide outside the approver gate), and both looked exactly like a
// working feature from one layer up.
//
// So this file wires the REAL engine to the REAL SQLite delivery store and then reads the
// rows back with SQL — not through the API that wrote them.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createQueue } from "../queue.mjs";
import { createPolicy } from "../policy.mjs";
import { createScheduler } from "../scheduler.mjs";
import { createEngine } from "../engine.mjs";
import { openDb } from "../db.mjs";
import { createDeliveries } from "../deliveries.mjs";

let root, storeDir, dbPath, clock, handle, db, deliveries;

const now = () => clock;
const flush = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ma-selfheal-db-")));
  storeDir = join(root, "store");
  dbPath = join(root, "data", "mission.db");
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(storeDir, { recursive: true });
  clock = 1_700_000_000_000;
  handle = openDb({ path: dbPath, patchesDir: join(root, "patches") });
  db = handle.db;
  deliveries = createDeliveries({ db: handle, now: () => new Date(clock).toISOString() });
});

afterEach(() => {
  try { handle?.close?.(); } catch { /* */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

// A rig with NO worktree manager and an injected broker: this file is about the failure
// path reaching the database, not about git.
function rig({ dispatchFn } = {}) {
  const queue = createQueue({ dir: storeDir, now, maxQueued: 100, leaseMs: 600_000, maxPerAgent: 2 });
  const policy = createPolicy({ file: join(storeDir, "policy.json"), token: "t" });
  let inUse = 0;
  const scheduler = createScheduler({
    tryAcquireSlot: () => (inUse >= 2 ? false : (inUse++, true)),
    releaseSlot: () => { inUse = Math.max(0, inUse - 1); },
    claimNext: () => queue.claimNext(),
  });
  const engine = createEngine({
    queue, policy, scheduler,
    broker: { listChanges: async () => [], applyChanges: async () => [] },
    dispatchFn,
    // THE SEAM UNDER TEST — wired exactly as server.mjs wires it.
    onTerminalFailure: (_task, info) => { deliveries.mintFailure(info); },
    now, jitter: () => 0, goalsDir: join(storeDir, "goals"),
    setTimer: () => ({ __inert: true }), clearTimer: () => {},
  });
  return { engine, queue };
}

const rows = (sql, ...args) => db.prepare(sql).all(...args);

test("a transient failure retries behind a backoff, and NOTHING is written to the DB yet", async () => {
  const r = rig({ dispatchFn: async () => ({ error: "spawn EAGAIN" }) });
  r.engine.enqueueGoal({ agentId: "sre", steps: ["do it"] });
  r.engine.start();
  await flush();

  const retry = r.queue.all().find((t) => t.status === "queued" && t.attempts === 1);
  assert.ok(retry, "a retry attempt is queued");
  assert.ok(Date.parse(retry.notBefore) > clock, "the backoff gate is in the future");

  // Paging the operator on attempt 1 of 3 is how an Inbox becomes noise nobody reads.
  assert.equal(rows("SELECT id FROM deliveries").length, 0, "no delivery while the budget remains");
});

test("EXHAUSTED RETRIES LAND A REAL ROW — read back with SQL, not through the writer's API", async () => {
  const r = rig({ dispatchFn: async () => ({ error: "spawn EAGAIN" }) });
  r.engine.enqueueGoal({ agentId: "sre", steps: ["do it"] });
  r.engine.start();
  await flush();

  for (let i = 0; i < 5 && rows("SELECT id FROM deliveries").length === 0; i++) {
    clock += 120_000; // past every backoff
    r.engine.tick();
    await flush();
  }

  const found = rows("SELECT id, agentId, kind, status, title, summary FROM deliveries");
  assert.equal(found.length, 1, "exactly one failure Delivery once the budget is spent");
  assert.equal(found[0].agentId, "sre");
  assert.equal(found[0].kind, "failure");
  assert.equal(found[0].status, "pending", "a failure waits for a human — it is never auto-decided");
  assert.match(`${found[0].title} ${found[0].summary}`, /EAGAIN|spawn/i, "the row must carry WHY, not just THAT");

  // And the task itself is terminal — a paged operator plus a task still claiming to be
  // running would be two different stories about the same work.
  const terminal = r.queue.all().filter((t) => t.status === "failed");
  assert.ok(terminal.length >= 1);
  assert.equal(terminal.at(-1).engineState, "FAILED");
});

test("the failure row is visible to the INBOX QUERY, not merely present in the table", async () => {
  // A row that exists but does not match the pending listing is a row the operator never
  // sees. "It is in the database" is not the same claim as "it reached the Inbox".
  const r = rig({ dispatchFn: async () => ({ error: "spawn EAGAIN" }) });
  r.engine.enqueueGoal({ agentId: "sre", steps: ["do it"] });
  r.engine.start();
  await flush();
  for (let i = 0; i < 5 && rows("SELECT id FROM deliveries").length === 0; i++) {
    clock += 120_000;
    r.engine.tick();
    await flush();
  }

  const items = deliveries.list({ status: "pending", limit: 20 });
  assert.ok(Array.isArray(items) && items.length === 1, "the failure must appear in the pending queue");
  assert.equal(items[0].kind, "failure");
  assert.equal(items[0].agentId, "sre");
});

test("a NON-RETRYABLE failure pages immediately — one attempt, one row, no wasted retries", async () => {
  // apply-rejected is a guard verdict: deterministic, so re-running it burns budget to
  // reach the same answer and delays the page. It must reach the operator on failure ONE.
  const store2 = join(root, "store2");
  mkdirSync(store2, { recursive: true });
  const queue = createQueue({ dir: store2, now, maxQueued: 100, leaseMs: 600_000, maxPerAgent: 2 });
  // Trust this agent so the diff actually reaches applyChanges — an untrusted agent would
  // HOLD at the policy gate and the guard verdict under test would never be produced.
  const policy = createPolicy({ file: join(store2, "policy.json"), token: "t" });
  policy.setLevel("sre", "auto-safe");
  let inUse = 0;
  const scheduler = createScheduler({
    tryAcquireSlot: () => (inUse >= 2 ? false : (inUse++, true)),
    releaseSlot: () => { inUse = Math.max(0, inUse - 1); },
    claimNext: () => queue.claimNext(),
  });
  const engine = createEngine({
    queue, policy, scheduler,
    broker: {
      listChanges: async () => [{ path: "src/a.ts", diff: "+1" }],
      applyChanges: async (_id, paths) => paths.map((p) => ({ path: p, ok: false, error: "protected key changed: scripts" })),
    },
    dispatchFn: async () => ({ acc: "wrote" }),
    onTerminalFailure: (_t, info) => { deliveries.mintFailure(info); },
    now, jitter: () => 0, goalsDir: join(store2, "goals"),
    setTimer: () => ({ __inert: true }), clearTimer: () => {},
  });
  engine.enqueueGoal({ agentId: "sre", steps: ["edit config"] });
  engine.start();
  await flush();

  assert.equal(queue.all().filter((t) => t.status === "held").length, 0, "the policy must have let the apply run");
  const found = rows("SELECT agentId, kind, status, summary FROM deliveries");
  assert.equal(found.length, 1, "one attempt, one row");
  assert.equal(found[0].kind, "failure");
  assert.match(found[0].summary, /protected key/, "the guard's own words reach the operator");
  assert.equal(queue.all().filter((t) => t.status === "queued").length, 0, "a guard verdict is never retried");
  assert.equal(queue.all().filter((t) => t.status === "failed").length, 1);
});

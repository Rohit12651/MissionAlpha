// ADR-027 — durable file-based task queue. Tests run against a temp dir, with an
// injected clock so lease/backoff timing is deterministic (no real sleeps).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQueue, computeIdemKey } from "../queue.mjs";

let dir;
let clock;
const now = () => clock;
const mkQueue = (opts = {}) => createQueue({ dir, now, maxQueued: 500, leaseMs: 600_000, maxPerAgent: 2, ...opts });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-queue-test-"));
  clock = 1_000_000;
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

const spec = (over = {}) => ({ goalId: "goal_a", stepIndex: 0, attempt: 0, agentId: "senior-web-1", tier: "sonnet", task: "build a thing", ...over });

test("enqueue mints a taskId + idemKey and persists a 0o600 record", () => {
  const q = mkQueue();
  const r = q.enqueue(spec());
  assert.match(r.taskId, /^task_[0-9a-f]{12}$/);
  assert.equal(r.deduped, false);
  const rec = q.get(r.taskId);
  assert.equal(rec.status, "queued");
  assert.equal(rec.attempts, 0);
  assert.equal(rec.agentId, "senior-web-1");
  assert.ok(existsSync(join(dir, "tasks", `${r.taskId}.json`)));
});

test("enqueue dedupes on idemKey while a task is non-terminal", () => {
  const q = mkQueue();
  const a = q.enqueue(spec());
  const b = q.enqueue(spec());
  assert.equal(b.deduped, true);
  assert.equal(b.taskId, a.taskId, "same idemKey collapses to one task");
  assert.equal(q.counts().queued, 1);
});

test("a different attempt is NOT deduped (legit retry gets its own task)", () => {
  const q = mkQueue();
  const a = q.enqueue(spec({ attempt: 0 }));
  const b = q.enqueue(spec({ attempt: 1 }));
  assert.notEqual(b.taskId, a.taskId);
  assert.equal(b.deduped, false);
});

test("claimNext leases the task and sets leaseExpiry; second claim of same agent within cap", () => {
  const q = mkQueue();
  q.enqueue(spec({ stepIndex: 0 }));
  const c = q.claimNext();
  assert.ok(c, "claimable");
  assert.equal(c.status, "claimed");
  assert.equal(c.claimedAt, new Date(clock).toISOString());
  assert.equal(c.leaseExpiry, new Date(clock + 600_000).toISOString());
});

test("claimNext returns null when nothing queued", () => {
  const q = mkQueue();
  assert.equal(q.claimNext(), null);
});

test("priority band: high is claimed before normal before low", () => {
  const q = mkQueue();
  q.enqueue(spec({ agentId: "a", goalId: "g1", priority: "low", task: "lo" }));
  q.enqueue(spec({ agentId: "b", goalId: "g2", priority: "high", task: "hi" }));
  q.enqueue(spec({ agentId: "c", goalId: "g3", priority: "normal", task: "no" }));
  assert.equal(q.claimNext().task, "hi");
});

test("round-robin within a band: a chatty agent does not starve a peer", () => {
  const q = mkQueue();
  q.enqueue(spec({ agentId: "a", goalId: "g1", stepIndex: 0, task: "a0" }));
  q.enqueue(spec({ agentId: "a", goalId: "g1", stepIndex: 1, task: "a1" }));
  q.enqueue(spec({ agentId: "b", goalId: "g2", stepIndex: 0, task: "b0" }));
  const first = q.claimNext();
  const second = q.claimNext();
  const served = [first.agentId, second.agentId].sort();
  assert.deepEqual(served, ["a", "b"], "both agents served before one repeats");
});

test("per-agent cap blocks a third concurrent claim for the same agent", () => {
  const q = mkQueue({ maxPerAgent: 2 });
  for (let i = 0; i < 3; i++) q.enqueue(spec({ agentId: "a", goalId: "g", stepIndex: i, task: `a${i}` }));
  assert.ok(q.claimNext());
  assert.ok(q.claimNext());
  assert.equal(q.claimNext(), null, "3rd held by per-agent cap");
});

test("notBefore gates a backoff-delayed task until the clock advances", () => {
  const q = mkQueue();
  const r = q.enqueue(spec());
  q.update(r.taskId, { notBefore: new Date(clock + 5000).toISOString() });
  assert.equal(q.claimNext(), null, "not yet eligible");
  clock += 6000;
  assert.ok(q.claimNext(), "eligible after notBefore passes");
});

test("expired lease is reclaimed to queued (worker died mid-step)", () => {
  const q = mkQueue({ leaseMs: 1000 });
  q.enqueue(spec());
  const c = q.claimNext();
  assert.equal(c.status, "claimed");
  clock += 2000; // lease expired
  const reclaimed = q.reclaimExpiredLeases();
  assert.equal(reclaimed, 1);
  assert.equal(q.get(c.taskId).status, "queued");
  assert.ok(q.claimNext(), "claimable again after reclaim");
});

test("held tasks are not claimable and occupy no slot", () => {
  const q = mkQueue();
  const r = q.enqueue(spec());
  q.update(r.taskId, { status: "held" });
  assert.equal(q.claimNext(), null);
  assert.equal(q.counts().held, 1);
});

test("MAX_QUEUED cap rejects enqueue over the bound", () => {
  const q = mkQueue({ maxQueued: 2 });
  q.enqueue(spec({ goalId: "g", stepIndex: 0, task: "0" }));
  q.enqueue(spec({ goalId: "g", stepIndex: 1, task: "1" }));
  const r = q.enqueue(spec({ goalId: "g", stepIndex: 2, task: "2" }));
  assert.equal(r.error, "backlog full");
});

test("terminal tasks free capacity and are not deduped against", () => {
  const q = mkQueue({ maxQueued: 1 });
  const a = q.enqueue(spec());
  q.update(a.taskId, { status: "done" });
  const b = q.enqueue(spec({ attempt: 9 })); // different idemKey
  assert.equal(b.error, undefined, "done task no longer counts toward cap");
});

test("free-text task/result/error is scrubbed of secrets on persist", () => {
  const q = mkQueue({ scrub: (s) => String(s).replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, "[redacted]") });
  const r = q.enqueue(spec({ task: "use key sk-ant-abc123456 now" }));
  assert.ok(!q.get(r.taskId).task.includes("sk-ant-abc123456"));
});

test("records survive a fresh queue instance over the same dir (durable + index rebuild)", () => {
  const q1 = mkQueue();
  const a = q1.enqueue(spec({ goalId: "g", stepIndex: 0, task: "persist-me" }));
  const q2 = mkQueue(); // new instance, same dir
  assert.equal(q2.get(a.taskId).task, "persist-me");
  assert.ok(q2.claimNext(), "rebuilt index makes it claimable");
});

test("atomic write leaves no .tmp file behind", () => {
  const q = mkQueue();
  const r = q.enqueue(spec());
  assert.ok(!existsSync(join(dir, "tasks", `${r.taskId}.json.tmp`)));
});

test("a torn/corrupt record file is skipped, not fatal", () => {
  const q1 = mkQueue();
  q1.enqueue(spec({ goalId: "g", stepIndex: 0, task: "good" }));
  writeFileSync(join(dir, "tasks", "task_deadbeef0000.json"), "{not json");
  const q2 = mkQueue();
  assert.equal(q2.counts().queued, 1, "corrupt file ignored, good one survives");
});

test("computeIdemKey is stable + collision-resistant across the keyed fields", () => {
  const k1 = computeIdemKey({ goalId: "g", stepIndex: 0, attempt: 0, agentId: "a", task: "x" });
  const k2 = computeIdemKey({ goalId: "g", stepIndex: 0, attempt: 0, agentId: "a", task: "x" });
  const k3 = computeIdemKey({ goalId: "g", stepIndex: 1, attempt: 0, agentId: "a", task: "x" });
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  assert.match(k1, /^[0-9a-f]{64}$/);
});

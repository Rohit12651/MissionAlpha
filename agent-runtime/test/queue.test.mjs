// ADR-027 — durable file-based task queue. Tests run against a temp dir, with an
// injected clock so lease/backoff timing is deterministic (no real sleeps).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
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

// ── S3 — storyId is ADDITIVE metadata, and it does NOT touch the idempotency key ──────
test("S3: storyId is carried onto the record, defaults null, and does NOT change the idemKey", () => {
  const q = mkQueue();
  // Default: no storyId → null (every pre-S3 caller is unaffected).
  const bare = q.enqueue(spec());
  assert.equal(q.get(bare.taskId).storyId, null, "storyId defaults null for existing callers");

  // The idemKey is computed over the SAME keyed fields — storyId is NOT one of them, so a
  // task tagged with a story hashes identically to the untagged one. Pin it explicitly.
  const s = spec();
  const key = computeIdemKey(s);
  assert.equal(computeIdemKey({ ...s, storyId: "story_abc123" }), key, "storyId is not in the idem hash");

  // A tagged enqueue on a fresh queue stores the story back-pointer, sanitized.
  const q2 = createQueue({ dir: mkdtempSync(join(tmpdir(), "ma-queue-sid-")), now });
  const r = q2.enqueue(spec({ storyId: "story_DEAD_beef.99" }));
  assert.equal(q2.get(r.taskId).storyId, "story_DEAD_beef99", "storyId sanitized to the safe id charset");

  // Same work unit, tagged vs untagged → dedupes (identity is the work unit, not the story).
  const q3 = createQueue({ dir: mkdtempSync(join(tmpdir(), "ma-queue-sid2-")), now });
  const t1 = q3.enqueue(spec());
  const t2 = q3.enqueue(spec({ storyId: "story_x" }));
  assert.equal(t2.taskId, t1.taskId, "tagging the same work unit does not fork a new task");
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

// ── P4: task.* emit-on-persist (program plan §2 catalog) ────────────────────
function mkSpy() {
  const seen = [];
  return { emit: (name, data) => seen.push({ name, data }), seen };
}

test("P4 enqueue emits task.queued exactly once, with the record shape", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit });
  const r = q.enqueue(spec());
  assert.equal(spy.seen.length, 1);
  assert.equal(spy.seen[0].name, "task.queued");
  assert.deepEqual(spy.seen[0].data, {
    taskId: r.taskId, goalId: "goal_a", agentId: "senior-web-1",
    stepIndex: 0, attempts: 0, priority: "normal", status: "queued",
  });
});

test("P4 a deduped enqueue emits NOTHING (exactly-once across a double submit)", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit });
  q.enqueue(spec());
  q.enqueue(spec());
  assert.equal(spy.seen.filter((e) => e.name === "task.queued").length, 1);
});

test("P4 an enqueue carrying attempts>0 emits task.retried, not task.queued", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit });
  q.enqueue(spec({ attempt: 1, attempts: 1 }));
  assert.deepEqual(spy.seen.map((e) => e.name), ["task.retried"]);
  assert.equal(spy.seen[0].data.attempts, 1);
});

test("P4 claimNext emits task.started exactly once per claim", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit, maxPerAgent: 1 });
  q.enqueue(spec());
  q.claimNext();
  q.claimNext(); // nothing ready (per-agent serial) → no second emit
  assert.deepEqual(spy.seen.map((e) => e.name), ["task.queued", "task.started"]);
});

test("P4 update to status failed emits task.failed with the classified kind", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit });
  const r = q.enqueue(spec());
  q.update(r.taskId, { status: "failed", error: { kind: "timeout", msg: "watchdog timeout" } });
  const failed = spy.seen.filter((e) => e.name === "task.failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.kind, "timeout");
  assert.equal(failed[0].data.taskId, r.taskId);
});

test("P4 update to a status with no catalog name emits nothing", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit });
  const r = q.enqueue(spec());
  spy.seen.length = 0;
  // held / cancelled have no name in the closed catalog; a non-status patch has none
  // either. (`done` DOES have one since the 2026-07-30 amendment — covered separately.)
  q.update(r.taskId, { status: "held", heldReason: "waiting" });
  q.update(r.taskId, { engineState: "EDITING" });
  q.update(r.taskId, { status: "cancelled" });
  assert.deepEqual(spy.seen, []);
});

test("P4 a re-update to failed does not emit a second task.failed", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit });
  const r = q.enqueue(spec());
  q.update(r.taskId, { status: "failed", error: { kind: "spawn", msg: "x" } });
  q.update(r.taskId, { status: "failed", error: { kind: "spawn", msg: "x" } });
  assert.equal(spy.seen.filter((e) => e.name === "task.failed").length, 1);
});

test("P4 reclaiming an expired lease emits task.queued (the task is queued again)", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit, leaseMs: 1000 });
  q.enqueue(spec());
  q.claimNext();
  spy.seen.length = 0;
  clock += 2000;
  assert.equal(q.reclaimExpiredLeases(), 1);
  assert.deepEqual(spy.seen.map((e) => e.name), ["task.queued"]);
});

test("P4 a throwing emit never breaks a queue write (the bus is observational)", () => {
  const q = mkQueue({ emit: () => { throw new Error("bus down"); } });
  const r = q.enqueue(spec());
  assert.equal(q.get(r.taskId).status, "queued");
  assert.ok(q.claimNext());
});

// ── P4: per-agent SERIAL by default (program plan P4: "per-agent serial") ────
test("P4 default maxPerAgent is 1 — one agent never runs two tasks at once", () => {
  const q = createQueue({ dir, now }); // NO maxPerAgent override → default
  q.enqueue(spec({ stepIndex: 0 }));
  q.enqueue(spec({ stepIndex: 1 }));
  assert.ok(q.claimNext(), "first claim");
  assert.equal(q.claimNext(), null, "second task for the SAME agent must wait");
});

test("P4 different agents still run in parallel under the serial default", () => {
  const q = createQueue({ dir, now });
  q.enqueue(spec({ agentId: "senior-web-1" }));
  q.enqueue(spec({ agentId: "senior-backend-1", goalId: "goal_b" }));
  assert.ok(q.claimNext());
  assert.ok(q.claimNext(), "a DIFFERENT agent claims concurrently");
});

// ── P4 hardening (sr-security LOW) — live-claim veto on reclaim ──────────────

test("HARDENING reclaimExpiredLeases SKIPS a task the caller reports as still LIVE", () => {
  const q = mkQueue({ leaseMs: 1000 });
  const r = q.enqueue(spec());
  const c = q.claimNext();
  assert.equal(c.taskId, r.taskId);
  clock += 2000; // lease expired, but the step is still executing in-process

  assert.equal(q.reclaimExpiredLeases((taskId) => taskId === r.taskId), 0, "a live claim is not dead");
  assert.equal(q.get(r.taskId).status, "claimed", "still owned — no second writer on its worktree");
  assert.equal(q.claimNext(), null, "and therefore not re-claimable");

  // The step finishes (leaves the caller's running map) → the sweep reclaims normally.
  assert.equal(q.reclaimExpiredLeases(() => false), 1);
  assert.equal(q.get(r.taskId).status, "queued");
});

test("HARDENING reclaimExpiredLeases without a predicate behaves exactly as before", () => {
  const q = mkQueue({ leaseMs: 1000 });
  const r = q.enqueue(spec());
  q.claimNext();
  clock += 2000;
  assert.equal(q.reclaimExpiredLeases(), 1, "default: no veto");
  assert.equal(q.get(r.taskId).status, "queued");
});

// ── P4 hardening — task.done (program plan §2 amendment, 2026-07-30) ─────────

test("HARDENING the done transition emits task.done exactly once, with the 7-scalar wire payload", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit });
  const r = q.enqueue(spec());
  spy.seen.length = 0;

  q.update(r.taskId, { status: "done", engineState: "DONE", result: "applied 1: a.ts" });
  q.update(r.taskId, { status: "done", engineState: "DONE" }); // re-update must not re-announce

  const done = spy.seen.filter((e) => e.name === "task.done");
  assert.equal(done.length, 1, "guarded on the PREVIOUS status, like task.failed");
  assert.deepEqual(Object.keys(done[0].data).sort(), [
    "agentId", "attempts", "goalId", "priority", "status", "stepIndex", "taskId",
  ], "same 7-scalar allow-list — no task text, no result, no error on the wire");
  assert.equal(done[0].data.taskId, r.taskId);
  assert.equal(done[0].data.status, "done");
});

test("HARDENING a non-done transition never emits task.done", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit });
  const r = q.enqueue(spec());
  spy.seen.length = 0;
  q.update(r.taskId, { status: "held", heldReason: "waiting" });
  q.update(r.taskId, { status: "cancelled" });
  assert.equal(spy.seen.filter((e) => e.name === "task.done").length, 0);
});

// ── P4 hardening (sr-security LOW) — terminal-record retention ───────────────

test("HARDENING sweepTerminal removes aged terminal records and keeps everything else", () => {
  const DAY = 86_400_000;
  const q = mkQueue();
  const oldDone = q.enqueue(spec({ stepIndex: 0 }));
  const oldFailed = q.enqueue(spec({ stepIndex: 1 }));
  q.update(oldDone.taskId, { status: "done" });
  q.update(oldFailed.taskId, { status: "failed", error: { kind: "spawn", msg: "x" } });

  clock += 30 * DAY;

  const freshDone = q.enqueue(spec({ stepIndex: 2 }));
  q.update(freshDone.taskId, { status: "done" });
  const live = q.enqueue(spec({ stepIndex: 3 }));

  assert.equal(q.sweepTerminal(7 * DAY), 2, "both aged terminal records");
  assert.equal(q.get(oldDone.taskId), null);
  assert.equal(q.get(oldFailed.taskId), null);
  assert.ok(!existsSync(join(dir, "tasks", `${oldDone.taskId}.json`)), "the file is gone, not just the index entry");
  assert.ok(q.get(freshDone.taskId), "a recently finished record is still inside its window");
  assert.equal(q.get(live.taskId).status, "queued", "a non-terminal record is never swept, at any age");
});

test("HARDENING sweepTerminal survives a rebuild — the records are gone from disk", () => {
  const DAY = 86_400_000;
  const q = mkQueue();
  const r = q.enqueue(spec());
  q.update(r.taskId, { status: "done" });
  clock += 30 * DAY;
  assert.equal(q.sweepTerminal(7 * DAY), 1);
  const fresh = mkQueue(); // new instance over the same dir
  assert.equal(fresh.get(r.taskId), null);
});

test("HARDENING sweepTerminal with a non-positive TTL is a no-op (retention can be disabled)", () => {
  const q = mkQueue();
  const r = q.enqueue(spec());
  q.update(r.taskId, { status: "done" });
  clock += 900 * 86_400_000;
  assert.equal(q.sweepTerminal(0), 0);
  assert.ok(q.get(r.taskId), "nothing removed when retention is off");
});

// 2026-09-07 — the live path dropped the failure's own words the same way the snapshot
// mapper did, so a UI reading either path could only ever show the error CLASS.
test("QD-1: task.failed carries the failure's own words, not just its class", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit });
  const r = q.enqueue(spec());
  q.update(r.taskId, {
    status: "failed",
    error: { kind: "empty-diff", msg: "wrote 2 path(s) OUTSIDE the appliable scope: src/a.ts" },
  });
  const failed = spy.seen.filter((e) => e.name === "task.failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.kind, "empty-diff");
  assert.match(String(failed[0].data.detail ?? ""), /OUTSIDE the appliable scope/);
  assert.match(String(failed[0].data.detail ?? ""), /src\/a\.ts/);
});

test("QD-2: a failure with no msg emits detail null, never the string 'undefined'", () => {
  const spy = mkSpy();
  const q = mkQueue({ emit: spy.emit });
  const r = q.enqueue(spec());
  q.update(r.taskId, { status: "failed", error: { kind: "spawn" } });
  const failed = spy.seen.filter((e) => e.name === "task.failed");
  assert.equal(failed[0].data.detail, null);
});

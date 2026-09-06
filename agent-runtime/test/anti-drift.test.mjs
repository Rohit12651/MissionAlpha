// Phase 4 / R14 — ANTI-DRIFT.
//
// AUDIT FIRST (the delta, not a rebuild). queue.mjs already has:
//   • per-agent serialization (maxPerAgent, default 1) inside claimNext
//   • a LEASE + reclaimExpiredLeases(isLive) that requeues a claimed task whose owner died
//   • a watchdog in engine.runStep around the dispatch itself
// What it does NOT have, and what this module adds:
//   (a) per-STORY concurrency. storyId is persisted but no scheduling decision reads it,
//       so two agents can build one story in parallel, each diffing against a base the
//       other is about to move.
//   (b) any surfacing of a wedge. reclaimExpiredLeases only fires when isLive() is FALSE;
//       a task whose handle is still live but which never settles is invisible forever,
//       and a queued task nothing ever claims is invisible forever. That is the exact
//       class that hid a three-day outage: the system was not failing, it was silent.
//
// LAW 3 is the shape of the output and is pinned by LAW3-*: kind 'failure', DIFF-LESS
// (so auto-apply is structurally impossible, not merely disallowed), ONE per stall
// episode, and daily-capped through the same worker-cap store the cadence workers use.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAntiDrift, STALL_STATES, DEFAULT_STALL_MS } from "../anti-drift.mjs";
import { createQueue } from "../queue.mjs";

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function harness(tasks, over = {}) {
  const minted = [];
  const logs = [];
  let clock = over.now ?? T0;
  const capCalls = [];
  const cap = over.cap === null ? null : (over.cap ?? {
    allows: () => true,
    consume: (id) => { capCalls.push(id); return { ok: true, used: 1, cap: 3 }; },
  });
  const ad = createAntiDrift({
    queue: { all: () => tasks },
    // NOTE: an ABSENT dep must be passed as null, never undefined — a default parameter
    // fires only for undefined and would silently re-supply the very thing under test.
    mintFailure: over.mintFailure === null ? null : (over.mintFailure ?? ((i) => { minted.push(i); return { id: `d${minted.length}` }; })),
    cap,
    stallMs: over.stallMs ?? 30 * MIN,
    now: () => clock,
    log: (m) => logs.push(m),
  });
  return { ad, minted, logs, capCalls, advance: (ms) => { clock += ms; } };
}

const task = (over = {}) => ({
  taskId: "task_aaa111", agentId: "a1", storyId: null, status: "queued",
  updatedAt: new Date(T0 - 5 * MIN).toISOString(), attempts: 0, ...over,
});

// ── stall detection ──────────────────────────────────────────────────────────

test("AD-1: a recently-updated task is not stalled", () => {
  const h = harness([task()]);
  const r = h.ad.sweep();
  assert.equal(r.stalled, 0);
  assert.equal(h.minted.length, 0);
});

test("AD-2: a QUEUED task past the window mints exactly one escalation", () => {
  const h = harness([task({ updatedAt: new Date(T0 - 45 * MIN).toISOString() })]);
  const r = h.ad.sweep();
  assert.equal(r.stalled, 1);
  assert.equal(r.minted, 1);
  assert.equal(h.minted.length, 1);
  assert.equal(h.minted[0].taskId, "task_aaa111");
});

test("AD-3: a CLAIMED task past the window stalls — a live handle is not progress", () => {
  const h = harness([task({ status: "claimed", updatedAt: new Date(T0 - 45 * MIN).toISOString() })]);
  assert.equal(h.ad.sweep().minted, 1);
});

test("AD-4: HELD is NEVER a stall — a human deciding slowly is not drift", () => {
  const h = harness([task({ status: "held", updatedAt: new Date(T0 - 10 * 60 * MIN).toISOString() })]);
  assert.equal(h.ad.sweep().stalled, 0);
  assert.equal(h.minted.length, 0, "the operator already has this row in the Inbox");
  assert.ok(!STALL_STATES.has("held"));
});

test("AD-5: terminal states never stall", () => {
  for (const status of ["done", "failed", "cancelled"]) {
    const h = harness([task({ status, updatedAt: new Date(T0 - 99 * 60 * MIN).toISOString() })]);
    assert.equal(h.ad.sweep().stalled, 0, `${status} must not stall`);
  }
});

test("AD-6: ONE PER EPISODE — sweeping again on an unchanged task mints nothing", () => {
  const t = task({ updatedAt: new Date(T0 - 45 * MIN).toISOString() });
  const h = harness([t]);
  assert.equal(h.ad.sweep().minted, 1);
  h.advance(60 * MIN);
  const second = h.ad.sweep();
  assert.equal(second.minted, 0);
  assert.equal(second.repeats, 1, "still stalled, already reported — the episode is one event");
  assert.equal(h.minted.length, 1);
});

test("AD-7: a task that MOVED and stalled again is a NEW episode", () => {
  const t = task({ updatedAt: new Date(T0 - 45 * MIN).toISOString() });
  const h = harness([t]);
  assert.equal(h.ad.sweep().minted, 1);
  // the task made progress, then went quiet again
  t.updatedAt = new Date(T0 + 10 * MIN).toISOString();
  h.advance(60 * MIN);
  assert.equal(h.ad.sweep().minted, 1, "a fresh wedge after progress deserves a fresh alert");
  assert.equal(h.minted.length, 2);
});

test("AD-8: an unparseable updatedAt is NOT treated as infinitely old", () => {
  // null-is-not-zero, applied to time: Date.parse(undefined) is NaN, and NaN comparisons
  // are false — but a `null` timestamp coerces to 0 and would read as 1970, i.e. maximally
  // stalled. An absent measurement is not an extreme measurement.
  for (const updatedAt of [null, undefined, "", "not-a-date", 0]) {
    const h = harness([task({ updatedAt })]);
    assert.equal(h.ad.sweep().minted, 0, `updatedAt=${JSON.stringify(updatedAt)} must not mint`);
  }
});

// ── LAW 3 ────────────────────────────────────────────────────────────────────

test("LAW3-1: the escalation is kind 'failure' and carries NO diff", () => {
  const h = harness([task({ updatedAt: new Date(T0 - 45 * MIN).toISOString() })]);
  h.ad.sweep();
  const m = h.minted[0];
  // mintFailure is the ONLY mint path used: it hard-codes kind='failure', diffFiles=0 and
  // changedPaths='[]' in its INSERT, so an auto-apply has literally nothing to apply.
  // Passing any change set is therefore impossible from here — assert we never try.
  assert.equal(m.changes, undefined);
  assert.equal(m.diff, undefined);
  assert.ok(m.kind, "the classified failure kind must be named");
  assert.match(m.kind, /stall/i);
});

test("LAW3-2: over the daily cap, nothing is minted and the refusal is reported", () => {
  const h = harness([task({ updatedAt: new Date(T0 - 45 * MIN).toISOString() })], {
    cap: { allows: () => false, consume: () => ({ ok: false, used: 3, cap: 3 }) },
  });
  const r = h.ad.sweep();
  assert.equal(r.stalled, 1);
  assert.equal(r.minted, 0);
  assert.equal(r.capped, 1);
  assert.equal(h.minted.length, 0);
});

test("LAW3-3: with NO cap seam the sweep mints NOTHING — a law needs its mechanism", () => {
  const h = harness([task({ updatedAt: new Date(T0 - 45 * MIN).toISOString() })], { cap: null });
  const r = h.ad.sweep();
  assert.equal(r.minted, 0);
  assert.ok(h.logs.some((l) => /cap/i.test(l)), "and it must say why, loudly");
});

test("LAW3-4: the cap is consumed under a stable id so it shares one daily budget", () => {
  const h = harness([
    task({ taskId: "task_aaa111", updatedAt: new Date(T0 - 45 * MIN).toISOString() }),
    task({ taskId: "task_bbb222", updatedAt: new Date(T0 - 45 * MIN).toISOString() }),
  ]);
  h.ad.sweep();
  assert.deepEqual(new Set(h.capCalls).size, 1, "one budget for all stall escalations, not one per task");
});

// ── robustness ───────────────────────────────────────────────────────────────

test("AD-9: a throwing mint does not abandon the rest of the sweep", () => {
  let n = 0;
  const h = harness([
    task({ taskId: "task_aaa111", updatedAt: new Date(T0 - 45 * MIN).toISOString() }),
    task({ taskId: "task_bbb222", updatedAt: new Date(T0 - 45 * MIN).toISOString() }),
  ], { mintFailure: () => { if (++n === 1) throw new Error("db locked"); return { id: "d" }; } });
  const r = h.ad.sweep();
  assert.equal(r.minted, 1);
  assert.equal(r.errors, 1);
});

test("AD-10: a throwing queue is contained — the sweep never takes the timer with it", () => {
  const ad = createAntiDrift({
    queue: { all: () => { throw new Error("store fault"); } },
    mintFailure: () => ({ id: "x" }),
    cap: { allows: () => true, consume: () => ({ ok: true }) },
  });
  const r = ad.sweep();
  assert.equal(r.errors >= 1, true);
  assert.equal(r.minted, 0);
});

test("AD-11: the default window is 30 minutes", () => {
  assert.equal(DEFAULT_STALL_MS, 30 * MIN);
});

// ── (a) the per-STORY concurrency cap — the queue delta ──────────────────────

function q(over = {}) {
  return createQueue({ dir: mkdtempSync(join(tmpdir(), "ad-queue-")), ...over });
}

test("STORY-1: two agents on ONE story cannot be claimed at the same time", () => {
  const queue = q({ maxPerStory: 1 });
  queue.enqueue({ goalId: "g1", stepIndex: 0, agentId: "a1", storyId: "s1", task: "one" });
  queue.enqueue({ goalId: "g2", stepIndex: 0, agentId: "a2", storyId: "s1", task: "two" });
  assert.ok(queue.claimNext(), "the first step claims");
  assert.equal(queue.claimNext(), null, "the second must wait — same story, moving base");
});

test("STORY-2: different stories still run in parallel", () => {
  const queue = q({ maxPerStory: 1 });
  queue.enqueue({ goalId: "g1", stepIndex: 0, agentId: "a1", storyId: "s1", task: "one" });
  queue.enqueue({ goalId: "g2", stepIndex: 0, agentId: "a2", storyId: "s2", task: "two" });
  assert.ok(queue.claimNext());
  assert.ok(queue.claimNext(), "the story cap must not become a global serializer");
});

test("STORY-3: story-less tasks are never capped by it", () => {
  const queue = q({ maxPerStory: 1 });
  queue.enqueue({ goalId: "g1", stepIndex: 0, agentId: "a1", task: "one" });
  queue.enqueue({ goalId: "g2", stepIndex: 0, agentId: "a2", task: "two" });
  assert.ok(queue.claimNext());
  assert.ok(queue.claimNext(), "a null storyId is not a story every task shares");
});

test("STORY-4: REGRESSION — maxPerStory:0 restores byte-identical pre-R14 claiming", () => {
  const queue = q({ maxPerStory: 0 });
  queue.enqueue({ goalId: "g1", stepIndex: 0, agentId: "a1", storyId: "s1", task: "one" });
  queue.enqueue({ goalId: "g2", stepIndex: 0, agentId: "a2", storyId: "s1", task: "two" });
  assert.ok(queue.claimNext());
  assert.ok(queue.claimNext(), "an explicit 0 means uncapped, as before this task");
});

test("STORY-5: the slot is POSTPONED, not destroyed — it claims once the first settles", () => {
  const queue = q({ maxPerStory: 1 });
  queue.enqueue({ goalId: "g1", stepIndex: 0, agentId: "a1", storyId: "s1", task: "one" });
  queue.enqueue({ goalId: "g2", stepIndex: 0, agentId: "a2", storyId: "s1", task: "two" });
  const first = queue.claimNext();
  assert.equal(queue.claimNext(), null);
  queue.update(first.taskId, { status: "done" });
  assert.ok(queue.claimNext(), "the deferred step must survive the deferral");
});

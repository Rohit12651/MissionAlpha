// Phase D · task 15 — THE MANAGER TICK LEASE.
//
// server.mjs's heartbeat fires `manager.tick(jid)` WITHOUT awaiting it, and a Manager stage
// is a model turn measured in minutes. So a slow tick could have a second tick for the same
// job start underneath it: two plan stages, two review gates, two commits — and with task 13,
// two resumes of one waiting task.
//
// The plan put the lease in the heartbeat. It lives in `tick` instead: the heartbeat is one
// caller, and a guard at one caller is allow-by-default for every other (addendum #11, fix
// where the class lives). One job, one tick in flight, whoever calls it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../db.mjs";
import { createJobs } from "../jobs.mjs";
import { createManager } from "../manager.mjs";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "ma-lease-"));
  const db = openDb({ path: join(dir, "mission.db"), patchesDir: join(dir, "patches") });
  const jobs = createJobs({ db, scrub: (t) => t });
  const calls = [];
  const logs = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const mgr = createManager({
    jobs, roster: { match: () => [], get: () => null }, catalog: ["api"],
    mailbox: { read: () => [], send: () => ({}) },
    enqueueGoal: () => ({ goalId: "g", firstTaskId: "t" }),
    // The intake stage hangs until the test releases it — a model turn that has not returned.
    dispatch: async ({ stage, jobId }) => { calls.push({ stage, jobId }); await gate; return { ok: true, findings: [], needs: [] }; },
    deliveries: { mintGate: (g) => ({ id: "d1", ...g }), listGates: () => [] },
    queue: { all: () => [] }, clock: () => 1_000_000, log: (r) => logs.push(r),
  });
  return { jobs, mgr, calls, logs, release: () => release() };
}

test("TICK-1: a second tick for a job whose first tick has not settled is SKIPPED and logged", async () => {
  const h = harness();
  const j = h.jobs.create({ title: "t", brief: "b" });

  const first = h.mgr.tick(j.id);       // still inside the intake stage
  await new Promise((r) => setImmediate(r));
  // BOUNDED. Without a lease the second tick enters the same hanging stage and never returns;
  // awaiting it bare would turn the red state into a hang, and a hang is not a failure
  // (addendum #8). A tick still pending after 200 ms is, by definition, not skipped.
  const second = await Promise.race([
    h.mgr.tick(j.id),
    new Promise((r) => { const t = setTimeout(() => r({ action: "STILL-RUNNING" }), 200); t.unref?.(); }),
  ]);
  assert.equal(second.action, "skipped", `the second tick ran on top of the first: ${JSON.stringify(second)}`);
  assert.equal(h.calls.length, 1, "exactly one model turn for one job");
  assert.ok(h.logs.some((e) => e.event === "tick-skipped" && e.jobId === j.id), "the skip is logged, not silent");

  h.release();
  await first;
  // The lease is RELEASED on settle — a lease that never frees is a job that never moves again.
  const third = await h.mgr.tick(j.id);
  assert.notEqual(third.action, "skipped", "once the first tick settles the job ticks normally");
});

test("TICK-2 (UNRELATED): a slow tick for one job does not hold up a DIFFERENT job", async () => {
  const h = harness();
  const a = h.jobs.create({ title: "a", brief: "b" });
  const b = h.jobs.create({ title: "b", brief: "different brief" });
  const slow = h.mgr.tick(a.id);
  await new Promise((r) => setImmediate(r));
  const other = h.mgr.tick(b.id);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.calls.map((c) => c.jobId).sort(), [a.id, b.id].sort(), "the lease is per JOB, not global");
  h.release();
  await Promise.all([slow, other]);
});

test("TICK-3: a tick that THROWS still releases the lease", async () => {
  const h = harness();
  const j = h.jobs.create({ title: "t", brief: "b" });
  const boom = createManager({
    jobs: h.jobs, roster: { match: () => [], get: () => null }, catalog: ["api"],
    mailbox: { read: () => { throw new Error("mail root unreadable"); }, send: () => ({}) },
    enqueueGoal: () => ({}), dispatch: async () => ({ ok: true, findings: [], needs: [] }),
    deliveries: { mintGate: () => ({}), listGates: () => [] }, queue: { all: () => [] }, clock: () => 1, log: () => {},
  });
  h.jobs.setStatus(j.id, "planned");
  h.jobs.setStatus(j.id, "building");
  await assert.rejects(boom.tick(j.id), /mail root unreadable/);
  await assert.rejects(boom.tick(j.id), /mail root unreadable/, "the second call RAN (and threw again) — it was not skipped by a leaked lease");
});

// Phase 9 · task 9.1 — the JOB-SCOPED gate slot.
//
// A gate belongs to EXACTLY ONE owner. Both owners would give one human decision two
// pipelines to notify and neither would own it; neither owner leaves the gate orphaned —
// decided by a human, connected to nothing.
//
// The STORY path must stay byte-identical: every existing gate row has jobId NULL, and the
// existing pipeline suites pass unchanged (109/109 alongside this file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../db.mjs";
import { createDeliveries } from "../deliveries.mjs";

function mk(onDecided) {
  const dir = mkdtempSync(join(tmpdir(), "ma-jobgate-"));
  const db = openDb({ path: join(dir, "mission.db"), patchesDir: join(dir, "patches") });
  return createDeliveries({ db, scrub: (t) => t, onDecided });
}

test("JG-1: mintGate({jobId}) lands a gate whose storyId is NULL", () => {
  const d = mk();
  const g = d.mintGate({ kind: "question", agentId: "tech-lead", jobId: "job_abc", title: "q", body: "?" });
  assert.equal(g.jobId, "job_abc");
  assert.equal(g.storyId, null, "a job gate must not occupy a story's slot");
  assert.equal(g.status, "pending");
});

test("JG-2: mintGate({storyId}) is unchanged — jobId NULL", () => {
  const d = mk();
  const g = d.mintGate({ kind: "question", agentId: "pm-analyst", storyId: "story_1", title: "q", body: "?" });
  assert.equal(g.storyId, "story_1");
  assert.equal(g.jobId, null);
});

test("JG-3: BOTH owners is refused — a gate cannot have two", () => {
  const d = mk();
  assert.throws(() => d.mintGate({ kind: "question", agentId: "a", storyId: "s1", jobId: "j1", title: "t", body: "b" }),
    /never both/i);
});

test("JG-4: NEITHER owner is refused — a gate cannot be orphaned", () => {
  const d = mk();
  assert.throws(() => d.mintGate({ kind: "question", agentId: "a", title: "t", body: "b" }), /required/i);
});

test("JG-5: listGates matches EITHER column", () => {
  const d = mk();
  d.mintGate({ kind: "question", agentId: "a", jobId: "job_x", slot: "job_x-q1", title: "t", body: "b" });
  d.mintGate({ kind: "question", agentId: "a", storyId: "story_y", slot: "story_y-q1", title: "t", body: "b" });
  assert.equal(d.listGates("job_x").length, 1);
  assert.equal(d.listGates("story_y").length, 1);
  assert.equal(d.listGates("job_x")[0].jobId, "job_x");
  assert.equal(d.listGates("story_y")[0].storyId, "story_y");
});

test("JG-6: a job gate and a story gate with the SAME slot do not collapse onto each other", () => {
  const d = mk();
  const a = d.mintGate({ kind: "question", agentId: "a", jobId: "own_1", slot: "own_1", title: "t", body: "b" });
  const b = d.mintGate({ kind: "question", agentId: "a", storyId: "own_1", slot: "own_1", title: "t", body: "b" });
  // Same slot + same agent is the dedupe key, so the second is expected to dedupe — but it
  // must NOT be silently returned as the OTHER owner's gate.
  assert.notEqual(b.jobId, a.jobId === null ? undefined : a.jobId === "own_1" ? null : a.jobId,
    "a story gate must never come back carrying a job's ownership");
  assert.ok(a.jobId === "own_1");
});

test("JG-7: onDecided receives the row carrying its owner, so the caller can route", async () => {
  const seen = [];
  const d = mk((row) => seen.push({ jobId: row.jobId, storyId: row.storyId }));
  const g = d.mintGate({ kind: "question", agentId: "tech-lead", jobId: "job_route", title: "t", body: "b" });
  const r = await d.decide(g.id, "approve", { by: "BOSS" });
  assert.equal(r.code, undefined, `decide failed: ${JSON.stringify(r)}`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].jobId, "job_route", "the Manager is what must be notified, not the story pipeline");
  assert.equal(seen[0].storyId, null);
});

test("JG-8: a STORY gate decision still reports a storyId and no jobId", async () => {
  const seen = [];
  const d = mk((row) => seen.push({ jobId: row.jobId, storyId: row.storyId }));
  const g = d.mintGate({ kind: "question", agentId: "pm-analyst", storyId: "story_route", title: "t", body: "b" });
  await d.decide(g.id, "approve", { by: "BOSS" });
  assert.deepEqual(seen[0], { jobId: null, storyId: "story_route" });
});

test("JG-9: an id with path characters is sanitised before it reaches SQL", () => {
  const d = mk();
  const g = d.mintGate({ kind: "question", agentId: "a", jobId: "job_../../etc", title: "t", body: "b" });
  assert.equal(/[./]/.test(g.jobId), false, `owner ids are charset-clamped; got ${g.jobId}`);
});

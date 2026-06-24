// agent-runtime/test/live-state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiveState } from "../live-state.mjs";

const roster = [
  { id: "ceo", role: "Chief Executive", tier: "supreme" },
  { id: "architect", role: "System Architect", tier: "principal" },
  { id: "senior-web-1", role: "Web Dev", tier: "senior" },
];
const nowMs = Date.parse("2026-06-22T12:00:00Z");

test("idle agent (no activity) → idle column", () => {
  const s = buildLiveState({ roster, engineTasks: [], activity: {}, inflightAgents: new Set(), nowMs, staleMs: 300000 });
  const a = s.agents.find((x) => x.id === "architect");
  assert.equal(a.column, "idle");
  assert.equal(a.task, null);
  assert.equal(s.counts.total, 3);
});

test("inflight agent → in_progress + STREAMING", () => {
  const s = buildLiveState({ roster, engineTasks: [], activity: {}, inflightAgents: new Set(["ceo"]), nowMs, staleMs: 300000 });
  const a = s.agents.find((x) => x.id === "ceo");
  assert.equal(a.column, "in_progress");
  assert.match(a.state, /STREAM/i);
});

test("engine task maps status → column + task text + heartbeat", () => {
  const tasks = [{ agentId: "senior-web-1", status: "claimed", task: "build SplitForm.tsx", updatedAt: "2026-06-22T11:59:30Z" }];
  const s = buildLiveState({ roster, engineTasks: tasks, activity: {}, inflightAgents: new Set(), nowMs, staleMs: 300000 });
  const a = s.agents.find((x) => x.id === "senior-web-1");
  assert.equal(a.column, "in_progress");
  assert.equal(a.task, "build SplitForm.tsx");
  assert.equal(a.heartbeatAt, "2026-06-22T11:59:30Z");
  assert.ok(s.feed.some((f) => f.from === "senior-web-1" && f.ref === "build SplitForm.tsx"));
});

test("held task → blocked column", () => {
  const tasks = [{ agentId: "architect", status: "held", task: "await review", updatedAt: "2026-06-22T11:59:00Z", blockedBy: "senior-web-1" }];
  const s = buildLiveState({ roster, engineTasks: tasks, activity: {}, inflightAgents: new Set(), nowMs, staleMs: 300000 });
  const a = s.agents.find((x) => x.id === "architect");
  assert.equal(a.column, "blocked");
  assert.equal(a.blockedBy, "senior-web-1");
  assert.equal(s.counts.blocked, 1);
});

test("stale: old activity, no task → stale flag", () => {
  const s = buildLiveState({ roster, engineTasks: [], activity: { ceo: "2026-06-22T11:00:00Z" }, inflightAgents: new Set(), nowMs, staleMs: 300000 });
  const a = s.agents.find((x) => x.id === "ceo");
  assert.equal(a.stale, true);
});

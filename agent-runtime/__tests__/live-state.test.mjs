import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiveState } from "../live-state.mjs";

const ROSTER = [
  { id: "ceo", role: "Chief Executive", tier: "supreme" },
  { id: "senior-web-1", role: "Web Dev", tier: "senior" },
];
const T0 = Date.parse("2026-06-26T20:00:00.000Z");

// ── alias: boss chat → ceo card ───────────────────────────────────────────────
test("alias folds boss inflight onto the ceo card → STREAMING", () => {
  const s = buildLiveState({
    roster: ROSTER, inflightAgents: new Set(["boss"]),
    aliases: { boss: "ceo" }, nowMs: T0,
  });
  const ceo = s.agents.find((a) => a.id === "ceo");
  assert.equal(ceo.state, "STREAMING");
  assert.equal(ceo.column, "in_progress");
});

test("alias folds boss heartbeat onto ceo → ACTIVE + fresh ageSec", () => {
  const act = { boss: new Date(T0 - 2000).toISOString() }; // 2s ago
  const s = buildLiveState({ roster: ROSTER, activity: act, aliases: { boss: "ceo" }, nowMs: T0 });
  const ceo = s.agents.find((a) => a.id === "ceo");
  assert.equal(ceo.state, "ACTIVE");
  assert.equal(ceo.stale, false);
  assert.ok(ceo.ageSec <= 3, `ageSec=${ceo.ageSec}`);
});

test("aliased boss heartbeat appears in the heartbeats array (as the roster id ceo)", () => {
  const act = { boss: new Date(T0 - 1000).toISOString() };
  const s = buildLiveState({ roster: ROSTER, activity: act, aliases: { boss: "ceo" }, nowMs: T0 });
  assert.ok(s.heartbeats.some((h) => h.agent === "ceo"), "ceo heartbeat present");
  assert.ok(!s.heartbeats.some((h) => h.agent === "boss"), "raw boss id not leaked");
});

test("without the alias, boss activity does NOT light ceo (regression guard)", () => {
  const s = buildLiveState({ roster: ROSTER, inflightAgents: new Set(["boss"]), nowMs: T0 });
  const ceo = s.agents.find((a) => a.id === "ceo");
  assert.equal(ceo.state, "IDLE"); // no alias → boss ignored, ceo stays idle
});

// ── chatFeed merge ────────────────────────────────────────────────────────────
test("chatFeed entries merge into feed, newest-first", () => {
  const chatFeed = [
    { ts: "2026-06-26T20:00:05.000Z", from: "ceo", to: "boss", topic: "chat", ref: "newer", body: "newer" },
    { ts: "2026-06-26T20:00:01.000Z", from: "ceo", to: "boss", topic: "chat", ref: "older", body: "older" },
  ];
  const s = buildLiveState({ roster: ROSTER, chatFeed, nowMs: T0 });
  assert.equal(s.feed.length, 2);
  assert.equal(s.feed[0].ref, "newer"); // newest first
  assert.equal(s.feed[1].ref, "older");
});

test("chatFeed merges with engine-task feed, sorted by ts newest-first", () => {
  const chatFeed = [{ ts: "2026-06-26T20:00:10.000Z", from: "ceo", to: "boss", topic: "chat", ref: "chat", body: "chat" }];
  const engineTasks = [{ agentId: "senior-web-1", status: "running", task: "build x", updatedAt: "2026-06-26T20:00:03.000Z" }];
  const s = buildLiveState({ roster: ROSTER, engineTasks, chatFeed, nowMs: T0 });
  assert.equal(s.feed.length, 2);
  assert.equal(s.feed[0].ref, "chat"); // chat newer than engine task
});

test("feed caps at 40 newest entries", () => {
  const chatFeed = Array.from({ length: 60 }, (_, i) => ({
    ts: new Date(T0 - i * 1000).toISOString(), from: "ceo", to: "boss", topic: "chat", ref: `r${i}`, body: `b${i}`,
  }));
  const s = buildLiveState({ roster: ROSTER, chatFeed, nowMs: T0 });
  assert.equal(s.feed.length, 40);
  assert.equal(s.feed[0].ref, "r0"); // newest (i=0) first
});

// ── liveOnly: hide dormant ghost roster entries ───────────────────────────────
test("liveOnly hides agents with no heartbeat, no task, not inflight", () => {
  const act = { boss: new Date(T0 - 1000).toISOString() };
  const s = buildLiveState({ roster: ROSTER, activity: act, aliases: { boss: "ceo" }, liveOnly: true, nowMs: T0 });
  const ids = s.agents.map((a) => a.id);
  assert.deepEqual(ids, ["ceo"]); // ceo beats (via alias); senior-web-1 is a dormant ghost → hidden
});

test("liveOnly keeps an agent that has a task even with no heartbeat", () => {
  const engineTasks = [{ agentId: "senior-web-1", status: "running", task: "build x", updatedAt: "2026-06-26T20:00:03.000Z" }];
  const s = buildLiveState({ roster: ROSTER, engineTasks, liveOnly: true, nowMs: T0 });
  assert.deepEqual(s.agents.map((a) => a.id).sort(), ["senior-web-1"]); // has a task → kept; ceo idle → hidden
});

test("liveOnly keeps an inflight (streaming) agent", () => {
  const s = buildLiveState({ roster: ROSTER, inflightAgents: new Set(["senior-web-1"]), liveOnly: true, nowMs: T0 });
  assert.ok(s.agents.some((a) => a.id === "senior-web-1" && a.state === "STREAMING"));
});

test("liveOnly counts reflect only the visible (live) agents", () => {
  const act = { boss: new Date(T0 - 1000).toISOString() };
  const s = buildLiveState({ roster: ROSTER, activity: act, aliases: { boss: "ceo" }, liveOnly: true, nowMs: T0 });
  assert.equal(s.counts.total, 1); // only ceo visible
});

test("alwaysShow keeps a pinned agent (ceo) visible even when idle", () => {
  const s = buildLiveState({ roster: ROSTER, liveOnly: true, alwaysShow: ["ceo"], nowMs: T0 });
  assert.deepEqual(s.agents.map((a) => a.id), ["ceo"]); // ceo pinned; senior-web-1 idle → hidden
});

test("default (no liveOnly) still shows every roster entry — ghosts included", () => {
  const s = buildLiveState({ roster: ROSTER, nowMs: T0 });
  assert.equal(s.agents.length, 2); // back-compat: both shown
});

// ── back-compat: existing behavior unchanged when new params omitted ──────────
test("omitting chatFeed/aliases keeps prior behavior (engine feed only)", () => {
  const engineTasks = [{ agentId: "senior-web-1", status: "running", task: "build x", updatedAt: "2026-06-26T20:00:03.000Z" }];
  const s = buildLiveState({ roster: ROSTER, engineTasks, nowMs: T0 });
  assert.equal(s.feed.length, 1);
  assert.equal(s.feed[0].from, "senior-web-1");
});

// ── P2 (ADR-052 §agent.state wiring) — settle clears ACTIVE ───────────────────
// P1 observation: a settled turn left the agent (notably ceo) stuck in the
// in_progress column for the whole staleMs window. The server now records a
// settle timestamp alongside the activity timestamp; a settle at-or-after the
// last activity means the turn is over.
test("settled at/after the last activity clears ACTIVE → idle", () => {
  const ts = new Date(T0 - 2000).toISOString();
  const s = buildLiveState({
    roster: ROSTER, activity: { boss: ts }, settled: { boss: ts },
    aliases: { boss: "ceo" }, nowMs: T0,
  });
  const ceo = s.agents.find((a) => a.id === "ceo");
  assert.equal(ceo.state, "IDLE");
  assert.equal(ceo.column, "idle");
  assert.equal(ceo.heartbeatAt, ts, "heartbeat preserved — only the ACTIVE column clears");
  assert.equal(s.counts.active, 0);
});

test("an in-flight turn still wins over a settle marker from the previous turn", () => {
  const ts = new Date(T0 - 5000).toISOString();
  const s = buildLiveState({
    roster: ROSTER, activity: { boss: ts }, settled: { boss: ts },
    inflightAgents: new Set(["boss"]), aliases: { boss: "ceo" }, nowMs: T0,
  });
  assert.equal(s.agents.find((a) => a.id === "ceo").state, "STREAMING");
});

test("a settle marker OLDER than the last activity leaves the agent ACTIVE", () => {
  const s = buildLiveState({
    roster: ROSTER,
    activity: { boss: new Date(T0 - 1000).toISOString() },
    settled: { boss: new Date(T0 - 9000).toISOString() },
    aliases: { boss: "ceo" }, nowMs: T0,
  });
  assert.equal(s.agents.find((a) => a.id === "ceo").state, "ACTIVE");
});

test("a settled but still-live agent stays VISIBLE under liveOnly (heartbeat kept)", () => {
  const ts = new Date(T0 - 2000).toISOString();
  const s = buildLiveState({
    roster: ROSTER, activity: { boss: ts }, settled: { boss: ts },
    aliases: { boss: "ceo" }, liveOnly: true, nowMs: T0,
  });
  assert.deepEqual(s.agents.map((a) => a.id), ["ceo"], "card stays on the board, just not in_progress");
});

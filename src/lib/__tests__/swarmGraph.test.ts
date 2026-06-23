import { test } from "node:test";
import assert from "node:assert/strict";
import { statusStyle, packetsFromFeed, hitTest, recentComms, selectPacketLabels, focusDim } from "../swarmGraph.ts";
import type { AgentState, FeedEvent } from "../../data/types.ts";

// minimal agent factory — only the fields statusStyle reads
function ag(p: Partial<AgentState>): Pick<AgentState, "column" | "stale" | "heartbeatAt"> {
  return { column: "idle", stale: false, heartbeatAt: "2026-06-22T00:00:00.000Z", ...p };
}

test("in_progress → bright pulse, full alpha, strong glow, no ring", () => {
  const s = statusStyle(ag({ column: "in_progress" }));
  assert.equal(s.alpha, 1);
  assert.ok(s.glow >= 1.3, "glow boosted");
  assert.ok(s.pulse >= 0.15, "visible pulse");
  assert.equal(s.ring, null);
  assert.equal(s.desaturate, false);
});

test("blocked → red ring #e24b4a", () => {
  const s = statusStyle(ag({ column: "blocked" }));
  assert.equal(s.ring, "#e24b4a");
});

test("stale → dim + desaturated, pulse killed", () => {
  const base = statusStyle(ag({ column: "in_progress", stale: false }));
  const s = statusStyle(ag({ column: "in_progress", stale: true }));
  assert.ok(s.alpha < base.alpha, "dimmer than non-stale");
  assert.equal(s.pulse, 0, "no pulse when stale");
  assert.equal(s.desaturate, true);
});

test("idle with no heartbeat → faint", () => {
  const s = statusStyle(ag({ column: "idle", heartbeatAt: null }));
  assert.ok(s.alpha <= 0.35, "faint");
  assert.equal(s.ring, null);
});

test("idle with heartbeat is brighter than idle without", () => {
  const live = statusStyle(ag({ column: "idle", heartbeatAt: "2026-06-22T00:00:00.000Z" }));
  const cold = statusStyle(ag({ column: "idle", heartbeatAt: null }));
  assert.ok(live.alpha > cold.alpha);
});

test("blocked AND stale → keeps red ring but dims fill", () => {
  const s = statusStyle(ag({ column: "blocked", stale: true }));
  assert.equal(s.ring, "#e24b4a", "ring survives staleness");
  assert.ok(s.alpha < 1, "fill dimmed");
});

test("no status maps to a pink hue (ring is only red or null)", () => {
  for (const column of ["idle", "in_progress", "blocked", "review", "done", "awaiting_user", "offline"] as const) {
    const s = statusStyle(ag({ column }));
    assert.ok(s.ring === null || s.ring === "#e24b4a", `ring for ${column} is red-or-null`);
  }
});

// ── packetsFromFeed (P0-2) ──────────────────────────────────────────────────
function ev(ts: string, from: string, to: string): FeedEvent {
  return { ts, from, to, topic: "t", ref: "r", body: "b" };
}
const NODES = new Set(["a", "b", "c"]);
const has = (id: string) => NODES.has(id);

test("first call (prevTs null) establishes baseline, spawns nothing", () => {
  const feed = [ev("2026-01-01T00:00:01Z", "a", "b"), ev("2026-01-01T00:00:02Z", "b", "c")];
  const r = packetsFromFeed(null, feed, has);
  assert.deepEqual(r.packets, []);
  assert.equal(r.lastTs, "2026-01-01T00:00:02Z");
});

test("a new event after baseline spawns exactly one packet from→to", () => {
  const feed = [ev("2026-01-01T00:00:01Z", "a", "b"), ev("2026-01-01T00:00:02Z", "b", "c")];
  const r = packetsFromFeed("2026-01-01T00:00:01Z", feed, has);
  assert.deepEqual(r.packets, [{ from: "b", to: "c", topic: "t" }]);
  assert.equal(r.lastTs, "2026-01-01T00:00:02Z");
});

test("packetsFromFeed carries the event topic", () => {
  const feed = [ev("2026-01-01T00:00:01Z", "a", "b"),
    { ts: "2026-01-01T00:00:02Z", from: "b", to: "c", topic: "review-req", ref: "r", body: "b" }];
  const r = packetsFromFeed("2026-01-01T00:00:01Z", feed, has);
  assert.deepEqual(r.packets, [{ from: "b", to: "c", topic: "review-req" }]);
});

test("event whose from or to is not a node is skipped (no crash)", () => {
  const feed = [ev("2026-01-01T00:00:02Z", "a", "zzz"), ev("2026-01-01T00:00:03Z", "ghost", "b")];
  const r = packetsFromFeed("2026-01-01T00:00:01Z", feed, has);
  assert.deepEqual(r.packets, []);
  assert.equal(r.lastTs, "2026-01-01T00:00:03Z");
});

test("same feed re-fed (prevTs = lastTs) spawns no duplicates", () => {
  const feed = [ev("2026-01-01T00:00:01Z", "a", "b"), ev("2026-01-01T00:00:02Z", "b", "c")];
  const r = packetsFromFeed("2026-01-01T00:00:02Z", feed, has);
  assert.deepEqual(r.packets, []);
  assert.equal(r.lastTs, "2026-01-01T00:00:02Z");
});

test("multiple new events spawn one packet each, in order, lastTs = newest", () => {
  const feed = [
    ev("2026-01-01T00:00:01Z", "a", "b"),
    ev("2026-01-01T00:00:02Z", "b", "c"),
    ev("2026-01-01T00:00:03Z", "c", "a"),
  ];
  const r = packetsFromFeed("2026-01-01T00:00:01Z", feed, has);
  assert.deepEqual(r.packets, [{ from: "b", to: "c", topic: "t" }, { from: "c", to: "a", topic: "t" }]);
  assert.equal(r.lastTs, "2026-01-01T00:00:03Z");
});

test("empty feed returns prevTs unchanged and no packets", () => {
  const r = packetsFromFeed("2026-01-01T00:00:05Z", [], has);
  assert.deepEqual(r.packets, []);
  assert.equal(r.lastTs, "2026-01-01T00:00:05Z");
});

// ── hitTest (P0-3) ──────────────────────────────────────────────────────────
const HN = [
  { x: 100, y: 100, r: 10, agentId: "a" },
  { x: 300, y: 200, r: 8, agentId: "b" },
  { x: 150, y: 150, r: 6 }, // artifact node — no agentId, not hoverable
];

test("cursor on a node center (no parallax) returns its agentId", () => {
  assert.equal(hitTest(HN, 100, 100, 0, 0), "a");
});

test("cursor far from all nodes returns null", () => {
  assert.equal(hitTest(HN, 500, 500, 0, 0), null);
});

test("hit-test subtracts parallax offset (ox/oy)", () => {
  assert.equal(hitTest(HN, 120, 110, 20, 10), "a");
  assert.equal(hitTest(HN, 120, 110, 0, 0), null);
});

test("artifact nodes (no agentId) are not hoverable", () => {
  assert.equal(hitTest(HN, 150, 150, 0, 0), null);
});

test("just inside radius hits, just outside misses (large node, no pad)", () => {
  const big = [{ x: 100, y: 100, r: 20, agentId: "a" }];
  assert.equal(hitTest(big, 119, 100, 0, 0), "a");  // dist 19 < r 20
  assert.equal(hitTest(big, 122, 100, 0, 0), null); // dist 22 > r 20
});

test("small nodes get a 12px minimum hit radius (clickability floor)", () => {
  const tiny = [{ x: 100, y: 100, r: 6, agentId: "a" }];
  assert.equal(hitTest(tiny, 111, 100, 0, 0), "a"); // dist 11 > r 6 but < 12px floor → hits
  assert.equal(hitTest(tiny, 114, 100, 0, 0), null); // dist 14 > 12px floor → misses
});

test("pad widens the hit circle (forgiving click target)", () => {
  const n = [{ x: 100, y: 100, r: 12, agentId: "a" }];
  assert.equal(hitTest(n, 118, 100, 0, 0), null);      // dist 18 > reach 12, no pad
  assert.equal(hitTest(n, 118, 100, 0, 0, 10), "a");   // dist 18 < reach 12+10, with pad
});

test("overlapping nodes return the nearest agent", () => {
  const nodes = [
    { x: 100, y: 100, r: 20, agentId: "big" },
    { x: 105, y: 100, r: 20, agentId: "near" },
  ];
  assert.equal(hitTest(nodes, 104, 100, 0, 0), "near");
});

// ── recentComms (P0-4) ──────────────────────────────────────────────────────
const FC = [
  ev("t1", "a", "b"),
  ev("t2", "b", "c"),
  ev("t3", "c", "a"),
  ev("t4", "a", "d"),
];

test("recentComms returns only events touching the agent, newest first", () => {
  const r = recentComms(FC, "a");
  assert.deepEqual(r.map((e) => e.ts), ["t4", "t3", "t1"]);
});

test("recentComms respects the limit", () => {
  const r = recentComms(FC, "a", 2);
  assert.deepEqual(r.map((e) => e.ts), ["t4", "t3"]);
});

test("recentComms returns [] when the agent has no comms", () => {
  assert.deepEqual(recentComms(FC, "zzz"), []);
});

test("recentComms returns [] for empty feed", () => {
  assert.deepEqual(recentComms([], "a"), []);
});

// ── selectPacketLabels (P1-2) ───────────────────────────────────────────────
test("selectPacketLabels filters empty topics and caps at max, nearest first", () => {
  const items = [
    { topic: "assign", dist: 80 },
    { topic: "", dist: 5 },
    { topic: "review-req", dist: 20 },
    { topic: "blocked", dist: 50 },
  ];
  const r = selectPacketLabels(items, 2);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.index), [2, 3]);
});

test("selectPacketLabels truncates topics to <=16 chars with ellipsis", () => {
  const r = selectPacketLabels([{ topic: "this-is-a-very-long-topic-name", dist: 1 }], 6);
  assert.equal(r[0].label.length, 16);
  assert.ok(r[0].label.endsWith("…"));
});

test("selectPacketLabels short topic is unchanged", () => {
  const r = selectPacketLabels([{ topic: "assign", dist: 1 }], 6);
  assert.equal(r[0].label, "assign");
});

test("selectPacketLabels emphasizes packets within nearPx", () => {
  const r = selectPacketLabels([{ topic: "a", dist: 30 }, { topic: "b", dist: 120 }], 6, 60);
  assert.equal(r.find((x) => x.index === 0)?.emphasized, true);
  assert.equal(r.find((x) => x.index === 1)?.emphasized, false);
});

test("selectPacketLabels returns [] when no topics", () => {
  assert.deepEqual(selectPacketLabels([{ topic: "", dist: 1 }], 6), []);
});

// ── focusDim (P1-3) ─────────────────────────────────────────────────────────
test("focusDim returns 1 for everything when focus is empty", () => {
  const f = new Set<string>();
  assert.equal(focusDim("ceo", f), 1);
  assert.equal(focusDim("file", f), 1);
});

test("focusDim keeps focused kinds full, dims others", () => {
  const f = new Set(["senior"]);
  assert.equal(focusDim("senior", f), 1);
  assert.equal(focusDim("principal", f), 0.12);
});

test("focusDim dims artifact kinds when any tier is focused", () => {
  assert.equal(focusDim("file", new Set(["ceo"])), 0.12);
});

test("focusDim union: any focused kind stays full", () => {
  const f = new Set(["ceo", "senior"]);
  assert.equal(focusDim("ceo", f), 1);
  assert.equal(focusDim("senior", f), 1);
  assert.equal(focusDim("support", f), 0.12);
});

test("focusDim honors a custom dim level", () => {
  assert.equal(focusDim("x", new Set(["ceo"]), 0.3), 0.3);
});

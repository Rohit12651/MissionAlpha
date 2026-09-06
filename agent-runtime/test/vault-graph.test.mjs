// Phase 4 / R15 — PageRank over the vault graph.
// Load-bearing: HUB-* (structure must actually change the order) and GUARD-* (a graph
// pass must never be the reason a turn hangs).

import test from "node:test";
import assert from "node:assert/strict";
import { buildGraph, pagerank, normalizeRanks, fuse, rankRecords,
         MAX_NODES, MAX_EDGE_COMPARISONS, EDGE_WEIGHT } from "../vault-graph.mjs";

const rec = (id, o = {}) => ({ id, ...o });

test("explicit refs create directed edges", () => {
  const g = buildGraph([rec("a", { refs: ["b"] }), rec("b")]);
  assert.equal(g.edges.get("a").get("b"), EDGE_WEIGHT.ref);
  assert.ok(!g.edges.get("b"), "a citation is one-directional — that is what grants authority");
});

test("a ref to a non-existent record is ignored", () => {
  const g = buildGraph([rec("a", { refs: ["ghost"] })]);
  assert.ok(!g.edges.get("a")?.has("ghost"));
});

test("co-membership edges are symmetric", () => {
  const g = buildGraph([rec("a", { storyId: "s1" }), rec("b", { storyId: "s1" })]);
  assert.equal(g.edges.get("a").get("b"), EDGE_WEIGHT.story);
  assert.equal(g.edges.get("b").get("a"), EDGE_WEIGHT.story);
});

test("the strongest relationship wins — weights are never summed", () => {
  const g = buildGraph([
    rec("a", { storyId: "s", agent: "qa", refs: ["b"] }),
    rec("b", { storyId: "s", agent: "qa" }),
  ]);
  assert.equal(g.edges.get("a").get("b"), EDGE_WEIGHT.ref, "ref outranks story and agent, not added to them");
});

test("self-edges are impossible", () => {
  const g = buildGraph([rec("a", { refs: ["a"] })]);
  assert.ok(!g.edges.get("a")?.has("a"));
});

// ── HUB: structure must change the answer ────────────────────────────────────

test("HUB-1: a cited record outranks an orphan", () => {
  const records = [rec("hub"), rec("x", { refs: ["hub"] }), rec("y", { refs: ["hub"] }),
                   rec("z", { refs: ["hub"] }), rec("orphan")];
  const r = pagerank(buildGraph(records));
  assert.ok(r.get("hub") > r.get("orphan"), `hub=${r.get("hub")} orphan=${r.get("orphan")}`);
});

test("HUB-2: fusion reorders equal-cosine candidates by structure", () => {
  const records = [rec("hub"), rec("x", { refs: ["hub"] }), rec("y", { refs: ["hub"] }), rec("lonely")];
  const { ranks } = rankRecords(records);
  const fused = fuse([{ id: "lonely", score: 0.8 }, { id: "hub", score: 0.8 }], ranks);
  assert.equal(fused[0].id, "hub", "at equal relevance, the load-bearing record wins");
});

test("HUB-3: cosine still DOMINATES — structure breaks ties, it does not override relevance", () => {
  const records = [rec("hub"), rec("x", { refs: ["hub"] }), rec("y", { refs: ["hub"] }), rec("onTopic")];
  const { ranks } = rankRecords(records);
  const fused = fuse([{ id: "onTopic", score: 0.95 }, { id: "hub", score: 0.30 }], ranks);
  assert.equal(fused[0].id, "onTopic", "a popular record that is not about the topic is still wrong");
});

test("ranks form a probability distribution", () => {
  const r = pagerank(buildGraph([rec("a", { refs: ["b"] }), rec("b"), rec("c")]));
  const sum = [...r.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `dangling mass leaked: sum=${sum}`);
});

test("a graph with no edges gives every node equal rank", () => {
  const r = pagerank(buildGraph([rec("a"), rec("b"), rec("c")]));
  assert.ok(Math.abs(r.get("a") - r.get("b")) < 1e-9);
});

// ── GUARD ─────────────────────────────────────────────────────────────────────

test("GUARD-1: the node cap truncates rather than growing without bound", () => {
  const many = Array.from({ length: MAX_NODES + 500 }, (_, i) => rec(`n${i}`));
  const g = buildGraph(many);
  assert.equal(g.nodes.length, MAX_NODES);
  assert.equal(g.truncated, true);
});

test("GUARD-2: the comparison budget bounds a pathological single-bucket graph", () => {
  // Every record in ONE story = the worst case that made ruflo bound this after the fact.
  const many = Array.from({ length: 1200 }, (_, i) => rec(`n${i}`, { storyId: "same" }));
  const g = buildGraph(many);
  assert.ok(g.comparisons <= MAX_EDGE_COMPARISONS + 1, `unbounded: ${g.comparisons}`);
});

test("GUARD-3: iteration is capped", () => {
  const records = Array.from({ length: 50 }, (_, i) => rec(`n${i}`, { refs: [`n${(i + 1) % 50}`] }));
  const r = pagerank(buildGraph(records), { maxIterations: 2 });
  assert.equal(r.size, 50, "a capped run still returns a full vector");
});

test("GUARD-4: temporal edges bucket by window, not all-pairs", () => {
  const base = Date.UTC(2026, 0, 1);
  const g = buildGraph([
    rec("a", { at: base }), rec("b", { at: base + 1000 }),
    rec("c", { at: base + 10 * 3600_000 }),
  ]);
  assert.ok(g.edges.get("a")?.has("b"), "same hour window links");
  assert.ok(!g.edges.get("a")?.has("c"), "ten hours apart does not");
});

// ── robustness ────────────────────────────────────────────────────────────────

test("never throws on malformed input", () => {
  for (const bad of [null, undefined, 42, "x", [null], [{}], [{ id: 1 }], [{ id: "a", refs: "no" }]]) {
    assert.doesNotThrow(() => rankRecords(bad));
  }
  assert.equal(rankRecords(null).nodes, 0);
});

test("normalizeRanks maps to 0..1 and survives an all-zero vector", () => {
  const n = normalizeRanks(new Map([["a", 0.2], ["b", 0.1]]));
  assert.equal(n.get("a"), 1);
  assert.equal(normalizeRanks(new Map([["a", 0]])).get("a"), 0);
});

test("INERT WITHOUT R6: fuse with no candidates returns nothing, changing no behaviour", () => {
  assert.deepEqual(fuse([], new Map()), []);
  assert.deepEqual(fuse(null, null), []);
});

test("fusion ordering is deterministic on ties", () => {
  const f1 = fuse([{ id: "b", score: 0.5 }, { id: "a", score: 0.5 }], new Map());
  const f2 = fuse([{ id: "a", score: 0.5 }, { id: "b", score: 0.5 }], new Map());
  assert.deepEqual(f1.map((x) => x.id), f2.map((x) => x.id));
});

test("fuse reports both components so a ranking can be explained", () => {
  const [top] = fuse([{ id: "a", score: 0.9 }], new Map([["a", 1]]));
  assert.equal(top.cosine, 0.9);
  assert.ok(Number.isFinite(top.rank));
});

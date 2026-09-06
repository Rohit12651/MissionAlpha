// Phase 4 / R15 — PAGERANK OVER THE VAULT GRAPH.
//
// WHAT THIS IS FOR: retrieval (R6) ranks prior art by cosine similarity alone. Similarity
// answers "is this about the same thing"; it does not answer "is this record any good".
// A one-off note and a decision that ten later records were built on top of look identical
// to a cosine score. PageRank answers the second question from structure: a record many
// others connect to is load-bearing, and load-bearing prior art is the prior art worth
// putting in a prompt.
//
// THIS IS THE HONEST HALF OF ruflo's intelligence layer. Their `intelligence.cjs` is the
// part of that product worth copying — PageRank over a memory graph with real guards
// (node caps, iteration caps, an O(n²) bound on edge building). Copied deliberately,
// including the guards, because an unbounded graph pass inside a session-end hook is how
// that kind of feature becomes a hang.
//
// PURE. Records are passed in; no vault access, no I/O, no globals.
//
// SEQUENCING NOTE: this is fusion-ready but INERT until R6 exists. `fuse()` needs cosine
// scores to fuse with. Shipping it now means the ranking half is tested and waiting; it
// changes nothing until retrieval calls it.

/** Hard caps. A graph pass must never be the reason a turn hangs. */
export const MAX_NODES = 5000;
export const MAX_ITERATIONS = 30;
export const MAX_EDGE_COMPARISONS = 100_000;

/** Standard damping. 0.85 is the canonical value and there is no reason to be clever. */
export const DAMPING = 0.85;
/** Convergence threshold — stop early when the vector stops moving. */
export const EPSILON = 1e-6;

/** Edge weights by kind. Explicit references are the strongest signal a human left. */
export const EDGE_WEIGHT = Object.freeze({
  ref: 1.0,        // record A explicitly cites record B
  story: 0.6,      // same story
  agent: 0.25,     // same authoring station
  temporal: 0.15,  // written close together in time
});

/** Records written within this window of each other get a temporal edge. */
export const TEMPORAL_WINDOW_MS = 60 * 60 * 1000;

/**
 * buildGraph(records) → { nodes, edges, truncated, comparisons }
 *
 * `records` = [{ id, storyId?, agent?, at?, refs?: string[] }]
 *
 * Edges are DIRECTED for refs (A cites B ⇒ A→B, which is what gives B authority) and
 * SYMMETRIC for the co-membership kinds. Never throws.
 */
export function buildGraph(records) {
  const list = Array.isArray(records) ? records.filter((r) => r && typeof r.id === "string" && r.id) : [];
  const truncated = list.length > MAX_NODES;
  const nodes = list.slice(0, MAX_NODES);
  const ids = new Set(nodes.map((r) => r.id));

  // edges: Map<from, Map<to, weight>>
  const edges = new Map();
  const add = (from, to, w) => {
    if (from === to || !ids.has(to)) return;
    if (!edges.has(from)) edges.set(from, new Map());
    const m = edges.get(from);
    m.set(to, Math.max(m.get(to) || 0, w)); // strongest relationship wins, never summed
  };

  // Explicit refs — linear, always done.
  for (const r of nodes) {
    for (const ref of Array.isArray(r.refs) ? r.refs.slice(0, 50) : []) {
      if (typeof ref === "string") add(r.id, ref, EDGE_WEIGHT.ref);
    }
  }

  // Co-membership edges are pairwise. Bucketing by key keeps this near-linear for the
  // normal shape (many small groups) and the comparison counter is the hard backstop for
  // the pathological one (every record in one bucket).
  let comparisons = 0;
  const bucketPass = (keyOf, weight) => {
    const buckets = new Map();
    for (const r of nodes) {
      const k = keyOf(r);
      if (k === null || k === undefined || k === "") continue;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    for (const group of buckets.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          if (++comparisons > MAX_EDGE_COMPARISONS) return false;
          add(group[i].id, group[j].id, weight);
          add(group[j].id, group[i].id, weight);
        }
      }
    }
    return true;
  };

  bucketPass((r) => r.storyId, EDGE_WEIGHT.story);
  bucketPass((r) => r.agent, EDGE_WEIGHT.agent);
  // Temporal buckets by hour window — bucketing rather than comparing all pairs is what
  // keeps this from being the O(n²) pass ruflo had to bound after the fact.
  bucketPass((r) => (Number.isFinite(Number(r.at)) ? Math.floor(Number(r.at) / TEMPORAL_WINDOW_MS) : null), EDGE_WEIGHT.temporal);

  return { nodes, edges, truncated, comparisons };
}

/**
 * pagerank(graph) → Map<id, rank>  (ranks sum to 1)
 *
 * Weighted, damped, iteration-capped, with dangling-node mass redistributed so the vector
 * stays a probability distribution. Never throws.
 */
export function pagerank({ nodes, edges }, opts = {}) {
  const damping = Number.isFinite(opts.damping) ? opts.damping : DAMPING;
  const maxIter = Number.isFinite(opts.maxIterations) ? opts.maxIterations : MAX_ITERATIONS;
  const n = nodes.length;
  const ranks = new Map();
  if (!n) return ranks;

  for (const r of nodes) ranks.set(r.id, 1 / n);

  // Pre-compute outbound weight totals once.
  const outTotal = new Map();
  for (const [from, m] of edges) {
    let t = 0;
    for (const w of m.values()) t += w;
    outTotal.set(from, t);
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Map();
    for (const r of nodes) next.set(r.id, 0);

    let dangling = 0;
    for (const r of nodes) {
      const total = outTotal.get(r.id) || 0;
      if (total <= 0) { dangling += ranks.get(r.id); continue; }
      const share = ranks.get(r.id);
      for (const [to, w] of edges.get(r.id)) {
        next.set(to, (next.get(to) || 0) + share * (w / total));
      }
    }

    // Dangling mass spreads evenly — otherwise rank leaks and the vector stops summing to 1.
    const spread = dangling / n;
    let delta = 0;
    for (const r of nodes) {
      const v = (1 - damping) / n + damping * (next.get(r.id) + spread);
      delta += Math.abs(v - ranks.get(r.id));
      next.set(r.id, v);
    }
    for (const [k, v] of next) ranks.set(k, v);
    if (delta < EPSILON) break; // converged
  }
  return ranks;
}

/** Normalise a rank map to 0..1 by its own maximum, so it can fuse with cosine. */
export function normalizeRanks(ranks) {
  const out = new Map();
  let max = 0;
  for (const v of ranks.values()) if (v > max) max = v;
  if (max <= 0) { for (const k of ranks.keys()) out.set(k, 0); return out; }
  for (const [k, v] of ranks) out.set(k, v / max);
  return out;
}

/**
 * fuse(candidates, ranks, weights) → candidates re-scored and re-sorted.
 *
 * `candidates` = [{ id, score }] from cosine similarity (R6).
 * final = cosineWeight·cosine + rankWeight·normalizedRank
 *
 * INERT WITHOUT R6 — with no candidates there is nothing to fuse. Cosine stays the
 * dominant term by default: structure should BREAK TIES between similar records, not
 * override relevance. A structurally popular record that is not about the topic is still
 * the wrong answer.
 */
export function fuse(candidates, ranks, { cosineWeight = 0.7, rankWeight = 0.3 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const norm = normalizeRanks(ranks instanceof Map ? ranks : new Map());
  return list
    .map((c) => {
      const cos = Number.isFinite(Number(c?.score)) ? Number(c.score) : 0;
      const pr = norm.get(c?.id) || 0;
      return { ...c, cosine: cos, rank: Number(pr.toFixed(4)), score: Number((cosineWeight * cos + rankWeight * pr).toFixed(6)) };
    })
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

/** One-call convenience: records → normalized rank map. Never throws. */
export function rankRecords(records, opts = {}) {
  try {
    const g = buildGraph(records);
    return { ranks: normalizeRanks(pagerank(g, opts)), truncated: g.truncated, comparisons: g.comparisons, nodes: g.nodes.length };
  } catch {
    return { ranks: new Map(), truncated: false, comparisons: 0, nodes: 0 };
  }
}

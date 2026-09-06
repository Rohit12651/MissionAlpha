// Phase 2 — failure clustering. Pure signature function.
// Real data (measured from the live runtime, 50 pending deliveries): failure deliveries
// carry kind:"failure", agentId:"tech-lead", title:"tech-lead is stuck — spawn".
// 97 failures currently render as ~20 near-identical Inbox cards: one problem, twenty
// decisions. These tests pin what may and may NOT collapse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { failureSignature, groupBySignature } from "../failure-signature.mjs";

const stuck = (agentId, reason, extra = {}) => ({
  id: `${agentId}-${reason}-${Math.random()}`,
  kind: "failure", agentId, status: "pending",
  title: `${agentId} is stuck — ${reason}`, createdAt: 1000, ...extra,
});

test("identical agent + reason share a signature", () => {
  assert.equal(failureSignature(stuck("tech-lead", "spawn")), failureSignature(stuck("tech-lead", "spawn")));
});

test("different reason does NOT collapse", () => {
  assert.notEqual(failureSignature(stuck("tech-lead", "spawn")), failureSignature(stuck("tech-lead", "timeout")));
});

test("same reason, different agent does NOT collapse", () => {
  assert.notEqual(failureSignature(stuck("tech-lead", "spawn")), failureSignature(stuck("sr-backend", "spawn")));
});

test("SAFETY: a real code delivery NEVER clusters", () => {
  assert.equal(failureSignature({ kind: "code", agentId: "sr-backend", title: "Add retry to webhook" }), null);
  assert.equal(failureSignature({ kind: "design", agentId: "architect", title: "Design approval: X" }), null);
});

test("SAFETY: a failure whose title does not match the stuck shape does not cluster", () => {
  assert.equal(failureSignature({ kind: "failure", agentId: "x", title: "something else entirely" }), null);
});

test("garbage in → null, never a throw", () => {
  for (const bad of [null, undefined, {}, { kind: "failure" }, { kind: "failure", title: 5 }]) {
    assert.equal(failureSignature(bad), null);
  }
});

test("groupBySignature collapses N identical failures into ONE cluster of size N", () => {
  const items = [
    stuck("tech-lead", "spawn"), stuck("tech-lead", "spawn"), stuck("tech-lead", "spawn"),
    stuck("tech-lead", "timeout"), stuck("tech-lead", "timeout"),
    { id: "code-1", kind: "code", agentId: "sr-backend", title: "Add retry", createdAt: 900 },
  ];
  const groups = groupBySignature(items);
  const clusters = groups.filter((g) => g.kind === "cluster");
  const singles = groups.filter((g) => g.kind === "single");

  assert.equal(clusters.length, 2, "expected spawn + timeout clusters");
  assert.equal(singles.length, 1, "the code delivery must stay a single");
  assert.equal(clusters.find((c) => c.reason === "spawn").size, 3);
  assert.equal(clusters.find((c) => c.reason === "timeout").size, 2);
  assert.equal(singles[0].delivery.id, "code-1");
});

test("a lone failure stays a single, not a cluster of one", () => {
  const groups = groupBySignature([stuck("qa", "spawn")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "single");
});

test("cluster ordering is STABLE and newest-first by member", () => {
  const items = [
    stuck("a", "spawn", { createdAt: 10 }), stuck("a", "spawn", { createdAt: 50 }),
    stuck("b", "timeout", { createdAt: 90 }), stuck("b", "timeout", { createdAt: 20 }),
  ];
  const g1 = groupBySignature(items).map((g) => g.key);
  const g2 = groupBySignature([...items].reverse()).map((g) => g.key);
  assert.deepEqual(g1, g2, "grouping must not depend on input order");
  assert.equal(groupBySignature(items)[0].newestAt, 90, "newest cluster first");
});

test("every input delivery appears exactly once in the output", () => {
  const items = [stuck("a", "spawn"), stuck("a", "spawn"), stuck("b", "x"), { id: "c1", kind: "code", agentId: "z", title: "t" }];
  const groups = groupBySignature(items);
  const seen = groups.flatMap((g) => (g.kind === "cluster" ? g.members.map((m) => m.id) : [g.delivery.id]));
  assert.equal(seen.length, items.length, "delivery lost or duplicated during grouping");
  assert.equal(new Set(seen).size, items.length);
});

test("REGRESSION: only PENDING failures cluster; decided ones stay history", () => {
  const d = (status) => ({ id: `x${Math.random()}`, kind: "failure", agentId: "t", status,
    title: "t is stuck — spawn", createdAt: 1 });
  assert.equal(failureSignature(d("rejected")), null);
  assert.equal(failureSignature(d("approved")), null);
  assert.notEqual(failureSignature(d("pending")), null);
  const g = groupBySignature([d("rejected"), d("rejected"), d("pending"), d("pending")]);
  const clusters = g.filter((x) => x.kind === "cluster");
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].size, 2);
});

// Phase 2 — Inbox failure clustering, client model.
// Shapes taken from the LIVE runtime: kind:"failure", agentId:"tech-lead",
// title:"tech-lead is stuck — spawn", risk:{score,band,reasons}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { failureSignature, groupDeliveries, decisionsSaved } from "../clusterModel.ts";
import type { Delivery } from "../inboxClient.ts";

const stuck = (agentId: string, reason: string, createdAt = 1000, id = `${agentId}-${reason}-${createdAt}-${Math.random()}`) =>
  ({ id, kind: "failure", agentId, status: "pending", title: `${agentId} is stuck — ${reason}`, createdAt } as unknown as Delivery);

const code = (id: string, createdAt = 900) =>
  ({ id, kind: "code", agentId: "sr-backend", status: "pending", title: "Add retry to webhook", createdAt } as unknown as Delivery);

test("identical agent + reason share a signature", () => {
  assert.equal(failureSignature(stuck("tech-lead", "spawn")), failureSignature(stuck("tech-lead", "spawn")));
});

test("different reason, and different agent, do NOT collapse", () => {
  assert.notEqual(failureSignature(stuck("tech-lead", "spawn")), failureSignature(stuck("tech-lead", "timeout")));
  assert.notEqual(failureSignature(stuck("tech-lead", "spawn")), failureSignature(stuck("sr-backend", "spawn")));
});

test("SAFETY: a real code delivery NEVER clusters", () => {
  assert.equal(failureSignature(code("c1")), null);
});

test("SAFETY: a failure with an unrecognised title does not cluster", () => {
  assert.equal(failureSignature({ id: "x", kind: "failure", agentId: "a", title: "something else" } as unknown as Delivery), null);
});

test("garbage in → null, never a throw", () => {
  assert.equal(failureSignature(null), null);
  assert.equal(failureSignature(undefined), null);
  assert.equal(failureSignature({} as unknown as Delivery), null);
});

test("N identical failures collapse into ONE cluster of size N", () => {
  const groups = groupDeliveries([
    stuck("tech-lead", "spawn"), stuck("tech-lead", "spawn"), stuck("tech-lead", "spawn"),
    stuck("tech-lead", "timeout"), stuck("tech-lead", "timeout"),
    code("c1"),
  ]);
  const clusters = groups.filter((g) => g.kind === "cluster");
  assert.equal(clusters.length, 2);
  assert.equal(groups.filter((g) => g.kind === "single").length, 1);
  assert.equal((clusters.find((c) => c.kind === "cluster" && c.reason === "spawn") as { size: number }).size, 3);
});

test("a lone failure stays a single, not a cluster of one", () => {
  const g = groupDeliveries([stuck("qa", "spawn")]);
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, "single");
});

test("grouping does not depend on input order, and newest sorts first", () => {
  const items = [stuck("a", "spawn", 10), stuck("a", "spawn", 50), stuck("b", "timeout", 90), stuck("b", "timeout", 20)];
  const k1 = groupDeliveries(items).map((g) => g.key);
  const k2 = groupDeliveries([...items].reverse()).map((g) => g.key);
  assert.deepEqual(k1, k2);
  assert.equal(groupDeliveries(items)[0].newestAt, 90);
});

test("every delivery appears exactly once — none lost, none duplicated", () => {
  const items = [stuck("a", "spawn"), stuck("a", "spawn"), stuck("b", "x"), code("c1")];
  const seen = groupDeliveries(items).flatMap((g) => (g.kind === "cluster" ? g.members.map((m) => m.id) : [g.delivery.id]));
  assert.equal(seen.length, items.length);
  assert.equal(new Set(seen).size, items.length);
});

test("decisionsSaved counts the decisions collapsing spares the human", () => {
  // 3 spawn + 2 timeout => 5 cards become 2 => 3 decisions saved
  const g = groupDeliveries([
    stuck("t", "spawn"), stuck("t", "spawn"), stuck("t", "spawn"),
    stuck("t", "timeout"), stuck("t", "timeout"),
  ]);
  assert.equal(decisionsSaved(g), 3);
  assert.equal(decisionsSaved(groupDeliveries([code("c1")])), 0);
});

// REGRESSION (found by live verification, not by the tests above): decided deliveries
// were being clustered, so the UI offered "Dismiss all 4" on four already-rejected rows.
// The runtime correctly refused every one with "already decided" — a dead button.
test("REGRESSION: only PENDING failures cluster; decided ones stay history", () => {
  const decided = (agentId: string, reason: string, status: string) =>
    ({ id: `${agentId}-${reason}-${status}-${Math.random()}`, kind: "failure", agentId, status,
       title: `${agentId} is stuck — ${reason}`, createdAt: 1 } as unknown as Delivery);

  assert.equal(failureSignature(decided("t", "spawn", "rejected")), null);
  assert.equal(failureSignature(decided("t", "spawn", "approved")), null);
  assert.notEqual(failureSignature(decided("t", "spawn", "pending")), null);

  // three rejected + two pending → ONE cluster (of the two pending), three singles
  const groups = groupDeliveries([
    decided("t", "spawn", "rejected"), decided("t", "spawn", "rejected"), decided("t", "spawn", "approved"),
    decided("t", "spawn", "pending"), decided("t", "spawn", "pending"),
  ]);
  const clusters = groups.filter((g) => g.kind === "cluster");
  assert.equal(clusters.length, 1);
  assert.equal((clusters[0] as { size: number }).size, 2, "only the pending pair may collapse");
  assert.equal(groups.filter((g) => g.kind === "single").length, 3);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { removableKind, removalReason, deleteRequest, type RemovableAgent } from "../agentActions.ts";

const A = (over: Partial<RemovableAgent>): RemovableAgent => ({ id: "x", factory: false, imported: false, ...over });

// ── removableKind ─────────────────────────────────────────────────────────────
test("ceo is never removable", () => {
  assert.equal(removableKind(A({ id: "ceo" })), "none");
  assert.equal(removableKind(A({ id: "ceo", imported: true })), "none"); // even if flagged
  assert.equal(removableKind(A({ id: "boss" })), "none"); // boss = the CEO thread alias
});

test("imported pool agent → imported (un-pin path)", () => {
  assert.equal(removableKind(A({ id: "architect", imported: true })), "imported");
});

test("factory-created agent → factory (delete path)", () => {
  assert.equal(removableKind(A({ id: "java17-engineer", factory: true })), "factory");
});

test("imported wins over factory when both set (un-pin, don't hard-delete)", () => {
  assert.equal(removableKind(A({ id: "x", imported: true, factory: true })), "imported");
});

test("a plain builtin (not imported, not factory) is NOT removable", () => {
  assert.equal(removableKind(A({ id: "senior-web-1" })), "none");
});

// ── deleteRequest ─────────────────────────────────────────────────────────────
test("imported → POST /factory/pool/remove with id in body", () => {
  const r = deleteRequest("imported", "architect");
  assert.deepEqual(r, { method: "POST", path: "/factory/pool/remove", body: { ids: ["architect"] } });
});

test("factory → DELETE /factory/:id, no body", () => {
  const r = deleteRequest("factory", "java17-engineer");
  assert.deepEqual(r, { method: "DELETE", path: "/factory/java17-engineer" });
});

test("factory path encodes the id", () => {
  const r = deleteRequest("factory", "weird id/../x");
  assert.equal(r?.path, `/factory/${encodeURIComponent("weird id/../x")}`);
});

test("none → null (nothing to call)", () => {
  assert.equal(deleteRequest("none", "ceo"), null);
});

// P1-F4 — the delete guard. The board must never offer a destructive control for the CEO
// or for a built-in swarm agent, whatever flags the board state happens to carry.
test("ceo and boss are never removable, whatever flags they carry", () => {
  assert.equal(removableKind({ id: "ceo" }), "none");
  assert.equal(removableKind({ id: "boss" }), "none");
  assert.equal(removableKind({ id: "ceo", factory: true, imported: true }), "none");
  assert.equal(removableKind({ id: "boss", factory: true }), "none");
  assert.equal(deleteRequest(removableKind({ id: "ceo", factory: true }), "ceo"), null);
});

test("built-in swarm agents can never be DELETED, even if flagged factory", () => {
  for (const id of ["architect", "senior-web-1", "senior-qa", "memory-updater", "principal-db-engineer"]) {
    assert.equal(removableKind({ id, factory: true }), "none", `${id} must refuse delete`);
    // Un-pinning a built-in that was IMPORTED from the pool stays allowed — it is reversible.
    assert.equal(removableKind({ id, imported: true }), "imported", `${id} un-pin must stay available`);
  }
});

test("removalReason explains why a protected agent has no control", () => {
  assert.equal(removalReason({ id: "ceo" }), "The CEO is permanent.");
  assert.equal(removalReason({ id: "architect" }), "Built-in swarm agent — not removable.");
  assert.equal(removalReason({ id: "some-seed" }), "Roster seed — not created here, nothing to remove.");
  assert.equal(removalReason({ id: "minted", factory: true }), null);
  assert.equal(removalReason({ id: "pinned", imported: true }), null);
});

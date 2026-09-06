// Phase 7 / task 7.4 — the PURE half of the roster client. Zero DOM, zero network, so it
// runs under `node --experimental-strip-types` alongside the other pure-layer specs.
//
// What these pin: the parser is DEFENSIVE. `GET /runtime/roster` is trusted-ish, but the
// strip must never crash the board because a field arrived null, a member arrived without
// a scope, or the payload shape drifted. A cockpit that white-screens on a malformed row
// is worse than one that renders six cards and drops the seventh.

import test from "node:test";
import assert from "node:assert/strict";
import { parseRoster, roleLabel, scopeSummary, type RosterMember } from "../rosterClient.ts";

const ok = {
  version: 1,
  members: [
    { id: "pikachu", name: "Pikachu", seat: "ui", role: "worker", skills: ["ui"], writeScope: ["src/**/*.tsx"], tools: ["Read"], createdBy: "seed", createdAt: "2026-09-04T00:00:00.000Z" },
    { id: "manager", name: "Manager", seat: "manager", role: "manager", skills: ["repo-read"], writeScope: [], tools: ["Read"], createdBy: "seed", createdAt: "2026-09-04T00:00:00.000Z" },
  ],
};

test("RC-1: a well-formed payload parses to typed members in order", () => {
  const m = parseRoster(ok);
  assert.equal(m.length, 2);
  assert.deepEqual(m.map((x: RosterMember) => x.id), ["pikachu", "manager"]);
  assert.deepEqual(m[0].writeScope, ["src/**/*.tsx"]);
});

test("RC-2: a non-object / null / array payload yields [] rather than throwing", () => {
  for (const bad of [null, undefined, 42, "roster", [], { nope: 1 }]) {
    assert.deepEqual(parseRoster(bad), [], `parseRoster(${JSON.stringify(bad)}) must be []`);
  }
});

test("RC-3: a member missing an id is DROPPED, the rest still render", () => {
  const m = parseRoster({ members: [{ name: "Ghost", role: "worker" }, ...ok.members] });
  assert.deepEqual(m.map((x) => x.id), ["pikachu", "manager"]);
});

test("RC-4: null/absent array fields degrade to [], never to a crash", () => {
  const [m] = parseRoster({ members: [{ id: "x", name: "X", seat: "s", role: "worker" }] });
  assert.deepEqual(m.skills, []);
  assert.deepEqual(m.writeScope, []);
  assert.deepEqual(m.tools, []);
});

test("RC-5: an unknown role degrades to 'worker' rather than rendering an unstyled card", () => {
  const [m] = parseRoster({ members: [{ id: "x", name: "X", seat: "s", role: "wizard" }] });
  assert.equal(m.role, "worker");
});

test("RC-6: non-string entries inside skills/writeScope are filtered out", () => {
  const [m] = parseRoster({ members: [{ id: "x", name: "X", seat: "s", role: "worker", skills: ["ui", 7, null], writeScope: ["src/**", {}] }] });
  assert.deepEqual(m.skills, ["ui"]);
  assert.deepEqual(m.writeScope, ["src/**"]);
});

test("RC-7: roleLabel is human, and every role has one", () => {
  assert.equal(roleLabel("worker"), "worker");
  assert.equal(roleLabel("ceo"), "CEO");
  assert.equal(roleLabel("hr"), "HR");
  assert.equal(roleLabel("manager"), "manager");
});

test("RC-8: scopeSummary states the constraint honestly for an unscoped seat", () => {
  // "no write scope" is a FACT about the seat, not an empty state to be hidden.
  assert.match(scopeSummary([]), /no write access/i);
  assert.equal(scopeSummary(["src/**/*.tsx"]), "src/**/*.tsx");
  assert.equal(scopeSummary(["a", "b", "c"]), "a · b · c");
});

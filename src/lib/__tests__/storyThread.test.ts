// SESSION 14 (option A) — the collaboration thread, as a PURE view-model.
//
// The Timeline showed raw machine rows ("plan-drafted | vault:plan-… | 22:37"). This module
// turns the SAME rows into "who handed what to whom, and why". Pure: no React, no fetch, no
// clock — so every rule below is provable without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThread, type ThreadEntry } from "../storyThread.ts";
import type { StoryLogRow, StoryBuild } from "../storiesClient.ts";
import type { Delivery } from "../inboxClient.ts";

const EMPTY_BUILD: StoryBuild = { goals: [], counts: { done: 0, failed: 0, running: 0 }, total: 0 };
const row = (o: Partial<StoryLogRow> & { seq: number }): StoryLogRow =>
  ({ stage: "requirements", event: "advance", ref: null, ts: 1_000, ...o }) as StoryLogRow;

const kinds = (t: ThreadEntry[]) => t.map((e) => e.kind);

// ── T-1 — a handoff names both ends ─────────────────────────────────────────
test("T-1: an attributed advance becomes a handoff naming both seats", () => {
  const t = buildThread({
    log: [row({ seq: 1, event: "advance", byAgent: "pm-analyst", toAgent: "architect", ref: "vault:req-1" })],
    gates: [], build: EMPTY_BUILD,
  });
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, "handoff");
  assert.equal(t[0].from, "pm-analyst");
  assert.equal(t[0].to, "architect");
  assert.equal(t[0].artifactRef, "vault:req-1");
});

// ── T-2 — an UNATTRIBUTED row is never given an invented author ─────────────
// The whole reason this data is recorded server-side rather than inferred from a
// stage→seat table. A row with no author renders as an event, not as a guess.
test("T-2: a row with no attribution is an event, never a fabricated handoff", () => {
  const t = buildThread({ log: [row({ seq: 1, event: "create" })], gates: [], build: EMPTY_BUILD });
  assert.equal(t[0].kind, "event");
  assert.equal(t[0].from, null, "no author invented");
  assert.equal(t[0].to, null);
});

// ── T-3 — a rework bounce reads backwards, and carries its evidence ─────────
test("T-3: a reject becomes a rework entry with its evidence", () => {
  const t = buildThread({
    log: [row({ seq: 1, stage: "build", event: "reject", byAgent: "reviewer", toAgent: "sr-backend", evidence: ["null deref in cart.ts:42"] })],
    gates: [], build: EMPTY_BUILD,
  });
  assert.equal(t[0].kind, "rework");
  assert.equal(t[0].from, "reviewer");
  assert.equal(t[0].to, "sr-backend");
  assert.deepEqual(t[0].evidence, ["null deref in cart.ts:42"]);
});

// ── T-4 — a failed stage is its own kind, and names the stuck seat ──────────
test("T-4: a *-failed event becomes a failure entry naming the seat and reason", () => {
  const t = buildThread({
    log: [row({ seq: 1, event: "requirements-failed", byAgent: "pm-analyst", ref: "engine did not answer — timed out after 600s" })],
    gates: [], build: EMPTY_BUILD,
  });
  assert.equal(t[0].kind, "failure");
  assert.equal(t[0].from, "pm-analyst");
  assert.match(String(t[0].detail), /timed out/);
});

// ── T-5 — a pending human gate is inserted in TIME ORDER, not appended ──────
// A gate that renders after later work reads as though the human was asked last.
test("T-5: a pending gate lands in chronological position among the log rows", () => {
  const gate = { id: "g1", kind: "design-approval", status: "pending", createdAt: new Date(2_000).toISOString(), title: "Design approval: X", agentId: "architect" } as unknown as Delivery;
  const t = buildThread({
    log: [row({ seq: 1, ts: 1_000, event: "design-drafted", byAgent: "architect" }), row({ seq: 2, ts: 3_000, event: "design-approved" })],
    gates: [gate], build: EMPTY_BUILD,
  });
  assert.deepEqual(kinds(t), ["handoff", "gate", "event"], "the gate sits between the two log rows");
});

// ── T-6 — the plan→build fan-out names the seats that actually got goals ────
// `plan` hands to N seats, so the server records no single toAgent. The receivers come
// from the real goal set, never from a guess.
test("T-6: a plan handoff takes its receivers from the actual build goals", () => {
  const build: StoryBuild = {
    goals: [
      { goalId: "g1", seat: "sr-backend", tier: null, steps: [], state: "running", tasks: [] },
      { goalId: "g2", seat: "sr-frontend", tier: null, steps: [], state: "running", tasks: [] },
    ],
    counts: { done: 0, failed: 0, running: 2 }, total: 2,
  };
  const t = buildThread({
    log: [row({ seq: 1, stage: "build", event: "plan-drafted", byAgent: "tech-lead", ref: "vault:plan-1" })],
    gates: [], build,
  });
  assert.equal(t[0].kind, "handoff");
  assert.equal(t[0].from, "tech-lead");
  assert.equal(t[0].to, "sr-backend + sr-frontend", "both receivers, from real goals");
});

// ── T-7 — an unmapped event still appears ───────────────────────────────────
// An event nobody wrote a case for is still something that happened. Dropping it would
// make the thread quietly incomplete — the failure mode this whole session was about.
test("T-7: an unknown event name renders as itself rather than being dropped", () => {
  const t = buildThread({ log: [row({ seq: 1, event: "some-future-event" })], gates: [], build: EMPTY_BUILD });
  assert.equal(t.length, 1);
  assert.equal(t[0].label, "some-future-event");
});

// ── T-8 — degenerate input never throws ─────────────────────────────────────
test("T-8: null/undefined input yields an empty thread, never a throw", () => {
  assert.deepEqual(buildThread({ log: null as never, gates: null as never, build: null as never }), []);
  assert.deepEqual(buildThread(undefined as never), []);
});

// ── T-9 — ordering is by time, and stable ───────────────────────────────────
test("T-9: entries are ordered oldest-first and every entry has a unique key", () => {
  const t = buildThread({
    log: [row({ seq: 2, ts: 5_000, event: "b" }), row({ seq: 1, ts: 1_000, event: "a" })],
    gates: [], build: EMPTY_BUILD,
  });
  assert.deepEqual(t.map((e) => e.label), ["a", "b"]);
  assert.equal(new Set(t.map((e) => e.key)).size, t.length, "keys unique — React list safety");
});

// ── Phase 8 / 8.3 — mail rows in the thread ──────────────────────────────────
// A mail row is a CONVERSATION, not a stage transition, so it gets its own kind rather than
// being dressed up as a handoff. `mail-refused` is rendered too, muted: a message the rules
// dropped is exactly the thing an operator needs to see, and hiding it would make the routing
// rules invisible at the moment they mattered.
test("MAILTHREAD-1: a mail row becomes kind `mail` with both ends attributed", () => {
  const [e] = buildThread({
    log: [{ seq: 1, stage: "build", event: "mail", ref: "handoff", ts: 1000,
      byAgent: "sr-frontend", toAgent: "sr-backend" }],
  });
  assert.equal(e.kind, "mail");
  assert.equal(e.from, "sr-frontend");
  assert.equal(e.to, "sr-backend");
  assert.equal(e.label, "mail");
  assert.equal(e.detail, "handoff", "the kind of message travels in detail");
});

test("MAILTHREAD-2: a refused message is kept and marked, never dropped", () => {
  const [e] = buildThread({
    log: [{ seq: 1, stage: "build", event: "mail-refused", ref: "question", ts: 1000,
      byAgent: "sr-frontend", toAgent: "ceo" }],
  });
  assert.equal(e.kind, "mail-refused", "the operator must be able to see the rules bite");
  assert.equal(e.from, "sr-frontend");
  assert.equal(e.to, "ceo");
});

test("MAILTHREAD-3: a mail row is NOT classified as a handoff", () => {
  // Before 8.3 any attributed row fell through to `handoff`. That would read as "work moved
  // to sr-backend" when in fact somebody just asked a question.
  const [e] = buildThread({
    log: [{ seq: 1, stage: "build", event: "mail", ref: "question", ts: 1, byAgent: "a", toAgent: "b" }],
  });
  assert.notEqual(e.kind, "handoff");
});

test("MAILTHREAD-4: mail rows interleave with transitions in time order", () => {
  const rows = buildThread({
    log: [
      { seq: 1, stage: "build", event: "plan-drafted", ref: null, ts: 100, byAgent: "tech-lead", toAgent: null },
      { seq: 2, stage: "build", event: "mail", ref: "question", ts: 200, byAgent: "sr-frontend", toAgent: "sr-backend" },
      { seq: 3, stage: "build", event: "mail", ref: "answer", ts: 300, byAgent: "sr-backend", toAgent: "sr-frontend" },
    ],
  });
  assert.deepEqual(rows.map((r) => r.kind), ["handoff", "mail", "mail"]);
  assert.deepEqual(rows.map((r) => r.ts), [100, 200, 300]);
});

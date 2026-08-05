// B1 T4 — the deck's pure layer.
//
// Two jobs here. (1) The badge mapper is table-driven over EVERY AgentColumn value in
// the real vocabulary, so a deck badge can never be a guess. (2) The client station
// mirror is pinned to the server's seed list and to the factory skill catalog — if the
// two ever drift, this test goes red instead of the screen going wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATIONS,
  STATION_IDS,
  BADGE_LABEL,
  BADGE_TONE,
  stationBadge,
  stationById,
  onWatchCount,
  deckOrder,
  stationOrdinal,
  CAPTAIN_ID,
} from "../stationMeta.ts";
import { COLUMN_ORDER } from "../agentMeta.ts";
import type { AgentColumn, AgentState } from "../../data/types.ts";
// the server-side source of truth for the same roster
import { STATIONS as SEED_STATIONS } from "../../../agent-runtime/seed-stations.mjs";
import { SKILL_CATALOG } from "../../../agent-runtime/factory.mjs";

// A live agent, with only the fields the mapper reads varied per case.
function agent(over: Partial<AgentState> = {}): AgentState {
  return {
    id: "tech-lead", role: "Orchestration", tier: "support",
    state: "IDLE", column: "idle", pipelineStage: "build",
    task: null, file: null, blockedBy: null,
    heartbeatAt: "2026-07-30T12:00:00.000Z", ageSec: 5, ttlSec: 300,
    stale: false, dead: false, inbox: [], next: null, eta: null,
    ...over,
  };
}

// ── mapper ───────────────────────────────────────────────────────────────────

test("stationBadge: every real column maps to exactly one of the three badges", () => {
  const table: Record<AgentColumn, string> = {
    idle: "standby",
    in_progress: "on",
    blocked: "standby",
    awaiting_user: "standby",
    review: "standby",
    done: "standby",
    offline: "off",
  };
  // the table must cover the SHIPPED column vocabulary, not a private copy of it
  assert.deepEqual(Object.keys(table).sort(), [...COLUMN_ORDER].sort());
  for (const [column, expected] of Object.entries(table)) {
    assert.equal(stationBadge(agent({ column: column as AgentColumn })), expected, column);
  }
});

test("stationBadge: an unknown column falls back to off, never to green", () => {
  assert.equal(stationBadge(agent({ column: "wat" as AgentColumn })), "off");
});

test("stationBadge: a missing agent is OFF WATCH, not a fabricated green", () => {
  assert.equal(stationBadge(undefined), "off");
  assert.equal(stationBadge(null), "off");
});

test("stationBadge: stale or dead is OFF WATCH even mid-run", () => {
  assert.equal(stationBadge(agent({ column: "in_progress", stale: true })), "off");
  assert.equal(stationBadge(agent({ column: "in_progress", dead: true })), "off");
});

test("stationBadge: a station that has never run is OFF WATCH, not STANDING BY", () => {
  assert.equal(stationBadge(agent({ column: "idle", heartbeatAt: null, task: null })), "off");
  // …but one that HAS beaten and is now idle is genuinely standing by
  assert.equal(stationBadge(agent({ column: "idle", heartbeatAt: "2026-07-30T12:00:00.000Z" })), "standby");
  // …and an idle-but-tasked row is standing by too
  assert.equal(stationBadge(agent({ column: "idle", heartbeatAt: null, task: "daily rollup" })), "standby");
});

test("every badge id has a label and a tone", () => {
  for (const id of ["on", "standby", "off"] as const) {
    assert.ok(BADGE_LABEL[id], id);
    assert.ok(BADGE_TONE[id], id);
  }
  assert.equal(BADGE_LABEL.on, "ON WATCH");
  assert.equal(BADGE_LABEL.standby, "STANDING BY");
  assert.equal(BADGE_LABEL.off, "OFF WATCH");
});

test("onWatchCount counts only agents actually running", () => {
  const list = [
    agent({ id: "a", column: "in_progress" }),
    agent({ id: "b", column: "in_progress", stale: true }),
    agent({ id: "c", column: "blocked" }),
    agent({ id: "d", column: "offline" }),
  ];
  assert.equal(onWatchCount(list), 1);
  assert.equal(onWatchCount([]), 0);
});

// ── ordering ─────────────────────────────────────────────────────────────────

test("deckOrder puts the SE seats first (roster order), drops the captain, keeps the swarm", () => {
  const list = [
    agent({ id: "senior-web-1", role: "Web" }),
    agent({ id: "qa" }),
    agent({ id: CAPTAIN_ID, role: "CEO" }),
    agent({ id: "tech-lead" }),
  ];
  assert.deepEqual(deckOrder(list).map((a) => a.id), ["tech-lead", "qa", "senior-web-1"]);
});

test("deckOrder renders no card for a seat the feed does not carry", () => {
  assert.deepEqual(deckOrder([agent({ id: "sr-backend" })]).map((a) => a.id), ["sr-backend"]);
  assert.deepEqual(deckOrder([]), []);
});

test("stationOrdinal is 1-based and zero-padded", () => {
  assert.equal(stationOrdinal(0), "STATION 01");
  assert.equal(stationOrdinal(9), "STATION 10");
});

// ── mirror integrity ─────────────────────────────────────────────────────────

test("the client seat mirror matches the server seed list exactly", () => {
  assert.equal(STATIONS.length, SEED_STATIONS.length);
  assert.deepEqual([...STATION_IDS], SEED_STATIONS.map((s: { id: string }) => s.id));
  for (const seed of SEED_STATIONS as ReadonlyArray<{ id: string; title: string; role: string; blurb: string; skills: readonly string[] }>) {
    const mine = stationById(seed.id);
    assert.ok(mine, `${seed.id} missing from the client mirror`);
    assert.equal(mine.name, seed.title, `${seed.id} name`);
    assert.equal(mine.role, seed.role, `${seed.id} role`);
    assert.equal(mine.blurb, seed.blurb, `${seed.id} blurb`);
    assert.deepEqual(mine.skills.map((s) => s.id), [...seed.skills], `${seed.id} skills`);
  }
});

test("every mirrored skill label matches the factory catalog (no invented capability)", () => {
  const byId = new Map((SKILL_CATALOG as ReadonlyArray<{ id: string; label: string }>).map((s) => [s.id, s]));
  for (const s of STATIONS) {
    for (const skill of s.skills) {
      const entry = byId.get(skill.id);
      assert.ok(entry, `${skill.id} is not in SKILL_CATALOG`);
      assert.equal(skill.label, entry.label, `${skill.id} label drifted`);
    }
  }
});

test("stationById returns null for a swarm agent", () => {
  assert.equal(stationById("senior-web-1"), null);
  assert.equal(stationById(CAPTAIN_ID), null);
});

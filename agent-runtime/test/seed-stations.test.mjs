// S0 — the ten SE seats are REAL registry agents, seeded idempotently, and the five
// retired business stations converge away.
//
// The point of these tests is that the deck is not a fixture: after a boot the SAME
// registry the Agent Factory writes contains the ten seats with their roles and skills,
// a second boot changes nothing, an agent the BOSS created by hand is never touched by
// the seed, and a registry that predates the story-pipeline pivot loses its business
// stations without a manual reset.
//
// Registry + persona dir are redirected to a tmpdir via the env overrides factory.mjs
// resolves LAZILY, so this test never writes the repo.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "ma-seed-"));
  process.env.FACTORY_REGISTRY_FILE = join(root, "factory", "registry.json");
  process.env.RUNTIME_AGENTS_DIR = join(root, "agents");
  process.env.RUNTIME_TOKEN_DIR = join(root, "rt");
});
after(() => {
  delete process.env.FACTORY_REGISTRY_FILE;
  delete process.env.RUNTIME_AGENTS_DIR;
  delete process.env.RUNTIME_TOKEN_DIR;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

// imported AFTER the env is staged is unnecessary (paths resolve per call), but the
// registry is module-level, so every test below shares one loaded registry.
const factory = await import("../factory.mjs");
const { STATIONS, STATION_IDS, RETIRED_STATION_IDS, seedStations, retireStaleStations, isStation } = await import("../seed-stations.mjs");

const byId = (id) => factory.listAgents().find((a) => a.id === id);

test("S0: the roster is the ten SE seats from the plan", () => {
  assert.deepEqual([...STATION_IDS], [
    "tech-lead", "pm-analyst", "architect", "sr-backend", "sr-frontend",
    "reviewer", "qa", "devops", "sre", "docs-writer",
  ]);
  assert.equal(STATIONS.length, 10);
  assert.ok(isStation("tech-lead"));
  assert.ok(!isStation("ceo"));
  // and none of the retired business stations is in the roster any more
  for (const id of RETIRED_STATION_IDS) assert.ok(!isStation(id), `${id} must be retired`);
});

test("S0: every seat skill is a real SKILL_CATALOG id (no invented capability)", () => {
  const ids = new Set(factory.SKILL_CATALOG.map((s) => s.id));
  for (const s of STATIONS) {
    assert.equal(s.skills.length, 3, `${s.id} must carry 3 skills`);
    for (const skill of s.skills) assert.ok(ids.has(skill), `${s.id}: unknown skill ${skill}`);
  }
});

test("S0: seeding an empty registry creates all ten with role + title + skills", () => {
  factory.loadRegistry();
  const r = seedStations();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.created, [...STATION_IDS]);
  assert.deepEqual(r.skipped, []);
  for (const s of STATIONS) {
    const got = byId(s.id);
    assert.ok(got, `${s.id} missing from registry`);
    assert.equal(got.role, s.role);
    assert.equal(got.title, s.title);
    assert.deepEqual(got.skills, [...s.skills]);
    // persona persisted to disk too — this is the file the runtime's systemFor() reads.
    assert.ok(existsSync(join(root, "agents", `${s.id}.md`)), `${s.id}.md not written`);
  }
});

test("S0: seats survive a restart (registry file is the source of truth)", () => {
  factory.loadRegistry(); // re-read from disk, as the server does at boot
  for (const id of STATION_IDS) assert.ok(byId(id), `${id} did not survive reload`);
});

test("S0: seeding twice is a no-op — still exactly ten seats, no duplicates", () => {
  const before2 = factory.listAgents().length;
  const r = seedStations();
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.skipped, [...STATION_IDS]);
  assert.equal(factory.listAgents().length, before2);
  const ids = factory.listAgents().map((a) => a.id);
  for (const id of STATION_IDS) {
    assert.equal(ids.filter((x) => x === id).length, 1, `${id} duplicated`);
  }
  const persisted = JSON.parse(readFileSync(process.env.FACTORY_REGISTRY_FILE, "utf-8"));
  assert.equal(persisted.filter((a) => STATION_IDS.includes(a.id)).length, 10);
});

test("S0: an existing hand-made agent is untouched by the seed", () => {
  factory.loadRegistry();
  const mine = factory.createAgent({
    id: "my-own-agent", title: "Mine", role: "Hand made",
    persona: "You are an agent the BOSS created by hand and the seed must never touch.",
    skills: ["repo-read"], tools: ["Read"],
  });
  assert.ok(!mine.error, mine.error);
  const before2 = byId("my-own-agent");
  const r = seedStations();
  assert.deepEqual(r.created, []);
  assert.deepEqual(byId("my-own-agent"), before2);
});

test("S0: a seeded seat holds no posting skill, no integration, and Read only", () => {
  for (const id of STATION_IDS) {
    const got = byId(id);
    assert.deepEqual(got.integrations, [], `${id} must have no integration`);
    assert.deepEqual(got.tools, ["Read"], `${id} must be read-only`);
    for (const skill of got.skills) {
      const entry = factory.SKILL_CATALOG.find((c) => c.id === skill);
      assert.equal(entry.posting, false, `${skill} must not be a posting skill`);
      assert.equal(entry.dev, undefined, `${skill} must not be a sandbox dev skill`);
    }
  }
});

// ── S0 migration: a registry that predates the pivot converges ────────────────

test("S0: retireStaleStations removes a business station left in an old registry", () => {
  factory.loadRegistry();
  // stage a pre-pivot registry entry through the SAME factory path that wrote it
  const staged = factory.createAgent({
    id: "coo-station", title: "COO", role: "Comms & ops",
    persona: "You are the COO station from the pre-pivot build. Bus comms in /caveman full.",
    skills: ["repo-read"], tools: ["Read"],
  }, { announce: false });
  assert.ok(!staged.error, staged.error);
  assert.ok(byId("coo-station"), "staged");

  const r = retireStaleStations();
  assert.deepEqual(r.removed, ["coo-station"]);
  assert.equal(byId("coo-station"), undefined, "the retired station is gone from the registry");

  // idempotent — a second pass removes nothing and throws nothing
  assert.deepEqual(retireStaleStations().removed, []);
  // and it never touches a seat that is still on the roster
  for (const id of STATION_IDS) assert.ok(byId(id), `${id} must survive the retire pass`);
});

test("S0: retireStaleStations only ever touches the closed retired list", () => {
  factory.loadRegistry();
  const mine = byId("my-own-agent");
  assert.ok(mine, "the hand-made agent from the earlier test is still here");
  retireStaleStations();
  assert.deepEqual(byId("my-own-agent"), mine, "a BOSS-made agent is never retired");
});

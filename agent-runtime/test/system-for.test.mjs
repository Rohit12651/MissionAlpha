// B1 — buildSystemFor: dev-agent branch gets redirect directive + tool note;
// "never claim you ran code" clause is dropped for dev agents, kept for content agents.
//
// Imports system-prompt.mjs (NOT server.mjs) so the HTTP server is never started.
// factory.mjs is the shared in-memory registry; tests create real agents there.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Isolate the factory's repo-bound writes (TRACKED factory/registry.json + .claude/agents/*.md)
// to a per-run tmpdir so this test never pollutes the real registry. factory.mjs resolves
// these paths lazily from env, so setting them at module top (before any createAgent) suffices.
const TMP = mkdtempSync(join(tmpdir(), "ma-system-for-"));
process.env.FACTORY_REGISTRY_FILE = join(TMP, "registry.json");
process.env.RUNTIME_AGENTS_DIR = join(TMP, "agents");

import * as factory from "../factory.mjs";
import { buildSystemFor } from "../system-prompt.mjs";

// Test agent ids — cleaned up before AND after each run (idempotent).
const TEST_IDS = ["sf-dev-go-1", "sf-content-1", "sf-dev-angular-1"];
// Agent .md files are written to the isolated agents dir set above.
const AGENTS_DIR = process.env.RUNTIME_AGENTS_DIR;

function cleanupTestAgents() {
  factory.loadRegistry();
  for (const id of TEST_IDS) {
    factory.deleteAgent(id);
    const f = join(AGENTS_DIR, `${id}.md`);
    try { if (existsSync(f)) rmSync(f); } catch { /* */ }
  }
}

before(() => {
  // Purge leftover test agents from prior runs before creating fresh ones.
  cleanupTestAgents();
});

after(() => {
  cleanupTestAgents();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

/** Create a real dev-skill agent (idempotent — pre-cleaned in before()). */
function createDev(id, extra = {}) {
  return factory.createAgent({
    id,
    role: "Go implementer",
    title: "Go Implementer",
    persona: "You implement Go code inside the sandbox. Bus comms in /caveman full.",
    skills: ["code-implement-go"],
    tools: ["Read", "Write", "Run"],
    integrations: [],
    redirect: "golang-pro",
    ...extra,
  });
}

/** Create a real read-only (non-dev) agent (idempotent — pre-cleaned in before()). */
function createContent(id) {
  return factory.createAgent({
    id,
    role: "Repo analyst",
    title: "Repo Analyst",
    persona: "You read the repository and report what you can source. Bus comms in /caveman full.",
    skills: ["repo-read"],
    tools: ["Read"],
    integrations: [],
  });
}

// ── B1 tests ─────────────────────────────────────────────────────────────────

test("B1: dev agent system prompt contains SPECIALIST REDIRECT directive", () => {
  const r = createDev("sf-dev-go-1");
  assert.ok(!r.error, `createAgent failed: ${r.error}`);

  const sys = buildSystemFor("sf-dev-go-1", "none");
  assert.ok(sys.includes("SPECIALIST REDIRECT"), "must include SPECIALIST REDIRECT header");
  assert.ok(sys.includes("golang-pro"), "must name golang-pro as the specialist");
});

test("B1: dev agent system prompt includes /run and /exec tool note", () => {
  // agent sf-dev-go-1 already in registry
  const sys = buildSystemFor("sf-dev-go-1", "none");
  assert.ok(sys.includes("/run") || sys.includes("/exec"), "must mention /run or /exec");
  assert.ok(
    sys.includes("Docker") || sys.includes("jailed") || sys.includes("sandbox"),
    "must mention jailed/Docker execution"
  );
});

test("B1: dev agent system prompt does NOT contain 'Never claim you ran code'", () => {
  const sys = buildSystemFor("sf-dev-go-1", "none");
  const lower = sys.toLowerCase();
  assert.ok(
    !lower.includes("never claim you ran code"),
    "dev agent must NOT have the 'never claim you ran code' clause"
  );
});

test("B1: content agent system prompt DOES contain 'Never claim you posted, ran code'", () => {
  const r = createContent("sf-content-1");
  assert.ok(!r.error, `createAgent failed: ${r.error}`);

  const sys = buildSystemFor("sf-content-1", "none");
  // The clause lives verbatim in buildSystemFor for content agents
  assert.ok(
    sys.includes("Never claim you posted, ran code"),
    `content agent must retain the no-code claim clause. Got: ${sys.slice(0, 400)}`
  );
});

test("B1: non-dev agent system prompt does NOT contain SPECIALIST REDIRECT", () => {
  const sys = buildSystemFor("sf-content-1", "none");
  assert.ok(!sys.includes("SPECIALIST REDIRECT"), "non-dev agent must not have SPECIALIST REDIRECT");
  assert.ok(!sys.includes("golang-pro"), "non-dev agent must not mention golang-pro");
});

test("S0: boss system prompt is the Tech Lead seat (dispatch protocol kept, no SPECIALIST REDIRECT)", () => {
  const sys = buildSystemFor("boss", "none");
  assert.ok(sys.includes("Tech Lead"), "boss must use the Tech Lead system");
  assert.ok(sys.includes("DISPATCH PROTOCOL"), "the dispatch protocol must survive the re-persona");
  assert.ok(!sys.includes("SPECIALIST REDIRECT"), "boss must not have SPECIALIST REDIRECT");
});

test("B1: builtin agent returns CAVEMAN_SYSTEM (no factory persona)", () => {
  // senior-lead-dev is a builtin — no factory persona, uses CAVEMAN_SYSTEM.
  // (`architect` is NOT one any more: S0 made it a seeded SE seat.)
  const sys = buildSystemFor("senior-lead-dev", "none");
  assert.ok(!sys.includes("SPECIALIST REDIRECT"), "builtin must not have SPECIALIST REDIRECT");
  assert.ok(sys.length > 10, "must return non-empty system for builtin");
});

test("B1: angular dev agent gets angular-architect redirect", () => {
  const r = factory.createAgent({
    id: "sf-dev-angular-1",
    role: "Angular implementer",
    title: "Angular Implementer",
    persona: "You implement Angular components in the sandbox. Bus comms in /caveman full.",
    skills: ["code-implement-angular"],
    tools: ["Read", "Write", "Run"],
    integrations: [],
    redirect: "angular-architect",
  });
  assert.ok(!r.error, `createAgent failed: ${r.error}`);

  const sys = buildSystemFor("sf-dev-angular-1", "none");
  assert.ok(sys.includes("angular-architect"), "angular dev agent must name angular-architect");
  assert.ok(!sys.toLowerCase().includes("never claim you ran code"), "angular dev agent must not have no-code clause");
});

// P1-F6 — the boss prompt must document the ```team block so the proposal card has a source.
test("boss system prompt documents the TEAM PROTOCOL block", () => {
  const s = buildSystemFor("boss", "none");
  assert.match(s, /TEAM PROTOCOL/);
  assert.match(s, /```team/);
  assert.match(s, /<agent-id> <role title> \| <skill,skill>/);
  // The governed catalog ids must be named so the seat can only propose real skills.
  assert.match(s, /repo-health-check/);
  assert.match(s, /repo-read/);
});

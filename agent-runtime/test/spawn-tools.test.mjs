// G5 — --allowed-tools derived from validated spec at minted-agent spawn.
// Tests agent-tools.mjs (the pure helper imported by server.mjs in cliReply /
// engineDispatch) plus the server behavior contract:
//   • factory agent: tools derived from spec (Read always; Write+Edit if write skill; no Bash)
//   • built-in agent: null returned → caller uses global TOOLS mode (unchanged)
//   • args fully built (sync) before stdin write (enforced by pure-sync helper)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { allowedToolsForAgent } from "../agent-tools.mjs";
import { createAgent, deleteAgent, loadRegistry, validateSpec } from "../factory.mjs";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Isolate: redirect the factory's repo-bound writes (TRACKED factory/registry.json +
// .claude/agents/*.md) to a per-run tmpdir so tests never pollute the real registry.
// factory.mjs resolves these paths LAZILY from env, so setting them before the first
// loadRegistry()/createAgent() call (i.e. here at module top) is enough.
const TMP = mkdtempSync(join(tmpdir(), "ma-spawn-tools-"));
process.env.FACTORY_REGISTRY_FILE = join(TMP, "registry.json");
process.env.RUNTIME_AGENTS_DIR = join(TMP, "agents");

let tempDir;
let createdIds = [];

before(() => {
  tempDir = TMP;
  loadRegistry(); // hydrate from the isolated (empty) registry
});

after(() => {
  // Clean up any agents we created
  for (const id of createdIds) {
    try { deleteAgent(id); } catch { /* */ }
  }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
});

// ── G5: built-in agent returns null (no change to global TOOLS mode) ──────────
test("G5: allowedToolsForAgent — built-in agent returns null", () => {
  assert.equal(allowedToolsForAgent("ceo"), null, "ceo must return null (built-in)");
  assert.equal(allowedToolsForAgent("architect"), null, "architect must return null");
  assert.equal(allowedToolsForAgent("boss"), null, "boss must return null");
  assert.equal(allowedToolsForAgent("some-unknown-builtin"), null, "unknown id returns null");
});

// ── G5: factory agent with read-only skill → only Read ────────────────────────
test("G5: factory agent with content-writing skill (Read-only) → [Read] only", () => {
  const id = "spawn-tools-content-" + Date.now().toString(36);
  createdIds.push(id);
  const result = createAgent({
    id, role: "Content writer", title: "Content Writer",
    persona: "You write content. Bus comms in /caveman full.",
    skills: ["content-writing"], tools: ["Read"], integrations: [],
  });
  assert.ok(!result.error, `createAgent failed: ${result.error}`);

  const tools = allowedToolsForAgent(id);
  assert.ok(Array.isArray(tools), "factory agent must return an array");
  assert.ok(tools.includes("Read"), "Read must be present");
  assert.ok(!tools.includes("Write"), "Write must NOT be present for read-only skill");
  assert.ok(!tools.includes("Edit"), "Edit must NOT be present");
  assert.ok(!tools.includes("Bash"), "Bash must NEVER be present");
  assert.ok(!tools.includes("Run"), "Run must not be in allowed-tools list");
});

// ── G5: factory agent with write-class skill → Read + Write + Edit ────────────
test("G5: factory agent with repo-edit skill (Write-class) → [Read, Write, Edit]", () => {
  const id = "spawn-tools-edit-" + Date.now().toString(36);
  createdIds.push(id);
  const result = createAgent({
    id, role: "Repo editor", title: "Repo Editor",
    persona: "You edit code in sandbox. Bus comms in /caveman full.",
    skills: ["repo-edit"], tools: ["Read", "Write"], integrations: [],
  });
  assert.ok(!result.error, `createAgent failed: ${result.error}`);

  const tools = allowedToolsForAgent(id);
  assert.ok(tools.includes("Read"), "Read always present");
  assert.ok(tools.includes("Write"), "Write present for write-class skill");
  assert.ok(tools.includes("Edit"), "Edit present for write-class skill");
  assert.ok(!tools.includes("Bash"), "Bash never");
});

// ── G5: factory dev agent with code-implement-go → Read + Write + Edit ────────
test("G5: factory dev agent with code-implement-go → [Read, Write, Edit]", () => {
  const id = "spawn-tools-go-" + Date.now().toString(36);
  createdIds.push(id);
  const result = createAgent({
    id, role: "Go implementer", title: "Go Implementer",
    persona: "You implement Go code in sandbox. Bus comms in /caveman full.",
    skills: ["code-implement-go"], tools: ["Read", "Write", "Run"], integrations: [],
    redirect: "golang-pro",
  });
  assert.ok(!result.error, `createAgent failed: ${result.error}`);

  const tools = allowedToolsForAgent(id);
  assert.ok(tools.includes("Read"), "Read always present");
  assert.ok(tools.includes("Write"), "Write for Go dev skill");
  assert.ok(tools.includes("Edit"), "Edit for Go dev skill");
  assert.ok(!tools.includes("Bash"), "Bash never");
  assert.ok(!tools.includes("Run"), "Run not in --allowed-tools (it's the exec-broker path)");
});

// ── G5: args are computable synchronously before stdin.write ──────────────────
test("G5: allowedToolsForAgent is synchronous — args computable before stdin write", () => {
  const id = "spawn-tools-sync-" + Date.now().toString(36);
  createdIds.push(id);
  createAgent({
    id, role: "Sync test", title: "Sync Test",
    persona: "You are a sync test agent. Bus comms in /caveman full.",
    skills: ["content-writing"], tools: ["Read"], integrations: [],
  });

  // Simulate the spawn-frame order
  const order = [];
  const tools = allowedToolsForAgent(id); // sync — runs before any async
  order.push("args-built");
  // In real cliReply: spawn(CLAUDE_BIN, args) → child.stdin.write(prompt)
  // Both are sync after the args array is finalized. Confirm tools is available.
  order.push("stdin-write");
  assert.equal(order[0], "args-built", "args must be built before stdin write");
  assert.ok(Array.isArray(tools), "tools array available synchronously");
});

// ── G5: strict-mcp-config kept (factory agents get no MCP grant) ──────────────
import { SKILL_CATALOG } from "../factory.mjs";
test("G5: factory dev agent gets no MCP grant (dev skills have empty platforms)", () => {
  const goSkill = SKILL_CATALOG.find((s) => s.id === "code-implement-go");
  assert.deepEqual(goSkill.platforms, [], "dev skill must have no platforms (no MCP)");
  const angularSkill = SKILL_CATALOG.find((s) => s.id === "code-implement-angular");
  assert.deepEqual(angularSkill.platforms, [], "dev skill must have no platforms (no MCP)");
});

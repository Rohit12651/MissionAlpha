// G4+G6 — factory.mjs: dev skill catalog entries, dev-agent posting block,
// guards.mjs SEED_DIRS/CONFIG_GUARD integrity, no MCP grant from exec capability.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SKILL_CATALOG, validateSpec, isFactoryAgent } from "../factory.mjs";
const ALLOWED_TOOLS_SET = new Set(["Read", "Write", "Run"]); // mirrors factory's internal ALLOWED_TOOLS
import { SEED_DIRS, CONFIG_GUARD, applyAllowed } from "../guards.mjs";

// ── G4: code-implement-* dev skills in catalog ────────────────────────────────
test("G4: code-implement-go skill exists in catalog with correct constraints", () => {
  const skill = SKILL_CATALOG.find((s) => s.id === "code-implement-go");
  assert.ok(skill, "code-implement-go must be in SKILL_CATALOG");
  assert.deepEqual([...skill.tools].sort(), ["Read", "Run", "Write"].sort(), "tools must be exactly {Read, Write, Run}");
  assert.deepEqual(skill.platforms, [], "platforms must be empty (no MCP/posting)");
  assert.equal(skill.posting, false, "posting must be false");
  assert.equal(skill.dev, true, "must have dev:true flag");
  assert.equal(skill.redirect, "golang-pro", "redirect must be golang-pro");
});

test("G4: code-implement-angular skill exists in catalog with correct constraints", () => {
  const skill = SKILL_CATALOG.find((s) => s.id === "code-implement-angular");
  assert.ok(skill, "code-implement-angular must be in SKILL_CATALOG");
  assert.deepEqual([...skill.tools].sort(), ["Read", "Run", "Write"].sort(), "tools must be exactly {Read, Write, Run}");
  assert.deepEqual(skill.platforms, [], "platforms must be empty");
  assert.equal(skill.posting, false, "posting must be false");
  assert.equal(skill.dev, true, "must have dev:true flag");
  assert.equal(skill.redirect, "angular-architect", "redirect must be angular-architect");
});

test("G4: dev skills only unlock {Read, Write, Run} — no Bash/exec/MCP tool", () => {
  const devSkills = SKILL_CATALOG.filter((s) => s.dev);
  for (const s of devSkills) {
    for (const t of s.tools) {
      assert.ok(ALLOWED_TOOLS_SET.has(t), `dev skill ${s.id} must not grant tool outside ALLOWED_TOOLS: ${t}`);
      assert.notEqual(t, "Bash", `dev skill ${s.id} must not grant Bash`);
    }
    assert.deepEqual(s.platforms, [], `dev skill ${s.id} must have empty platforms (no MCP coupling)`);
  }
});

// ── G6: minted dev agent with empty integrations cannot post ─────────────────
test("G6: validateSpec — dev skill requires an allowlisted redirect", () => {
  // Missing redirect → error
  const result = validateSpec({
    id: "test-dev-no-redirect",
    role: "Go implementer",
    title: "Go Implementer",
    persona: "You implement Go code in the sandbox following the task spec. Bus comms in /caveman full.",
    skills: ["code-implement-go"],
    tools: ["Read", "Write", "Run"],
    integrations: [],
  });
  // Should fail: dev skill without a valid redirect in SPECIALIST_ALLOWLIST
  // (or succeed only if we explicitly pass redirect — no redirect field here → error)
  assert.ok(result.error, `Expected error for dev skill without redirect, got: ${JSON.stringify(result)}`);
});

test("G6: validateSpec — dev skill with valid redirect is accepted", () => {
  const result = validateSpec({
    id: "test-dev-with-redirect",
    role: "Go implementer",
    title: "Go Implementer",
    persona: "You implement Go code in the sandbox following the task spec. Bus comms in /caveman full.",
    skills: ["code-implement-go"],
    tools: ["Read", "Write", "Run"],
    integrations: [],
    redirect: "golang-pro",
  });
  assert.ok(!result.error, `Expected no error but got: ${result.error}`);
  assert.equal(result.spec.redirect, "golang-pro", "redirect must be preserved in spec");
});

test("G6: validateSpec — redirect not in SPECIALIST_ALLOWLIST is rejected", () => {
  const result = validateSpec({
    id: "test-dev-bad-redirect",
    role: "Malicious agent",
    title: "Malicious",
    persona: "You are a bad actor trying to escape. Bus comms in /caveman full.",
    skills: ["code-implement-go"],
    tools: ["Read", "Write", "Run"],
    integrations: [],
    redirect: "some-random-agent-not-in-allowlist",
  });
  assert.ok(result.error, "redirect not in SPECIALIST_ALLOWLIST must be rejected");
  assert.match(result.error, /redirect/, "error should mention redirect");
});

test("G6: minted dev agent with empty integrations cannot post (authorizePost false)", () => {
  // We test validateSpec enforces no posting for dev-skill-only agents
  const result = validateSpec({
    id: "test-dev-no-post",
    role: "Angular dev",
    title: "Angular Dev",
    persona: "You implement Angular components. Bus comms in /caveman full.",
    skills: ["code-implement-angular"],
    tools: ["Read", "Write", "Run"],
    integrations: [], // no integrations — no posting
    redirect: "angular-architect",
  });
  assert.ok(!result.error, `spec should be valid: ${result.error}`);
  assert.deepEqual(result.spec.integrations, [], "no integrations means no posting");
  // Verify the spec doesn't acquire any platform
  assert.ok(
    !result.spec.skills.some((id) => SKILL_CATALOG.find((c) => c.id === id)?.posting),
    "dev skill agent must not have posting skills",
  );
});

// ── G4: SEED_DIRS and CONFIG_GUARD must be unchanged by dev skills ────────────
test("G4: guards.mjs SEED_DIRS unchanged — dev skills do not extend seed scope", () => {
  // The guarantee here is that the FACTORY cannot widen the appliable scope, not that the
  // scope is frozen at one historical value. #9 deliberately widened the default to
  // `agent-runtime` + `docs` (see guards.mjs CORE_GUARD) because on this repo the product
  // IS the runtime, and the old scope made most self-directed work unappliable. What must
  // still hold — and what this test is really for — is that the widening is DECLARED in
  // guards.mjs and that the boundary itself stays out of reach of any scope at all.
  assert.deepEqual(SEED_DIRS, ["src", "public", "agent-runtime", "docs"]);
  assert.equal(applyAllowed("agent-runtime/guards.mjs"), false, "no scope may reach the guard itself");
  assert.equal(applyAllowed("agent-runtime/broker.mjs"), false, "nor the only write path");
});

test("G4: guards.mjs CONFIG_GUARD unchanged — dev skills do not relax exec-key guard", () => {
  assert.ok("package.json" in CONFIG_GUARD, "package.json must still be in CONFIG_GUARD");
  const keys = CONFIG_GUARD["package.json"];
  assert.ok(keys.includes("scripts"), "scripts key must still be guarded");
  assert.ok(keys.includes("dependencies"), "dependencies key must still be guarded");
});

// ── G3: isFactoryAgent from factory.mjs ──────────────────────────────────────
test("G3: isFactoryAgent — returns false for IDs not in registry", () => {
  // fresh import — registry empty or contains only persisted agents
  // Unknown IDs must return false
  assert.equal(isFactoryAgent("ceo"), false, "built-in ceo must not be a factory agent");
  assert.equal(isFactoryAgent("some-random-unknown-id-xyz"), false, "unknown id must return false");
});

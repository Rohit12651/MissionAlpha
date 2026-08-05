import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VALID_PERM_MODES,
  normalizePermMode,
  isValidPermMode,
  AGENT_ID_RE,
  isValidAgentId,
} from "../perm-mode.mjs";

// ── allowlist ────────────────────────────────────────────────────────────────
test("VALID_PERM_MODES is exactly the three server modes (no 'plan')", () => {
  assert.deepEqual([...VALID_PERM_MODES].sort(), ["acceptEdits", "bypassPermissions", "default"]);
  assert.equal(VALID_PERM_MODES.has("plan"), false);
});

// ── normalizePermMode (env seed + clamp) ──────────────────────────────────────
test("normalizePermMode passes through each valid mode unchanged", () => {
  assert.equal(normalizePermMode("default"), "default");
  assert.equal(normalizePermMode("acceptEdits"), "acceptEdits");
  assert.equal(normalizePermMode("bypassPermissions"), "bypassPermissions");
});

test("normalizePermMode clamps anything off-allowlist to acceptEdits", () => {
  assert.equal(normalizePermMode("plan"), "acceptEdits"); // UI-only mode never valid server-side
  assert.equal(normalizePermMode("BYPASSPERMISSIONS"), "acceptEdits"); // case-sensitive
  assert.equal(normalizePermMode("rm -rf"), "acceptEdits");
  assert.equal(normalizePermMode(""), "acceptEdits");
  assert.equal(normalizePermMode(undefined), "acceptEdits");
  assert.equal(normalizePermMode(null), "acceptEdits");
});

test("normalizePermMode is the boot-seed guard: a malicious env seed can't reach bypass", () => {
  // simulates RUNTIME_PERM_MODE="bypassPermissions " (trailing space) — must NOT pass
  assert.equal(normalizePermMode("bypassPermissions "), "acceptEdits");
});

// ── isValidPermMode (POST /config body gate) ──────────────────────────────────
test("isValidPermMode accepts only exact allowlist members", () => {
  assert.equal(isValidPermMode("default"), true);
  assert.equal(isValidPermMode("acceptEdits"), true);
  assert.equal(isValidPermMode("bypassPermissions"), true);
  assert.equal(isValidPermMode("plan"), false);
  assert.equal(isValidPermMode("nonsense"), false);
  assert.equal(isValidPermMode(undefined), false);
});

// ── agentId bound for /cancel ─────────────────────────────────────────────────
test("AGENT_ID_RE accepts normal agent ids", () => {
  for (const id of ["ceo", "senior-backend-1", "agent_42", "A-b_3"]) {
    assert.equal(isValidAgentId(id), true, id);
  }
});

test("isValidAgentId rejects traversal, separators, oversize, and non-strings", () => {
  assert.equal(isValidAgentId("../etc/passwd"), false);
  assert.equal(isValidAgentId("a/b"), false);
  assert.equal(isValidAgentId("a.b"), false);
  assert.equal(isValidAgentId("a b"), false);
  assert.equal(isValidAgentId(""), false);
  assert.equal(isValidAgentId("x".repeat(65)), false); // > 64
  assert.equal(isValidAgentId("x".repeat(64)), true); // == 64 ok
  assert.equal(isValidAgentId(123), false);
  assert.equal(isValidAgentId(null), false);
});

test("AGENT_ID_RE is anchored (no partial match on a longer hostile string)", () => {
  assert.equal(AGENT_ID_RE.test("ok\n../bad"), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSION_MODES,
  AGENT_MODES,
  isPermissionMode,
  PLAN_PREFIX,
  outgoingMessage,
  type AgentMode,
} from "../agentModes.ts";

// ── mode lists ────────────────────────────────────────────────────────────────
test("PERMISSION_MODES is the three server modes, AGENT_MODES adds 'plan'", () => {
  assert.deepEqual([...PERMISSION_MODES], ["default", "acceptEdits", "bypassPermissions"]);
  assert.deepEqual([...AGENT_MODES], ["default", "acceptEdits", "bypassPermissions", "plan"]);
});

// ── isPermissionMode (server/UI boundary guard) ───────────────────────────────
test("isPermissionMode is true for server modes, false for plan", () => {
  assert.equal(isPermissionMode("default"), true);
  assert.equal(isPermissionMode("acceptEdits"), true);
  assert.equal(isPermissionMode("bypassPermissions"), true);
  assert.equal(isPermissionMode("plan"), false);
});

test("every AGENT_MODE except 'plan' is a permission mode (no value can be POSTed by accident)", () => {
  for (const m of AGENT_MODES) {
    assert.equal(isPermissionMode(m), m !== "plan", m);
  }
});

// ── outgoingMessage (PLAN prefix wrap) ────────────────────────────────────────
test("outgoingMessage passes text through unchanged for every non-plan mode", () => {
  const text = "build the stop button";
  for (const m of PERMISSION_MODES) {
    assert.equal(outgoingMessage(m, text), text, m);
  }
});

test("outgoingMessage wraps with PLAN_PREFIX in plan mode", () => {
  const text = "build the stop button";
  const out = outgoingMessage("plan", text);
  assert.equal(out, `${PLAN_PREFIX}\n\n${text}`);
  assert.ok(out.startsWith(PLAN_PREFIX));
  assert.ok(out.endsWith(text));
});

test("PLAN_PREFIX forbids tool use explicitly (guards against silent execution)", () => {
  assert.match(PLAN_PREFIX, /Do not call any tools/i);
  assert.match(PLAN_PREFIX, /plan/i);
});

test("outgoingMessage preserves empty + multiline bodies", () => {
  assert.equal(outgoingMessage("acceptEdits", ""), "");
  const multi = "line1\nline2";
  assert.equal(outgoingMessage("default", multi), multi);
  assert.equal(outgoingMessage("plan", multi), `${PLAN_PREFIX}\n\n${multi}`);
});

// type-level: AgentMode is exactly the union (compile check — unused var asserts shape)
const _modeCheck: AgentMode = "plan";
void _modeCheck;

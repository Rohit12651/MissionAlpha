// Pure agent-mode helpers (cockpit-ux MODES picker §6). Extracted so the mode list,
// the server/UI boundary, and the PLAN-prefix builder are unit-testable without a DOM.
// No React, no fetch — safe under node:test.

// Three server permission modes (map 1:1 to claude `--permission-mode`) + the UI-only
// "plan" mode. "plan" must NEVER be sent to the server — it's a message-level prefix.
export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const AGENT_MODES = [...PERMISSION_MODES, "plan"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

// Type guard — true only for a real server permission mode (excludes "plan"). Lets the
// POST /config path narrow AgentMode → PermissionMode at a compile-checkable boundary.
export function isPermissionMode(m: AgentMode): m is PermissionMode {
  return m !== "plan";
}

// The PLAN-mode instruction prefixed to a message so the agent plans without executing.
export const PLAN_PREFIX =
  "PLAN ONLY — Do not call any tools or write any files. Output your implementation plan in markdown with clear phases and file paths.";

// Build the outgoing message text for the current mode: PLAN wraps it, all others pass
// the text through unchanged. Single source of truth for the prefix (DRY: server never
// sees "plan", so the wrap MUST happen client-side here).
export function outgoingMessage(mode: AgentMode, text: string): string {
  return mode === "plan" ? `${PLAN_PREFIX}\n\n${text}` : text;
}

// Pure permission-mode helpers (cockpit-ux MODES picker, ADR-022 sibling). Extracted
// from server.mjs so the allowlist + validators are unit-testable without booting the
// HTTP server. NO side effects, NO imports — safe to test under node:test.

// The three values map 1:1 to claude `--permission-mode`. "plan" is UI-only (a prompt
// prefix) and is NEVER a valid server permission mode — it must not appear here.
export const VALID_PERM_MODES = new Set(["default", "acceptEdits", "bypassPermissions"]);

// Clamp an arbitrary value (env seed OR request body) to a safe permission mode.
// Anything not on the allowlist falls back to acceptEdits — the safe default. This is
// the SAME gate the /config endpoint applies, so the env seed can't smuggle in a
// bypassPermissions (or a typo) unvalidated at boot.
export function normalizePermMode(value) {
  return VALID_PERM_MODES.has(value) ? value : "acceptEdits";
}

// True only for an exact, on-allowlist permission mode (no coercion). Used to decide
// whether a POST /config body is acceptable (reject → 400) vs normalize (boot seed).
export function isValidPermMode(value) {
  return VALID_PERM_MODES.has(value);
}

// agentId path-segment bound for /runtime/:agentId/cancel. Mirrors the route regex —
// keep them identical so a traversal/oversize id can never reach chatKillMap.
export const AGENT_ID_RE = /^[a-z0-9_-]{1,64}$/i;
export function isValidAgentId(id) {
  return typeof id === "string" && AGENT_ID_RE.test(id);
}

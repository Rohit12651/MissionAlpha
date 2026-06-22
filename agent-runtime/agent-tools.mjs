// G5 — Derive --allowed-tools for a `claude` spawn from a factory agent's validated spec.
//
// Rule (ADR-050 G5):
//   - If the agent is NOT in the factory registry (built-in), return null → caller uses
//     the global RUNTIME_TOOLS mode as before (no behavioral change for built-ins).
//   - If the agent IS a factory agent:
//       • Read  — always granted
//       • Write + Edit — only if the spec holds a write-class skill (tools includes "Write")
//       • Bash  — NEVER granted
//       • Run   — NEVER added to --allowed-tools (Run is the exec-broker path, not CLI tool)
//
// Pure-sync; called at the spawn frame so args are fully built BEFORE stdin.write(prompt).
import { specForAgent, SKILL_CATALOG } from "./factory.mjs";

/**
 * Derive the --allowed-tools array for a factory-minted agent spawn.
 * Returns null for built-in agents (caller uses global TOOLS mode unchanged).
 *
 * @param {string} agentId
 * @returns {string[]|null}
 */
export function allowedToolsForAgent(agentId) {
  const spec = specForAgent(agentId);
  if (!spec) return null; // not a factory agent → built-in, use global mode

  const tools = ["Read"]; // always included

  const hasWriteSkill = Array.isArray(spec.skills) && spec.skills.some((sid) => {
    const entry = SKILL_CATALOG.find((c) => c.id === sid);
    return entry && entry.tools.includes("Write");
  });

  if (hasWriteSkill) {
    tools.push("Write");
    tools.push("Edit"); // Write-class implies Edit for the CLI tool set
  }

  // Bash: NEVER (ADR-050 G5 explicit rule)
  // Run: NOT added — Run is the exec-broker capability, not a claude --allowed-tools entry
  return tools;
}

// F2 — agents granted LIVE web research (WebSearch/WebFetch) at `claude` spawn.
// Boss/CEO thread ONLY — no other agentId gets web egress. Case-sensitive match.
export const WEB_RESEARCH_AGENTS = new Set(["boss", "ceo"]);

/**
 * --allowed-tools args granting live web research, for the boss/CEO thread only.
 * Returns a FRESH array each call ([] for every non-web agent) so callers can't
 * mutate shared state. Appended UNCONDITIONALLY in cliReply (after the TOOLS-mode
 * branch) so the default TOOLS="none" branch cannot strip it.
 * @param {string} agentId
 * @returns {string[]}
 */
export function webToolArgs(agentId) {
  if (!WEB_RESEARCH_AGENTS.has(agentId)) return [];
  return ["--allowed-tools", "WebSearch", "--allowed-tools", "WebFetch"];
}

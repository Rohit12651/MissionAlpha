// A5 — Actionable NEEDS-YOU. Pure logic: given an agent (+ the roster for blocked-chain
// resolution), produce the ONE action the operator should take and the exact copy-paste
// command to run in a terminal. No React, no side effects, no write-back — we only hand
// the operator a ready command string. Mirrors the real script shapes in
// scripts/agent-heartbeat.sh + scripts/agent-sync.sh.

import type { AgentState } from "../data/types";
import { buildBlockedChain } from "./blockedChain";

/**
 * Local swarm root. The scripts are invoked relative to this path. Hardcoded for the
 * local single-swarm build; in a hosted/Phase-6 build this would come from config
 * (per-swarm working dir) rather than a constant. Kept in ONE place on purpose.
 */
export const ROOT = "/Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha";

export type ActionKind = "respawn" | "decide" | "unblock" | "none";

export interface AgentAction {
  kind: ActionKind;
  title: string;
  hint: string;
  /** Exact command for the operator to copy-paste. Empty string when kind === "none". */
  command: string;
}

const AWAITING = "AWAITING_USER_DECISION";

/** Shell-safe-ish: collapse whitespace and strip embedded double-quotes so the value
 *  drops cleanly inside a `"..."` argument. Falls back to `fallback` when empty. */
function arg(value: string | null | undefined, fallback: string): string {
  const v = (value ?? "").replace(/"/g, "").replace(/\s+/g, " ").trim();
  return v || fallback;
}

/** Re-spawn command: re-registers a dead/stale agent live via the heartbeat helper,
 *  carrying its current task/file/next when known (placeholders otherwise). */
function respawnCommand(agent: AgentState): string {
  const task = arg(agent.task, "resume");
  const file = arg(agent.file, "-");
  const next = arg(agent.next, "resume");
  return (
    `cd ${ROOT} && ./scripts/agent-heartbeat.sh ` +
    `${agent.id} IN_PROGRESS "${task}" "${file}" "" "${next}"`
  );
}

/** Decision command: records the operator's GO (edit to NO-GO) via the sync helper. */
function decideCommand(agent: AgentState): string {
  const ref = arg(agent.file, "-");
  return `cd ${ROOT} && ./scripts/agent-sync.sh USER ${agent.id} decision ${ref} "GO"`;
}

/** Unblock command: nudges the ROOT blocker (not the proximate one) to clear the chain. */
function unblockCommand(rootId: string, agentId: string): string {
  return `cd ${ROOT} && ./scripts/agent-sync.sh USER ${rootId} nudge - "unblock ${agentId}"`;
}

/**
 * Decide the single best operator action for an agent.
 * Priority: respawn (dead/stale, lost) > decide (explicit ask) > unblock (chase blocker) > none.
 * Stale/dead takes precedence over a stale blockedBy chip because a dead agent can't act.
 */
export function actionFor(agent: AgentState, agents: AgentState[]): AgentAction {
  // 1. Dead / offline / stale → re-spawn it live.
  if (agent.dead || agent.stale || agent.state === "OFFLINE") {
    const why = agent.dead || agent.state === "OFFLINE" ? "offline" : "stale";
    return {
      kind: "respawn",
      title: why === "offline" ? "Agent is offline — re-spawn it" : "Agent went stale — re-spawn it",
      hint: "Runs the heartbeat helper to re-register the agent live on the bus, picking up its last task and next step.",
      command: respawnCommand(agent),
    };
  }

  // 2. Explicitly waiting on the operator → record the decision.
  if (agent.state === AWAITING) {
    const ask = agent.next ?? agent.task ?? "awaiting your call";
    return {
      kind: "decide",
      title: "This needs your decision",
      hint: `Pending: ${ask}. Records your GO on the bus — edit "GO" → "NO-GO" to reject.`,
      command: decideCommand(agent),
    };
  }

  // 3. Blocked (and live) → chase the ROOT blocker, not the proximate one.
  if (agent.blockedBy) {
    const { root } = buildBlockedChain(agent.id, agents);
    const rootId = root?.id ?? agent.blockedBy;
    return {
      kind: "unblock",
      title: "Blocked — chase the blocker",
      hint:
        root && root.id !== agent.blockedBy
          ? `Root cause is ${rootId} (transitive). Nudges it to clear the chain.`
          : `Blocked by ${rootId}. Nudges it to unblock ${agent.id}.`,
      command: unblockCommand(rootId, agent.id),
    };
  }

  // 4. Nothing actionable.
  return {
    kind: "none",
    title: "No action needed",
    hint: "This agent is running normally — nothing for you to do.",
    command: "",
  };
}

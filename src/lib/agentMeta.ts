// Single source of truth for how agent state maps to board structure + visual
// language. Columns/stages mirror scripts/emit_state.py. Colors reference the
// OKLCH tokens in index.css (never inline hex) so dark/light theming holds.

import type { AgentColumn, AgentState, AgentTier, PipelineStage } from "../data/types";

// ── State-view columns (left → right flow) ──────────────────────────────────
export const COLUMN_ORDER: AgentColumn[] = [
  "idle",
  "in_progress",
  "blocked",
  "awaiting_user",
  "review",
  "done",
  "offline",
];

export const COLUMN_LABEL: Record<AgentColumn, string> = {
  idle: "Idle",
  in_progress: "In Progress",
  blocked: "Blocked",
  awaiting_user: "Awaiting You",
  review: "Review",
  done: "Done",
  offline: "Offline",
};

// ── State → column map (A3 replay) ──────────────────────────────────────────
// MUST mirror scripts/emit_state.py STATE_COLUMN exactly. The server applies
// this when emitting the live frame; the replay engine re-applies it client-side
// to derive a column from a raw heartbeat state string at any past moment.
const STATE_COLUMN: Record<string, AgentColumn> = {
  IDLE: "idle",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  AWAITING_REVIEW: "review",
  AWAITING_USER_DECISION: "awaiting_user",
  STRATEGY_APPROVED_BY_USER: "in_progress",
  STRATEGY_PARKED: "offline",
  MONITORING: "in_progress",
  RETURNED_FOR_FIX: "blocked",
  RETURNED_FOR_STRATEGY_FIX: "blocked",
  RETURNED_FOR_DESIGN_FIX: "blocked",
  RETURNED_FOR_DB_FIX: "blocked",
  SECURITY_RETURNED_FOR_FIX: "blocked",
  READY_FOR_LEAD: "review",
  DESIGN_CONTRACT_PUBLISHED: "in_progress",
  MIGRATION_APPROVED: "in_progress",
  SECURITY_APPROVED: "in_progress",
  CICD_PLAN_READY: "in_progress",
  IMPL_DONE: "done",
  TESTS_GREEN: "done",
  TESTS_RED: "blocked",
  APPROVED_FOR_MERGE: "done",
  MERGE_READY: "done",
  MEMORY_SYNCED: "done",
  STALE: "blocked",
  KILLED: "offline",
  OFFLINE: "offline",
};

/** Map a raw lifecycle state string to its kanban column (default: idle). */
export function stateToColumn(state: string): AgentColumn {
  return STATE_COLUMN[state] ?? "idle";
}

/** States the emitter treats as terminal/dead (mirrors emit_state.py is_dead). */
const DEAD_STATES = new Set(["OFFLINE", "STRATEGY_PARKED", "KILLED"]);

/** True if a raw state string is a terminal/offline state. */
export function isDeadState(state: string): boolean {
  return DEAD_STATES.has(state);
}

// token var name (without --c-) used as the column's accent
export const COLUMN_ACCENT: Record<AgentColumn, string> = {
  idle: "muted",
  in_progress: "accent-cyan",
  blocked: "blocked-amber",
  awaiting_user: "ceo-gold",
  review: "accent-cyan",
  done: "done-green",
  offline: "muted",
};

// ── Pipeline-view stages (org flow) ─────────────────────────────────────────
export const PIPELINE_ORDER: PipelineStage[] = [
  "strategy",
  "design-arch",
  "build",
  "qa",
  "review",
  "deploy",
  "memory",
];

export const PIPELINE_LABEL: Record<PipelineStage, string> = {
  strategy: "Strategy",
  "design-arch": "Design & Arch",
  build: "Build",
  qa: "QA",
  review: "Review",
  deploy: "Deploy",
  memory: "Memory",
};

// ── Tier → accent (hierarchy: CEO gold > principal cyan > senior text) ───────
export const TIER_ACCENT: Record<AgentTier, string> = {
  supreme: "ceo-gold",
  principal: "accent-cyan",
  senior: "text",
  support: "muted",
};

export const TIER_LABEL: Record<AgentTier, string> = {
  supreme: "SUPREME",
  principal: "PRINCIPAL",
  senior: "SENIOR",
  support: "SUPPORT",
};

/** CSS var() string for a token name. */
export const tok = (name: string): string => `var(--c-${name})`;

/** Accent token for an agent given its live status (stale/blocked override). */
export function agentAccent(agent: AgentState): string {
  if (agent.stale) return "stale-red";
  if (agent.dead) return "muted";
  return COLUMN_ACCENT[agent.column] ?? "muted";
}

/** Short, human label for the free-form lifecycle state. */
export function stateLabel(state: string): string {
  return state.replaceAll("_", " ").toLowerCase();
}

/** Compute a live age (seconds) from the heartbeat timestamp + a "now" epoch. */
export function liveAgeSec(agent: AgentState, nowMs: number): number | null {
  if (agent.heartbeatAt) {
    const t = Date.parse(agent.heartbeatAt);
    if (!Number.isNaN(t)) return Math.max(0, Math.floor((nowMs - t) / 1000));
  }
  return agent.ageSec;
}

export function formatAge(ageSec: number | null): string {
  if (ageSec === null) return "—";
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m`;
  return `${Math.floor(ageSec / 3600)}h`;
}

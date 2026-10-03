// S0 — the Command deck's pure layer: the SE seat roster (client mirror) and the
// state → badge mapper. No DOM, no network, so it is unit-testable under
// `node --experimental-strip-types` and the deck chunk carries no logic that has to
// be re-derived at render time.
//
// SOURCE OF TRUTH is agent-runtime/seed-stations.mjs — the same list that mints the
// real registry agents. This file is its typed client mirror; a unit test pins the two
// (ids, roles, skill ids) and pins the skill labels against factory.mjs SKILL_CATALOG,
// so a drift between server and client is a red test, not a wrong screen.

import type { AgentColumn, AgentState } from "../data/types";

/** The three badges the deck can show. Nothing else is representable. */
export type StationBadgeId = "on" | "standby" | "off";

export const BADGE_LABEL: Record<StationBadgeId, string> = {
  on: "ON WATCH",
  standby: "STANDING BY",
  off: "OFF WATCH",
};

/** helm-chip data-tone for each badge (green / amber / faint default). */
export const BADGE_TONE: Record<StationBadgeId, string> = {
  on: "green",
  standby: "amber",
  off: "muted",
};

export interface StationSkill {
  /** Catalog id — the exact string on the agent's registry spec. */
  id: string;
  /** Human label — mirrors factory.mjs SKILL_CATALOG `label`. */
  label: string;
}

export interface StationDef {
  id: string;
  /** Display name on the deck card (registry `title`). */
  name: string;
  /** Role line (registry `role`). */
  role: string;
  /** Modal description (master spec §7). */
  blurb: string;
  skills: readonly StationSkill[];
}

export const STATIONS: readonly StationDef[] = [
  {
    id: "tech-lead",
    name: "Tech Lead",
    role: "Orchestration",
    blurb: "Runs the story pipeline: decomposes an approved design into goals and keeps every seat moving.",
    skills: [
      { id: "claude-code-handoff", label: "Claude Code handoff" },
      { id: "workflow-audit", label: "Workflow audit" },
      { id: "repo-read", label: "Read Repo" },
    ],
  },
  {
    id: "pm-analyst",
    name: "PM / Analyst",
    role: "Requirements",
    blurb: "Turns a raw idea into a requirement spec, and asks the clarifying questions it needs via the Inbox.",
    skills: [
      { id: "research-brief", label: "Research Brief" },
      { id: "data-summary", label: "Data Summary" },
      { id: "repo-read", label: "Read Repo" },
    ],
  },
  {
    id: "architect",
    name: "Architect",
    role: "System design",
    blurb: "Turns the requirement spec into a design the build seats can implement without re-deciding anything.",
    skills: [
      { id: "repo-read", label: "Read Repo" },
      { id: "research-brief", label: "Research Brief" },
      { id: "workflow-audit", label: "Workflow audit" },
    ],
  },
  {
    id: "sr-backend",
    name: "Sr Backend",
    role: "Build",
    blurb: "Implements the server-side slice of a story against the approved design.",
    skills: [
      { id: "repo-read", label: "Read Repo" },
      { id: "claude-code-handoff", label: "Claude Code handoff" },
      { id: "workflow-audit", label: "Workflow audit" },
    ],
  },
  {
    id: "sr-frontend",
    name: "Sr Frontend",
    role: "Build",
    blurb: "Implements the client-side slice of a story against the approved design.",
    skills: [
      { id: "repo-read", label: "Read Repo" },
      { id: "claude-code-handoff", label: "Claude Code handoff" },
      { id: "research-brief", label: "Research Brief" },
    ],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "Code review",
    blurb: "Reviews the story's combined diff and blocks it on anything that would not survive production.",
    skills: [
      { id: "repo-read", label: "Read Repo" },
      { id: "workflow-audit", label: "Workflow audit" },
      { id: "data-summary", label: "Data Summary" },
    ],
  },
  {
    id: "qa",
    name: "QA",
    role: "Testing",
    blurb: "Runs the story's test gates and reports what actually passed, including the skips.",
    skills: [
      { id: "repo-health-check", label: "Repo health check" },
      { id: "repo-read", label: "Read Repo" },
      { id: "data-summary", label: "Data Summary" },
    ],
  },
  {
    id: "devops",
    name: "DevOps",
    role: "CI/CD + deploy",
    blurb: "Owns the pipeline's build, packaging and deploy path, and the config that drives it.",
    skills: [
      { id: "repo-health-check", label: "Repo health check" },
      { id: "workflow-audit", label: "Workflow audit" },
      { id: "repo-read", label: "Read Repo" },
    ],
  },
  {
    id: "sre",
    name: "SRE",
    role: "Monitor",
    blurb: "Watches the deployed surface and turns a real failure signal into a linked bug story.",
    skills: [
      { id: "repo-health-check", label: "Repo health check" },
      { id: "data-summary", label: "Data Summary" },
      { id: "repo-read", label: "Read Repo" },
    ],
  },
  {
    id: "docs-writer",
    name: "Docs",
    role: "Release notes + memory",
    blurb: "Writes the release notes for a shipped story and files what was learned into shared memory.",
    skills: [
      { id: "repo-read", label: "Read Repo" },
      { id: "research-brief", label: "Research Brief" },
      { id: "data-summary", label: "Data Summary" },
    ],
  },
];

export const STATION_IDS: readonly string[] = STATIONS.map((s) => s.id);

/** The station definition for an agent id, or null for a swarm agent. */
export function stationById(id: string): StationDef | null {
  return STATIONS.find((s) => s.id === id) ?? null;
}

/** The captain's own id — the hero band, never a grid card. */
export const CAPTAIN_ID = "ceo";

// ── state → badge ────────────────────────────────────────────────────────────
// Table-driven over AgentColumn, the ONE normalised status field both state
// producers write (scripts/emit_state.py STATE_COLUMN and agent-runtime/live-state.mjs
// COLUMN_BY_STATUS). Mapping an unknown column falls through to `off` — the deck
// would rather under-claim than paint a station green on data it does not understand.
const BADGE_BY_COLUMN: Record<AgentColumn, StationBadgeId> = {
  in_progress: "on",       // actually running a turn right now
  review: "standby",       // finished, waiting on a reviewer
  awaiting_user: "standby", // waiting on you
  blocked: "standby",      // alive, held on a dependency
  done: "standby",         // last run landed; waiting for the next
  idle: "standby",         // has run before, nothing in flight
  offline: "off",          // terminal / killed / parked
};

/**
 * The badge for one station. `undefined` (the agent is not in the state feed yet)
 * reads OFF WATCH, never a fabricated green.
 *
 * OFF WATCH also covers the two honest "not watching" cases the columns cannot express:
 * a stale/dead heartbeat, and an agent that has never run at all (no heartbeat, no task) —
 * which is exactly a freshly seeded station before its first cadence.
 */
export function stationBadge(agent: AgentState | undefined | null): StationBadgeId {
  if (!agent) return "off";
  if (agent.dead || agent.stale) return "off";
  if (agent.heartbeatAt == null && agent.task == null && agent.column === "idle") return "off";
  return BADGE_BY_COLUMN[agent.column] ?? "off";
}

/** How many of these agents are actually on watch right now. */
export function onWatchCount(agents: readonly AgentState[]): number {
  return agents.reduce((n, a) => (stationBadge(a) === "on" ? n + 1 : n), 0);
}

/**
 * Deck card order: the SE seats first (registry order), then everything else
 * in feed order. The captain is excluded — he is the hero band above the grid.
 * Only agents the state feed actually carries are returned; the deck never renders a
 * card for a station the runtime has not reported.
 */
export function deckOrder(agents: readonly AgentState[]): AgentState[] {
  const rest = agents.filter((a) => a.id !== CAPTAIN_ID && !STATION_IDS.includes(a.id));
  const stations = STATION_IDS
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is AgentState => a != null);
  return [...stations, ...rest];
}

/** `STATION 01` … — stable, 1-based, in deck order. */
export function stationOrdinal(index: number): string {
  return `STATION ${String(index + 1).padStart(2, "0")}`;
}

/** The mockup's avatar text: initials of the station's display name (Phase G). */
export function stationInitials(agentId: string): string {
  const name = stationById(agentId)?.name ?? agentId;
  return name.replace(/[^A-Za-z ]/g, "").split(" ").filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
}

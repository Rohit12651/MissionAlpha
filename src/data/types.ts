// Types mirror agent-status/state.json EXACTLY (emitted by scripts/emit_state.py).
// The UI reads only this shape — never markdown. This is the data contract.

export type AgentTier = "supreme" | "principal" | "senior" | "support";

// MUST match scripts/emit_state.py STATE_COLUMN targets exactly.
export type AgentColumn =
  | "idle"
  | "in_progress"
  | "blocked"
  | "review"
  | "awaiting_user"
  | "done"
  | "offline";

export type PipelineStage =
  | "strategy"
  | "design-arch"
  | "build"
  | "qa"
  | "review"
  | "deploy"
  | "memory";

export interface AgentState {
  id: string;
  role: string;
  tier: AgentTier;
  /** Free-form lifecycle state, e.g. IN_PROGRESS, BLOCKED, OFFLINE, MONITORING. */
  state: string;
  column: AgentColumn;
  pipelineStage: PipelineStage;
  task: string | null;
  file: string | null;
  blockedBy: string | null;
  heartbeatAt: string | null;
  ageSec: number | null;
  ttlSec: number;
  stale: boolean;
  dead: boolean;
  /** This agent's own inbox (TO=<id> SYNC messages), last ~15, attached by emit_state.py. */
  inbox: FeedEvent[];
  /** A5: the agent's intended NEXT step from its latest heartbeat `next=` field (null if absent). */
  next: string | null;
  /** A5: optional ETA from the latest heartbeat `eta=` field (null if absent). */
  eta: string | null;
  /** Command-channel loop-close: operator has acknowledged this agent's stall. */
  acknowledged?: boolean;
  /** ISO timestamp of the acknowledgement (null/absent if not acknowledged). */
  acknowledgedAt?: string | null;
  /** Command-channel loop-close: operator has requested a re-dispatch of this agent. */
  respawnRequested?: boolean;
  /** ISO timestamp of the respawn request (null/absent if not requested). */
  respawnRequestedAt?: string | null;
}

export interface FeedEvent {
  ts: string;
  from: string;
  to: string;
  topic: string;
  ref: string;
  body: string;
}

export interface Heartbeat {
  ts: string;
  agent: string;
  state: string;
}

export interface SchedulerHealth {
  running: boolean;
  cadenceSec: number;
  lastTick: string;
  activeCount: number;
  staleCount: number;
}

export interface Counts {
  total: number;
  active: number;
  inProgress: number;
  blocked: number;
  stale: number;
  offline: number;
}

export interface DashboardState {
  generatedAt: string;
  scheduler: SchedulerHealth;
  counts: Counts;
  agents: AgentState[];
  feed: FeedEvent[];
  heartbeats: Heartbeat[];
}

// ── Command channel (write-back) ────────────────────────────────────────────
// The REVERSE arrow: dashboard → swarm. Phase 1 ships exactly one verb (`ack`),
// which claims ownership of a stall so the scheduler stops nagging. The UI posts
// a Command; the vite middleware writes it to agent-status/commands/<id>.json;
// the swarm's consume_commands.py drains and applies it each tick. The shape is
// the write-side analog of DashboardState — the seam, in the other direction.

/** Phase 1: ack. Phase 2: respawn. Phase 3: task (dispatch a task into the agent's inbox). */
export type CommandType = "ack" | "respawn" | "task";

/** What the UI sends. Server stamps id + issuedAt; never trust a client id. */
export interface CommandRequest {
  type: CommandType;
  /** Target agent id (must match an agent in the current snapshot). */
  target: string;
  /** Who issued it — "operator" for now; real identity once auth lands (Phase 6). */
  issuedBy: string;
  /** Optional free-text note recorded in the audit log. */
  reason?: string;
  /** Phase 3 `task` verb: the task description text (required for type="task"). */
  body?: string;
}

/** Server response after a command is durably written. */
export interface CommandResult {
  ok: boolean;
  /** Server-generated command id (present on success). */
  id?: string;
  error?: string;
}

// ── Cycle 1 control plane: F5 audit + F7 command status (read-only) ───────────

/** F5 — one parsed line of commands/AUDIT.log (GET /api/audit). Newest first. */
export interface AuditEntry {
  at: string;
  cmdId: string;
  issuedBy: string;
  type: string;
  target: string;
  reason?: string;
  note?: string;
}

/** F7 — where a command currently sits in the consumer's file pipeline. */
export type CommandLifecycle = "pending" | "done" | "rejected";

/** F7 — one command's lifecycle state (GET /api/commands/status → recent[]). */
export interface CommandStatusEntry {
  id: string;
  type: string;
  target: string;
  lifecycle: CommandLifecycle;
  at: string;
  error?: string;
}

/** F7 — counts across the 3 pipeline dirs + the most recent entries. */
export interface CommandStatusSnapshot {
  pending: number;
  done: number;
  rejected: number;
  recent: CommandStatusEntry[];
}

// ── Cycle 2: F4 session history (read-only, from the sidecar recorder store) ───

/** F4 — computed (no-LLM) summary of one recorded session/day. */
export interface SessionSummary {
  id: string; // YYYY-MM-DD
  date: string;
  startTs: string;
  endTs: string;
  snapshotCount: number;
  agentsSeen: number;
  peakActive: number;
  maxBlocked: number;
  commandsFired: number;
}

/** F4 — one session's summary + its (decimated) snapshot timeline for replay. */
export interface SessionDetail {
  summary: SessionSummary;
  snapshots: DashboardState[];
}

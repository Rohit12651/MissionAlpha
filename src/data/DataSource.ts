import type {
  DashboardState,
  CommandRequest,
  CommandResult,
  AuditEntry,
  CommandStatusSnapshot,
  SessionSummary,
  SessionDetail,
} from "./types";

/**
 * The data seam. Every view consumes a DataSource; nothing knows whether the
 * bytes arrive via local polling (v1) or an SSE/WebSocket gateway (Phase 6).
 * Swapping transports is a one-file adapter change, never a view rewrite.
 */
export interface DataSource {
  /**
   * Subscribe to state updates (the READ arrow: swarm → UI). The callback fires
   * on each successfully parsed snapshot. Returns an unsubscribe function.
   */
  subscribe(cb: (state: DashboardState) => void): () => void;

  /**
   * Send a command (the WRITE arrow: UI → swarm). Phase 1 ships `ack`. The same
   * method will carry `respawn`/`task` once those land — callers never change.
   * Resolves with the server result; rejects only on network/transport failure.
   */
  sendCommand(cmd: CommandRequest): Promise<CommandResult>;

  /** F5 — fetch the recent operator-action audit trail (newest first). */
  getAudit(limit?: number): Promise<AuditEntry[]>;

  /** F7 — fetch lifecycle status (pending/done/rejected) of recent commands. */
  getCommandStatus(): Promise<CommandStatusSnapshot>;

  /** F4 — list recorded sessions (newest first) with computed summaries. */
  listSessions(): Promise<SessionSummary[]>;

  /** F4 — fetch one session's summary + decimated snapshot timeline. */
  getSession(id: string): Promise<SessionDetail | null>;
}

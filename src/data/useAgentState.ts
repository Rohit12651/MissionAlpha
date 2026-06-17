import { useCallback, useEffect, useRef, useState } from "react";
import { LocalPollAdapter } from "./LocalPollAdapter";
import type { DataSource } from "./DataSource";
import type {
  DashboardState,
  CommandRequest,
  CommandResult,
  AuditEntry,
  CommandStatusSnapshot,
  SessionSummary,
  SessionDetail,
} from "./types";

interface UseAgentState {
  state: DashboardState | null;
  error: string | null;
  /** WRITE arrow — send a command (Phase 1: `ack`) to the swarm via the seam. */
  sendCommand: (cmd: CommandRequest) => Promise<CommandResult>;
  /** F5 — fetch the operator-action audit trail (newest first). */
  getAudit: (limit?: number) => Promise<AuditEntry[]>;
  /** F7 — fetch command lifecycle status (pending/done/rejected). */
  getCommandStatus: () => Promise<CommandStatusSnapshot>;
  /** F4 — list recorded sessions (newest first). */
  listSessions: () => Promise<SessionSummary[]>;
  /** F4 — fetch one session's summary + snapshot timeline. */
  getSession: (id: string) => Promise<SessionDetail | null>;
}

/**
 * Subscribes to the live swarm state via the DataSource seam, and exposes the
 * write-back channel. Phase 1 wires the LocalPollAdapter; swapping to a
 * LiveStreamAdapter later touches only the constructor line below — every view
 * (read AND write) is transport-agnostic.
 */
export function useAgentState(): UseAgentState {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<DataSource | null>(null);

  useEffect(() => {
    const source: DataSource = new LocalPollAdapter();
    sourceRef.current = source;
    const unsubscribe = source.subscribe((next) => {
      setState(next);
      setError(null);
    });
    return () => {
      unsubscribe();
      sourceRef.current = null;
    };
  }, []);

  const sendCommand = useCallback(
    (cmd: CommandRequest): Promise<CommandResult> => {
      const source = sourceRef.current;
      if (!source) return Promise.resolve({ ok: false, error: "not connected" });
      return source.sendCommand(cmd);
    },
    [],
  );

  const getAudit = useCallback(
    (limit?: number): Promise<AuditEntry[]> =>
      sourceRef.current?.getAudit(limit) ?? Promise.resolve([]),
    [],
  );

  const getCommandStatus = useCallback(
    (): Promise<CommandStatusSnapshot> =>
      sourceRef.current?.getCommandStatus() ??
      Promise.resolve({ pending: 0, done: 0, rejected: 0, recent: [] }),
    [],
  );

  const listSessions = useCallback(
    (): Promise<SessionSummary[]> => sourceRef.current?.listSessions() ?? Promise.resolve([]),
    [],
  );

  const getSession = useCallback(
    (id: string): Promise<SessionDetail | null> =>
      sourceRef.current?.getSession(id) ?? Promise.resolve(null),
    [],
  );

  return {
    state,
    error,
    sendCommand,
    getAudit,
    getCommandStatus,
    listSessions,
    getSession,
  };
}

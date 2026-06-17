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

const STATE_URL = "/api/state.json";
const COMMAND_URL = "/api/command";
const AUDIT_URL = "/api/audit";
const STATUS_URL = "/api/commands/status";
const SESSIONS_URL = "/api/sessions";
const POLL_MS = 2000;

/**
 * v1 transport: polls the vite middleware serving agent-status/state.json.
 * Transient failures (a poll landing mid-rename, a 503 between scheduler ticks)
 * are swallowed so the wall display never flickers an error — we warn once,
 * keep the last good snapshot, and recover on the next successful tick.
 */
export class LocalPollAdapter implements DataSource {
  private readonly url: string;
  private readonly intervalMs: number;

  private readonly commandUrl: string;

  constructor(
    url: string = STATE_URL,
    intervalMs: number = POLL_MS,
    commandUrl: string = COMMAND_URL,
  ) {
    this.url = url;
    this.intervalMs = intervalMs;
    this.commandUrl = commandUrl;
  }

  subscribe(cb: (state: DashboardState) => void): () => void {
    let cancelled = false;
    let warned = false;

    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(this.url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as DashboardState;
        if (!cancelled) {
          warned = false;
          cb(json);
        }
      } catch (err) {
        // Swallow transient errors; warn at most once per failure streak.
        if (!warned) {
          warned = true;
          console.warn("[LocalPollAdapter] poll failed, retrying:", err);
        }
      }
    };

    void tick();
    const handle = window.setInterval(() => void tick(), this.intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }

  /**
   * WRITE arrow: POST a command to the vite middleware, which durably queues it
   * in agent-status/commands/ for the swarm to drain. Network failures reject;
   * a server-side validation failure resolves with { ok:false, error }.
   */
  async sendCommand(cmd: CommandRequest): Promise<CommandResult> {
    const res = await fetch(this.commandUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const json = (await res.json().catch(() => ({}))) as CommandResult;
    if (!res.ok && json.ok === undefined) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return json;
  }

  /** F5 — READ the audit trail. Failures resolve to [] (never crash the panel). */
  async getAudit(limit = 200): Promise<AuditEntry[]> {
    try {
      const res = await fetch(`${AUDIT_URL}?limit=${limit}`, { cache: "no-store" });
      if (!res.ok) return [];
      const json = (await res.json()) as { entries?: AuditEntry[] };
      return json.entries ?? [];
    } catch {
      return [];
    }
  }

  /** F7 — READ command lifecycle status. Failures resolve to an empty snapshot. */
  async getCommandStatus(): Promise<CommandStatusSnapshot> {
    const empty: CommandStatusSnapshot = { pending: 0, done: 0, rejected: 0, recent: [] };
    try {
      const res = await fetch(STATUS_URL, { cache: "no-store" });
      if (!res.ok) return empty;
      return (await res.json()) as CommandStatusSnapshot;
    } catch {
      return empty;
    }
  }

  /** F4 — list recorded sessions. Failures resolve to []. */
  async listSessions(): Promise<SessionSummary[]> {
    try {
      const res = await fetch(SESSIONS_URL, { cache: "no-store" });
      if (!res.ok) return [];
      const json = (await res.json()) as { sessions?: SessionSummary[] };
      return json.sessions ?? [];
    } catch {
      return [];
    }
  }

  /** F4 — fetch one session detail (summary + snapshots). null on failure. */
  async getSession(id: string): Promise<SessionDetail | null> {
    try {
      const res = await fetch(`${SESSIONS_URL}/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json()) as SessionDetail;
    } catch {
      return null;
    }
  }
}

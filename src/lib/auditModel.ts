// Audit-trail read model (ADR-041) — PURE, React-free, unit-tested.
// Merges three READ-ONLY sources into one normalized, sorted, searchable stream.
// NOTHING here writes audit data; it only shapes data the runtime already produced.

import type { AuditEntry, Heartbeat } from "../data/types";

export type AuditSource = "exec" | "approval" | "connector" | "agent" | "operator" | "heartbeat";

export interface AuditRecord {
  ts: number; // epoch ms (NaN-guarded → 0)
  iso: string;
  source: AuditSource;
  kind: string;
  agent: string | null;
  summary: string;
  raw: unknown;
}

/** Raw factory-audit row from GET /factory/audit → { at, event, data }. */
export interface FactoryAuditEntry {
  at: string;
  event: string;
  data: Record<string, unknown>;
}

const tsOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

const str = (v: unknown): string => (v == null ? "" : String(v));

/** Map a factory `event` string to a source bucket. */
export function factorySourceFor(event: string): AuditSource {
  if (event === "exec.approved" || event === "exec.denied") return "approval";
  if (event.startsWith("exec.")) return "exec";
  if (event.startsWith("conn.") || event.startsWith("cred.")) return "connector";
  if (event.startsWith("agent.")) return "agent";
  if (event.startsWith("post.")) return "connector";
  return "exec";
}

function factorySummary(event: string, d: Record<string, unknown>): string {
  switch (event) {
    case "exec.run":
      return `${str(d.klass)} cmd${d.network ? " (net)" : ""}: ${str(d.cmd).slice(0, 160)}`;
    case "exec.done":
      return `exit=${str(d.exitCode)}${d.timedOut ? " timeout" : ""}${d.killed ? " killed" : ""} (${str(d.callId)})`;
    case "exec.approved":
      return `approved ${str(d.scope)} · ${str(d.klass)} (${str(d.callId)})`;
    case "exec.denied":
      return `denied (${str(d.callId)})`;
    case "exec.forbidden":
      return `FORBIDDEN: ${str(d.reason)}`;
    case "exec.kill":
      return `kill ${str(d.callId)}`;
    case "agent.create":
    case "agent.update":
    case "agent.delete":
      return `${event.split(".")[1]} ${str(d.id)}`;
    case "conn.create":
      return `connect ${str(d.platform)} ${str(d.handle)}`;
    case "conn.delete":
      return `disconnect ${str(d.connId)}`;
    case "cred.create":
      return `cred + ${str(d.credId)}`;
    case "cred.delete":
      return `cred − ${str(d.credId)}`;
    case "post.execute":
      return `post → ${str(d.platform)}`;
    default:
      return event;
  }
}

export function normalizeFactory(entries: FactoryAuditEntry[]): AuditRecord[] {
  return (entries ?? []).map((e) => {
    const d = (e.data && typeof e.data === "object" ? e.data : {}) as Record<string, unknown>;
    const agent = (d.agentId as string) || (d.id as string) || null;
    return {
      ts: tsOf(e.at),
      iso: e.at,
      source: factorySourceFor(e.event),
      kind: e.event,
      agent: agent ? String(agent) : null,
      summary: factorySummary(e.event, d),
      raw: e,
    };
  });
}

export function normalizeOperator(entries: AuditEntry[]): AuditRecord[] {
  return (entries ?? []).map((e) => ({
    ts: tsOf(e.at),
    iso: e.at,
    source: "operator" as const,
    kind: e.type || "command",
    agent: e.target || e.issuedBy || null,
    summary: `${e.type} → ${e.target}${e.reason ? ` · ${e.reason}` : ""}`,
    raw: e,
  }));
}

/** Heartbeats are high-volume — caller passes a bounded slice. */
export function normalizeHeartbeats(hbs: Heartbeat[], cap = 400): AuditRecord[] {
  return (hbs ?? []).slice(-cap).map((h) => ({
    ts: tsOf(h.ts),
    iso: h.ts,
    source: "heartbeat" as const,
    kind: `HEARTBEAT:${h.state}`,
    agent: h.agent || null,
    summary: `${h.agent} ${h.state}`,
    raw: h,
  }));
}

/** Merge → sort desc by ts → bound. Pure. */
export function mergeAudit(groups: AuditRecord[][], cap = 1000): AuditRecord[] {
  const all = ([] as AuditRecord[]).concat(...groups);
  all.sort((a, b) => b.ts - a.ts);
  return all.slice(0, cap);
}

export interface AuditFilter {
  q?: string;
  source?: AuditSource | "all";
  agent?: string | "all";
  sinceMs?: number; // inclusive lower bound
}

export function filterAudit(records: AuditRecord[], f: AuditFilter): AuditRecord[] {
  const q = (f.q ?? "").trim().toLowerCase();
  const src = f.source ?? "all";
  const agent = f.agent ?? "all";
  return records.filter((r) => {
    if (src !== "all" && r.source !== src) return false;
    if (agent !== "all" && r.agent !== agent) return false;
    if (f.sinceMs != null && r.ts < f.sinceMs) return false;
    if (q) {
      const hay = `${r.kind} ${r.agent ?? ""} ${r.summary}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Distinct agents present (for the facet dropdown), sorted. */
export function agentsIn(records: AuditRecord[]): string[] {
  const s = new Set<string>();
  for (const r of records) if (r.agent) s.add(r.agent);
  return Array.from(s).sort();
}

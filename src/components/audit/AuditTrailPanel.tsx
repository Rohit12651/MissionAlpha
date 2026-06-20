// Audit-trail UI (ADR-041 / gap #22) — READ-ONLY unified view over exec + approval
// + connector + agent + operator + heartbeat history. Searchable + filterable. It
// only READS (factory /factory/audit?limit, operator getAudit, heartbeats from live
// state) and normalizes client-side. There is NO write path to audit here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { History, ChevronDown, Search } from "lucide-react";
import type { AuditEntry, Heartbeat } from "../../data/types";
import { getRuntimeAudit } from "../../lib/factoryClient";
import {
  normalizeFactory,
  normalizeOperator,
  normalizeHeartbeats,
  mergeAudit,
  filterAudit,
  agentsIn,
  type AuditRecord,
  type AuditSource,
} from "../../lib/auditModel";
import { tok } from "../../lib/agentMeta";

const POLL_MS = 4000;
const RENDER_CAP = 200;

const SOURCE_TOK: Record<AuditSource, string> = {
  exec: "accent-cyan",
  approval: "ceo-gold",
  connector: "factory-violet",
  agent: "done-green",
  operator: "accent-cyan",
  heartbeat: "muted",
};
const SOURCES: (AuditSource | "all")[] = ["all", "exec", "approval", "connector", "agent", "operator", "heartbeat"];
const RANGES: { label: string; ms: number | null }[] = [
  { label: "15m", ms: 15 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "all", ms: null },
];

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function AuditTrailPanel({
  getAudit,
  heartbeats,
}: {
  getAudit: (limit?: number) => Promise<AuditEntry[]>;
  heartbeats: Heartbeat[];
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [factory, setFactory] = useState<AuditRecord[]>([]);
  const [operator, setOperator] = useState<AuditRecord[]>([]);
  const [q, setQ] = useState("");
  const [source, setSource] = useState<AuditSource | "all">("all");
  const [agent, setAgent] = useState<string>("all");
  const [rangeMs, setRangeMs] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const mounted = useRef(true);

  const poll = useCallback(async () => {
    try {
      const [f, o] = await Promise.all([getRuntimeAudit(2000), getAudit(RENDER_CAP)]);
      if (!mounted.current) return;
      setFactory(normalizeFactory(f.entries));
      setOperator(normalizeOperator(o));
    } catch {
      /* read-only poll — a transient fetch failure is non-fatal, retried next tick */
    }
  }, [getAudit]);

  useEffect(() => {
    mounted.current = true;
    if (open) {
      void poll();
      const h = window.setInterval(() => void poll(), POLL_MS);
      return () => {
        mounted.current = false;
        window.clearInterval(h);
      };
    }
    return () => {
      mounted.current = false;
    };
  }, [open, poll]);

  const hbRecords = useMemo(() => normalizeHeartbeats(heartbeats), [heartbeats]);
  const merged = useMemo(() => mergeAudit([factory, operator, hbRecords]), [factory, operator, hbRecords]);
  const agentOpts = useMemo(() => ["all", ...agentsIn(merged)], [merged]);

  const sinceMs = useMemo(() => (rangeMs == null ? undefined : Date.now() - rangeMs), [rangeMs]);
  const rows = useMemo(
    () => filterAudit(merged, { q, source, agent, sinceMs }),
    [merged, q, source, agent, sinceMs],
  );

  return (
    <div className="overflow-hidden rounded-panel border border-border bg-panel/60 backdrop-blur-md">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left outline-none focus-visible:ring-2"
      >
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted">
          <History size={12} aria-hidden /> Audit trail
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted">
          {open ? `${rows.length} of ${merged.length}` : "read-only · exec · approvals · connectors · heartbeats"}
          <ChevronDown size={14} aria-hidden style={{ transform: open ? "rotate(180deg)" : "none", transition: reduce ? "none" : "transform 160ms ease-out" }} />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }}
            className="border-t border-border/50"
          >
            <div className="px-4 py-3">
              {/* search */}
              <div className="mb-2.5 flex items-center gap-2 rounded-md border border-border bg-panel-2/50 px-2.5 py-1.5">
                <Search size={13} aria-hidden style={{ color: tok("muted") }} />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search actions (e.g. exec.approved, an agent id, npm)…"
                  className="w-full bg-transparent font-mono text-[12px] text-text outline-none placeholder:text-muted"
                  aria-label="Search audit trail"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {/* facets */}
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by source">
                  {SOURCES.map((s) => {
                    const active = s === source;
                    const a = tok(s === "all" ? "accent-cyan" : SOURCE_TOK[s]);
                    return (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSource(s)}
                        className="rounded font-mono text-[10px] outline-none focus-visible:ring-2"
                        style={{
                          padding: "2px 8px",
                          color: active ? a : tok("muted"),
                          backgroundColor: active ? `color-mix(in oklch, ${a} 14%, transparent)` : "transparent",
                          border: `1px solid ${active ? `color-mix(in oklch, ${a} 30%, transparent)` : tok("border")}`,
                        }}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
                <select
                  value={agent}
                  onChange={(e) => setAgent(e.target.value)}
                  aria-label="Filter by agent"
                  className="rounded border border-border bg-panel-2/50 px-2 py-1 font-mono text-[10px] text-text outline-none focus-visible:ring-2"
                >
                  {agentOpts.map((a) => (
                    <option key={a} value={a}>{a === "all" ? "all agents" : a}</option>
                  ))}
                </select>
                <div className="ml-auto flex gap-1" role="group" aria-label="Time range">
                  {RANGES.map((r) => {
                    const active = r.ms === rangeMs;
                    return (
                      <button
                        key={r.label}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setRangeMs(r.ms)}
                        className="rounded font-mono text-[10px] outline-none focus-visible:ring-2"
                        style={{
                          padding: "2px 8px",
                          color: active ? tok("accent-cyan") : tok("muted"),
                          backgroundColor: active ? `color-mix(in oklch, ${tok("accent-cyan")} 14%, transparent)` : "transparent",
                          border: `1px solid ${active ? `color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` : tok("border")}`,
                        }}
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <p className="sr-only" role="status" aria-live="polite">{rows.length} audit records match.</p>

              {rows.length === 0 ? (
                <p className="py-6 text-center text-[12px] text-muted">
                  {merged.length === 0 ? "No audited activity yet. Tool-loop, approvals, connectors and heartbeats appear here." : "No records match the current filters."}
                </p>
              ) : (
                <div className="max-h-80 overflow-y-auto">
                  <table className="w-full border-collapse text-[11px]">
                    <thead className="sticky top-0 bg-panel/95 backdrop-blur-sm">
                      <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
                        <th className="py-1 pr-3 font-medium">Time</th>
                        <th className="py-1 pr-3 font-medium">Source</th>
                        <th className="py-1 pr-3 font-medium">Event</th>
                        <th className="py-1 pr-3 font-medium">Agent</th>
                        <th className="py-1 font-medium">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, RENDER_CAP).map((r, i) => {
                        const a = tok(SOURCE_TOK[r.source]);
                        // Content identity (position-free) so an expanded row stays
                        // pinned to its record across the 4s re-poll + filter changes.
                        const rid = `${r.iso}|${r.kind}|${r.source}|${r.agent ?? ""}|${r.summary}`;
                        const isOpen = expanded === rid;
                        return (
                          <tr
                            key={`${rid}#${i}`}
                            className="cursor-pointer border-t border-border/30 align-top hover:bg-panel-2/40"
                            onClick={() => setExpanded(isOpen ? null : rid)}
                          >
                            <td className="py-1 pr-3 font-mono tabular-nums text-muted">{fmt(r.iso)}</td>
                            <td className="py-1 pr-3">
                              <span className="inline-block rounded px-1.5 py-0.5 font-mono text-[9px] uppercase" style={{ color: a, backgroundColor: `color-mix(in oklch, ${a} 12%, transparent)` }}>
                                {r.source}
                              </span>
                            </td>
                            <td className="py-1 pr-3 font-mono text-text/85">{r.kind}</td>
                            <td className="py-1 pr-3 text-muted">{r.agent ?? "—"}</td>
                            <td className="py-1 text-text/75">
                              <span className={isOpen ? "" : "line-clamp-1"}>{r.summary}</span>
                              {isOpen && (
                                <pre className="mt-1 max-w-full overflow-x-auto rounded bg-panel-2/60 p-2 font-mono text-[10px] text-muted">
                                  {JSON.stringify(r.raw, null, 2)}
                                </pre>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {rows.length > RENDER_CAP && (
                    <p className="pt-2 text-center text-[10px] text-muted">showing latest {RENDER_CAP} of {rows.length}</p>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

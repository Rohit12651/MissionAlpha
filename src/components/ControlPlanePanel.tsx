import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ScrollText, ChevronDown, Clock, Check, XCircle, BellOff, RefreshCw, Send,
} from "lucide-react";
import type {
  AuditEntry, CommandStatusSnapshot, CommandLifecycle,
} from "../data/types";
import { tok } from "../lib/agentMeta";

// F5 (audit-log viewer) + F7 (command feedback) — Cycle 1 control plane.
// READ-only: both poll the new vite endpoints (/api/audit, /api/commands/status)
// over files the swarm already writes. F7 = lifecycle counts + chips (did my click
// land?). F5 = expandable audit trail (who did what, when). OKLCH tokens only;
// reduced-motion safe; bounded render (cap rows) so a huge log never janks.

const POLL_MS = 3000;
const MAX_ROWS = 120;

const LIFECYCLE_TOK: Record<CommandLifecycle, string> = {
  pending: "blocked-amber",
  done: "done-green",
  rejected: "stale-red",
};
function LifecycleIcon({ k }: { k: CommandLifecycle }) {
  if (k === "done") return <Check size={11} aria-hidden />;
  if (k === "rejected") return <XCircle size={11} aria-hidden />;
  return <Clock size={11} aria-hidden />;
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  ack: <BellOff size={11} aria-hidden />,
  respawn: <RefreshCw size={11} aria-hidden />,
  task: <Send size={11} aria-hidden />,
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Pill({ label, n, accent }: { label: string; n: number; accent: string }) {
  const a = tok(accent);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] tabular-nums"
      style={{
        color: a,
        backgroundColor: `color-mix(in oklch, ${a} 12%, transparent)`,
        border: `1px solid color-mix(in oklch, ${a} 28%, transparent)`,
      }}
    >
      <span className="font-semibold">{n}</span>
      <span className="text-[10px] uppercase tracking-wide opacity-80">{label}</span>
    </span>
  );
}

export function ControlPlanePanel({
  getAudit,
  getCommandStatus,
}: {
  getAudit: (limit?: number) => Promise<AuditEntry[]>;
  getCommandStatus: () => Promise<CommandStatusSnapshot>;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [status, setStatus] = useState<CommandStatusSnapshot>({
    pending: 0, done: 0, rejected: 0, recent: [],
  });
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const mounted = useRef(true);

  const poll = useCallback(async () => {
    const [a, s] = await Promise.all([getAudit(MAX_ROWS), getCommandStatus()]);
    if (!mounted.current) return;
    setAudit(a);
    setStatus(s);
  }, [getAudit, getCommandStatus]);

  useEffect(() => {
    mounted.current = true;
    void poll();
    const h = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(h);
    };
  }, [poll]);

  // lifecycle by command id (F7) so each audit row can show its current state.
  const lifecycleById = useMemo(() => {
    const m = new Map<string, CommandLifecycle>();
    for (const r of status.recent) m.set(r.id, r.lifecycle);
    return m;
  }, [status.recent]);

  const types = useMemo(() => {
    const s = new Set<string>();
    for (const e of audit) if (e.type) s.add(e.type);
    return ["all", ...Array.from(s).sort()];
  }, [audit]);

  const rows = useMemo(
    () => (typeFilter === "all" ? audit : audit.filter((e) => e.type === typeFilter)),
    [audit, typeFilter],
  );

  return (
    <div className="overflow-hidden rounded-panel border border-border bg-panel/60 backdrop-blur-md">
      {/* header — F7 status summary + expand toggle */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left outline-none focus-visible:ring-2"
      >
        <span className="mr-1 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted">
          <ScrollText size={12} aria-hidden /> Control plane
        </span>
        <Pill label="pending" n={status.pending} accent="blocked-amber" />
        <Pill label="done" n={status.done} accent="done-green" />
        <Pill label="rejected" n={status.rejected} accent="stale-red" />
        <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted">
          {audit.length} audit {audit.length === 1 ? "entry" : "entries"}
          <ChevronDown
            size={14}
            aria-hidden
            style={{
              transform: open ? "rotate(180deg)" : "none",
              transition: reduce ? "none" : "transform 160ms ease-out",
            }}
          />
        </span>
      </button>

      {/* F5 — expandable audit trail */}
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
              {/* type filter */}
              <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] uppercase tracking-wide text-muted">filter</span>
                {types.map((t) => {
                  const active = t === typeFilter;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTypeFilter(t)}
                      className="rounded font-mono text-[10px] outline-none focus-visible:ring-2"
                      style={{
                        padding: "2px 8px",
                        color: active ? tok("accent-cyan") : tok("muted"),
                        backgroundColor: active
                          ? `color-mix(in oklch, ${tok("accent-cyan")} 14%, transparent)`
                          : "transparent",
                        border: `1px solid ${active ? `color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` : "var(--c-border)"}`,
                      }}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>

              {/* audit rows (bounded) */}
              {rows.length === 0 ? (
                <p className="py-4 text-center text-[12px] text-muted">
                  No actions recorded yet. Operator commands (ack / respawn / task) appear here.
                </p>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full border-collapse text-[11px]">
                    <thead className="sticky top-0 bg-panel/95 backdrop-blur-sm">
                      <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
                        <th className="py-1 pr-3 font-medium">Time</th>
                        <th className="py-1 pr-3 font-medium">Type</th>
                        <th className="py-1 pr-3 font-medium">Target</th>
                        <th className="py-1 pr-3 font-medium">By</th>
                        <th className="py-1 font-medium">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, MAX_ROWS).map((e, i) => {
                        const lc = lifecycleById.get(e.cmdId);
                        return (
                          <tr key={`${e.cmdId}-${i}`} className="border-t border-border/30">
                            <td className="py-1 pr-3 font-mono tabular-nums text-muted">{fmtTime(e.at)}</td>
                            <td className="py-1 pr-3">
                              <span className="inline-flex items-center gap-1 font-mono text-text/85">
                                {TYPE_ICON[e.type] ?? null}
                                {e.type}
                              </span>
                            </td>
                            <td className="py-1 pr-3 font-mono text-text/85">{e.target}</td>
                            <td className="py-1 pr-3 text-muted">{e.issuedBy}</td>
                            <td className="py-1">
                              {lc ? (
                                <span
                                  className="inline-flex items-center gap-1 rounded font-mono text-[10px]"
                                  style={{
                                    padding: "1px 6px",
                                    color: tok(LIFECYCLE_TOK[lc]),
                                    backgroundColor: `color-mix(in oklch, ${tok(LIFECYCLE_TOK[lc])} 12%, transparent)`,
                                  }}
                                >
                                  <LifecycleIcon k={lc} />
                                  {lc}
                                </span>
                              ) : (
                                <span className="font-mono text-[10px] text-muted/60">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {rows.length > MAX_ROWS && (
                    <p className="pt-2 text-center text-[10px] text-muted">
                      showing latest {MAX_ROWS} of {rows.length}
                    </p>
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  History, ChevronDown, Activity, ShieldAlert, Send, Users, Clock, Camera,
} from "lucide-react";
import type { SessionSummary } from "../data/types";
import { tok } from "../lib/agentMeta";

// F4 (Cycle 2) — Session history browser + computed summary. "Walk in tomorrow,
// see what the swarm did yesterday." Reads the sidecar recorder store via
// /api/sessions (list) and /api/sessions/:id is fetched on demand by the parent.
// Read-only, no LLM — summary is pure computed stats. OKLCH tokens; reduced-motion.

const POLL_MS = 15000;

function fmtDate(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function fmtSpan(startTs: string, endTs: string): string {
  const a = Date.parse(startTs);
  const b = Date.parse(endTs);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "—";
  const mins = Math.round((b - a) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}
function fmtClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Stat({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: React.ReactNode; accent: string }) {
  const a = tok(accent);
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-bg/40 px-2.5 py-2">
      <span style={{ color: a }}>{icon}</span>
      <div className="min-w-0">
        <div className="font-mono text-[13px] font-semibold tabular-nums text-text">{value}</div>
        <div className="text-[9px] uppercase tracking-wide text-muted">{label}</div>
      </div>
    </div>
  );
}

export function SessionsBrowser({
  listSessions,
}: {
  listSessions: () => Promise<SessionSummary[]>;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const mounted = useRef(true);

  const poll = useCallback(async () => {
    const s = await listSessions();
    if (mounted.current) setSessions(s);
  }, [listSessions]);

  useEffect(() => {
    mounted.current = true;
    void poll();
    const h = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(h);
    };
  }, [poll]);

  const sel = useMemo(() => sessions.find((s) => s.id === selected) ?? null, [sessions, selected]);

  return (
    <div className="overflow-hidden rounded-panel border border-border bg-panel/60 backdrop-blur-md">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left outline-none focus-visible:ring-2"
      >
        <span className="mr-1 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted">
          <History size={12} aria-hidden /> Sessions
        </span>
        <span className="font-mono text-[11px] tabular-nums text-text/80">
          {sessions.length} recorded
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted">
          history
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
              {sessions.length === 0 ? (
                <p className="py-4 text-center text-[12px] text-muted">
                  No sessions recorded yet. The history recorder appends a snapshot every tick — sessions appear here per day.
                </p>
              ) : (
                <>
                  {/* session list */}
                  <div className="flex flex-wrap gap-2">
                    {sessions.map((s) => {
                      const active = s.id === selected;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setSelected(active ? null : s.id)}
                          className="rounded-md px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2"
                          style={{
                            backgroundColor: active
                              ? `color-mix(in oklch, ${tok("accent-cyan")} 12%, transparent)`
                              : "var(--c-panel-2)",
                            border: `1px solid ${active ? `color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` : "var(--c-border)"}`,
                          }}
                        >
                          <div className="text-[12px] font-semibold text-text">{fmtDate(s.date)}</div>
                          <div className="mt-0.5 font-mono text-[10px] tabular-nums text-muted">
                            {fmtClock(s.startTs)}–{fmtClock(s.endTs)} · {s.snapshotCount} snaps
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* selected session summary (F4c) */}
                  {sel && (
                    <motion.div
                      initial={{ opacity: 0, y: reduce ? 0 : -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: reduce ? 0 : 0.16, ease: "easeOut" }}
                      className="mt-3 rounded-md border border-border/60 bg-bg/30 p-3"
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[12px] font-semibold text-text">{fmtDate(sel.date)} — summary</span>
                        <span className="font-mono text-[10px] text-muted">
                          {fmtClock(sel.startTs)}–{fmtClock(sel.endTs)} · {fmtSpan(sel.startTs, sel.endTs)}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        <Stat icon={<Activity size={14} aria-hidden />} label="peak active" value={sel.peakActive} accent="done-green" />
                        <Stat icon={<ShieldAlert size={14} aria-hidden />} label="max blocked" value={sel.maxBlocked} accent="blocked-amber" />
                        <Stat icon={<Send size={14} aria-hidden />} label="commands" value={sel.commandsFired} accent="accent-cyan" />
                        <Stat icon={<Users size={14} aria-hidden />} label="agents seen" value={sel.agentsSeen} accent="ceo-gold" />
                        <Stat icon={<Camera size={14} aria-hidden />} label="snapshots" value={sel.snapshotCount} accent="muted" />
                        <Stat icon={<Clock size={14} aria-hidden />} label="duration" value={fmtSpan(sel.startTs, sel.endTs)} accent="muted" />
                      </div>
                    </motion.div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

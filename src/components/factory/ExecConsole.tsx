import { useCallback, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Terminal, ChevronDown, Play, ShieldAlert, Check, X, Ban, Loader2, Globe } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { proposeExec, approveExec, type ExecResult } from "../../lib/factoryClient";

// ADR-039 — Approval UX for the full tool loop. Propose a command for an agent →
// classified by the broker → SAFE auto-runs jailed, SENSITIVE shows an approval prompt
// (allow-once / allow-for-session / deny) with command preview + declared capabilities,
// FORBIDDEN is refused. Output streams back from the Docker sandbox. NO host exec, ever.

function OutBlock({ r }: { r: ExecResult }) {
  if (r.stdout == null && r.stderr == null) return null;
  return (
    <div className="mt-2 rounded border border-border/60 bg-bg/50 p-2 font-mono text-[11px]">
      <div className="mb-1" style={{ color: r.exitCode === 0 ? tok("done-green") : tok("stale-red") }}>
        exit {r.exitCode}{r.timedOut ? " · timed out (killed)" : ""}{r.killed && !r.timedOut ? " · killed" : ""} · {r.klass} · jailed in sandbox
      </div>
      {r.stdout ? <pre className="whitespace-pre-wrap break-words" style={{ color: tok("text") }}>{r.stdout}</pre> : null}
      {r.stderr ? <pre className="whitespace-pre-wrap break-words" style={{ color: tok("blocked-amber") }}>{r.stderr}</pre> : null}
    </div>
  );
}

export function ExecConsole({ agentIds }: { agentIds: string[] }) {
  const reduce = useReducedMotion();
  const accent = tok("stale-red"); // exec = highest-risk surface → red identity
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState(agentIds[0] || "builder");
  const [command, setCommand] = useState("");
  const [network, setNetwork] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ExecResult | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [err, setErr] = useState("");

  const propose = useCallback(async () => {
    const cmd = command.trim();
    if (!cmd || busy) return;
    setErr(""); setResult(null); setPending(null); setBusy(true);
    try {
      const r = await proposeExec(agentId, cmd, network);
      if (r.error) setErr(r.error);
      else if (r.refused) setResult(r);          // FORBIDDEN
      else if (r.pending) setPending(r);          // SENSITIVE → approval gate
      else setResult(r);                          // SAFE → ran
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }, [command, agentId, network, busy]);

  const decide = useCallback(async (scope: "once" | "session" | "deny") => {
    if (!pending?.callId) return;
    setBusy(true);
    try {
      const r = await approveExec(pending.callId, scope);
      setPending(null);
      setResult(r);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }, [pending]);

  return (
    <div className="overflow-hidden rounded-panel border border-border bg-panel/60 backdrop-blur-md">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left outline-none focus-visible:ring-2">
        <span className="mr-1 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest" style={{ color: accent }}>
          <Terminal size={12} aria-hidden /> Sandbox Exec
        </span>
        <span className="font-mono text-[11px] text-text/70">full tool loop · jailed in Docker</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted">
          exec
          <ChevronDown size={14} aria-hidden style={{ transform: open ? "rotate(180deg)" : "none", transition: reduce ? "none" : "transform 160ms ease-out" }} />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }} className="border-t border-border/50">
            <div className="space-y-2 px-4 py-3">
              <div className="flex items-center gap-2">
                <label className="font-mono text-[10px] uppercase" style={{ color: tok("muted") }}>agent</label>
                <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="agent"
                  className="rounded border px-2 py-1 text-[12px] outline-none focus-visible:ring-2" style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }}>
                  {agentIds.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <label className="ml-auto inline-flex items-center gap-1 text-[11px]" style={{ color: network ? tok("blocked-amber") : tok("muted") }}>
                  <input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} /> <Globe size={12} aria-hidden /> network
                </label>
              </div>
              <div className="flex items-end gap-2">
                <input value={command} onChange={(e) => setCommand(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void propose(); }}
                  placeholder="command to run in the sandbox (e.g. npm create vite@latest app)" aria-label="command"
                  className="w-full rounded border px-2 py-1.5 font-mono text-[11px] outline-none focus-visible:ring-2" style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }} />
                <button type="button" onClick={() => void propose()} disabled={busy || !command.trim()}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-3 py-1.5 text-[11px] font-semibold outline-none focus-visible:ring-2 disabled:opacity-40"
                  style={{ color: accent, backgroundColor: `color-mix(in oklch, ${accent} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${accent} 34%, transparent)` }}>
                  {busy ? <Loader2 size={13} className={reduce ? "" : "animate-spin"} aria-hidden /> : <Play size={13} aria-hidden />} Run
                </button>
              </div>

              {err && <p role="alert" className="font-mono text-[10px]" style={{ color: tok("stale-red") }}>{err}</p>}

              {/* SENSITIVE → approval prompt */}
              {pending && (
                <div className="rounded-md p-2.5" style={{ backgroundColor: `color-mix(in oklch, ${tok("blocked-amber")} 8%, transparent)`, border: `1px solid color-mix(in oklch, ${tok("blocked-amber")} 30%, transparent)` }}>
                  <div className="mb-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: tok("blocked-amber") }}>
                    <ShieldAlert size={12} aria-hidden /> approval required · {pending.klass}
                  </div>
                  <pre className="mb-1 whitespace-pre-wrap break-words rounded bg-bg/50 p-1.5 font-mono text-[11px]" style={{ color: tok("text") }}>{pending.preview}</pre>
                  <div className="mb-2 font-mono text-[10px]" style={{ color: tok("muted") }}>
                    capabilities: {pending.capabilities?.length ? pending.capabilities.join(", ") : "none (no network, no host fs)"} · runs jailed in Docker
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => void decide("once")} disabled={busy} className="inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold outline-none focus-visible:ring-2" style={{ color: tok("done-green"), border: `1px solid color-mix(in oklch, ${tok("done-green")} 40%, transparent)` }}><Check size={12} aria-hidden /> Allow once</button>
                    <button type="button" onClick={() => void decide("session")} disabled={busy} className="inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold outline-none focus-visible:ring-2" style={{ color: tok("accent-cyan"), border: `1px solid color-mix(in oklch, ${tok("accent-cyan")} 40%, transparent)` }}><Check size={12} aria-hidden /> Allow for session</button>
                    <button type="button" onClick={() => void decide("deny")} disabled={busy} className="inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold outline-none focus-visible:ring-2" style={{ color: tok("stale-red"), border: `1px solid color-mix(in oklch, ${tok("stale-red")} 40%, transparent)` }}><X size={12} aria-hidden /> Deny</button>
                  </div>
                </div>
              )}

              {/* FORBIDDEN */}
              {result?.refused && (
                <p role="alert" className="inline-flex items-center gap-1.5 font-mono text-[11px]" style={{ color: tok("stale-red") }}>
                  <Ban size={13} aria-hidden /> FORBIDDEN — {result.reason} · never runs
                </p>
              )}
              {result?.denied && <p className="font-mono text-[11px]" style={{ color: tok("muted") }}>denied — not executed</p>}
              {result && (result.ran || result.exitCode != null) && <OutBlock r={result} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

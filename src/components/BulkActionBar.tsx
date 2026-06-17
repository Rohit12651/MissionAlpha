import { useCallback, useMemo, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { BellOff, RefreshCw, Loader2, Check, Layers } from "lucide-react";
import type { AgentState, CommandRequest, CommandResult, CommandType } from "../data/types";
import { tok } from "../lib/agentMeta";
import { PermissionGate } from "./PermissionGate";

// F6 — Bulk actions. Act on many agents in ONE click instead of opening N drawers.
// "ack all stale", "respawn all offline". Each bulk action is HARD-gated by the F3
// PermissionGate (no mass action fires without explicit confirm). Implementation
// loops the existing validated sendCommand (one /api/command per agent) — zero
// backend change, fully on-architecture. Best-effort: collects per-agent results,
// shows a summary. Reduced-motion safe. OKLCH tokens only.

type Phase = "idle" | "sending" | "done";
interface PendingAction {
  type: CommandType;
  targets: string[];
  title: string;
  summary: string;
  confirmLabel: string;
  accent: string;
}

export function BulkActionBar({
  agents,
  onCommand,
}: {
  agents: AgentState[];
  onCommand: (cmd: CommandRequest) => Promise<CommandResult>;
}) {
  const reduce = useReducedMotion();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [summary, setSummary] = useState<string>("");

  // stale-but-not-dead → ack candidates; dead OR OFFLINE → respawn candidates.
  const staleIds = useMemo(
    () => agents.filter((a) => a.stale && !a.dead).map((a) => a.id),
    [agents],
  );
  const offlineIds = useMemo(
    () => agents.filter((a) => a.dead || a.state === "OFFLINE").map((a) => a.id),
    [agents],
  );

  const run = useCallback(
    async (action: PendingAction) => {
      setPending(null);
      setPhase("sending");
      setSummary("");
      const results = await Promise.all(
        action.targets.map((id) =>
          onCommand({ type: action.type, target: id, issuedBy: "operator" }).catch(
            (e): CommandResult => ({ ok: false, error: (e as Error).message }),
          ),
        ),
      );
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      setPhase("done");
      setSummary(
        `${action.type === "ack" ? "Acknowledged" : "Respawn requested"}: ${ok} ok${failed ? ` · ${failed} failed` : ""}`,
      );
      window.setTimeout(() => setPhase("idle"), 4000);
    },
    [onCommand],
  );

  const askAck = () =>
    setPending({
      type: "ack",
      targets: staleIds,
      title: "Acknowledge all stale agents",
      summary: `Claims the stall on ${staleIds.length} stale agent${staleIds.length === 1 ? "" : "s"} so the scheduler stops nagging. Does not restart them.`,
      confirmLabel: `Acknowledge ${staleIds.length}`,
      accent: "blocked-amber",
    });

  const askRespawn = () =>
    setPending({
      type: "respawn",
      targets: offlineIds,
      title: "Respawn all offline agents",
      summary: `Queues a respawn request for ${offlineIds.length} offline agent${offlineIds.length === 1 ? "" : "s"}. Each will re-dispatch on the next swarm tick.`,
      confirmLabel: `Respawn ${offlineIds.length}`,
      accent: "stale-red",
    });

  const busy = phase === "sending";
  const amber = tok("blocked-amber");
  const red = tok("stale-red");
  const green = tok("done-green");

  const btn = (
    label: string,
    count: number,
    icon: React.ReactNode,
    accentVar: string,
    onClick: () => void,
  ) => {
    const disabled = busy || count === 0;
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 disabled:cursor-default disabled:opacity-40"
        style={{
          color: accentVar,
          backgroundColor: `color-mix(in oklch, ${accentVar} 12%, transparent)`,
          border: `1px solid color-mix(in oklch, ${accentVar} 30%, transparent)`,
        }}
      >
        {busy ? <Loader2 size={13} className={reduce ? "" : "animate-spin"} aria-hidden /> : icon}
        {label} <span className="font-mono tabular-nums opacity-80">({count})</span>
      </button>
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-panel border border-border bg-panel/60 px-4 py-2.5 backdrop-blur-md">
        <span className="mr-1 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted">
          <Layers size={12} aria-hidden /> Bulk actions
        </span>
        {btn("Acknowledge all stale", staleIds.length, <BellOff size={13} aria-hidden />, amber, askAck)}
        {btn("Respawn all offline", offlineIds.length, <RefreshCw size={13} aria-hidden />, red, askRespawn)}

        {phase === "done" && (
          <span
            className="inline-flex items-center gap-1.5 font-mono text-[11px]"
            style={{ color: summary.includes("failed") ? red : green }}
          >
            <Check size={13} aria-hidden /> {summary}
          </span>
        )}
        {busy && (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
            <Loader2 size={13} className={reduce ? "" : "animate-spin"} aria-hidden /> dispatching…
          </span>
        )}
        <span className="sr-only" role="status" aria-live="polite">
          {summary}
        </span>
      </div>

      <PermissionGate
        open={pending !== null}
        title={pending?.title ?? ""}
        summary={pending?.summary ?? ""}
        affected={pending?.targets ?? []}
        confirmLabel={pending?.confirmLabel ?? "Confirm"}
        accent={pending?.accent ?? "blocked-amber"}
        onConfirm={() => pending && run(pending)}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

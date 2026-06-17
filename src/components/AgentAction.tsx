import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import {
  Check,
  Copy,
  Zap,
  Gavel,
  Link2,
  CircleCheck,
  ArrowRight,
  BellOff,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Send,
} from "lucide-react";
import type { AgentState, CommandRequest, CommandResult } from "../data/types";
import { actionFor, type ActionKind } from "../lib/actions";
import { tok } from "../lib/agentMeta";
import { AgentChat } from "./AgentChat";

type AckPhase = "idle" | "sending" | "done" | "error";
type RespawnPhase = "idle" | "sending" | "done" | "error";
type TaskPhase = "idle" | "sending" | "done" | "error";

// A5 — Actionable NEEDS-YOU panel. Lives at the TOP of the drawer (right after the
// header, before Why-Stuck) so the first thing the operator can do on drill-in is ACT.
// Surfaces the agent's `next=` step prominently, an explaining hint, and a copy-paste
// command block with a real <button> Copy. Read-only: we hand a command, never run it.
// All color via OKLCH tokens. Reduced-motion safe; "Copied" announced via aria-live.

const KIND_ACCENT: Record<ActionKind, string> = {
  respawn: "stale-red",
  decide: "ceo-gold",
  unblock: "blocked-amber",
  none: "muted",
};

function KindIcon({ kind }: { kind: ActionKind }) {
  const size = 14;
  if (kind === "respawn") return <Zap size={size} aria-hidden />;
  if (kind === "decide") return <Gavel size={size} aria-hidden />;
  if (kind === "unblock") return <Link2 size={size} aria-hidden />;
  return <CircleCheck size={size} aria-hidden />;
}

function CopyButton({ command, accent }: { command: string; accent: string }) {
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(command);
    } catch {
      // Clipboard blocked (insecure ctx / denied) — the command block stays selectable
      // so the operator can still copy manually. We still flash the confirm.
    }
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }, [command]);

  const accentVar = tok(accent);

  return (
    <>
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy command to clipboard"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium outline-none focus-visible:ring-2"
        style={{
          color: copied ? tok("done-green") : accentVar,
          backgroundColor: `color-mix(in oklch, ${copied ? tok("done-green") : accentVar} 12%, transparent)`,
          border: `1px solid color-mix(in oklch, ${copied ? tok("done-green") : accentVar} 30%, transparent)`,
          transition: reduce
            ? "none"
            : "color 140ms ease-out, background-color 140ms ease-out, border-color 140ms ease-out",
        }}
      >
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
      {/* Announce the copy to assistive tech (text content swaps → polite read-out). */}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Command copied to clipboard" : ""}
      </span>
    </>
  );
}

// The WRITE arrow, surfaced as a real button. Phase 1 verb = `ack`: claims
// ownership of a stall so the scheduler stops nagging (PagerDuty-style). Sends
// via the DataSource seam; optimistic UI with pending/done/error states. The
// copy-paste command stays beside it as a manual fallback.
function AckButton({
  agent,
  onCommand,
}: {
  agent: AgentState;
  onCommand: (cmd: CommandRequest) => Promise<CommandResult>;
}) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<AckPhase>("idle");
  const [msg, setMsg] = useState<string>("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reset when the drawer switches to a different agent. If the polled snapshot
  // already shows this agent acknowledged (loop closed via emit_state→acks.json),
  // start in the done state so the button reflects swarm truth, not just local click.
  useEffect(() => {
    if (agent.acknowledged) {
      setPhase("done");
      setMsg(agent.acknowledgedAt ? `acknowledged · ${agent.acknowledgedAt}` : "acknowledged");
    } else {
      setPhase("idle");
      setMsg("");
    }
  }, [agent.id, agent.acknowledged, agent.acknowledgedAt]);

  const onAck = useCallback(async () => {
    setPhase("sending");
    setMsg("");
    try {
      const res = await onCommand({ type: "ack", target: agent.id, issuedBy: "operator" });
      if (!mounted.current) return;
      if (res.ok) {
        setPhase("done");
        setMsg(`acknowledged · ${res.id ?? ""}`);
      } else {
        setPhase("error");
        setMsg(res.error ?? "command rejected");
      }
    } catch (e) {
      if (!mounted.current) return;
      setPhase("error");
      setMsg((e as Error).message);
    }
  }, [agent.id, onCommand]);

  const green = tok("done-green");
  const red = tok("stale-red");
  const accent = phase === "done" ? green : phase === "error" ? red : tok("blocked-amber");
  const disabled = phase === "sending" || phase === "done";

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={onAck}
        disabled={disabled}
        aria-label={`Acknowledge ${agent.id} — stop scheduler nagging`}
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold outline-none focus-visible:ring-2 disabled:cursor-default"
        style={{
          color: accent,
          backgroundColor: `color-mix(in oklch, ${accent} 12%, transparent)`,
          border: `1px solid color-mix(in oklch, ${accent} 30%, transparent)`,
          transition: reduce ? "none" : "color 140ms ease-out, background-color 140ms ease-out",
        }}
      >
        {phase === "sending" ? (
          <Loader2 size={13} className={reduce ? "" : "animate-spin"} aria-hidden />
        ) : phase === "done" ? (
          <Check size={13} aria-hidden />
        ) : phase === "error" ? (
          <AlertTriangle size={13} aria-hidden />
        ) : (
          <BellOff size={13} aria-hidden />
        )}
        {phase === "sending"
          ? "Acknowledging…"
          : phase === "done"
            ? "Acknowledged"
            : phase === "error"
              ? "Retry acknowledge"
              : "Acknowledge"}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {msg}
      </span>
      {phase === "error" && msg && (
        <p className="mt-1.5 font-mono text-[10px]" style={{ color: red }}>
          {msg}
        </p>
      )}
      {phase === "done" && (
        <p className="mt-1.5 font-mono text-[10px]" style={{ color: green }}>
          queued for swarm · stops nagging next tick
        </p>
      )}
    </div>
  );
}

// Phase 2 — WRITE arrow for the respawn verb. Mirrors AckButton exactly but:
//   • sends `type: "respawn"` instead of `"ack"`
//   • reflects `agent.respawnRequested` / `agent.respawnRequestedAt` from the poll
//   • uses `stale-red` accent (intent: re-dispatch a stalled/dead agent)
//   • writes to respawns.json (separate file — no collision with acks.json)
//   SECURITY: records intent only — never executes a shell command from here.
function RespawnButton({
  agent,
  onCommand,
}: {
  agent: AgentState;
  onCommand: (cmd: CommandRequest) => Promise<CommandResult>;
}) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<RespawnPhase>("idle");
  const [msg, setMsg] = useState<string>("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reset when the drawer switches to a different agent. If the polled snapshot
  // already shows this agent respawn-requested (loop closed via emit_state→respawns.json),
  // start in the done state so the button reflects swarm truth, not just local click.
  useEffect(() => {
    if (agent.respawnRequested) {
      setPhase("done");
      setMsg(
        agent.respawnRequestedAt
          ? `respawn requested · ${agent.respawnRequestedAt}`
          : "respawn requested",
      );
    } else {
      setPhase("idle");
      setMsg("");
    }
  }, [agent.id, agent.respawnRequested, agent.respawnRequestedAt]);

  const onRespawn = useCallback(async () => {
    setPhase("sending");
    setMsg("");
    try {
      const res = await onCommand({ type: "respawn", target: agent.id, issuedBy: "operator" });
      if (!mounted.current) return;
      if (res.ok) {
        setPhase("done");
        setMsg(`respawn requested · ${res.id ?? ""}`);
      } else {
        setPhase("error");
        setMsg(res.error ?? "command rejected");
      }
    } catch (e) {
      if (!mounted.current) return;
      setPhase("error");
      setMsg((e as Error).message);
    }
  }, [agent.id, onCommand]);

  const red = tok("stale-red");
  const green = tok("done-green");
  const accent = phase === "done" ? green : phase === "error" ? red : red;
  const disabled = phase === "sending" || phase === "done";

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onRespawn}
        disabled={disabled}
        aria-label={`Request respawn of ${agent.id} — re-dispatch stalled agent`}
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold outline-none focus-visible:ring-2 disabled:cursor-default"
        style={{
          color: accent,
          backgroundColor: `color-mix(in oklch, ${accent} 12%, transparent)`,
          border: `1px solid color-mix(in oklch, ${accent} 30%, transparent)`,
          transition: reduce ? "none" : "color 140ms ease-out, background-color 140ms ease-out",
        }}
      >
        {phase === "sending" ? (
          <Loader2 size={13} className={reduce ? "" : "animate-spin"} aria-hidden />
        ) : phase === "done" ? (
          <Check size={13} aria-hidden />
        ) : phase === "error" ? (
          <AlertTriangle size={13} aria-hidden />
        ) : (
          <RefreshCw size={13} aria-hidden />
        )}
        {phase === "sending"
          ? "Requesting…"
          : phase === "done"
            ? "Respawn Requested"
            : phase === "error"
              ? "Retry respawn"
              : "Request Respawn"}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {msg}
      </span>
      {phase === "error" && msg && (
        <p className="mt-1.5 font-mono text-[10px]" style={{ color: red }}>
          {msg}
        </p>
      )}
      {phase === "done" && (
        <p className="mt-1.5 font-mono text-[10px]" style={{ color: green }}>
          queued for swarm · re-dispatch on next tick
        </p>
      )}
    </div>
  );
}

// Phase 3 — WRITE arrow for the `task` verb. Sends an arbitrary task description
// to the target agent's INBOX via the command channel. Unlike ack/respawn, there
// is no loop-closing *.json — the inbox line IS the visible result: on the next
// poll it surfaces in the drawer's Inbox section automatically.
//
// Rendered for ALL agents (any agent can receive a task), including when
// action.kind === "none". The textarea is cleared on success so the operator can
// dispatch another task immediately. Reduced-motion safe; aria-live status.
// NO inline hex — all color from OKLCH design tokens via tok().
function TaskDispatch({
  agent,
  onCommand,
}: {
  agent: AgentState;
  onCommand: (cmd: CommandRequest) => Promise<CommandResult>;
}) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<TaskPhase>("idle");
  const [text, setText] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  const [lastId, setLastId] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reset status (not textarea) when the drawer switches to a different agent.
  useEffect(() => {
    setPhase("idle");
    setStatusMsg("");
    setLastId(null);
  }, [agent.id]);

  const onDispatch = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPhase("sending");
    setStatusMsg("");
    try {
      const res = await onCommand({
        type: "task",
        target: agent.id,
        issuedBy: "operator",
        body: trimmed,
      });
      if (!mounted.current) return;
      if (res.ok) {
        setPhase("done");
        setLastId(res.id ?? null);
        setStatusMsg(`dispatched · ${res.id ?? ""}`);
        setText(""); // clear on success so another task can be sent immediately
      } else {
        setPhase("error");
        setStatusMsg(res.error ?? "command rejected");
      }
    } catch (e) {
      if (!mounted.current) return;
      setPhase("error");
      setStatusMsg((e as Error).message);
    }
  }, [agent.id, text, onCommand]);

  // After a successful dispatch the operator can immediately type a new task.
  const onTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      // Reset done/error state when they start typing a new task.
      if (phase === "done" || phase === "error") {
        setPhase("idle");
        setStatusMsg("");
      }
    },
    [phase],
  );

  const cyan = tok("accent-cyan");
  const red = tok("stale-red");
  const green = tok("done-green");

  const buttonAccent =
    phase === "done" ? green : phase === "error" ? red : cyan;
  const isSending = phase === "sending";
  const isDisabled = isSending || !text.trim();

  return (
    <div className="mt-4 border-t border-border/40 pt-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Dispatch task
      </p>
      <textarea
        value={text}
        onChange={onTextChange}
        placeholder={`Describe a task for ${agent.id}…`}
        rows={3}
        disabled={isSending}
        aria-label={`Task description for ${agent.id}`}
        className="w-full resize-y rounded-md border border-border/60 bg-bg/60 px-2.5 py-2 font-mono text-[11px] text-text/85 outline-none placeholder:text-muted/50 focus-visible:ring-2 disabled:opacity-60"
        style={{
          minHeight: "4.5rem",
          transition: reduce ? "none" : "border-color 120ms ease-out",
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onDispatch}
          disabled={isDisabled}
          aria-label={`Dispatch task to ${agent.id}`}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold outline-none focus-visible:ring-2 disabled:cursor-default disabled:opacity-40"
          style={{
            color: buttonAccent,
            backgroundColor: `color-mix(in oklch, ${buttonAccent} 12%, transparent)`,
            border: `1px solid color-mix(in oklch, ${buttonAccent} 30%, transparent)`,
            transition: reduce
              ? "none"
              : "color 140ms ease-out, background-color 140ms ease-out, border-color 140ms ease-out",
          }}
        >
          {isSending ? (
            <Loader2 size={13} className={reduce ? "" : "animate-spin"} aria-hidden />
          ) : phase === "done" ? (
            <Check size={13} aria-hidden />
          ) : phase === "error" ? (
            <AlertTriangle size={13} aria-hidden />
          ) : (
            <Send size={13} aria-hidden />
          )}
          {isSending
            ? "Dispatching…"
            : phase === "done"
              ? "Dispatched"
              : phase === "error"
                ? "Retry dispatch"
                : "Dispatch task"}
        </button>
        {/* aria-live region announces result to assistive tech */}
        <span className="sr-only" role="status" aria-live="polite">
          {statusMsg}
        </span>
      </div>
      {phase === "error" && statusMsg && (
        <p className="mt-1.5 font-mono text-[10px]" style={{ color: red }}>
          {statusMsg}
        </p>
      )}
      {phase === "done" && lastId && (
        <p className="mt-1.5 font-mono text-[10px]" style={{ color: green }}>
          dispatched · {lastId} · appears in inbox next poll
        </p>
      )}
    </div>
  );
}

export function AgentAction({
  agent,
  agents,
  onCommand,
}: {
  agent: AgentState;
  agents: AgentState[];
  /** WRITE arrow. When present, renders a live Acknowledge button. */
  onCommand?: (cmd: CommandRequest) => Promise<CommandResult>;
}) {
  const action = useMemo(() => actionFor(agent, agents), [agent, agents]);
  const accent = KIND_ACCENT[action.kind];
  const accentVar = tok(accent);

  if (action.kind === "none") {
    return (
      <section className="px-5 pb-4 pt-1" aria-label="Operator action">
        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-panel-2/40 px-3 py-2.5 text-[12px] text-muted">
          <CircleCheck size={14} className="text-done-green" aria-hidden />
          <span>{action.hint}</span>
        </div>
        {/* Phase 3: task dispatch is available even when the agent needs no operator
            decision — any agent can receive a task at any time. */}
        {onCommand && <TaskDispatch agent={agent} onCommand={onCommand} />}

        {/* Track B / F1: streaming chat with the agent's Claude brain (chat-only). */}
        <AgentChat agentId={agent.id} />
      </section>
    );
  }

  return (
    <section className="px-5 pb-4 pt-1" aria-label="Operator action">
      <div
        className="rounded-lg p-3.5"
        style={{
          backgroundColor: `color-mix(in oklch, ${accentVar} 8%, transparent)`,
          border: `1px solid color-mix(in oklch, ${accentVar} 26%, transparent)`,
        }}
      >
        {/* title row */}
        <div className="flex items-center gap-2">
          <span style={{ color: accentVar }}>
            <KindIcon kind={action.kind} />
          </span>
          <h3 className="text-[12px] font-semibold" style={{ color: accentVar }}>
            {action.title}
          </h3>
        </div>

        {/* the agent's NEXT step — surfaced prominently */}
        {agent.next && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] text-text/90">
            <ArrowRight size={13} className="mt-0.5 shrink-0 text-muted" aria-hidden />
            <span>
              <span className="font-semibold text-muted">Next: </span>
              <span className="text-text">{agent.next}</span>
              {agent.eta && (
                <span className="ml-1.5 font-mono text-[10px] tabular-nums text-muted">
                  · eta {agent.eta}
                </span>
              )}
            </span>
          </p>
        )}

        {/* hint */}
        <p className="mt-2 text-[11px] leading-snug text-muted">{action.hint}</p>

        {/* command block + copy */}
        <div className="mt-3 flex items-stretch gap-2">
          <code
            className="min-w-0 flex-1 select-text overflow-x-auto whitespace-nowrap rounded-md border border-border/60 bg-bg/60 px-2.5 py-2 font-mono text-[11px] text-text/85"
            tabIndex={0}
          >
            {action.command}
          </code>
          <CopyButton command={action.command} accent={accent} />
        </div>

        {/* WRITE arrow — live one-click actions. Phase 1: ack. Phase 2: respawn.
            Both may appear. Respawn shown for stale/dead (kind === "respawn");
            Ack shown for all actionable states as a fallback ownership claim. */}
        {onCommand && action.kind === "respawn" && (
          <RespawnButton agent={agent} onCommand={onCommand} />
        )}
        {onCommand && <AckButton agent={agent} onCommand={onCommand} />}

        {/* Phase 3: task dispatch — always available, regardless of action kind.
            Operator can send a task description to any agent at any time. */}
        {onCommand && <TaskDispatch agent={agent} onCommand={onCommand} />}

        {/* Track B / F1: streaming chat with the agent's Claude brain (chat-only). */}
        <AgentChat agentId={agent.id} />
      </div>
    </section>
  );
}

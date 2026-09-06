// PHASE 2 TASK 2.1 — READINESS, STATED HONESTLY, WHERE THE OPERATOR STARTS WORK.
//
// The defect: the Command Center rendered its controls as if the engine could always
// dispatch. When the active account had not demonstrated tool support, queueing work
// produced a task that failed deep in the loop for a reason no surface had ever shown.
//
// The sentence rendered here is the SAME sentence the dispatcher refuses with — the runtime
// computes both from one predicate — so what the operator reads before queueing and what a
// failed task says afterwards cannot drift apart.
//
// PRINCIPLE 0: no state here names a brand as the remedy. The fix for "this model did not
// answer a tool call" is a measurement, and the control that takes it is one click away.

import { AlertTriangle, CheckCircle2, KeyRound } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import {
  standingLabel,
  standingTone,
  probeWouldHelp,
  type EngineReadiness,
} from "../../lib/engineReadiness";

export interface EngineReadinessBannerProps {
  /** `null` while the first read is in flight; `undefined` never — absence is a state. */
  readiness: EngineReadiness | null;
  /** True when the runtime could not be reached. Distinct from "not ready". */
  error: boolean;
  /** Take the operator to Accounts, where the probe control lives. */
  onOpenAccounts: () => void;
  onRetry: () => void;
}

const toneColor = (t: "ok" | "warn" | "error"): string =>
  t === "ok" ? tok("done-green") : t === "warn" ? tok("blocked-amber") : tok("stale-red");

export function EngineReadinessBanner({ readiness, error, onOpenAccounts, onRetry }: EngineReadinessBannerProps) {
  // A transport failure is NOT "the engine cannot run" — we do not know, and saying either
  // way would be a claim nothing measured. Same rule the KPI tiles follow with "—".
  if (error) {
    return (
      <p className="bos-center-note helm-mono" role="status">
        engine readiness unavailable — runtime not reachable
        <button type="button" className="bos-center-retry helm-mono" onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  }

  if (!readiness) return null; // first read in flight — no placeholder claim either way

  const tone = standingTone(readiness.standing);
  const color = toneColor(tone);
  const showProbe = probeWouldHelp(readiness);

  // READY: one quiet line. The operator does not need a banner to tell them nothing is
  // wrong, but they DO need to know which account their work will run on, and whether the
  // dollar ceiling on it is real.
  if (readiness.ready) {
    return (
      <div
        className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl px-3.5 py-2 text-[12px]"
        style={{
          color: tok("muted"),
          backgroundColor: `color-mix(in oklch, ${color} 7%, transparent)`,
          border: `1px solid color-mix(in oklch, ${color} 24%, transparent)`,
        }}
        role="status"
      >
        <CheckCircle2 size={14} aria-hidden style={{ color }} />
        <span className="font-semibold" style={{ color }}>{standingLabel(readiness.standing)}</span>
        {readiness.account && (
          <>
            <span aria-hidden>·</span>
            <span>
              runs on <span className="font-mono">{readiness.account.label}</span>
              {readiness.account.model ? <> (<span className="font-mono">{readiness.account.model}</span>)</> : null}
            </span>
          </>
        )}
        <span aria-hidden>·</span>
        <span>{readiness.spendCap}</span>
      </div>
    );
  }

  // NOT READY: the refusal verbatim. `role="alert"` because the operator is about to queue
  // work that cannot run, and finding that out afterwards is the whole failure being fixed.
  return (
    <div
      className="flex flex-col gap-2 rounded-xl px-4 py-3"
      style={{
        backgroundColor: `color-mix(in oklch, ${color} 8%, transparent)`,
        border: `1px solid color-mix(in oklch, ${color} 28%, transparent)`,
      }}
      role="alert"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={15} aria-hidden style={{ color, marginTop: 2 }} />
        <div className="min-w-0">
          <p className="text-[13px] font-bold" style={{ color }}>
            {standingLabel(readiness.standing)}
          </p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed" style={{ color: tok("muted") }}>
            {readiness.refusal ?? readiness.explanation}
          </p>
          {/* With no account there is nothing to say about a spend cap that the refusal
              has not already said. Repeating "no account is active" under itself is noise,
              and noise is how an operator learns to skip the line that matters. */}
          {readiness.standing !== "none" && (
            <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: tok("muted") }}>
              {readiness.spendCap}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-[25px]">
        <button
          type="button"
          onClick={onOpenAccounts}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold outline-none transition-colors focus-visible:ring-2"
          style={{ color: tok("accent-cyan"), border: `1px solid color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` }}
        >
          <KeyRound size={13} aria-hidden />
          {showProbe ? "Open Accounts to run a capability probe" : "Open Accounts"}
        </button>
      </div>
    </div>
  );
}

// Phase 2 — can the swarm act at all? Phase G (ADR G-2): the mockup's `.alert` vocabulary.
// READY is the mockup's quiet `.alert.okline` line; NOT READY is the full `.alert` with the
// refusal verbatim and the control that fixes it. A transport failure is its own line:
// "we could not ask" is never rendered as "the engine cannot run".

import { standingLabel, probeWouldHelp, type EngineReadiness } from "../../lib/engineReadiness";

export interface EngineReadinessBannerProps {
  /** `null` while the first read is in flight; absence is a state. */
  readiness: EngineReadiness | null;
  /** True when the runtime could not be reached. Distinct from "not ready". */
  error: boolean;
  /** Take the operator to Accounts, where the probe control lives. */
  onOpenAccounts: () => void;
  onRetry: () => void;
}

export function EngineReadinessBanner({ readiness, error, onOpenAccounts, onRetry }: EngineReadinessBannerProps) {
  if (error) {
    return (
      <div className="alert okline" role="status">
        <span className="dot muted" style={{ marginTop: 7 }} />
        <div>
          {"Engine readiness unavailable. "}
          <span className="sub">runtime not reachable · <button type="button" className="linkish" onClick={onRetry}>Retry</button></span>
        </div>
      </div>
    );
  }
  if (!readiness) return null; // first read in flight — no claim either way

  if (readiness.ready) {
    const runsOn = readiness.account
      ? `${readiness.account.label}${readiness.account.model ? ` · ${readiness.account.model}` : ""}`
      : readiness.explanation;
    return (
      <div className="alert okline" role="status">
        <span className="dot sage" style={{ marginTop: 7 }} />
        <div>
          {"Engines ready. "}
          <span className="sub">{`${runsOn} · ${readiness.spendCap}`}</span>
        </div>
      </div>
    );
  }

  // NOT READY: `role="alert"` because the operator is about to queue work that cannot run.
  return (
    <div className="alert" role="alert">
      <span className="dot bad" style={{ marginTop: 7 }} />
      <div>
        <b>{standingLabel(readiness.standing)}</b>
        <p style={{ margin: "4px 0 10px" }}>{readiness.refusal ?? readiness.explanation}</p>
        {readiness.standing !== "none" && <p className="sub" style={{ margin: "0 0 10px" }}>{readiness.spendCap}</p>}
        <button type="button" className="btn btn-ghost" onClick={onOpenAccounts}>
          {probeWouldHelp(readiness) ? "Open Accounts to run a capability probe" : "Open Accounts"}
        </button>
      </div>
    </div>
  );
}

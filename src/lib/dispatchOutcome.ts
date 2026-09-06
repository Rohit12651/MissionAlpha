// BOSS dispatch — turning what ACTUALLY happened into what the operator is told.
//
// WHY THIS IS ITS OWN MODULE. `fireDispatch` reported success from the audit-bus call and
// never read the response of the call that actually starts the agent:
//
//     ).catch(() => {}),   // a 400 RESOLVES — this catches network errors only
//     setDispatchMsg(`dispatched ${ok}/${dirs.length} · ${taskDirs.length} agent(s) running`)
//
// With RUNTIME_TOOLS unset, every run POST answered 400 "runtime not in write mode" and the
// console still said "2 agent(s) running". The operator waited for agent chatter that could
// never arrive, and nothing anywhere named the cause.
//
// Two rules, and they are the whole point:
//   1. NEVER claim a run started unless its own response said so.
//   2. When a run failed, SAY WHY. A failure with no reason just relocates the mystery.

/** Result of one POST /runtime/<agent>/run. `ok` mirrors the HTTP response, not the fetch. */
export interface RunOutcome {
  target: string;
  ok: boolean;
  error?: string;
}

export interface DispatchSummary {
  message: string;
  tone: "ok" | "warn" | "error";
}

/** Keep the banner readable; a 50-agent failure must not become a wall of text. */
const MAX_MESSAGE = 300;
const MAX_REASON = 120;

const int = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);

/**
 * summarizeDispatch({ recorded, total, runs }) → what to show the operator.
 *
 * `recorded` = directives that reached the audit bus.
 * `runs`     = one entry per TASK directive, carrying the run endpoint's real verdict.
 *
 * Malformed input degrades to a non-committal message — it must never fall through to
 * "everything is running", which is the failure mode being fixed.
 */
export function summarizeDispatch(input: {
  recorded: number;
  total: number;
  runs: RunOutcome[];
} | null | undefined): DispatchSummary {
  const recorded = int(input?.recorded);
  const total = int(input?.total);
  const runs = Array.isArray(input?.runs) ? input.runs.filter((r) => r && typeof r.target === "string") : [];

  const started = runs.filter((r) => r.ok);
  const failed = runs.filter((r) => !r.ok);

  const parts: string[] = [`dispatched ${recorded}/${total}`];

  if (runs.length) {
    // Only ever states a count the run responses actually support.
    parts.push(started.length ? `${started.length}/${runs.length} agent(s) running` : `none started (0/${runs.length})`);
  }

  if (failed.length) {
    // One reason is enough to act on; naming every one turns a banner into a log.
    const first = failed[0];
    const reason = String(first.error || "no reason given").slice(0, MAX_REASON);
    parts.push(
      failed.length === 1
        ? `${first.target} failed: ${reason}`
        : `${failed.length} failed (${first.target}: ${reason})`,
    );
  }

  const tone: DispatchSummary["tone"] =
    recorded < total || (runs.length > 0 && started.length === 0)
      ? "error"
      : failed.length
        ? "warn"
        : "ok";

  return { message: parts.join(" · ").slice(0, MAX_MESSAGE), tone };
}

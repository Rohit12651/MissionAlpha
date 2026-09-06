// ADR-028 — Retry / Self-Heal. Failure detection → bounded retry → rollback
// (worktree discard, done by the engine) → operator escalation.
//
// INVARIANT (sr-security): retry never weakens a guard, never re-attempts a guard
// rejection (apply-rejected is terminal), never double-applies (engine idempotency),
// never reverts the live repo (rollback = worktree discard only). Escalation reuses
// the sanitized bus path (same metachar strip as reportBack server.mjs L530).

// Map a concrete detection signal (ADR-024 §5) → { kind, retryable }.
export function classify(sig) {
  switch (sig.type) {
    case "spawn-error":
      return { kind: "spawn", retryable: true };
    case "timeout":
      return { kind: "timeout", retryable: true };
    case "crash":
      return { kind: "crash", retryable: true };
    case "diffed":
      return (sig.changes && sig.changes.length === 0)
        ? { kind: "empty-diff", retryable: true }
        : { kind: "none", retryable: false };
    case "close":
      if ((!sig.acc || !sig.acc.trim()) && (!sig.changes || sig.changes.length === 0)) {
        return { kind: "no-output", retryable: true };
      }
      return { kind: "none", retryable: false };
    case "apply": {
      const results = sig.applyResults || [];
      const anyOk = results.some((r) => r.ok);
      if (results.length && !anyOk) return { kind: "apply-rejected", retryable: false }; // guard fired — NON-retryable
      return { kind: "none", retryable: false };
    }
    default:
      return { kind: "unknown", retryable: false };
  }
}

// D4 — A DISPATCH THAT REFUSED IS NOT A DISPATCH THAT FAILED.
//
// `engineDispatch` returns { error, code } for a refusal it has already decided: a
// post-edit hook veto, an account that measured as not tool-capable, a backend with no
// model to spawn. runStep used to fold every one of those into `spawn` — the TRANSIENT
// bucket — so the engine retried a settled answer up to maxAttempts. Measured on this
// install: one goal, three tasks, three live model turns and three 120s container runs,
// three identical verdicts, and an operator told "spawn" about a quality gate.
//
// A code this table does not know stays `spawn`/retryable, byte-identical to the old
// behaviour: an unrecognised failure is a reason to retry, not a reason to give up.
const TERMINAL_DISPATCH_CODES = Object.freeze({
  HOOK_VETO: "gate-veto",             // a registered hook stopped the run on evidence
  NOT_TOOL_CAPABLE: "not-capable",    // the active account cannot drive the write-loop
  BACKEND_UNAVAILABLE: "backend",     // this runtime has no model to spawn
  CHAT_ONLY: "chat-only",             // the provider is not a swarm engine
});

/** Map a dispatch result `code` to { kind, retryable }. Never throws. */
export function classifyDispatchError(code) {
  const kind = TERMINAL_DISPATCH_CODES[String(code ?? "")];
  return kind ? { kind, retryable: false } : { kind: "spawn", retryable: true };
}

// Exponential backoff with jitter: min(base * 2^(attempt-1), max) + jitter.
export function backoffMs(attempt, opts = {}) {
  const base = opts.base ?? 2000;
  const max = opts.max ?? 60000;
  const jitter = opts.jitter || (() => Math.floor(Math.random() * 1000));
  const raw = base * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(raw, max) + jitter();
}

// Build the two bus spawn-arg arrays for escalation, sanitized identically to
// reportBack (server.mjs L530): strip control chars + bus-format metachars.
export function escalationArgs(agentId, kind, attempts, reason = "") {
  // eslint-disable-next-line no-control-regex
  const clean = (s) => String(s).replace(/[\x00-\x1f"'`|$=]/g, " ").replace(/\s+/g, " ").trim();
  const safeId = String(agentId).replace(/[^a-z0-9_-]/gi, "");
  const why = clean(`task failed: ${kind} after ${attempts} tries`).slice(0, 120);
  const reasonClean = clean(reason).slice(0, 140);
  return {
    heartbeat: [safeId, "BLOCKED", why, "-", "", "needs BOSS"],
    sync: [safeId, "BOSS", "task-failed", "-", `failed: ${kind} — ${reasonClean}`],
  };
}

// Should a failure be retried? retryable kind AND attempts budget remaining.
//
// S4 — `test-failed` (the unit-test gate rejected the diff) is retryable: it is the RED of
// the red→green loop. It shares the same bounded `maxAttempts` budget as the other
// transient kinds (a spent budget → failTerminal → the story blocks). `apply-rejected`
// stays terminal — a fired guard is never re-attempted.
export function shouldRetry(kind, attempts, maxAttempts) {
  const retryable = ["spawn", "timeout", "crash", "empty-diff", "no-output", "test-failed"].includes(kind);
  return retryable && attempts < maxAttempts;
}

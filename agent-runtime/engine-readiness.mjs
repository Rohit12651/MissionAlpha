// PHASE 2 TASK 2.1 — READINESS, AS A MEASUREMENT THE UI CAN RENDER.
//
// The gap: the Command Center offered its controls unconditionally. If the active account
// had never demonstrated tool support, the operator queued work and got a task that failed
// deep in the loop, for a reason no surface had told them. A control that cannot succeed
// must not be rendered as if it could — and the only way to obey that is for the UI to be
// able to ask the same question the dispatcher asks.
//
// ONE PREDICATE, TWO CALLERS. `engineDispatch` builds its refusal from this function and
// `GET /runtime/engine/readiness` serves it. Two independent copies of "can the engine run"
// would drift, and the surface would eventually promise what the loop refuses. That drift
// is exactly how `capability: "chat_only"` — five literals describing our adapter, written
// onto the provider — survived as long as it did.
//
// PRINCIPLE 0: no branch here reads a brand to decide capability. `providerType === "claude"`
// appears only to name which TRANSPORT is used (the Claude CLI vs an HTTP endpoint), which
// is what decides whether the BACKEND env var is even relevant.

import { capabilityExplanation, probeIsStale, spendCapExplanation, resolveCapability } from "./providers/capability-probe.mjs";

/** The five honest states. `runs` is the only one the engine dispatches on. */
export const STANDING = Object.freeze({
  RUNS: "runs",              // measured tool-capable (or Claude via the CLI)
  CANNOT: "cannot",          // measured, and the model did not call the tool
  UNMEASURED: "unmeasured",  // never probed, or probed against a different model
  NONE: "none",              // no active account at all
  BACKEND: "backend",        // the account could run, but its transport is disabled here
  DETERMINISTIC: "deterministic", // the soak harness authors the diff; no model is consulted
});

/** Backends that can actually spawn the Claude CLI write-loop (server.mjs). */
const CLAUDE_BACKENDS = new Set(["cli", "api"]);

const publicView = (a) => (a
  ? { id: a.id, label: a.label, providerType: a.providerType, model: a.model ?? null, authMethod: a.authMethod ?? null }
  : null);

/**
 * Can the autonomous engine dispatch right now, and if not, WHY — in the operator's terms.
 *
 * `refusal` is the sentence the dispatcher itself returns, so what the Command Center shows
 * and what a failed task says are the same words rather than two paraphrases.
 */
export function engineReadiness(account, { backend = "cli", deterministic = false } = {}) {
  const probePath = account?.id ? `/runtime/accounts/${encodeURIComponent(account.id)}/probe` : null;
  const spendCap = spendCapExplanation(account);

  // The soak harness substitutes only the diff-authoring step; everything after it is the
  // real loop. Reporting "cannot dispatch" while it demonstrably dispatches would make this
  // surface a liar about the very thing it exists to describe.
  if (deterministic) {
    return {
      ready: true,
      standing: STANDING.DETERMINISTIC,
      capability: "swarm",
      account: publicView(account),
      explanation: "the deterministic soak spawner is active — the engine authors a canned diff instead of calling a model",
      spendCap,
      refusal: null,
      probePath,
    };
  }

  if (!account) {
    return {
      ready: false,
      standing: STANDING.NONE,
      capability: "chat_only",
      account: null,
      explanation: "no account is active",
      spendCap,
      refusal: "no active account cannot run the autonomous engine: no account is active. Add an account and set it active.",
      probePath: null,
    };
  }

  const who = `active account '${account.label}' (${account.providerType})`;
  const capability = resolveCapability(account);

  if (capability !== "swarm") {
    const stale = probeIsStale(account);
    const why = capabilityExplanation(account);
    const fix = stale ? " Run a tool-capability probe on this account to let the engine use it." : "";
    return {
      ready: false,
      // "never measured" and "measured, and it cannot" are DIFFERENT answers. Collapsing
      // them into one would repeat the table's mistake at a smaller scale: reporting an
      // unasked question as a settled no.
      standing: stale ? STANDING.UNMEASURED : STANDING.CANNOT,
      capability,
      account: publicView(account),
      explanation: why,
      spendCap,
      refusal: `${who} cannot run the autonomous engine: ${why}.${fix}`,
      probePath,
    };
  }

  // Capability is settled. The remaining question is TRANSPORT, and it applies only to the
  // Claude CLI path — an OpenAI-compatible account drives its own HTTP endpoint and never
  // reads BACKEND, so gating it on that env var would refuse a provider for a reason that
  // has nothing to do with it.
  if (account.providerType === "claude" && !CLAUDE_BACKENDS.has(backend)) {
    return {
      ready: false,
      standing: STANDING.BACKEND,
      capability,
      account: publicView(account),
      explanation: `this runtime is started with RUNTIME_BACKEND=${backend}, which has no model to spawn`,
      spendCap,
      refusal: `${who} cannot run the autonomous engine: the write-loop requires a real Claude backend (cli subscription or api key), but this runtime is running backend=${backend}.`,
      probePath,
    };
  }

  return {
    ready: true,
    standing: STANDING.RUNS,
    capability,
    account: publicView(account),
    explanation: capabilityExplanation(account),
    spendCap,
    refusal: null,
    probePath,
  };
}

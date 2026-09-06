// PHASE 2 TASK 2.1 — the typed client over GET /runtime/engine/readiness.
//
// Why this exists: the Command Center offered its controls unconditionally. If the active
// account had never demonstrated tool support, the operator queued work and got a task that
// failed deep in the loop, for a reason no surface had shown them. A control that cannot
// succeed must not be rendered as if it could.
//
// The runtime computes this with the SAME predicate `engineDispatch` refuses with
// (agent-runtime/engine-readiness.mjs), so `refusal` here is the exact sentence a failed
// task would carry — not a paraphrase that can drift away from it.
//
// PRINCIPLE 0: nothing in this file maps a provider BRAND to a capability. The five
// hardcoded `capability` literals that did are deleted; standing is a measurement.

import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

export const READINESS_PATH = "/runtime/engine/readiness";

/** The five honest states. `runs` is the only one the engine dispatches on. */
export type EngineStandingState =
  | "runs"          // measured tool-capable (or Claude, which drives the CLI)
  | "cannot"        // measured, and the model did not call the tool it was given
  | "unmeasured"    // never probed, or probed against a different model
  | "none"          // no active account at all
  | "backend"       // the account could run, but its transport is disabled here
  | "deterministic"; // the soak harness authors the diff; no model is consulted

export interface ReadinessAccount {
  id: string;
  label: string;
  providerType: string;
  model: string | null;
  authMethod: string | null;
}

export interface EngineReadiness {
  ready: boolean;
  standing: EngineStandingState;
  capability: "swarm" | "chat_only";
  account: ReadinessAccount | null;
  /** Why the engine is (or is not) able to dispatch, in the operator's terms. */
  explanation: string;
  /** Whether the dollar ceiling on an autonomous turn can actually bind this account. */
  spendCap: string;
  /** The exact sentence a dispatch would fail with. `null` when ready. */
  refusal: string | null;
  /** POST here to measure tool support. `null` when there is no account to probe. */
  probePath: string | null;
}

/** Short label for the readiness chip. Never names a brand as the remedy. */
export function standingLabel(s: EngineStandingState): string {
  switch (s) {
    case "runs": return "Engine ready";
    case "cannot": return "Engine cannot dispatch";
    case "unmeasured": return "Tool support not measured";
    case "none": return "No active account";
    case "backend": return "Backend unavailable";
    case "deterministic": return "Deterministic soak";
  }
}

/**
 * Which tone the chip takes. `unmeasured` is deliberately WARN, not ERROR: nobody has
 * asked the model yet, and rendering an unasked question as a failure is the same
 * unearned claim the deleted capability table made.
 */
export function standingTone(s: EngineStandingState): "ok" | "warn" | "error" {
  if (s === "runs" || s === "deterministic") return "ok";
  if (s === "unmeasured") return "warn";
  return "error";
}

/** True when running a probe is the actual next step — drives whether we offer the control. */
export const probeWouldHelp = (r: EngineReadiness): boolean =>
  Boolean(r.probePath) && (r.standing === "unmeasured" || r.standing === "cannot");

export async function getEngineReadiness(): Promise<EngineReadiness> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(READINESS_PATH), {
    cache: "no-store",
    headers: { "x-runtime-token": token },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as EngineReadiness;
}

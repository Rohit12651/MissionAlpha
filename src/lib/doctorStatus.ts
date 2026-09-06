// Phase 1 / R4 (UI) — the typed client over GET /runtime/doctor, plus what the cockpit
// should actually SHOW from a report.
//
// `doctor.status` has been on the wire since session 3 and nothing rendered it. The comment
// in useRuntimeEvents claimed the readiness banner reacted to it; it did not. A health
// report nobody can see is the same silence the doctor was built to end — the runtime knew
// `gh` was missing and encryption was off, and no surface ever said so.
//
// THE SSE FRAME IS A SIGNAL, NOT A PAYLOAD. `doctor.status` carries {status, fails, warns}
// only — deliberately, because a health report enumerates this install's weaknesses and the
// event bus is a broadcast. The frame means "re-read the gated route", exactly like
// `memory.changed`.

import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

export const DOCTOR_PATH = "/runtime/doctor";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** A copy-pasteable remedy where one exists. Absent is normal, not an error. */
  fix?: string;
}

export interface DoctorReport {
  status: CheckStatus;
  checks: DoctorCheck[];
  summary: { ok?: number; warn?: number; fail?: number };
}

/**
 * Check ids the READINESS BANNER already renders, in its own words, directly above this
 * strip. Surfacing them again stacks the same sentence twice — and the banner's own header
 * spells out why that is harmful: "noise is how an operator learns to skip the line that
 * matters."
 *
 * The set is CLOSED and its members are the runtime's real check ids (agent-runtime/
 * doctor.mjs), read off that file rather than assumed. A doctor check added later is
 * surfaced by default; hiding one is a deliberate edit here.
 */
export const READINESS_OWNED: ReadonlySet<string> = new Set(["account"]);

const isCheck = (c: unknown): c is DoctorCheck =>
  !!c && typeof c === "object" && typeof (c as DoctorCheck).id === "string";

/** Every failing or warning check the cockpit should show, worst first, readiness excluded. */
export function visibleFailures(report: DoctorReport | null | undefined): DoctorCheck[] {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const live = checks.filter(
    (c) => isCheck(c) && (c.status === "fail" || c.status === "warn") && !READINESS_OWNED.has(c.id),
  );
  // Stable within severity: a `fail` always outranks a `warn`, and inside one severity the
  // runtime's own ordering wins — it lists checks cheapest-to-verify first, which is the
  // order an operator would work them in.
  return [...live].sort((a, b) => (a.status === b.status ? 0 : a.status === "fail" ? -1 : 1));
}

/** The single check worth putting in front of the operator, or null when all is well. */
export function worstCheck(report: DoctorReport | null | undefined): DoctorCheck | null {
  return visibleFailures(report)[0] ?? null;
}

/**
 * Tone follows what is VISIBLE, not the report's headline `status`.
 *
 * A report can be `fail` purely because of the account check — which the banner above is
 * already showing. Painting the strip red for a fault it is not displaying would be a
 * colour with nothing behind it.
 */
export function doctorTone(report: DoctorReport | null | undefined): "ok" | "warn" | "error" {
  const worst = worstCheck(report);
  if (!worst) return "ok";
  return worst.status === "fail" ? "error" : "warn";
}

export async function getDoctorReport(): Promise<DoctorReport> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(DOCTOR_PATH), {
    cache: "no-store",
    headers: { "x-runtime-token": token },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as DoctorReport;
}

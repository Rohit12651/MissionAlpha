// Phase 3 (UI) — R9 metaharness self-grade, made visible.
//
// The runtime has graded its own configuration since session 7 and emitted
// `selfgrade.changed` since session 8. Nothing rendered either, so a posture score could
// not influence a decision — which makes it decoration, not a control.
//
// TWO PAYLOADS, TWO JOBS, and they are NOT the same shape (verified against the runtime,
// not assumed):
//   · `GET /runtime/selfgrade` returns the FULL grade — findings[] with text and fixes,
//     checked[] as an array of section names. This is what the tile reads.
//   · the `selfgrade.changed` FRAME carries {score, grade, findings: <count>, worst,
//     checked: <count>, delta, appeared[], cleared[]}. `delta` exists ONLY here — the
//     route has no notion of "since when" — so the arrow uses the server's own diffGrades
//     number rather than a client-side re-derivation that could disagree with it.
//
// A DELTA IS NEVER SHOWN WITHOUT ITS CAUSE. This is the module's own hard-won rule: it
// once scored a healthy install 46/D on a finding it had invented, and the lesson recorded
// was that a grader which cries wolf trains the operator to ignore the number. A bare
// arrow is exactly that — movement with no reason to believe it.

import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

export const SELFGRADE_PATH = "/runtime/selfgrade";

/** Every section grade() can check. Read off metaharness.mjs `checked.push` sites. */
export const GRADED_SECTIONS = [
  "policy", "quality", "stationPerms", "mcpGrants", "hooks", "encryption",
] as const;

export interface GradeFinding {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  detail: string;
  fix: string;
}

/** The route payload — `checked` is an ARRAY here (a COUNT on the SSE frame). */
export interface SelfGrade {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  findings: GradeFinding[];
  checked: string[];
  worst: GradeFinding["severity"] | null;
}

/** The `selfgrade.changed` frame — the only place a delta exists. */
export interface SelfGradeFrame {
  delta: number;
  appeared: string[];
  cleared: string[];
}

export type GradeTone = "ok" | "warn" | "error" | "none";

const TONE: Record<string, GradeTone> = { A: "ok", B: "ok", C: "warn", D: "error", F: "error" };

/** Tone from the LETTER, not the raw score — the letter is the graded judgement. */
export function gradeTone(g: SelfGrade | null | undefined): GradeTone {
  const letter = g && typeof g === "object" ? (g as SelfGrade).grade : null;
  return (typeof letter === "string" && TONE[letter]) || "none";
}

export interface DeltaBadge {
  direction: "up" | "down";
  tone: "ok" | "error";
  /** The finding id that moved the number. Never null — see the header. */
  cause: string;
  amount: number;
}

/**
 * deltaDirection(frame) → DeltaBadge | null
 *
 * `null` whenever the score did not move, OR when it moved with nothing named. A score
 * that changed for no stated reason is not information the operator can act on, and
 * rendering it anyway is how a number becomes wallpaper.
 */
export function deltaDirection(frame: SelfGradeFrame | null | undefined): DeltaBadge | null {
  if (!frame || typeof frame !== "object") return null;
  const delta = Number((frame as SelfGradeFrame).delta);
  if (!Number.isFinite(delta) || delta === 0) return null;

  const appeared = Array.isArray(frame.appeared) ? frame.appeared : [];
  const cleared = Array.isArray(frame.cleared) ? frame.cleared : [];
  // A drop is explained by what APPEARED; a recovery by what CLEARED.
  const cause = delta < 0 ? appeared[0] : cleared[0];
  if (typeof cause !== "string" || !cause) return null;

  return {
    direction: delta < 0 ? "down" : "up",
    tone: delta < 0 ? "error" : "ok",
    cause,
    amount: Math.abs(delta),
  };
}

/** The single finding worth showing. grade() already sorts by severity weight. */
export function topFinding(g: SelfGrade | null | undefined): GradeFinding | null {
  const f = g && Array.isArray((g as SelfGrade).findings) ? g.findings : [];
  return f[0] ?? null;
}

/**
 * partialCoverage(grade) → a sentence, or null when everything was graded.
 *
 * An UNGRADED section must never read as a clean one. On this install `factory/policy.json`
 * is empty, so `policy` is not graded — and the report says so rather than counting the
 * ungraded section as passing. That distinction is the difference between "we checked and
 * it is fine" and "we did not check".
 */
export function partialCoverage(g: SelfGrade | null | undefined): string | null {
  const checked = g && Array.isArray((g as SelfGrade).checked) ? g.checked : null;
  if (!checked || checked.length >= GRADED_SECTIONS.length) return null;
  const missing = GRADED_SECTIONS.filter((s) => !checked.includes(s));
  return `${checked.length} of ${GRADED_SECTIONS.length} sections graded — ${missing.join(", ")} not checked`;
}

export async function getSelfGrade(): Promise<SelfGrade> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(SELFGRADE_PATH), {
    cache: "no-store",
    headers: { "x-runtime-token": token },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as SelfGrade;
}

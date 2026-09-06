// Phase 3 (UI) — R9 self-grade, in the cockpit.
//
// The runtime grades its own configuration — band policy, deny-list floor, quality-gate
// allow-list, station perms, MCP grants, hook state, encryption — and has done since
// session 7. The number reached no surface, so it could not change a decision.
//
// DESIGN — this is a POSTURE tile, not a KPI:
//   · The score is secondary to the FINDING. A "96" tells the operator nothing they can
//     act on; "band policy allows medium auto-approve" does. So the finding gets the
//     sentence and the score gets the corner.
//   · A delta is rendered ONLY beside its cause (selfGrade.ts deltaDirection). This module
//     once scored a healthy install 46/D on a finding it had invented; the lesson written
//     down was that a grader which cries wolf teaches the operator to ignore it. A bare
//     arrow is movement with no reason to believe it.
//   · PARTIAL COVERAGE IS STATED. An ungraded section must never read as a passing one.
//   · No motion. A score that animates on every poll is a distraction, and the frame only
//     fires when the number actually moved.

import { ShieldCheck, ShieldAlert, ArrowDownRight, ArrowUpRight } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import {
  gradeTone,
  deltaDirection,
  topFinding,
  partialCoverage,
  type SelfGrade,
  type SelfGradeFrame,
} from "../../lib/selfGrade";

export interface SelfGradeTileProps {
  /** `null` while the first read is in flight, or when the runtime was unreachable. */
  grade: SelfGrade | null;
  /** The last `selfgrade.changed` frame — the ONLY place a delta exists. */
  lastFrame: SelfGradeFrame | null;
}

const toneColor = (t: ReturnType<typeof gradeTone>): string =>
  t === "error" ? tok("stale-red") : t === "warn" ? tok("blocked-amber") : tok("done-green");

export function SelfGradeTile({ grade, lastFrame }: SelfGradeTileProps) {
  // A tile that cannot read its number renders nothing. Showing "—/F" would be a claim
  // about the install made out of a failed fetch.
  if (!grade || typeof grade.score !== "number") return null;

  const tone = gradeTone(grade);
  const color = toneColor(tone);
  const finding = topFinding(grade);
  const delta = deltaDirection(lastFrame);
  const partial = partialCoverage(grade);
  const Icon = tone === "ok" ? ShieldCheck : ShieldAlert;
  const DeltaIcon = delta?.direction === "down" ? ArrowDownRight : ArrowUpRight;

  return (
    <section
      className="flex flex-col gap-1.5 rounded-xl px-4 py-3"
      style={{
        backgroundColor: `color-mix(in oklch, ${color} 6%, transparent)`,
        border: `1px solid color-mix(in oklch, ${color} 22%, transparent)`,
      }}
      aria-label="Configuration self-grade"
    >
      <header className="flex items-center gap-2">
        <Icon size={14} aria-hidden style={{ color, flexShrink: 0 }} />
        <span className="helm-eyebrow" style={{ color: tok("muted") }}>
          Config posture
        </span>
        <span className="helm-mono ml-auto font-bold" style={{ color, fontSize: "var(--type-4)" }}>
          {grade.score}
          <span style={{ color: tok("muted"), fontSize: "var(--type-1)" }}> / {grade.grade}</span>
        </span>
        {delta && (
          <span
            className="helm-mono flex items-center gap-0.5"
            style={{
              color: delta.tone === "error" ? tok("stale-red") : tok("done-green"),
              fontSize: "var(--type-1)",
            }}
            title={`${delta.direction === "down" ? "Dropped" : "Recovered"} ${delta.amount} — ${delta.cause}`}
          >
            <DeltaIcon size={12} aria-hidden />
            {delta.amount}
          </span>
        )}
      </header>

      {/* The finding is the actionable half. A score with no named cause is a number. */}
      {finding ? (
        <p className="leading-relaxed" style={{ color: tok("muted"), fontSize: "var(--type-2)" }}>
          {/* VISUAL-VERIFIED FIX: --c-text flips with [data-theme] while the helm-skinned
              cockpit around this tile does not, so the severity word vanished in light mode.
              The tone colour is both theme-stable here AND semantically the right choice —
              severity is precisely the thing the tone encodes. */}
          <span className="font-semibold" style={{ color }}>
            {finding.severity}
          </span>
          {" · "}
          {finding.detail}
          {grade.findings.length > 1 && (
            <span> · {grade.findings.length - 1} more</span>
          )}
        </p>
      ) : (
        <p style={{ color: tok("muted"), fontSize: "var(--type-2)" }}>No configuration findings.</p>
      )}

      {/* An ungraded section is NOT a passing one, and the difference is the whole reason
          `checked[]` exists. */}
      {partial && (
        <p className="helm-mono" style={{ color: tok("blocked-amber"), fontSize: "var(--type-1)" }}>
          {partial}
        </p>
      )}
    </section>
  );
}

// Phase 3 / R9 — the configuration self-grade. APP-ONLY surface (the mockup has no
// counterpart), kept per Phase G D-5 and restyled in the mockup's tokens: a `.card` with
// the mockup's card header, chip tones and `.sub` type. `data-app-only` lets the parity
// diff leave it out — and say that it did.

import { gradeTone, deltaDirection, topFinding, partialCoverage, type SelfGrade, type SelfGradeFrame } from "../../lib/selfGrade";

export interface SelfGradeTileProps {
  /** `null` while the first read is in flight, or when the runtime was unreachable. */
  grade: SelfGrade | null;
  /** The last `selfgrade.changed` frame — the ONLY place a delta exists. */
  lastFrame: SelfGradeFrame | null;
}

const CHIP = { ok: "ok", warn: "warn", error: "bad", none: "" } as const;

export function SelfGradeTile({ grade, lastFrame }: SelfGradeTileProps) {
  if (!grade || typeof grade.score !== "number") return null;
  const tone = CHIP[gradeTone(grade)];
  const finding = topFinding(grade);
  const delta = deltaDirection(lastFrame);
  const partial = partialCoverage(grade);
  return (
    <section className="card" data-app-only="self-grade" aria-label="Configuration self-grade" style={{ padding: "12px 16px" }}>
      <div className="card-h" style={{ margin: "0 0 8px" }}>
        <span className="sub">Config posture</span>
        <span className="pills">
          <span className={`chip ${tone}`}>{`${grade.score} / ${grade.grade}`}</span>
          {delta && (
            <span className={`chip ${delta.tone === "error" ? "bad" : "ok"}`} title={`${delta.direction === "down" ? "Dropped" : "Recovered"} ${delta.amount}: ${delta.cause}`}>
              {`${delta.direction === "down" ? "↓" : "↑"} ${delta.amount}`}
            </span>
          )}
        </span>
      </div>
      <p style={{ margin: 0 }}>
        {finding ? (
          <>
            <b>{finding.severity}</b>
            {` · ${finding.detail}${grade.findings.length > 1 ? ` · ${grade.findings.length - 1} more` : ""}`}
          </>
        ) : "No configuration findings."}
      </p>
      {partial && <p className="sub" style={{ margin: "6px 0 0" }}>{partial}</p>}
    </section>
  );
}

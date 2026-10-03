// Phase 1 / R4 — the doctor report. Phase G (ADR G-2): the mockup's Doctor card — one
// `.chip` per check (its label; the dot carries the status), then the config-posture chips. A failing check that carries a fix also gets
// the mockup's `.alert` above the card, because a remedy must be readable, not a tooltip.
//
// D-7: every chip is a real field or an honest "—". The mockup's "stations on Bypass" and
// "seats" have no runtime source yet; they read "—" and are logged as Phase G gaps.

import { READINESS_OWNED, worstCheck, type DoctorReport } from "../../lib/doctorStatus";
import type { EngineReadiness } from "../../lib/engineReadiness";

export interface DoctorStripProps {
  /** `null` while the first read is in flight — absence is a state, not a failure. */
  report: DoctorReport | null;
  /** Readiness carries the spend cap (a posture item). */
  readiness: EngineReadiness | null;
  /** Re-read the gated routes. */
  onRecheck: () => void;
}

const TONE = { ok: "ok", warn: "warn", fail: "bad" } as const;

export function DoctorStrip({ report, readiness, onRecheck }: DoctorStripProps) {
  const checks = (report?.checks ?? []).filter((c) => !READINESS_OWNED.has(c.id));
  const worst = worstCheck(report);
  const spendCap = readiness && readiness.standing !== "none" ? readiness.spendCap : "—";
  return (
    <>
      {worst?.status === "fail" && (
        <div className="alert" role="alert">
          <span className="dot bad" style={{ marginTop: 7 }} />
          <div>
            <b>{worst.label}</b>
            <p style={{ margin: "4px 0 6px" }}>{worst.detail}</p>
            {worst.fix && <p className="mono" style={{ margin: "0 0 8px", userSelect: "all" }}>{worst.fix}</p>}
            <button type="button" className="linkish" onClick={onRecheck}>Re-check</button>
          </div>
        </div>
      )}
      <div className="card" style={{ padding: "12px 16px" }}>
        <div className="card-h" style={{ margin: "0 0 8px" }}>
          <span className="sub">Doctor</span>
          <span className="sub">config posture</span>
        </div>
        <div className="pills">
          {report === null && <span className="chip">{"doctor —"}</span>}
          {checks.map((c) => (
            <span key={c.id} className={`chip ${TONE[c.status]}`} title={c.fix ? `${c.detail}\n${c.fix}` : c.detail}>
              <span className={`dot ${TONE[c.status]}`} />
              {c.label}
            </span>
          ))}
          <span className="chip">{`spend cap ${spendCap}`}</span>
          <span className="chip">{"— stations on Bypass"}</span>
          <span className="chip">{"seats —"}</span>
        </div>
      </div>
    </>
  );
}

import type { RiskBand } from "../../lib/inboxClient";

/*
  P6 / ADR-053 — the risk band chip. Phase G (ADR G-2): the mockup's riskChip() — a `.chip`
  toned bad / warn / ok reading "high risk" / "medium risk" / "low risk". A band the runtime
  left null (legacy rows) reads "unrated", untoned: an absent rating is never shown as safe.
*/
const TONE: Record<Exclude<RiskBand, null>, string> = { high: "bad", medium: "warn", low: "ok" };

export function RiskChip({ band }: { band: RiskBand }) {
  return band ? <span className={`chip ${TONE[band]}`}>{`${band} risk`}</span> : <span className="chip">unrated</span>;
}

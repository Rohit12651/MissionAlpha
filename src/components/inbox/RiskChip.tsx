import { riskLabel, riskTone, type RiskBand } from "../../lib/inboxClient";

/*
  P6 / ADR-053 — the risk band chip. band → colour is the single mapping owned by
  inboxClient (riskTone/riskLabel), reused verbatim so the card, the review pane and
  the auto strip can never drift: low green · medium amber · high red · unrated grey.
*/
export function RiskChip({ band, className }: { band: RiskBand; className?: string }) {
  return (
    <span className={`helm-chip${className ? ` ${className}` : ""}`} data-tone={riskTone(band)}>
      {riskLabel(band)}
    </span>
  );
}

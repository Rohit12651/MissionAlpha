// B5 — the Command Center's four numbers. Phase G (ADR G-2, D-7): the mockup's `.tiles`
// (label over a display number) and the mockup's four questions, each bound to the real
// field that answers it:
//   Active jobs    — GET /runtime/jobs, status neither shipped nor blocked
//   Need you       — every pending inbox item (the same count the title bar shows)
//   Shipped today  — GET /runtime/bos/kpis window=1d → jobsShipped
//   Spend today    — GET /runtime/spend window=24h → usd (null = no price, never $0)
// A value the runtime could not give is "—", never a fabricated zero.

export interface StatTilesProps {
  activeJobs: number | null;
  needYou: number | null;
  shippedToday: number | null;
  /** Metered spend in USD; `null` when unknown or unpriced. */
  spendToday: number | null;
}

const num = (n: number | null): string => (n === null ? "—" : String(n));

export function StatTiles({ activeJobs, needYou, shippedToday, spendToday }: StatTilesProps) {
  const tiles: [string, string][] = [
    ["Active jobs", num(activeJobs)],
    ["Need you", num(needYou)],
    ["Shipped today", num(shippedToday)],
    ["Spend today", spendToday === null ? "—" : `$${spendToday.toFixed(2)}`],
  ];
  return (
    <div className="tiles">
      {tiles.map(([label, value]) => (
        <div key={label} className="tile">
          <span className="label">{label}</span>
          <p className="big num">{value}</p>
        </div>
      ))}
    </div>
  );
}

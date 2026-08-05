// B5 — the Command Center's four KPI tiles. Presentational: the container owns the
// fetch, this renders the numbers.
//
// EVERY NUMBER IS REAL OR AN ADMITTED GAP (hallmark gate 56):
//   • Decisions today / Deliveries approved are CROSS-VENTURE (deliveries have no
//     venture column in v1) — labelled "all ventures" so the number is never mistaken
//     for a per-venture figure.
//   • Records written is venture-scoped — its note names the current scope.
//   • S0 removed the "Open follow-ups" tile with the leads store that fed it. A tile with
//     no store behind it is not rendered at all — it is never kept alive on a faked 0.
//   • No sparkline and no delta are drawn: v1 computes no prior-window series, and a
//     fabricated trend is exactly the dishonesty this phase refuses (hasTrend gates it).
//
// dataviz treatment: calm, no gridlines, tabular-nums, one number per tile.

import { tile, type Kpis } from "../../lib/kpiClient";

export interface StatTilesProps {
  kpis: Kpis | null;
  /** True when the KPI fetch failed — every tile shows "—" plus one faint note. */
  error: boolean;
  /** The current scope (null = all ventures) — names the Records-written tile's note. */
  ventureLabel: string;
}

interface TileDef {
  key: string;
  label: string;
  value: string;
  note: string;
  title: string;
}

function tilesFrom(kpis: Kpis | null, error: boolean, ventureLabel: string): TileDef[] {
  // A failed fetch renders "—" everywhere — never a zero the BOSS would read as truth.
  const dash = (): string => "—";
  const v = (n: number): string => (error || !kpis ? dash() : tile(n));
  return [
    {
      key: "decisions",
      label: "Decisions today",
      value: v(kpis?.decisionsToday ?? 0),
      note: "all ventures",
      title: "Approvals, rejections and change requests you made in the last 24h (across every venture)",
    },
    {
      key: "records",
      label: "Records written",
      value: v(kpis?.recordsWritten ?? 0),
      note: ventureLabel,
      title: "Knowledge-vault records written in the last 24h, in the current scope",
    },
    {
      key: "approved",
      label: "Deliveries approved",
      value: v(kpis?.deliveriesApproved ?? 0),
      note: "all ventures",
      title: "Deliveries you approved in the last 24h (across every venture)",
    },
  ];
}

export function StatTiles({ kpis, error, ventureLabel }: StatTilesProps) {
  const tiles = tilesFrom(kpis, error, ventureLabel);
  return (
    <div className="bos-center-tiles" role="list" aria-label="Key numbers">
      {tiles.map((t) => (
        <div key={t.key} className="bos-center-tile" role="listitem" title={t.title}>
          <span className="bos-center-tile-value helm-mono">{t.value}</span>
          <span className="bos-center-tile-label helm-mono">{t.label}</span>
          <span className="bos-center-tile-note helm-mono">{t.note}</span>
        </div>
      ))}
    </div>
  );
}

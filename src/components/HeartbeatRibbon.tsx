import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { Heartbeat } from "../data/types";
import { tok } from "../lib/agentMeta";

// Inline EKG-style sparkline of swarm heartbeat cadence. Pure SVG + framer —
// no chart lib (CEO deferred recharts to Phase 4). Buckets the recent window
// of beats into a fixed column count and plots beats-per-bucket as a smoothed
// line with a faint area fill + a soft-pulsing "now" point. Emil motion: only
// the newest point animates (transform/opacity), reduced-motion → static.

const W = 140;
const H = 32;
const BUCKETS = 24;
const WINDOW = 40; // last N valid beats considered
const EASE = [0.22, 1, 0.36, 1] as const;

function validBeats(beats: Heartbeat[]): number[] {
  // Parse timestamps, drop the junk "#" sentinel row, keep ascending order.
  return beats
    .map((b) => Date.parse(b.ts))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
}

export function HeartbeatRibbon({ heartbeats }: { heartbeats: Heartbeat[] }) {
  const reduce = useReducedMotion();

  const { path, area, last } = useMemo(() => {
    const ts = validBeats(heartbeats).slice(-WINDOW);
    // Bucket by even time span so cadence (beats over time) shows as amplitude.
    const counts = new Array<number>(BUCKETS).fill(0);
    if (ts.length >= 2) {
      const min = ts[0];
      const max = ts[ts.length - 1];
      const span = Math.max(1, max - min);
      for (const t of ts) {
        const idx = Math.min(BUCKETS - 1, Math.floor(((t - min) / span) * BUCKETS));
        counts[idx] += 1;
      }
    } else if (ts.length === 1) {
      counts[BUCKETS - 1] = 1;
    }

    const peak = Math.max(1, ...counts);
    const pad = 3;
    const stepX = (W - pad * 2) / (BUCKETS - 1);
    const pts = counts.map((c, i) => {
      const x = pad + i * stepX;
      // amplitude inverted (SVG y grows downward); keep a 2px floor baseline.
      const y = H - pad - (c / peak) * (H - pad * 2);
      return [x, y] as const;
    });

    const line = pts
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
    const fill = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H - pad} L${pts[0][0].toFixed(1)},${H - pad} Z`;

    return { path: line, area: fill, last: pts[pts.length - 1] };
  }, [heartbeats]);

  const cyan = tok("accent-cyan");

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Swarm heartbeat cadence sparkline"
      className="overflow-visible"
    >
      <defs>
        <linearGradient id="hbrib-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={cyan} stopOpacity={0.22} />
          <stop offset="100%" stopColor={cyan} stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* faint baseline */}
      <line
        x1={3}
        y1={H - 3}
        x2={W - 3}
        y2={H - 3}
        stroke={tok("border")}
        strokeWidth={1}
        opacity={0.5}
      />

      <path d={area} fill="url(#hbrib-area)" />
      <path
        d={path}
        fill="none"
        stroke={cyan}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.92}
      />

      {/* the "now" point — soft pulse on the latest beat */}
      {reduce ? (
        <circle cx={last[0]} cy={last[1]} r={2} fill={cyan} />
      ) : (
        <>
          <motion.circle
            cx={last[0]}
            cy={last[1]}
            r={2}
            fill={cyan}
            initial={{ scale: 0.9, opacity: 1 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.2, ease: EASE }}
          />
          <motion.circle
            cx={last[0]}
            cy={last[1]}
            fill="none"
            stroke={cyan}
            strokeWidth={1}
            initial={{ r: 2, opacity: 0.6 }}
            animate={{ r: [2, 6], opacity: [0.6, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        </>
      )}
    </svg>
  );
}

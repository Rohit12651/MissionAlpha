import { tok } from "../lib/agentMeta";

/**
 * Circular countdown toward the next expected heartbeat. Depletes as the agent
 * approaches its TTL; goes full + red once overdue. Pure SVG, GPU-cheap, no
 * animation lib — the value updates each second via the parent's clock.
 */
export function TtlRing({
  ageSec,
  ttlSec,
  accent,
  overdue,
  size = 38,
  stroke = 3,
  children,
}: {
  ageSec: number | null;
  ttlSec: number;
  accent: string; // token name
  overdue: boolean;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const ratio = ageSec === null ? 0 : Math.min(1, ageSec / Math.max(1, ttlSec));
  // remaining arc (fills back up on a fresh beat, depletes as it ages)
  const dash = circ * (1 - ratio);
  const color = overdue ? tok("stale-red") : tok(accent);

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tok("border")}
          strokeWidth={stroke}
          opacity={0.5}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={dash}
          style={{
            transition: "stroke-dashoffset 0.6s cubic-bezier(0.22,1,0.36,1), stroke 0.3s ease",
            filter: overdue ? `drop-shadow(0 0 4px ${color})` : undefined,
          }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

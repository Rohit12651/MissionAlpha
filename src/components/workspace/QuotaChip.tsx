import { useEffect, useState } from "react";
import { tok } from "../../lib/agentMeta";
import { getQuota, type QuotaStatus } from "../../lib/quotaClient";

// Quota chip — the BRAKE next to the UsageMeter GAUGE. Shows the quota guard's
// window count; turns AMBER when paused (an agent hit its self-imposed call cap).
// Honest: `max` is operator-picked, NOT Anthropic's real subscription limit — the
// 429 backoff (server-side) handles the real limit. This chip is the runaway brake.
// Read-only poll of GET /runtime/quota. No $ anywhere (subscription = flat-rate).

const POLL_MS = 30_000;

export function QuotaChip() {
  const [q, setQ] = useState<QuotaStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await getQuota();
      if (alive) setQ(s);
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!q) return null;
  const accent = q.paused ? "blocked-amber" : "done-green";
  const ac = tok(accent);
  return (
    <div
      className="flex items-center gap-1.5 rounded-md px-2 py-1"
      style={{ backgroundColor: tok("panel-2"), border: `1px solid ${tok("border")}` }}
      title={`quota guard — ${q.count} calls in the last ${Math.round(q.windowMs / 3_600_000)}h · per-agent cap ${q.max}${q.paused ? " · PAUSED (agent at cap, retrying)" : ""}`}
      aria-label={`Quota guard: ${q.count} calls in window, cap ${q.max} per agent${q.paused ? ", paused" : ""}`}
    >
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ac }} aria-hidden />
      <span className="font-mono text-[10px] tabular-nums" style={{ color: tok("muted") }}>
        {q.count}/{q.max}
      </span>
      {q.paused && (
        <span className="font-mono text-[9px] uppercase" style={{ color: ac }}>
          paused
        </span>
      )}
    </div>
  );
}

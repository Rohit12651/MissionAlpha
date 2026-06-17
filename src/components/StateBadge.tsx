import { memo } from "react";
import { tok, stateLabel } from "../lib/agentMeta";

/** Small status pill — tinted by accent token, mono, uppercase. */
export const StateBadge = memo(function StateBadge({ state, accent }: { state: string; accent: string }) {
  const c = tok(accent);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide"
      style={{
        color: c,
        backgroundColor: `color-mix(in oklch, ${c} 14%, transparent)`,
        border: `1px solid color-mix(in oklch, ${c} 30%, transparent)`,
      }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: c, boxShadow: `0 0 6px ${c}` }}
        aria-hidden
      />
      {stateLabel(state)}
    </span>
  );
});

import { tok } from "../../lib/agentMeta";

// ADR-030 — Usage meter. Tokens + context-window %, modeled on Claude Code's
// `/context`. NO DOLLARS, EVER (subscription is flat-rate; a $ figure would be false).
// Compact header readout: a context% bar + in/out token counts + which tier ran.

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
  contextTokens: number;
  contextWindow: number;
  contextPct: number;
  tier: string;
  estimated: boolean;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function UsageMeter({ usage }: { usage: TurnUsage | null }) {
  if (!usage) return null;
  const pct = Math.round(usage.contextPct * 1000) / 10; // one decimal
  // bar color escalates with fill: green → amber → red as context fills
  const accent = usage.contextPct < 0.6 ? "done-green" : usage.contextPct < 0.85 ? "blocked-amber" : "stale-red";
  const ac = tok(accent);
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1"
      style={{ backgroundColor: tok("panel-2"), border: `1px solid ${tok("border")}` }}
      title={`context ${usage.contextTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${pct}%) · in ${usage.inputTokens.toLocaleString()} · out ${usage.outputTokens.toLocaleString()}${usage.cacheReadTokens ? ` · cache-read ${usage.cacheReadTokens.toLocaleString()}` : ""}${usage.thinkingTokens ? ` · thinking ${usage.thinkingTokens.toLocaleString()}` : ""}${usage.estimated ? " · estimated" : ""}`}
      aria-label={`Context window ${pct} percent used, ${usage.inputTokens} input and ${usage.outputTokens} output tokens, tier ${usage.tier}${usage.estimated ? ", estimated" : ""}`}
    >
      {/* context-window % bar */}
      <div className="flex items-center gap-1.5">
        <div className="h-1.5 w-14 overflow-hidden rounded-full" style={{ backgroundColor: tok("bg") }} aria-hidden>
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, usage.contextPct * 100)}%`, backgroundColor: ac, transition: "width 240ms ease-out" }} />
        </div>
        <span className="font-mono text-[10px] tabular-nums" style={{ color: ac }}>{pct}%</span>
      </div>
      {/* in/out tokens */}
      <span className="font-mono text-[10px] tabular-nums" style={{ color: tok("muted") }}>
        ↑{compact(usage.inputTokens)} ↓{compact(usage.outputTokens)}
      </span>
      {usage.estimated && (
        <span className="font-mono text-[9px] uppercase" style={{ color: tok("blocked-amber") }} title="estimated (~chars/4); backend returned no token count">~est</span>
      )}
    </div>
  );
}

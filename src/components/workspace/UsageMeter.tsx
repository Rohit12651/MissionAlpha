import { tok } from "../../lib/agentMeta";
import type { UsageTick } from "../../lib/useRuntimeEvents";

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

// Zero-state — shown on a fresh thread BEFORE the first turn returns usage. Keeps the
// context-window readout ALWAYS visible (like Claude Code's /context) so the operator
// never wonders how full the window is. 200k = the default context window we model.
const ZERO_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  thinkingTokens: 0,
  contextTokens: 0,
  contextWindow: 200_000,
  contextPct: 0,
  tier: "—",
  estimated: false,
};

export function UsageMeter({ usage }: { usage: TurnUsage | null }) {
  // Always render — fall back to the zero-state when no turn has completed yet.
  const u = usage ?? ZERO_USAGE;
  const pct = Math.round(u.contextPct * 1000) / 10; // one decimal
  // Phase G (ADR G-2): the mockup's `.meter` — a context-window ring and its percent.
  const RING = 50.3; // 2πr, r = 8
  return (
    <span
      className="meter"
      title={`context ${compact(u.contextTokens)} / ${compact(u.contextWindow)} tokens (${pct}%) · in ${u.inputTokens.toLocaleString()} · out ${u.outputTokens.toLocaleString()}${u.cacheReadTokens ? ` · cache-read ${u.cacheReadTokens.toLocaleString()}` : ""}${u.thinkingTokens ? ` · thinking ${u.thinkingTokens.toLocaleString()}` : ""}${u.estimated ? " · estimated" : ""}`}
      aria-label={`Context window ${pct} percent used, ${u.inputTokens} input and ${u.outputTokens} output tokens, tier ${u.tier}${u.estimated ? ", estimated" : ""}`}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="3" />
        <circle cx="10" cy="10" r="8" fill="none" stroke="var(--brand)" strokeWidth="3" strokeDasharray={RING}
          strokeDashoffset={RING * (1 - Math.min(1, u.contextPct))} transform="rotate(-90 10 10)" />
      </svg>
      <span>{`${Math.round(pct)}%`}</span>
    </span>
  );
}

// ── UsageOverview (P8) — the BUS-DRIVEN glanceable panel. ─────────────────────
// Fed by `usage.tick` (useRuntimeEvents → applyUsageTick), it shows tokens + context%
// per AGENT (aggregate) and per THREAD × tier, live, across the whole swarm — Claude-
// Code `/context` at a roster scale. Still NO DOLLARS: tokens + context% only.

const accentFor = (pct: number): string => tok(pct < 0.6 ? "done-green" : pct < 0.85 ? "blocked-amber" : "stale-red");

// A slim context-window fill bar (compositor-friendly width transition).
function CtxBar({ pct }: { pct: number }) {
  const ac = accentFor(pct);
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 overflow-hidden rounded-full" style={{ backgroundColor: tok("bg") }} aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct * 100)}%`, backgroundColor: ac, transition: "width 240ms ease-out" }} />
      </div>
      <span className="font-mono text-[10px] tabular-nums" style={{ color: ac }}>{(Math.round(pct * 1000) / 10).toFixed(1)}%</span>
    </div>
  );
}

interface AgentRoll {
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  contextPct: number; // the max window fill across the agent's threads
  estimated: boolean;
  threads: UsageTick[];
}

// Group ticks → per-agent rolls (with their threads), heaviest first.
export function rollUsage(ticks: UsageTick[]): AgentRoll[] {
  const byAgent = new Map<string, AgentRoll>();
  for (const t of ticks) {
    const r = byAgent.get(t.agentId) ?? { agentId: t.agentId, inputTokens: 0, outputTokens: 0, turns: 0, contextPct: 0, estimated: false, threads: [] };
    r.inputTokens += t.inputTokens;
    r.outputTokens += t.outputTokens;
    r.turns += t.turns;
    r.contextPct = Math.max(r.contextPct, t.contextPct);
    r.estimated = r.estimated || t.estimated;
    r.threads.push(t);
    byAgent.set(t.agentId, r);
  }
  const rolls = [...byAgent.values()];
  for (const r of rolls) r.threads.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  rolls.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  return rolls;
}

const EstBadge = () => (
  <span className="font-mono text-[9px] uppercase" style={{ color: tok("blocked-amber") }} title="estimated (~chars/4); backend returned no token count">~est</span>
);

// MUNDER-ADOPTION A3 — ground-truth totals mined from Claude Code's own JSONL
// transcripts (usage.transcript frames). Aggregate-only here; the per-session
// detail stays behind the gated GET /runtime/usage/transcripts.
export interface TranscriptTotals {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  /** which directory key answered: "current" | "legacy" | "none" */
  source: string;
}

export function UsageOverview({ ticks, transcripts }: { ticks: UsageTick[]; transcripts?: TranscriptTotals | null }) {
  const rolls = rollUsage(ticks);
  return (
    <section className="overflow-hidden rounded-panel border border-border bg-panel/60 backdrop-blur-md" aria-label="Usage — tokens and context, today">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Usage · today</span>
        <span className="ml-auto font-mono text-[10px] text-muted">tokens + context% · never $</span>
      </div>
      {/* MUNDER-ADOPTION A3 — the transcript ledger line. Rendered only once a frame has
          arrived; "source: transcripts" marks these as Claude Code's own numbers, not
          parsed from our child's stream. */}
      {transcripts && transcripts.sessions > 0 && (
        <div className="flex items-center gap-2 border-t border-border/30 px-4 py-2" aria-label={`Transcript ground truth: ${transcripts.sessions} sessions, ${transcripts.inputTokens} input and ${transcripts.outputTokens} output tokens`}>
          <span className="rounded px-1 py-0.5 font-mono text-[9px] uppercase" style={{ color: tok("done-green"), backgroundColor: `color-mix(in oklch, ${tok("done-green")} 12%, transparent)` }}>source: transcripts</span>
          <span className="font-mono text-[10px] text-muted">{transcripts.sessions} session{transcripts.sessions === 1 ? "" : "s"}</span>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-muted" title="cumulative tokens across local Claude Code transcripts (in → out)">
            {compact(transcripts.inputTokens)}→{compact(transcripts.outputTokens)}
          </span>
        </div>
      )}
      {rolls.length === 0 ? (
        <p className="px-4 pb-4 text-[12px] text-muted">No usage yet. A turn on any agent/thread appears here live.</p>
      ) : (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {rolls.map((r) => (
            <div key={r.agentId} className="rounded-md border border-border/50 bg-panel-2/40 px-2.5 py-2">
              {/* per-agent aggregate */}
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-[12px] text-text/90" title={r.agentId}>{r.agentId}</span>
                {r.estimated && <EstBadge />}
                <span className="ml-auto font-mono text-[10px] tabular-nums text-muted" title="cumulative tokens today (in → out)">
                  {compact(r.inputTokens)}→{compact(r.outputTokens)}
                </span>
                <CtxBar pct={r.contextPct} />
              </div>
              {/* per-thread × tier breakdown */}
              <ul className="mt-1.5 flex flex-col gap-1 border-t border-border/30 pt-1.5">
                {r.threads.map((t) => (
                  <li key={`${t.threadId}::${t.tier}`} className="flex items-center gap-2">
                    <span className="truncate font-mono text-[10px] text-muted" title={t.threadId}>{t.threadId}</span>
                    <span className="rounded px-1 py-0.5 font-mono text-[9px] uppercase" style={{ color: tok("accent-cyan"), backgroundColor: `color-mix(in oklch, ${tok("accent-cyan")} 12%, transparent)` }}>{t.tier}</span>
                    {t.estimated && <EstBadge />}
                    <span className="ml-auto font-mono text-[10px] tabular-nums text-muted">{compact(t.inputTokens)}→{compact(t.outputTokens)}</span>
                    <CtxBar pct={t.contextPct} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

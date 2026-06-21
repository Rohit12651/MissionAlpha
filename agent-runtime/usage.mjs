// ADR-030 — Usage tracking. PURE token/context math. NO DOLLARS, EVER — the cli
// `result` event carries `total_cost_usd` but it is NEVER read here; subscription is
// flat-rate so a $ figure would be false. This module only ever produces token counts
// + a context-window %. Modeled on Claude Code's `/context`.

const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

// Normalize a cli `result.usage` object into a per-turn usage + context snapshot.
export function usageFromResult(u = {}, tier, contextWindow) {
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheCreation = u.cache_creation_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const thinking = u.output_tokens_details?.thinking_tokens || 0;
  const contextTokens = input + cacheRead + cacheCreation;
  return {
    inputTokens: input, outputTokens: output, cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead, thinkingTokens: thinking, contextTokens,
    contextWindow, contextPct: clamp01(contextTokens / contextWindow),
    tier, estimated: false,
  };
}

// Estimate (~chars/4) when a backend returns no usage (mock). Clearly flagged est.
export function estimateUsage(promptChars, replyChars, tier, contextWindow) {
  const input = Math.round((promptChars || 0) / 4);
  const output = Math.round((replyChars || 0) / 4);
  const contextTokens = input;
  return {
    inputTokens: input, outputTokens: output, cacheCreationTokens: 0, cacheReadTokens: 0,
    thinkingTokens: 0, contextTokens, contextWindow,
    contextPct: clamp01(contextTokens / contextWindow), tier, estimated: true,
  };
}

// Accumulate a turn into a lifetime-of-thread rollup (survives message trimming).
// Pure: returns the next rollup; the caller owns storage.
export function rollupUsage(prev, turn) {
  const r = prev
    ? { ...prev }
    : {
        totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0, totalThinkingTokens: 0, turns: 0,
        lastContextTokens: 0, lastContextPct: 0, lastTier: null, estimated: false,
      };
  r.totalInputTokens += turn.inputTokens;
  r.totalOutputTokens += turn.outputTokens;
  r.totalCacheCreationTokens += turn.cacheCreationTokens;
  r.totalCacheReadTokens += turn.cacheReadTokens;
  r.totalThinkingTokens += turn.thinkingTokens;
  r.turns += 1;
  r.lastContextTokens = turn.contextTokens;
  r.lastContextPct = turn.contextPct;
  r.lastTier = turn.tier;
  r.estimated = turn.estimated;
  return r;
}

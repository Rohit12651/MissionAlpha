// ADR-030 — Usage tracking. PURE token/context math. NO DOLLARS IN THIS MODULE — the cli
// `result` event carries `total_cost_usd` but it is NEVER read here. This module only
// ever produces token counts + a context-window %. Modeled on Claude Code's `/context`.
//
// PHASE 7 AMENDMENT (2026-08-11) — WHY THIS RULE NARROWED, AND WHY IT STILL HOLDS HERE.
//
// This header used to read "NO DOLLARS, EVER — subscription is flat-rate so a $ figure
// would be false." That reasoning was correct, and it was correct because of a PREMISE:
// every run went through a Claude Code subscription. The multi-provider work (Phase 1)
// broke that premise — api_key accounts (OpenRouter, custom endpoints) bill per token,
// so for those accounts a cost is a real measurement rather than a fiction.
//
// The rule is therefore now scoped, not repealed:
//   * SUBSCRIPTION runs still have no dollar figure. Ever. `included`, never a number.
//   * API-KEY runs may carry a REPORTED cost, and only a reported one — spend is never
//     inferred from token counts we have no price for.
//   * The two can never be summed into one total.
//
// That logic lives in `spend.mjs`, which owns the exception in full. This module stays
// token-only so there is exactly ONE place a dollar figure can be produced.
//
// This comment is load-bearing: a stale comment contradicting the code is how this
// project's worst error happened. If the premise changes again, change this text with it.

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

// UTC calendar day ('YYYY-MM-DD') for an epoch-ms instant — the accumulation bucket.
export function utcDay(ms) {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().slice(0, 10);
}
// The UTC day-portion of an ISO/epoch value, or null when it doesn't parse — used to
// clamp an export range onto the per-day `usage` rows without throwing on junk input.
function dayOf(v) {
  if (v == null || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
const int = (x) => (Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0);
const safeStr = (s, cap = 80) => String(s ?? "").slice(0, cap);

// ADR-030 — persisted usage accumulation + emit-on-persist `usage.tick`. Tokens +
// context% ONLY, NEVER a dollar figure. Takes the SHARED better-sqlite3 handle (the
// same DB the deliveries/events tables live in) + the event bus's emit + a clock.
//
// `record()` is the ONE write point: it folds a turn into the (agentId,threadId,tier,
// UTC-day) row and, in the SAME call, emits `usage.tick` on the bus (emit-on-persist —
// no dual path, no watcher). It runs OFF the token hot-path (callers invoke it after a
// turn settles), so it never slows the streaming SSE.
export function createUsageStore(deps = {}) {
  const db = deps.db;
  if (!db || typeof db.prepare !== "function") throw new Error("createUsageStore: db handle required");
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();

  // UPSERT — first turn of the bucket inserts (turns=1); every later turn adds the token
  // counters, bumps turns, and overwrites the last-context snapshot + estimated flag
  // (last-turn-wins, so the meter shows the CURRENT window fill).
  const upsert = db.prepare(`
    INSERT INTO usage(agentId, threadId, tier, day, inputTokens, outputTokens, cacheReadTokens,
                      cacheCreationTokens, thinkingTokens, turns, lastContextTokens, lastContextPct,
                      lastContextWindow, estimated, updatedAt)
    VALUES(@agentId, @threadId, @tier, @day, @inputTokens, @outputTokens, @cacheReadTokens,
           @cacheCreationTokens, @thinkingTokens, 1, @lastContextTokens, @lastContextPct,
           @lastContextWindow, @estimated, @updatedAt)
    ON CONFLICT(agentId, threadId, tier, day) DO UPDATE SET
      inputTokens         = inputTokens         + excluded.inputTokens,
      outputTokens        = outputTokens        + excluded.outputTokens,
      cacheReadTokens     = cacheReadTokens     + excluded.cacheReadTokens,
      cacheCreationTokens = cacheCreationTokens + excluded.cacheCreationTokens,
      thinkingTokens      = thinkingTokens      + excluded.thinkingTokens,
      turns               = turns + 1,
      lastContextTokens   = excluded.lastContextTokens,
      lastContextPct      = excluded.lastContextPct,
      lastContextWindow   = excluded.lastContextWindow,
      estimated           = excluded.estimated,
      updatedAt           = excluded.updatedAt
  `);
  const selRow = db.prepare("SELECT * FROM usage WHERE agentId=? AND threadId=? AND tier=? AND day=?");

  // Fold one turn (the output of usageFromResult / estimateUsage) into its day bucket,
  // then emit. `threadId` defaults to agentId (a chat thread is its agent); an autonomous
  // engine run passes the taskId so the per-agent view aggregates across its tasks.
  function record({ agentId, threadId, tier, turn } = {}) {
    if (!turn) return null;
    const aid = safeStr(agentId) || "unknown";
    const tid = safeStr(threadId ?? agentId) || aid;
    const t = safeStr(turn.tier || tier || "sonnet", 24);
    const day = utcDay(now());
    const row = {
      agentId: aid, threadId: tid, tier: t, day,
      inputTokens: int(turn.inputTokens), outputTokens: int(turn.outputTokens),
      cacheReadTokens: int(turn.cacheReadTokens), cacheCreationTokens: int(turn.cacheCreationTokens),
      thinkingTokens: int(turn.thinkingTokens), lastContextTokens: int(turn.contextTokens),
      lastContextPct: Math.min(1, Math.max(0, Number(turn.contextPct) || 0)),
      lastContextWindow: int(turn.contextWindow), estimated: turn.estimated ? 1 : 0,
      updatedAt: new Date(now()).toISOString(),
    };
    upsert.run(row);
    const acc = selRow.get(aid, tid, t, day) || row;
    // usage.tick — tokens + context% ONLY. Day-cumulative in/out + the latest window
    // fill (contextPct). NO cost/USD/$ field on this frame, ever: the bus is fanned out
    // to every connected client and a cost here would be attached to runs that have no
    // price. Phase 7 puts metered spend in spend.mjs, scoped to api_key accounts, and
    // deliberately did NOT widen this frame to carry it.
    const tick = {
      agentId: aid, threadId: tid, tier: t, day,
      inputTokens: acc.inputTokens, outputTokens: acc.outputTokens, turns: acc.turns,
      contextTokens: acc.lastContextTokens, contextWindow: acc.lastContextWindow,
      contextPct: acc.lastContextPct, estimated: !!acc.estimated,
    };
    try { emit("usage.tick", tick); } catch { /* bus is observational — never break a turn */ }
    return acc;
  }

  // Per-thread latest + per-agent aggregate for TODAY (UTC) — a boot/refresh hydrate for
  // the meter; the live path is the bus. Returns { threads:[...], agents:[...] }.
  function snapshot() {
    const day = utcDay(now());
    const threads = db.prepare(
      "SELECT agentId, threadId, tier, inputTokens, outputTokens, turns, lastContextTokens AS contextTokens, " +
      "lastContextWindow AS contextWindow, lastContextPct AS contextPct, estimated FROM usage WHERE day=? ORDER BY updatedAt DESC",
    ).all(day).map((r) => ({ ...r, estimated: !!r.estimated }));
    const byAgent = new Map();
    for (const r of threads) {
      const a = byAgent.get(r.agentId) || { agentId: r.agentId, inputTokens: 0, outputTokens: 0, turns: 0, contextPct: 0, estimated: false };
      a.inputTokens += r.inputTokens; a.outputTokens += r.outputTokens; a.turns += r.turns;
      a.contextPct = Math.max(a.contextPct, r.contextPct); a.estimated = a.estimated || r.estimated;
      byAgent.set(r.agentId, a);
    }
    return { day, threads, agents: [...byAgent.values()] };
  }

  // Stream every usage row whose day falls in [from,to] (inclusive), oldest first — for
  // the audit export. better-sqlite3 `.iterate()` yields row-by-row (never buffers the
  // whole set). Junk/absent bounds fall back to open ranges (never a SQL error).
  function iterateRange({ from, to } = {}) {
    const lo = dayOf(from);
    const hi = dayOf(to);
    const where = [];
    const args = [];
    if (lo) { where.push("day >= ?"); args.push(lo); }
    if (hi) { where.push("day <= ?"); args.push(hi); }
    const sql = `SELECT * FROM usage ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY day ASC, agentId ASC, threadId ASC`;
    return db.prepare(sql).iterate(...args);
  }

  // Aggregate totals across [from,to] for the export summary — swarm-wide + per tier.
  function totalsRange({ from, to } = {}) {
    let totalIn = 0, totalOut = 0, totalTurns = 0;
    const byTier = {};
    for (const r of iterateRange({ from, to })) {
      totalIn += r.inputTokens; totalOut += r.outputTokens; totalTurns += r.turns;
      const t = byTier[r.tier] || { inputTokens: 0, outputTokens: 0, turns: 0 };
      t.inputTokens += r.inputTokens; t.outputTokens += r.outputTokens; t.turns += r.turns;
      byTier[r.tier] = t;
    }
    return { inputTokens: totalIn, outputTokens: totalOut, turns: totalTurns, byTier };
  }

  return { record, snapshot, iterateRange, totalsRange };
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

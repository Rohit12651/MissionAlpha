// PHASE 7 — metered spend, multi-provider.
//
// WHY THIS EXISTS, AND WHY usage.mjs's RULE WAS RIGHT BEFORE IT.
//
// `usage.mjs` opens with "NO DOLLARS, EVER — the cli `result` event carries
// `total_cost_usd` but it is NEVER read here; subscription is flat-rate so a $ figure
// would be false." That was CORRECT, and it stays correct for subscription runs. The
// multi-provider work changed the premise underneath it: API-key accounts (OpenRouter,
// custom endpoints) bill per token, so for those accounts a cost is a real measurement
// rather than a fiction. usage.mjs's header now records that this module owns the
// exception — a stale comment contradicting the code is how this project's worst error
// happened, so the two are kept in step deliberately.
//
// FOUR RULES, all of them about not lying:
//
//   1. ONLY `authMethod === "api_key"` meters. Anything else — subscription, unknown,
//      missing — is unmetered and fails closed. Guessing would invent money.
//   2. A subscription run records `null`, NEVER 0. Zero is a measurement ("this cost
//      nothing"); null is the truth ("this has no price"). A chart plots a zero.
//   3. A metered run with no REPORTED figure also records null. Spend is never inferred
//      from token counts we never received a price for — no rate cards, no modelling.
//   4. A blended subscription + API total is IMPOSSIBLE to build here. `rollupSpend`
//      sums metered turns only and reports the unmetered count separately, with a
//      `mixed` flag so the UI must caveat it. "$0.01 today" on a day that also ran 40
//      subscription turns is a false statement about the day.

/** What an unmetered account shows instead of a number. */
export const SUBSCRIPTION_LABEL = "included";

/**
 * True only for accounts that genuinely bill per token.
 * Fails closed on null / unknown / missing — see rule 1.
 */
export function isMeteredAccount(account) {
  return !!account && typeof account === "object" && account.authMethod === "api_key";
}

/** A finite, non-negative JS number, or null. Strings are NOT coerced. */
function realUsd(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Spend for ONE turn.
 *
 * @param {{account: object|null, reportedCostUsd?: unknown}} args
 * @returns {{usd: number|null, metered: boolean, reason: string|null}}
 */
export function spendForTurn({ account, reportedCostUsd } = {}) {
  if (!isMeteredAccount(account)) {
    // Rule 2. The figure the CLI reported is deliberately discarded: on a flat-rate plan
    // it describes a hypothetical API price, not money anyone spent.
    return { usd: null, metered: false, reason: "subscription" };
  }
  const usd = realUsd(reportedCostUsd);
  if (usd === null) return { usd: null, metered: true, reason: "no cost reported" };
  return { usd, metered: true, reason: null };
}

/**
 * Sum a batch. Metered turns only; unmetered ones are COUNTED, never valued.
 *
 * @param {Array<{usd?: unknown, metered?: unknown}>} entries
 */
export function rollupSpend(entries = []) {
  let usd = null;
  let meteredTurns = 0;
  let unmeteredTurns = 0;

  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== "object") continue;
    if (e.metered !== true) {
      // Anything not positively metered is unmetered. A malformed entry counts as a turn
      // we cannot price, which is exactly what it is.
      unmeteredTurns += 1;
      continue;
    }
    meteredTurns += 1;
    const v = realUsd(e.usd);
    if (v === null) continue; // metered but unpriced — counted, not valued
    usd = (usd ?? 0) + v;
  }

  return {
    usd,
    meteredTurns,
    unmeteredTurns,
    // Rule 4: the UI MUST caveat a mixed batch. Without this flag "$0.01" silently
    // describes only part of the work.
    mixed: meteredTurns > 0 && unmeteredTurns > 0,
  };
}

/**
 * The one string an operator reads. It is the last line of defence for rules 2 and 3.
 *
 * `metered` is read from the FIRST argument; the optional second argument exists only so
 * a caller that keeps the flag elsewhere can pass it without reshaping its data.
 */
export function spendLabel(entry = {}, extra = {}) {
  const metered = entry.metered === true || extra.metered === true;
  if (!metered) return SUBSCRIPTION_LABEL; // never a number, whatever `usd` says
  const usd = realUsd(entry.usd);
  if (usd === null) return "not reported";
  // Sub-dollar figures are the NORMAL case on token billing, so they keep four decimals.
  // Two decimals would round a real $0.0123 turn to "$0.01" and a real $0.0004 turn to
  // "$0.00", which reads as free. An exact zero still renders "$0.00" — that is a
  // measurement, and four decimals on it would only look like noise.
  if (usd > 0 && usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * The persisted store. ONE write point (`record`), one read point (`summary`).
 *
 * A subscription turn is never written at all — the table's CHECK makes an unmetered row
 * structurally impossible, so "no row" and "no price" cannot drift apart. A metered turn
 * whose provider reported nothing IS written, with `usd = NULL`: the turn happened and is
 * counted, it simply has no figure. That distinction is the whole point.
 */
export function createSpendStore(deps = {}) {
  const db = deps.db;
  if (!db || typeof db.prepare !== "function") throw new Error("createSpendStore: db handle required");
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();

  const ins = db.prepare(
    `INSERT INTO spend (agentId, threadId, tier, day, accountId, authMethod, usd, at)
     VALUES (?, ?, ?, ?, ?, 'api_key', ?, ?)`,
  );

  const str = (v, cap = 80) => String(v ?? "").slice(0, cap);

  /**
   * Fold one settled turn. Returns the spend record (also when it was NOT written, so a
   * caller can render `included` without a second lookup).
   */
  function record({ agentId, threadId, tier, account, reportedCostUsd } = {}) {
    const s = spendForTurn({ account, reportedCostUsd });
    if (!s.metered) return s; // subscription — nothing to persist, and nothing to show
    const ts = new Date(now()).toISOString();
    try {
      ins.run(
        str(agentId) || "unknown",
        str(threadId ?? agentId) || str(agentId) || "unknown",
        str(tier || "sonnet", 24),
        ts.slice(0, 10),
        str(account?.id, 64) || "unknown",
        s.usd,
        ts,
      );
    } catch {
      /* spend is observational — a write hiccup must never break or slow a turn */
    }
    return s;
  }

  /**
   * Totals over a window, per agent and overall. `usd` is null when nothing priced landed
   * — never 0 — and `mixed` is true whenever metered turns are missing a figure, so the
   * UI is forced to caveat rather than present a partial sum as the whole truth.
   */
  function summary({ windowMs = 7 * 24 * 3600_000, nowMs = now() } = {}) {
    const since = new Date(nowMs - Math.max(3600_000, Number(windowMs) || 0)).toISOString();
    const rows = db.prepare(
      `SELECT agentId, COUNT(*) AS turns,
              SUM(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
              SUM(usd) AS usd
         FROM spend WHERE at >= ? GROUP BY agentId ORDER BY agentId`,
    ).all(since);

    let total = null;
    let turns = 0;
    let unpriced = 0;
    const agents = rows.map((r) => {
      turns += r.turns;
      unpriced += r.unpriced;
      const usd = typeof r.usd === "number" && Number.isFinite(r.usd) ? r.usd : null;
      if (usd !== null) total = (total ?? 0) + usd;
      return { agentId: r.agentId, meteredTurns: r.turns, unpricedTurns: r.unpriced, usd };
    });

    return { since, usd: total, meteredTurns: turns, unpricedTurns: unpriced, mixed: unpriced > 0, agents };
  }

  return { record, summary };
}

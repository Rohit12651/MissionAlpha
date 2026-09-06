// #8 — THE PROVIDER CIRCUIT BREAKER. PURE over an injected clock.
//
// THE DEFECT, measured live on 2026-08-24: `stealth/ox-alpha` rate-limited essentially
// every call for the better part of an hour. Backoff existed everywhere and helped nowhere,
// because every backoff was PRIVATE: the story pipeline waited per (story, stage), the
// engine waited per task, chat waited not at all. Six blocked stories and a queue of build
// tasks each learned the same fact separately, paid an upstream 429 to learn it, and then
// all knocked again on their own schedule. That is a thundering herd against a shared
// limit, and the system had no place to write down "the endpoint is refusing everyone".
//
// This is that place. It is deliberately NOT `breaker.mjs`: that one watches an AGENT for
// runaway behaviour, this one watches an ENDPOINT for refusal. Different question,
// different key, different remedy.
//
// THE ONE JUDGEMENT — what may open it:
//   Only provider WEATHER: 429, 5xx, overloaded, a dropped socket. A 401, a missing model
//   id, a bad prompt are settled answers ABOUT US. Opening a cooldown on those would hide a
//   blocker the operator must clear behind a timer that looks like rate limiting, which is
//   the same "make a broken thing look busy" failure this program keeps removing. An
//   unrecognised error opens nothing either — silence is not evidence of weather.
//
// FAIL OPEN, ALWAYS. An unknown key, a malformed outcome, a missing record: callable. This
// is an optimisation over a shared resource, never a gate; a bug here must cost a wasted
// request, never a refused one.

/** Provider weather. Same closed-set discipline as stage-retry.mjs, and the same reason. */
const OVERLOAD = [
  /\b429\b/, /rate[- ]?limit/i, /too many requests/i,
  /\b50[0234]\b/, /bad gateway/i, /service unavailable/i, /gateway time-?out/i,
  /overloaded/i, /temporarily/i,
  /econnreset/i, /econnrefused/i, /eai_again/i, /socket hang up/i,
];

/** Settled answers about us. These BEAT the overload set — see the header. */
const SETTLED = [
  /\b401\b/, /\b403\b/, /unauthor/i, /forbidden/i,
  /authenticat/i, /oauth/i, /invalid api key/i, /api key/i,
  /no model id/i, /insufficient_quota/i, /\bbilling\b/i, /\bpayment\b/i,
];

const DEFAULT_BASE_MS = 30_000;
const DEFAULT_MAX_MS = 300_000;

/** Is this failure the ENDPOINT refusing, rather than an answer about us? Never throws. */
export function isProviderOverload(error) {
  const s = typeof error === "string" ? error : "";
  if (!s) return false;
  if (SETTLED.some((re) => re.test(s))) return false;
  return OVERLOAD.some((re) => re.test(s));
}

/**
 * createProviderBreaker({ now, cooldownBaseMs, cooldownMaxMs, log })
 *
 * `record(key, outcome)` after every provider call; `canCall(key)` before deciding to make
 * one. `snapshot()` is the operator-facing view and lists ONLY keys that are currently
 * refusing — a report of everything that is fine is a report nobody reads.
 */
export function createProviderBreaker(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const baseMs = Number(deps.cooldownBaseMs) > 0 ? Number(deps.cooldownBaseMs) : DEFAULT_BASE_MS;
  const maxMs = Number(deps.cooldownMaxMs) > 0 ? Number(deps.cooldownMaxMs) : DEFAULT_MAX_MS;

  // key → { consecutive, untilMs, reason }. Null-proto: an operator-keyed map must not
  // inherit anything from Object.prototype (repo convention).
  const cells = Object.create(null);

  const cooldownFor = (consecutive) => Math.min(baseMs * Math.pow(2, Math.max(0, consecutive - 1)), maxMs);

  /** Record one provider call outcome. Total: nothing here may throw into a dispatch path. */
  function record(key, outcome) {
    try {
      const k = typeof key === "string" && key ? key : null;
      if (!k || !outcome || typeof outcome !== "object") return;
      if (outcome.ok === true) {
        // The endpoint answered. Whatever it was doing, it has stopped.
        if (cells[k]) { delete cells[k]; log(`[provider-breaker] ${k} answered — cooldown cleared`); }
        return;
      }
      const err = typeof outcome.error === "string" ? outcome.error : "";
      if (!isProviderOverload(err)) return; // a settled answer is the operator's problem, not a timer's
      const cell = cells[k] || { consecutive: 0, untilMs: 0, reason: "" };
      cell.consecutive += 1;
      cell.reason = err.slice(0, 200);
      const ours = cooldownFor(cell.consecutive);
      // A provider that TELLS us how long to wait knows better than our guess — but it can
      // only ever lengthen the guard. A one-second Retry-After during a sustained refusal
      // would hand the herd straight back.
      const theirs = Number(outcome.retryAfterMs);
      const wait = Math.max(ours, Number.isFinite(theirs) && theirs > 0 ? theirs : 0);
      cell.untilMs = now() + wait;
      cells[k] = cell;
      log(`[provider-breaker] ${k} refusing (${cell.consecutive}x) — holding calls for ${Math.round(wait / 1000)}s: ${cell.reason}`);
    } catch { /* a breaker that throws into a dispatch is worse than no breaker */ }
  }

  /** May we call this provider right now? Unknown ⇒ yes, always. */
  function canCall(key) {
    const k = typeof key === "string" && key ? key : null;
    const cell = k ? cells[k] : null;
    if (!cell) return { ok: true, remainingMs: 0, reason: null };
    const remainingMs = cell.untilMs - now();
    if (remainingMs <= 0) return { ok: true, remainingMs: 0, reason: null };
    return { ok: false, remainingMs, reason: cell.reason || "the provider is refusing calls" };
  }

  /** Milliseconds a caller should wait before its next attempt on this key (0 = now). */
  const holdMs = (key) => Math.max(0, canCall(key).remainingMs || 0);

  /** Only the keys currently refusing. Metadata only — never a credential. */
  function snapshot() {
    const t = now();
    const out = [];
    for (const key of Object.keys(cells)) {
      const c = cells[key];
      const remainingMs = c.untilMs - t;
      if (remainingMs <= 0) continue;
      out.push({ key, consecutive: c.consecutive, remainingMs, reason: c.reason });
    }
    return out;
  }

  return { record, canCall, holdMs, snapshot };
}

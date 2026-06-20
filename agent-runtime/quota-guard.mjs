// ── Quota guard ──────────────────────────────────────────────────────────────
// Stop a runaway swarm from locking the BOSS out of his Claude subscription.
// File-based, single process, NO database. Two independent mechanisms:
//
//   1. PRE-GATE (runaway brake, POLITENESS).  Before spawning `claude`, count this
//      agent's calls in a sliding window; if count >= max, throw QuotaExceeded and
//      do NOT spawn. HONEST FRAMING: Anthropic's real subscription limit is NOT
//      readable from here, so `max` is a SELF-IMPOSED number the operator picks.
//      The pre-gate cannot "know" the real cap — it only stops obvious runaways.
//
//   2. 429 BACKOFF (CORRECTNESS).  When Claude actually returns a rate limit (429 /
//      "overloaded" / "rate limit"), wait exponentially and retry. THIS is the part
//      that respects the REAL limit, because it reacts to the true 429.
//
// Log: one JSONL line per call → ${RUNTIME_TOKEN_DIR}/quota-log.jsonl  {ts, agentId, ok}
// (ok=false when the call 429'd). appendFileSync is safe (single process). On each
// write we prune lines older than 2× the window so the file stays tiny. The log lives
// OUTSIDE the repo (same posture as the runtime token + factory-audit.log).
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// ── config (env-tunable, conservative defaults) ──
// Validate every knob: a non-finite or non-positive value (e.g. MA_QUOTA_MAX_RETRIES=NaN)
// would otherwise break the gate/retry math — NaN comparisons are always false, so
// `attempt >= NaN` never terminates the backoff loop, and `count >= NaN` disables the
// pre-gate. Fall back to the safe default instead. (sr-review M-1/L-2.)
function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
export const MA_QUOTA_MAX = positiveInt(process.env.MA_QUOTA_MAX, 200);             // calls / agent / window
export const MA_QUOTA_WINDOW_MS = positiveInt(process.env.MA_QUOTA_WINDOW_MS, 5 * 60 * 60 * 1000); // 5h
export const MA_QUOTA_BASE_DELAY_MS = positiveInt(process.env.MA_QUOTA_BASE_DELAY_MS, 800);
export const MA_QUOTA_MAX_RETRIES = positiveInt(process.env.MA_QUOTA_MAX_RETRIES, 4);

export class QuotaExceeded extends Error {
  constructor(agentId, count, max) {
    super(`quota: ${agentId} at ${count}/${max} calls in window — paused`);
    this.name = "QuotaExceeded";
    this.agentId = agentId;
    this.count = count;
    this.max = max;
  }
}

// Resolve the log path at call time so tests can redirect via MA_QUOTA_LOG.
function logFile() {
  if (process.env.MA_QUOTA_LOG) return process.env.MA_QUOTA_LOG;
  const dir = process.env.RUNTIME_TOKEN_DIR || join(tmpdir(), "missionalpha-runtime");
  return join(dir, "quota-log.jsonl");
}

function readLines() {
  const f = logFile();
  if (!existsSync(f)) return [];
  const out = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip a torn/partial line */ }
  }
  return out;
}

// Append one call record, then prune anything older than 2× the window.
export function logCall(agentId, ok, windowMs = MA_QUOTA_WINDOW_MS) {
  const f = logFile();
  mkdirSync(dirname(f), { recursive: true });
  const rec = { ts: Date.now(), agentId: String(agentId), ok: !!ok };
  appendFileSync(f, JSON.stringify(rec) + "\n");
  // prune on write — keep the file tiny (single short line per call)
  const cutoff = Date.now() - 2 * windowMs;
  const kept = readLines().filter((r) => typeof r.ts === "number" && r.ts >= cutoff);
  writeFileSync(f, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
}

export function countInWindow(agentId, windowMs = MA_QUOTA_WINDOW_MS) {
  const cutoff = Date.now() - windowMs;
  return readLines().filter((r) => r.agentId === agentId && r.ts >= cutoff).length;
}

export function countAllInWindow(windowMs = MA_QUOTA_WINDOW_MS) {
  const cutoff = Date.now() - windowMs;
  return readLines().filter((r) => r.ts >= cutoff).length;
}

// Highest single-agent count in the window — drives the "paused" signal: one agent
// at its cap means the brake is active even if the total looks modest.
function maxAgentCountInWindow(windowMs = MA_QUOTA_WINDOW_MS) {
  const cutoff = Date.now() - windowMs;
  const byAgent = new Map();
  for (const r of readLines()) {
    if (r.ts < cutoff) continue;
    byAgent.set(r.agentId, (byAgent.get(r.agentId) || 0) + 1);
  }
  let m = 0;
  for (const n of byAgent.values()) if (n > m) m = n;
  return m;
}

// Read-only status for the /quota endpoint + UI chip. count = total calls across
// the swarm in the window (account-wide pressure — what actually risks lockout).
export function quotaStatus({ max = MA_QUOTA_MAX, windowMs = MA_QUOTA_WINDOW_MS } = {}) {
  return {
    count: countAllInWindow(windowMs),
    max,
    windowMs,
    paused: maxAgentCountInWindow(windowMs) >= max,
  };
}

// Recognise a Claude rate-limit from an Error (SDK status) OR from CLI-surfaced text.
export function is429(err) {
  if (!err) return false;
  if (err.status === 429 || err.statusCode === 429) return true;
  const text = `${err.message || ""} ${err.subtype || ""}`.toLowerCase();
  return /\b429\b|rate.?limit|overloaded|too many requests/.test(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wrap one Claude call. Pre-gate (no spawn if over the self-imposed max), then run
// fn; log ok:true on success. On a real 429: log ok:false, exponential backoff, retry
// up to maxRetries, then rethrow. Non-429 errors rethrow immediately (not a quota
// signal — nothing logged).
export async function guardedSpawn(
  { agentId, max = MA_QUOTA_MAX, windowMs = MA_QUOTA_WINDOW_MS,
    baseDelayMs = MA_QUOTA_BASE_DELAY_MS, maxRetries = MA_QUOTA_MAX_RETRIES },
  fn,
) {
  const count = countInWindow(agentId, windowMs);
  if (count >= max) throw new QuotaExceeded(agentId, count, max); // brake: do NOT spawn

  let attempt = 0;
  for (;;) {
    try {
      const result = await fn();
      logCall(agentId, true, windowMs);
      return result;
    } catch (err) {
      if (!is429(err)) throw err;              // not a quota signal → bubble up, no log
      logCall(agentId, false, windowMs);       // record the 429
      if (attempt >= maxRetries) throw err;     // give up after N backoffs
      await sleep(baseDelayMs * 2 ** attempt);  // exponential backoff
      attempt++;
    }
  }
}

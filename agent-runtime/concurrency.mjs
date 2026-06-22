// agent-runtime/concurrency.mjs
// Pure concurrency math (no I/O, no os import — caller injects cpuCount) so it is
// unit-testable without booting server.mjs. F1: CPU-derived MAX_INFLIGHT default.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Resolve the concurrency cap for spawned `claude` children.
 * Env override (RUNTIME_MAX_INFLIGHT) always wins when it parses to an int >= 1.
 * Otherwise CPU-derived: clamp(cpuCount - 1, 2, 6).
 * NOTE: the ceiling (6) is RAM/subscription-governed, not CPU-governed — each slot
 * is a heavy `claude` CLI child (Node + possible Docker + a full LLM turn, ~300MB).
 * Do NOT raise it from CPU count; operators wanting more set RUNTIME_MAX_INFLIGHT.
 * @param {{ env?: Record<string,string|undefined>, cpuCount?: number }} opts
 * @returns {number}
 */
export function computeMaxInflight({ env = {}, cpuCount = 0 } = {}) {
  const raw = env.RUNTIME_MAX_INFLIGHT;
  if (raw != null && /^\d+$/.test(String(raw).trim())) {
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return clamp((Number(cpuCount) || 0) - 1, 2, 6);
}

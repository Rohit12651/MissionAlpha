// MUNDER-ADOPTION A2 — the breaker ladder's CLIENT model. One tiny module so App.tsx
// (the SSE fold) and StatusStrip (the chip) share one level order and one summary shape;
// MUST stay in step with agent-runtime/breaker.mjs BREAKER_LEVELS.
export const BREAKER_ORDER = {
  healthy: 0,
  steering: 1,
  constrained: 2,
  stopped: 3,
} as const;

export type BreakerLevel = keyof typeof BREAKER_ORDER;

export interface BreakerSummary {
  /** The worst level any agent currently holds. */
  worst: BreakerLevel;
  /** How many agents sit above healthy right now. */
  degraded: number;
}

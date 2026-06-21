// Model-tier client list (ADR-022). The runtime owns the authoritative tier→id
// allowlist; the UI only sends a tier KEY ("opus"|"sonnet"|"haiku"). Default =
// sonnet (balanced). Per-thread selection persists in localStorage.

export type ModelTier = "opus" | "sonnet" | "haiku";

export interface TierMeta {
  key: ModelTier;
  label: string;
  hint: string;
}

export const MODEL_TIERS: readonly TierMeta[] = [
  { key: "opus", label: "Opus", hint: "smartest" },
  { key: "sonnet", label: "Sonnet", hint: "balanced" },
  { key: "haiku", label: "Haiku", hint: "fastest" },
] as const;

export const DEFAULT_TIER: ModelTier = "sonnet";

const VALID = new Set<ModelTier>(["opus", "sonnet", "haiku"]);
export function isTier(v: unknown): v is ModelTier {
  return typeof v === "string" && VALID.has(v as ModelTier);
}

const KEY = (threadId: string) => `ma.model.${threadId}`;
// Mirror of settings.defaultTier (ADR-040) — keeps modelTiers decoupled from the
// settings store while still honoring the BOSS's chosen default for NEW threads.
const DEFAULT_TIER_MIRROR_KEY = "ma.default.tier";

/** The BOSS's configured default tier for new threads (settings ADR-040), else sonnet. */
export function configuredDefaultTier(): ModelTier {
  try {
    const v = localStorage.getItem(DEFAULT_TIER_MIRROR_KEY);
    if (isTier(v)) return v;
  } catch {
    /* no storage */
  }
  return DEFAULT_TIER;
}

/** Read a thread's persisted tier (falls back to the configured default). */
export function loadTier(threadId: string): ModelTier {
  try {
    const v = localStorage.getItem(KEY(threadId));
    if (isTier(v)) return v;
  } catch {
    /* no storage */
  }
  return configuredDefaultTier();
}

/** Persist a thread's chosen tier. */
export function saveTier(threadId: string, tier: ModelTier): void {
  try {
    localStorage.setItem(KEY(threadId), tier);
  } catch {
    /* ignore */
  }
}

export const tierLabel = (key: ModelTier): string =>
  MODEL_TIERS.find((t) => t.key === key)?.label ?? key;

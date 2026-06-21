// Per-agent Claude model (opus/sonnet/haiku), independent of the agent's ORG tier
// (principal/senior — that's agent.tier). Persisted per agent; the operator picks it
// in the inspect drawer, and it's surfaced read-only in the roster. Sent as {tier}
// when that agent next runs (the runtime /run already accepts it).

import { type ModelTier, isTier, configuredDefaultTier } from "./modelTiers";

const KEY = (id: string) => `ma.agent.model.${id}`;

/** The model chosen for an agent, else the BOSS's configured default (sonnet). */
export function loadAgentModel(id: string): ModelTier {
  try {
    const v = localStorage.getItem(KEY(id));
    if (isTier(v)) return v;
  } catch {
    /* no storage */
  }
  return configuredDefaultTier();
}

export function saveAgentModel(id: string, tier: ModelTier): void {
  try {
    localStorage.setItem(KEY(id), tier);
  } catch {
    /* ignore */
  }
}

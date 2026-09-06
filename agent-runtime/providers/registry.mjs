// Multi-Provider Credentials — the PROVIDER_TYPES preset catalog.
//
// This is a PICKER catalog, NOT a fixed account list. A user adds ANY NUMBER of
// accounts of ANY type; each preset describes how that type authenticates, whether it
// needs an OpenAI-compatible base URL, and whether a live key-probe is possible before
// persisting.
//
// ── PHASE 1 (autonomy program): THE CAPABILITY COLUMN IS GONE. ───────────────
//
// This file used to carry `capability: "swarm"` on claude and `capability: "chat_only"` on
// openai / minimax / zai / custom. Five hardcoded literals that never asked a model
// anything, and they were WRONG: GPT, Nemotron, MiniMax and Z.ai all call tools. The label
// described OUR ADAPTER — which yielded text deltas and could not run a tool loop — and it
// got written onto the PROVIDER, where it then refused those models autonomous work they
// were perfectly able to do.
//
// PRINCIPLE 0: the operator chooses the model; the app never chooses for them. A provider
// is swarm-capable if it can actually call a tool, which is PROVED BY PROBE
// (providers/capability-probe.mjs) and cached per account, never asserted by a table here.
//
// Deriving capability from a type is now impossible by construction rather than merely
// discouraged: there is no field to read and no `capabilityForType()` to call. Use
// `resolveCapability(account)` from capability-probe.mjs, which answers for a SPECIFIC
// account and its SPECIFIC model, and fails closed when nothing has been measured.
export const PROVIDER_TYPES = Object.freeze([
  { type: "claude",  label: "Claude",                     authMethods: ["subscription", "api_key"], needsBaseUrl: false, probeCapable: true  },
  { type: "openai",  label: "OpenAI",                     authMethods: ["api_key"],                  needsBaseUrl: false, probeCapable: true  },
  { type: "minimax", label: "MiniMax",                    authMethods: ["api_key"],                  needsBaseUrl: false, probeCapable: false },
  { type: "zai",     label: "Z.ai",                       authMethods: ["api_key"],                  needsBaseUrl: false, probeCapable: false },
  { type: "custom",  label: "Custom (OpenAI-compatible)", authMethods: ["api_key"],                  needsBaseUrl: true,  probeCapable: false },
  // Phase 13 — JIRA is NOT a model provider. It is in this catalog because this catalog is what
  // the Accounts page renders and what seals a secret per account, and a Jira site is exactly
  // that: a base URL plus a credential the operator owns and the agent must never read.
  // `probeCapable: false` because the capability probe asks a MODEL to call a tool, which is a
  // question a ticket tracker cannot be asked — and Principle 0 forbids asserting an answer.
  // The api_key is stored as `email:api_token`: that pairing IS how Atlassian API tokens
  // authenticate (Basic), and splitting it across two fields would invent a shape Jira has not.
  { type: "jira",    label: "Jira (Atlassian Cloud)",      authMethods: ["api_key"],                  needsBaseUrl: true,  probeCapable: false },
].map(Object.freeze));

const BY_TYPE = Object.freeze(Object.fromEntries(PROVIDER_TYPES.map((p) => [p.type, p])));

// hasOwnProperty (not `in`) so prototype keys (toString/constructor) can't resolve.
export function providerTypePreset(type) {
  return Object.prototype.hasOwnProperty.call(BY_TYPE, type) ? BY_TYPE[type] : null;
}

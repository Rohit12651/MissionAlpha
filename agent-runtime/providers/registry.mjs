// Multi-Provider Credentials — the PROVIDER_TYPES preset catalog.
//
// This is a PICKER catalog, NOT a fixed account list. A user adds ANY NUMBER of
// accounts of ANY type; each preset describes how that type authenticates, whether it
// can drive the autonomous swarm (capability), whether it needs an OpenAI-compatible
// base URL, and whether a live key-probe is possible before persisting.
//
// capability is DERIVED per type: claude → "swarm" (runs the engine), every other type
// → "chat_only" (stored for chat/future use; the engine only runs on Claude). Only
// claude/openai are probe-capable — minimax/zai/custom are store-and-ready.
export const PROVIDER_TYPES = Object.freeze([
  { type: "claude",  label: "Claude",                     authMethods: ["subscription", "api_key"], capability: "swarm",     needsBaseUrl: false, probeCapable: true  },
  { type: "openai",  label: "OpenAI",                     authMethods: ["api_key"],                  capability: "chat_only", needsBaseUrl: false, probeCapable: true  },
  { type: "minimax", label: "MiniMax",                    authMethods: ["api_key"],                  capability: "chat_only", needsBaseUrl: false, probeCapable: false },
  { type: "zai",     label: "Z.ai",                       authMethods: ["api_key"],                  capability: "chat_only", needsBaseUrl: false, probeCapable: false },
  { type: "custom",  label: "Custom (OpenAI-compatible)", authMethods: ["api_key"],                  capability: "chat_only", needsBaseUrl: true,  probeCapable: false },
].map(Object.freeze));

const BY_TYPE = Object.freeze(Object.fromEntries(PROVIDER_TYPES.map((p) => [p.type, p])));

// hasOwnProperty (not `in`) so prototype keys (toString/constructor) can't resolve.
export function providerTypePreset(type) {
  return Object.prototype.hasOwnProperty.call(BY_TYPE, type) ? BY_TYPE[type] : null;
}

// Derived capability for a provider type, or null for an unknown type.
export function capabilityForType(type) {
  const p = providerTypePreset(type);
  return p ? p.capability : null;
}

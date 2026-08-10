// Multi-Provider Credentials — the single, testable child-env builder.
//
// Lives in its own module (NOT server.mjs) because server.mjs opens a listener on
// import — a unit test must be able to exercise this pure function without booting
// the runtime. server.mjs imports buildChildEnv and calls it from BOTH spawn sites
// (engine write-loop + chat spawn).
//
// Contract: strip every secret-shaped var from the parent env (a tool/log inside the
// child can otherwise leak them), then re-inject ANTHROPIC_API_KEY ONLY when the
// active account is Claude in api_key mode. Only Claude runs the engine, so no other
// provider type ever gets a key injected here — non-claude accounts are stored, not
// injected (no engine path yet). Subscription/none → the key stays absent and the
// `claude` CLI falls back to ~/.claude subscription auth.
//
// Denylist is a SUBSTRING match (not suffix-anchored) so it also catches SECRET_KEY_BASE,
// AWS_ACCESS_KEY_ID, MYAPP_CREDENTIALS, GH_TOKEN, etc. A separate rule drops *_URL vars
// whose value embeds credentials (scheme "://" + "@"), e.g. DATABASE_URL / REDIS_URL.
const SECRET_SHAPED = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;

function isSecretShaped(name, value) {
  if (name === "ANTHROPIC_API_KEY") return true;
  if (SECRET_SHAPED.test(name)) return true;
  // Credentials-in-URL: userinfo before the host (scheme "://" then a "@").
  if (/_URL$/i.test(name) && typeof value === "string" && value.includes("://") && value.includes("@")) return true;
  return false;
}

export function buildChildEnv(processEnv, { activeSecret, activeProviderType } = {}) {
  const childEnv = {};
  for (const [k, v] of Object.entries(processEnv)) {
    if (isSecretShaped(k, v)) continue;
    childEnv[k] = v;
  }
  // Surgical unlock: an active Claude api_key account runs the full swarm by handing
  // the key to the child. Any other provider type (or subscription mode) never gets a
  // key injected here.
  if (activeSecret && activeProviderType === "claude") childEnv.ANTHROPIC_API_KEY = activeSecret;
  return childEnv;
}

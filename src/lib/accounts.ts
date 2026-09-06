// Multi-Provider Credentials — the typed client over the token-gated
// /runtime/accounts/* routes (agent-runtime/providers/routes.mjs). Same token
// pattern as providers.ts / inboxClient.ts: same-origin runtime token in an
// x-runtime-token header, runtimeUrl() base so it works dev-proxied AND packaged.
//
// GENERIC MULTI-ACCOUNT contract — the OLD /runtime/providers/* connect/replace/
// disconnect/active routes are DELETED (404). This mirrors routes.mjs EXACTLY:
//   GET    /runtime/accounts            → { accounts, activeAccountId, providerTypes }
//   POST   /runtime/accounts            → create → { ok, account }
//   POST   /runtime/accounts/:id/secret → replace secret → { ok, account }
//   DELETE /runtime/accounts/:id        → remove → { ok }
//   POST   /runtime/accounts/active      { accountId } → { ok, activeAccountId, capability, warning? }
// No response ever carries a secret — `hasSecret` is the only signal a key is stored.
import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

// ── Types (mirror registry.mjs + credStore.snapshot) ─────────────────────────
export type ProviderType = "claude" | "openai" | "minimax" | "zai" | "custom";
export type AuthMethod = "subscription" | "api_key";
export type Capability = "swarm" | "chat_only";

/** One stored account's METADATA — never the secret (credStore hands back metadata only). */
export interface Account {
  id: string;
  providerType: ProviderType;
  label: string;
  authMethod: AuthMethod;
  hasSecret: boolean;
  capability: Capability;
  createdAt: number;
  identifier?: string;
  baseUrl?: string;
  /** OpenAI-compatible chat model id (custom/openai only) — metadata, never a secret. */
  model?: string;
  /**
   * PHASE 1 — the cached tool-capability PROBE for this account's CURRENT model.
   * Absent means "never measured", which is NOT the same as "cannot" and is rendered
   * differently: a control that cannot succeed must say why, and "unknown" is a why.
   */
  toolProbe?: ToolProbe;
  /**
   * P1-D — whether the $ ceiling on an autonomous turn can actually bind this account,
   * as a sentence. DECORATED BY THE RUNTIME (providers/routes.mjs), never recomputed here:
   * the rule is a property of the executor, and a second copy in TypeScript is a copy that
   * drifts. Absent on older responses.
   */
  spendCap?: string;
}

/** The recorded verdict of a real tool-capability probe. */
export interface ToolProbe {
  capability: Capability;
  capable: boolean;
  /** Operator-facing explanation. Never carries a key or a raw provider body. */
  reason: string | null;
  /** The model that was measured. A probe of a different model does not apply. */
  model: string | null;
  /**
   * P1-D — did this endpoint report a per-call `usage.cost`? That, and only that, is what
   * the executor's dollar ceiling is enforced from. `null` means NOT MEASURED, which is not
   * the same as "no" — the same three-state honesty the capability probe uses.
   */
  reportsCost?: boolean | null;
  probedAt: number;
}

/** A provider-type PRESET — the picker catalog, NOT a fixed account list (registry.mjs). */
export interface Preset {
  type: ProviderType;
  label: string;
  authMethods: AuthMethod[];
  /** PHASE 1: there is deliberately NO `capability` here. It was five hardcoded literals
   *  that never asked a model anything; capability is now probed per ACCOUNT. */
  needsBaseUrl?: boolean;
  probeCapable?: boolean;
}

/** GET /runtime/accounts — every stored account, which one is active, plus the picker catalog. */
export interface AccountsResponse {
  accounts: Account[];
  activeAccountId: string | null;
  providerTypes: Preset[];
}

/** POST /runtime/accounts body. `secret` only for api_key; `baseUrl` only for custom. */
export interface AddAccountBody {
  providerType: ProviderType;
  label: string;
  authMethod: AuthMethod;
  secret?: string;
  baseUrl?: string;
  identifier?: string;
  /** OpenAI-compatible chat model id (custom/openai only; ≤128 chars). Persisted by the runtime for these types. */
  model?: string;
}

export interface AccountResult {
  ok?: boolean;
  account?: Account;
  error?: string;
}

/**
 * Editable fields for PATCH /runtime/accounts/:id (Phase 1, excellence program).
 *
 * Every field is optional and OMITTED fields are left untouched — that is the whole
 * point: before this existed, changing a model meant delete + re-add, which destroyed
 * the sealed secret. Leave `secret` undefined (or "") to keep the stored token.
 *
 * `providerType` is deliberately absent: the runtime rejects a type change, because the
 * capability tier and the sealed secret were both derived from it at creation.
 */
export interface AccountPatch {
  label?: string;
  /** `null` clears the model; omit to leave it unchanged. */
  model?: string | null;
  baseUrl?: string;
  /** Replacement token. Omit or leave empty to keep the currently sealed one. */
  secret?: string;
}
export interface RemoveResult {
  ok?: boolean;
  error?: string;
}
export interface SetActiveResult {
  ok?: boolean;
  activeAccountId?: string;
  capability?: Capability;
  warning?: string;
  error?: string;
}

// ── Path builders ────────────────────────────────────────────────────────────
export const ACCOUNTS_PATH = "/runtime/accounts";
export const ACTIVE_PATH = "/runtime/accounts/active";
export const secretPath = (id: string): string => `/runtime/accounts/${encodeURIComponent(id)}/secret`;
export const accountPath = (id: string): string => `/runtime/accounts/${encodeURIComponent(id)}`;
export const probePath = (id: string): string => `/runtime/accounts/${encodeURIComponent(id)}/probe`;

// ── Pure helpers (unit-testable; feed the preflight override + the UI badge) ──
/**
 * "auth OK" for the preflight gate under the generic contract: at least one stored
 * account that can actually drive or serve — a Claude subscription (no key needed),
 * OR ANY account with a stored secret. Block only when NEITHER exists.
 */
export function authReady(accounts: readonly Account[]): boolean {
  return accounts.some(
    (a) => (a.providerType === "claude" && a.authMethod === "subscription") || a.hasSecret,
  );
}

/** The two honest capability tiers, named. */
export const capabilityLabel = (c: Capability): string => (c === "swarm" ? "Full swarm" : "Chat only");

// ── Fetchers (providers.ts / inboxClient.ts token pattern) ───────────────────
async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
  // 400 carries a useful JSON body (validation / failed key probe) the caller renders;
  // every other non-2xx is a transport-level failure.
  if (!r.ok && r.status !== 400) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const getAccounts = (): Promise<AccountsResponse> => authedJson<AccountsResponse>(ACCOUNTS_PATH);

// MUNDER-ADOPTION A1 — the CLI-engine roster (GET /runtime/engines): preset table ×
// PATH detection. `spawnEngine` reports the honest truth: dispatch runs Claude CLI.
export interface CliEngineRow {
  id: string;
  label: string;
  bin: string;
  found: boolean;
  path: string | null;
  promptDelivery: "flag" | "positional" | "type-into-tui";
  installCommand: string | null;
  docsUrl: string | null;
}
export interface CliEnginesResponse {
  at: number;
  engines: CliEngineRow[];
  spawnEngine: string;
  /** A1-FINISH: true when RUNTIME_CLI_ENGINE was invalid and dispatch fell back to claude. */
  spawnForced?: boolean;
}
export const getCliEngines = (): Promise<CliEnginesResponse> => authedJson<CliEnginesResponse>("/runtime/engines");

export const addAccount = (body: AddAccountBody): Promise<AccountResult> =>
  authedJson<AccountResult>(ACCOUNTS_PATH, { method: "POST", body: JSON.stringify(body) });

export const replaceAccountSecret = (id: string, secret: string): Promise<AccountResult> =>
  authedJson<AccountResult>(secretPath(id), { method: "POST", body: JSON.stringify({ secret }) });

/**
 * Edit an existing account in place. Only the supplied fields change; the sealed secret
 * survives unless `patch.secret` is a non-empty string. Empty-string fields are stripped
 * so a blank "replace token" input can never clear a working credential by accident.
 */
export const updateAccount = (id: string, patch: AccountPatch): Promise<AccountResult> => {
  const body: Record<string, unknown> = {};
  if (patch.label !== undefined && patch.label !== "") body.label = patch.label;
  if (patch.model !== undefined) body.model = patch.model;
  if (patch.baseUrl !== undefined && patch.baseUrl !== "") body.baseUrl = patch.baseUrl;
  if (patch.secret !== undefined && patch.secret !== "") body.secret = patch.secret;
  return authedJson<AccountResult>(accountPath(id), { method: "PATCH", body: JSON.stringify(body) });
};

export const removeAccount = (id: string): Promise<RemoveResult> =>
  authedJson<RemoveResult>(accountPath(id), { method: "DELETE" });

export const setActiveAccount = (id: string): Promise<SetActiveResult> =>
  authedJson<SetActiveResult>(ACTIVE_PATH, { method: "POST", body: JSON.stringify({ accountId: id }) });


/** POST /runtime/accounts/:id/probe — run a REAL tool-capability probe and cache the verdict. */
export interface ProbeResult {
  ok?: boolean;
  account?: Account;
  probe?: ToolProbe & { skipped?: boolean };
  error?: string;
}
export const probeAccount = (id: string): Promise<ProbeResult> =>
  authedJson<ProbeResult>(probePath(id), { method: "POST" });

/**
 * What to show for an account's engine eligibility.
 *
 * THREE states, not two. "Never measured" is its own answer: reporting it as "cannot" would
 * be the same lie the deleted capability table told, just quieter.
 */
export type EngineStanding = "runs" | "cannot" | "unmeasured";

export const engineStanding = (a: Account): EngineStanding => {
  if (a.providerType === "claude") return "runs";
  const p = a.toolProbe;
  if (!p) return "unmeasured";
  if ((p.model ?? null) !== (a.model ?? null)) return "unmeasured";
  return p.capable ? "runs" : "cannot";
};

export const engineStandingLabel = (s: EngineStanding): string =>
  s === "runs" ? "Runs the engine" : s === "cannot" ? "Cannot run the engine" : "Tool support not measured";

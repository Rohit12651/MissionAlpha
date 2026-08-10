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
}

/** A provider-type PRESET — the picker catalog, NOT a fixed account list (registry.mjs). */
export interface Preset {
  type: ProviderType;
  label: string;
  authMethods: AuthMethod[];
  capability: Capability;
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

export const addAccount = (body: AddAccountBody): Promise<AccountResult> =>
  authedJson<AccountResult>(ACCOUNTS_PATH, { method: "POST", body: JSON.stringify(body) });

export const replaceAccountSecret = (id: string, secret: string): Promise<AccountResult> =>
  authedJson<AccountResult>(secretPath(id), { method: "POST", body: JSON.stringify({ secret }) });

export const removeAccount = (id: string): Promise<RemoveResult> =>
  authedJson<RemoveResult>(accountPath(id), { method: "DELETE" });

export const setActiveAccount = (id: string): Promise<SetActiveResult> =>
  authedJson<SetActiveResult>(ACTIVE_PATH, { method: "POST", body: JSON.stringify({ accountId: id }) });

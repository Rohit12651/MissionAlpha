import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getAccounts,
  addAccount,
  replaceAccountSecret,
  removeAccount,
  setActiveAccount,
  authReady,
  capabilityLabel,
  secretPath,
  accountPath,
  ACCOUNTS_PATH,
  ACTIVE_PATH,
  type Account,
} from "../accounts.ts";

// ── fetch harness ────────────────────────────────────────────────────────────
// runtimeToken() (runtimeBase.ts) hits /api/runtime-token once and caches the
// promise module-wide; every wrapper then hits its runtime path with the token in
// an x-runtime-token header. The stub answers the token endpoint and records the
// last runtime request so each wrapper's path + method + header + body can be asserted.
interface Call {
  url: string;
  method: string;
  token: string | null;
  body: string | null;
}
let last: Call | null = null;
let nextJson: unknown = { ok: true };
const originalFetch = globalThis.fetch;

function headerToken(init?: RequestInit): string | null {
  const h = init?.headers as Record<string, string> | undefined;
  return h?.["x-runtime-token"] ?? null;
}

beforeEach(() => {
  last = null;
  nextJson = { ok: true };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/runtime-token")) {
      return { ok: true, status: 200, json: async () => ({ token: "tok-abc" }) } as Response;
    }
    last = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      token: headerToken(init),
      body: typeof init?.body === "string" ? init.body : null,
    };
    return { ok: true, status: 200, json: async () => nextJson } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── wrappers hit the right path + method + carry the token + body ────────────
test("getAccounts → GET /runtime/accounts with token header", async () => {
  await getAccounts();
  assert.equal(last?.url, ACCOUNTS_PATH);
  assert.equal(last?.method, "GET");
  assert.equal(last?.token, "tok-abc");
});

test("addAccount → POST /runtime/accounts, token, body carries the full create shape", async () => {
  await addAccount({ providerType: "openai", label: "Work key", authMethod: "api_key", secret: "sk-XYZ", identifier: "me@x.co" });
  assert.equal(last?.url, ACCOUNTS_PATH);
  assert.equal(last?.method, "POST");
  assert.equal(last?.token, "tok-abc");
  const sent = JSON.parse(last?.body ?? "{}");
  assert.equal(sent.providerType, "openai");
  assert.equal(sent.label, "Work key");
  assert.equal(sent.authMethod, "api_key");
  assert.equal(sent.secret, "sk-XYZ");
  assert.equal(sent.identifier, "me@x.co");
});

test("addAccount custom → body carries baseUrl", async () => {
  await addAccount({ providerType: "custom", label: "Local", authMethod: "api_key", secret: "k", baseUrl: "https://llm.internal/v1" });
  const sent = JSON.parse(last?.body ?? "{}");
  assert.equal(sent.providerType, "custom");
  assert.equal(sent.baseUrl, "https://llm.internal/v1");
});

test("addAccount custom/openai → body carries model when provided", async () => {
  await addAccount({ providerType: "custom", label: "OpenRouter", authMethod: "api_key", secret: "k", baseUrl: "https://openrouter.ai/api/v1", model: "nvidia/llama-3.1-nemotron-70b-instruct:free" });
  const sent = JSON.parse(last?.body ?? "{}");
  assert.equal(sent.model, "nvidia/llama-3.1-nemotron-70b-instruct:free");
});

test("replaceAccountSecret → POST :id/secret path, token, { secret } body", async () => {
  await replaceAccountSecret("acc-123", "sk-new");
  assert.equal(last?.url, secretPath("acc-123"));
  assert.equal(last?.url, "/runtime/accounts/acc-123/secret");
  assert.equal(last?.method, "POST");
  assert.equal(last?.token, "tok-abc");
  assert.deepEqual(JSON.parse(last?.body ?? "{}"), { secret: "sk-new" });
});

test("removeAccount → DELETE :id path with token", async () => {
  await removeAccount("acc-123");
  assert.equal(last?.url, accountPath("acc-123"));
  assert.equal(last?.url, "/runtime/accounts/acc-123");
  assert.equal(last?.method, "DELETE");
  assert.equal(last?.token, "tok-abc");
});

test("setActiveAccount → POST /runtime/accounts/active with { accountId } body", async () => {
  await setActiveAccount("acc-9");
  assert.equal(last?.url, ACTIVE_PATH);
  assert.equal(last?.method, "POST");
  assert.equal(last?.token, "tok-abc");
  assert.deepEqual(JSON.parse(last?.body ?? "{}"), { accountId: "acc-9" });
});

test("a 400 body (validation / failed probe) is returned, not thrown", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/runtime-token")) return { ok: true, status: 200, json: async () => ({ token: "t" }) } as Response;
    void init;
    return { ok: false, status: 400, json: async () => ({ error: "key verification failed" }) } as Response;
  }) as typeof fetch;
  const r = await addAccount({ providerType: "claude", label: "x", authMethod: "api_key", secret: "bad" });
  assert.equal(r.error, "key verification failed");
});

// ── pure readiness helpers ───────────────────────────────────────────────────
const acct = (over: Partial<Account> = {}): Account => ({
  id: "a1",
  providerType: "claude",
  label: "My Claude",
  authMethod: "subscription",
  hasSecret: false,
  capability: "swarm",
  createdAt: 1,
  ...over,
});

test("authReady true for a Claude subscription (no key needed)", () => {
  assert.equal(authReady([acct({ authMethod: "subscription", hasSecret: false })]), true);
});

test("authReady true for ANY account with a stored secret", () => {
  assert.equal(authReady([acct({ providerType: "openai", authMethod: "api_key", hasSecret: true, capability: "chat_only" })]), true);
});

test("authReady false for empty, or an api_key account without a stored secret", () => {
  assert.equal(authReady([]), false);
  assert.equal(authReady([acct({ providerType: "openai", authMethod: "api_key", hasSecret: false, capability: "chat_only" })]), false);
});

test("capabilityLabel names the two honest tiers", () => {
  assert.equal(capabilityLabel("swarm"), "Full swarm");
  assert.equal(capabilityLabel("chat_only"), "Chat only");
});

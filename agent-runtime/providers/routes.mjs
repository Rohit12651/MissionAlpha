// Multi-Provider Credentials — /runtime/accounts/* HTTP handlers (generic REST).
//
// Pure dispatch: createProviderRoutes(credStore, probeFn) → async dispatch({method,
// pathname, body}) → { status, json }. server.mjs adapts req/res and applies the SAME
// hostOk + token gate as /inbox before calling this. No handler ever returns a secret.
//
// probeFn(secret, { providerType, baseUrl }) → { ok } (or throws). A probe runs ONLY
// for probe-capable types (claude/openai) in api_key mode; the account persists only
// AFTER the probe accepts. minimax/zai/custom are store-and-ready (no live probe) but
// still require a non-empty api_key secret.
import { PROVIDER_TYPES, providerTypePreset } from "./registry.mjs";
import { assertSafeHttpUrl } from "./url-guard.mjs";

// Route surface:
//   GET    /runtime/accounts            → { accounts, activeAccountId, providerTypes }
//   POST   /runtime/accounts            → create → { ok, account }
//   POST   /runtime/accounts/:id/secret → replace secret → { ok, account }
//   DELETE /runtime/accounts/:id        → remove → { ok }
//   POST   /runtime/accounts/active     → { accountId } → { ok, activeAccountId, capability, warning? }
//   GET    /runtime/providers           → legacy alias → { providerTypes }
export function createProviderRoutes(credStore, probeFn) {
  function list() {
    const snap = credStore.snapshot();
    return { status: 200, json: { accounts: snap.accounts, activeAccountId: snap.activeAccountId, providerTypes: PROVIDER_TYPES } };
  }

  async function create(body) {
    const providerType = body?.providerType;
    const preset = providerTypePreset(providerType);
    if (!preset) return { status: 400, json: { error: `unknown provider type: ${providerType}` } };

    const { label, authMethod, baseUrl, identifier, model } = body ?? {};
    if (typeof label !== "string" || label.trim().length === 0 || label.length > 80) {
      return { status: 400, json: { error: "label is required (1-80 chars)" } };
    }
    if (identifier != null && String(identifier).length > 256) {
      return { status: 400, json: { error: "identifier too long (max 256 chars)" } };
    }
    if (model != null && String(model).length > 128) {
      return { status: 400, json: { error: "model too long (max 128 chars)" } };
    }
    if (!preset.authMethods.includes(authMethod)) {
      return { status: 400, json: { error: `provider ${providerType} does not support authMethod '${authMethod}'` } };
    }
    if (preset.needsBaseUrl && !(typeof baseUrl === "string" && /^https?:\/\//i.test(baseUrl))) {
      return { status: 400, json: { error: `provider type '${providerType}' requires an http(s) baseUrl` } };
    }
    // SSRF-vet any supplied baseUrl (openai + custom) BEFORE it is probed or persisted,
    // so a stored custom baseUrl fetched by a future chat path is already safe at rest.
    if (typeof baseUrl === "string" && baseUrl.length > 0) {
      try {
        await assertSafeHttpUrl(baseUrl);
      } catch (e) {
        return { status: 400, json: { error: `unsafe baseUrl: ${e?.message || "rejected"}` } };
      }
    }

    if (authMethod === "api_key") {
      const secret = body?.secret;
      if (typeof secret !== "string" || secret.length === 0) {
        return { status: 400, json: { error: "api_key requires a non-empty secret" } };
      }
      // Probe BEFORE persisting — but only for probe-capable types (claude/openai).
      // A rejected/invalid key writes nothing. Non-probe types are store-and-ready.
      if (preset.probeCapable) {
        let probe;
        try {
          probe = await probeFn(secret, { providerType, baseUrl });
        } catch (e) {
          return { status: 400, json: { error: `key verification failed: ${e?.message || "probe error"}` } };
        }
        if (!probe || !probe.ok) return { status: 400, json: { error: "key verification failed" } };
      }
    }

    let account;
    try {
      account = credStore.addAccount({ providerType, label, authMethod, secret: body?.secret, baseUrl, identifier, model });
    } catch (e) {
      return { status: 400, json: { error: e?.message || "could not add account" } };
    }
    return { status: 200, json: { ok: true, account } }; // account = metadata only
  }

  async function replaceSecret(id, body) {
    if (!credStore.isUuid(id)) return { status: 400, json: { error: "malformed account id" } };
    const snap = credStore.snapshot();
    const acct = snap.accounts.find((a) => a.id === id);
    if (!acct) return { status: 400, json: { error: `unknown account id: ${id}` } };
    const secret = body?.secret;
    if (typeof secret !== "string" || secret.length === 0) {
      return { status: 400, json: { error: "a non-empty secret is required" } };
    }
    const preset = providerTypePreset(acct.providerType);
    if (preset?.probeCapable) {
      let probe;
      try {
        probe = await probeFn(secret, { providerType: acct.providerType, baseUrl: acct.baseUrl });
      } catch (e) {
        return { status: 400, json: { error: `key verification failed: ${e?.message || "probe error"}` } };
      }
      if (!probe || !probe.ok) return { status: 400, json: { error: "key verification failed" } };
    }
    let account;
    try {
      account = credStore.replaceSecret(id, secret);
    } catch (e) {
      return { status: 400, json: { error: e?.message || "could not replace secret" } };
    }
    return { status: 200, json: { ok: true, account } };
  }

  function remove(id) {
    if (!credStore.isUuid(id)) return { status: 400, json: { error: "malformed account id" } };
    try {
      credStore.removeAccount(id);
    } catch (e) {
      return { status: 400, json: { error: e?.message || "could not remove account" } };
    }
    return { status: 200, json: { ok: true } };
  }

  function setActive(body) {
    const id = body?.accountId;
    if (!credStore.isUuid(id)) return { status: 400, json: { error: "malformed account id" } };
    try {
      credStore.setActive(id);
    } catch (e) {
      return { status: 400, json: { error: e?.message || "could not set active account" } };
    }
    const active = credStore.getActive();
    const out = { ok: true, activeAccountId: id, capability: active?.capability ?? null };
    if (active?.capability === "chat_only") {
      out.warning = "stored — the autonomous engine runs on Claude accounts; this one is saved for chat/future use";
    }
    return { status: 200, json: out };
  }

  // Legacy alias — kept because src/lib/providers.ts still GETs /runtime/providers.
  function providersAlias() {
    return { status: 200, json: { providerTypes: PROVIDER_TYPES } };
  }

  async function dispatch({ method, pathname, body }) {
    if (method === "GET" && pathname === "/runtime/accounts") return list();
    if (method === "POST" && pathname === "/runtime/accounts") return create(body);
    if (method === "POST" && pathname === "/runtime/accounts/active") return setActive(body);

    const secretM = /^\/runtime\/accounts\/([^/]{1,64})\/secret$/.exec(pathname);
    if (method === "POST" && secretM) return replaceSecret(secretM[1], body);

    const idM = /^\/runtime\/accounts\/([^/]{1,64})$/.exec(pathname);
    if (method === "DELETE" && idM) return remove(idM[1]);

    if (method === "GET" && pathname === "/runtime/providers") return providersAlias();
    return { status: 404, json: { error: "not found" } };
  }

  return { dispatch, list, setActive, remove };
}

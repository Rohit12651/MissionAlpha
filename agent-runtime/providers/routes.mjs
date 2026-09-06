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
import { probeToolCapability, spendCapExplanation } from "./capability-probe.mjs";
import { assertSafeHttpUrl } from "./url-guard.mjs";

// Route surface:
//   GET    /runtime/accounts            → { accounts, activeAccountId, providerTypes }
//   POST   /runtime/accounts            → create → { ok, account }
//   POST   /runtime/accounts/:id/secret → replace secret → { ok, account }
//   POST   /runtime/accounts/:id/probe  → tool-capability probe → { ok, account, probe }
//   PATCH  /runtime/accounts/:id        → edit label/model/baseUrl/secret → { ok, account }
//   DELETE /runtime/accounts/:id        → remove → { ok }
//   POST   /runtime/accounts/active     → { accountId } → { ok, activeAccountId, capability, warning? }
//   GET    /runtime/providers           → legacy alias → { providerTypes }
// P1-D — the spend-cap sentence is DECORATED onto each account here rather than
// reimplemented in the UI. The rule ("the $ ceiling is enforced from a reported usage.cost,
// which many endpoints never send") is a property of the executor, and a second copy in
// TypeScript is a copy that drifts. The client renders what the runtime measured.
const withSpendCap = (a) => ({ ...a, spendCap: spendCapExplanation(a) });

export function createProviderRoutes(credStore, probeFn) {
  function list() {
    const snap = credStore.snapshot();
    return {
      status: 200,
      json: {
        accounts: snap.accounts.map(withSpendCap),
        activeAccountId: snap.activeAccountId,
        providerTypes: PROVIDER_TYPES,
      },
    };
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

  // Edit an existing account (Phase 1, excellence program).
  //
  // Closes a live defect: server.mjs streamed "edit the account and add a model id" while
  // the UI offered only Set-active / Remove, so the only recovery was delete + re-add —
  // which destroys the sealed secret.
  //
  // SECURITY: (a) same needsAuth + Host gate as every other route in this file, applied
  // by server.mjs; (b) any incoming baseUrl goes through the SAME assertSafeHttpUrl SSRF
  // guard as create() — an edit must not be a way around the guard; (c) the response is
  // the metadata snapshot only, which by construction never carries the secret.
  async function update(id, body) {
    if (!credStore.isUuid(id)) return { status: 400, json: { error: "malformed account id" } };
    if (!body || typeof body !== "object") return { status: 400, json: { error: "body required" } };

    const patch = {};
    if ("label" in body) patch.label = body.label;
    if ("model" in body) patch.model = body.model;
    if ("secret" in body) patch.secret = body.secret;

    if ("baseUrl" in body && body.baseUrl !== undefined && body.baseUrl !== "") {
      if (typeof body.baseUrl !== "string" || !/^https?:\/\//i.test(body.baseUrl)) {
        return { status: 400, json: { error: "baseUrl must be an http(s) URL" } };
      }
      try {
        await assertSafeHttpUrl(body.baseUrl);
      } catch (e) {
        return { status: 400, json: { error: e?.message || "baseUrl rejected" } };
      }
      patch.baseUrl = body.baseUrl;
    }

    if (Object.keys(patch).length === 0) {
      return { status: 400, json: { error: "no editable fields supplied" } };
    }

    let account;
    try {
      account = credStore.updateAccount(id, patch);
    } catch (e) {
      return { status: 400, json: { error: e?.message || "could not update account" } };
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

  /**
   * PHASE 1 TASK 1.3 — run a REAL tool-capability probe and cache the verdict.
   *
   * This is the route that replaces five hardcoded `capability` literals. It sends the
   * model one trivial tool and records whether it came back with a well-formed tool call.
   * A negative result is recorded just as durably as a positive one, with the reason, so
   * the operator can see WHY a provider cannot run the engine instead of meeting a silent
   * refusal when they try to queue work.
   *
   * Costs a few tokens per call — it is a real request, which is the whole point.
   */
  async function probe(id) {
    if (!credStore.isUuid(id)) return { status: 400, json: { error: "malformed account id" } };
    let account;
    try {
      account = credStore.snapshot().accounts.find((a) => a.id === id);
    } catch {
      account = null;
    }
    if (!account) return { status: 404, json: { error: "no such account" } };

    if (account.providerType === "claude") {
      return {
        status: 200,
        json: {
          ok: true,
          account,
          probe: {
            capable: true,
            capability: "swarm",
            reason: "Claude accounts drive the engine through the Claude CLI, not an HTTP endpoint",
            skipped: true,
          },
        },
      };
    }

    const secret = credStore.getSecretFor(id);
    const result = await probeToolCapability({
      baseUrl: account.baseUrl,
      apiKey: secret,
      model: account.model,
    });
    let updated;
    try {
      updated = credStore.setToolProbe(id, result);
    } catch (e) {
      return { status: 400, json: { error: e?.message || "could not record the probe result" } };
    }
    // The reason is operator-facing text; it never carries the key (which lives only in an
    // Authorization header) and never carries a response body beyond the adapter's own
    // bounded error snippet.
    // Decorated like list(): the probe is exactly the moment the spend-cap answer CHANGES
    // (it is the call that measures whether this endpoint reports a cost), so the response
    // that reports it must carry the new sentence rather than leave the UI on the old one
    // until a refetch.
    return { status: 200, json: { ok: true, account: withSpendCap(updated), probe: result } };
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
      out.warning =
        "stored — this account has not demonstrated tool support, so the autonomous engine cannot dispatch to it yet. Run a capability probe to check.";
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

    const probeM = /^\/runtime\/accounts\/([^/]{1,64})\/probe$/.exec(pathname);
    if (method === "POST" && probeM) return probe(probeM[1]);

    const idM = /^\/runtime\/accounts\/([^/]{1,64})$/.exec(pathname);
    if (method === "DELETE" && idM) return remove(idM[1]);
    if (method === "PATCH" && idM) return update(idM[1], body);

    if (method === "GET" && pathname === "/runtime/providers") return providersAlias();
    return { status: 404, json: { error: "not found" } };
  }

  return { dispatch, list, setActive, remove, probe };
}

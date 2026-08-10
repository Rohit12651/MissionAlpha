// OpenAI-compatible chat adapter — streams a chat completion from any OpenAI-shaped
// endpoint (OpenRouter, NVIDIA, a local vLLM, …) so a non-Claude ACTIVE account can
// actually reply. The autonomous engine still runs only on Claude; this is the chat
// path for chat_only accounts.
//
// SECURITY: the target endpoint is SSRF-vetted (assertSafeHttpUrl + redirect:"manual")
// BEFORE any request, so a private/loopback/metadata baseUrl is rejected with no fetch.
// The api key travels ONLY in the Authorization header and is NEVER placed in a thrown
// error message or log line.
import { assertSafeHttpUrl } from "../url-guard.mjs";

// OpenAI-compatible provider types (everything except claude). The engine capability
// ("swarm" vs "chat_only") is the real gate; this set is a defensive belt.
const OPENAI_COMPAT_TYPES = new Set(["custom", "openai", "minimax", "zai"]);
const MAX_ERR_BODY = 500; // chars of a non-2xx body surfaced for diagnosis

// Resolve the chat endpoint: honor a baseUrl that already targets /chat/completions,
// otherwise append it. Trailing slashes are normalized away first.
export function resolveEndpoint(baseUrl) {
  const trimmed = String(baseUrl).replace(/\/+$/, "");
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

// Decide the chat backend for the active account: "adapter" for a chat-capable,
// OpenAI-compatible account that carries a stored key AND a baseUrl; "cli" otherwise
// (Claude/swarm, no account, no secret, or no baseUrl → the existing Claude CLI path).
export function pickChatBackend(acct) {
  if (
    acct &&
    acct.capability !== "swarm" &&
    OPENAI_COMPAT_TYPES.has(acct.providerType) &&
    acct.hasSecret === true &&
    typeof acct.baseUrl === "string" &&
    acct.baseUrl.length > 0
  ) {
    return "adapter";
  }
  return "cli";
}

// Yield raw byte/string chunks from a fetch Response body, whether it's a WHATWG
// ReadableStream (getReader) or an async-iterable (Node undici / a test stub).
async function* iterateBody(body) {
  if (!body) return;
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    for await (const chunk of body) yield chunk;
  }
}

// Stream an OpenAI-compatible chat completion. Async generator: yields assistant
// content deltas (strings) as they arrive and RETURNS the usage object (or null) when
// the stream terminates on `data: [DONE]`. `fetchImpl` is injectable for tests; prod
// uses the global fetch.
export async function* streamChat({ baseUrl, apiKey, model, messages, signal, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  const endpoint = resolveEndpoint(baseUrl);
  await assertSafeHttpUrl(endpoint); // SSRF guard — throws before any request

  const res = await doFetch(endpoint, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://missionalpha.local",
      "X-Title": "MissionAlpha",
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!res.ok) {
    let snippet = "";
    try { snippet = String(await res.text()).slice(0, MAX_ERR_BODY); } catch { /* body unreadable */ }
    // NOTE: neither the endpoint nor the snippet carries the api key (it lives only in
    // the Authorization header), so this message is safe to surface/log.
    throw new Error(`openai-compat chat failed: HTTP ${res.status}${snippet ? ` — ${snippet}` : ""}`);
  }

  const decoder = new TextDecoder();
  let buf = "";
  let usage = null;

  for await (const chunk of iterateBody(res.body)) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "").trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return usage;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length) yield delta;
      if (json?.usage) usage = json.usage;
    }
  }
  return usage;
}

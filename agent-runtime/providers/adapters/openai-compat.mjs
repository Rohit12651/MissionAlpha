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
import { createToolCallAccumulator } from "../tool-call-accumulator.mjs";

// OpenAI-compatible provider types (everything except claude). The engine capability
// ("swarm" vs "chat_only") is the real gate; this set is a defensive belt.
export const OPENAI_COMPAT_TYPES = new Set(["custom", "openai", "minimax", "zai"]);
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

/** True for OpenRouter, whose cost field is opt-in and provider-specific. */
export function isOpenRouterEndpoint(endpoint) {
  try { return /(^|\.)openrouter\.ai$/i.test(new URL(endpoint).hostname); } catch { return false; }
}

/**
 * The USD cost a provider REPORTED for a completion, or null.
 *
 * Phase 7 rule 3, at the adapter boundary: spend is never inferred. Token counts are not
 * a price — this project has no rate card and inventing one would put a number on screen
 * that is not a measurement. Only a real, finite, non-negative `cost` counts; everything
 * else, including a numeric-looking string, is "not reported" and stores as null.
 */
export function costFromUsage(usage) {
  const c = usage?.cost;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0) return null;
  return c;
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
    // `stream_options.include_usage` is the standard OpenAI-compatible way to get a usage
    // object on a STREAMED completion; without it many servers send none at all.
    // `usage: { include: true }` is OpenRouter-specific and is the ONLY way it reports a
    // dollar cost — so it is sent to OpenRouter and to nothing else, because an unknown
    // body field can be a 400 on a stricter server and this adapter also serves custom,
    // self-hosted endpoints.
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(isOpenRouterEndpoint(endpoint) ? { usage: { include: true } } : {}),
    }),
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

// ── PHASE 1 — the tool-calling transport ─────────────────────────────────────
//
// `streamChat` above yields text deltas and nothing else, which is precisely why the
// registry used to stamp `capability: "chat_only"` on every non-Claude provider. That was
// a statement about THIS ADAPTER, not about the models. GPT, Nemotron, MiniMax and Z.ai
// all call tools. What follows gives them the same reach the Claude CLI path already has.
//
// `streamChat` is left untouched — the chat route still uses it and its tests still pass.
// This is an additional entry point, not a rewrite of the one that works.

/** Shared request body for both transports, so streamed and non-streamed cannot diverge. */
function completionBody({ model, messages, tools, stream, endpoint }) {
  return JSON.stringify({
    model,
    messages,
    ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    ...(stream
      ? {
          stream: true,
          stream_options: { include_usage: true },
          ...(isOpenRouterEndpoint(endpoint) ? { usage: { include: true } } : {}),
        }
      : { stream: false }),
  });
}

async function postCompletion({ endpoint, apiKey, body, signal, doFetch }) {
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
    body,
  });
  if (!res.ok) {
    let snippet = "";
    try { snippet = String(await res.text()).slice(0, MAX_ERR_BODY); } catch { /* body unreadable */ }
    // The key lives only in the Authorization header, so this message is safe to surface.
    throw new Error(`openai-compat completion failed: HTTP ${res.status}${snippet ? ` — ${snippet}` : ""}`);
  }
  return res;
}

/**
 * ONE assistant turn, streamed, WITH tool calls.
 *
 * Returns `{ text, toolCalls, usage, finishReason }`. `toolCalls` comes from
 * createToolCallAccumulator, so fragmented `delta.tool_calls` are reassembled and a
 * truncated one is REPORTED (`ok:false`) rather than dropped — see
 * tool-call-accumulator.mjs for why that distinction is the whole point.
 *
 * `onText` is invoked with each content delta so a caller can stream to the UI without
 * this function needing to know what a UI is.
 */
export async function completeWithTools({
  baseUrl, apiKey, model, messages, tools, signal, fetchImpl, onText,
} = {}) {
  const doFetch = fetchImpl || fetch;
  const endpoint = resolveEndpoint(baseUrl);
  await assertSafeHttpUrl(endpoint); // SSRF guard — throws before any request

  const res = await postCompletion({
    endpoint, apiKey, signal, doFetch,
    body: completionBody({ model, messages, tools, stream: true, endpoint }),
  });

  const acc = createToolCallAccumulator();
  const decoder = new TextDecoder();
  let buf = "";
  let usage = null;
  let text = "";
  let finishReason = null;

  for await (const chunk of iterateBody(res.body)) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "").trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { buf = ""; break; }
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const choice = json?.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta.length) {
        text += delta;
        if (onText) onText(delta);
      }
      acc.push(choice?.delta?.tool_calls);
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (json?.usage) usage = json.usage;
    }
  }

  return { text, toolCalls: acc.finish(), usage, finishReason };
}

/**
 * TASK 1.5 — the non-streaming fallback.
 *
 * Some OpenAI-compatible servers stream tool calls unreliably: fragments arrive with no
 * index, or the final `arguments` chunk is dropped, and the accumulator correctly reports
 * unparseable JSON. Guessing at the truncated text would be the silent-corruption failure
 * this project keeps finding, so the honest move is to ask again WITHOUT streaming, where
 * the server sends one complete JSON body and there is nothing to reassemble.
 */
export async function completeWithToolsNonStreaming({
  baseUrl, apiKey, model, messages, tools, signal, fetchImpl,
} = {}) {
  const doFetch = fetchImpl || fetch;
  const endpoint = resolveEndpoint(baseUrl);
  await assertSafeHttpUrl(endpoint);

  const res = await postCompletion({
    endpoint, apiKey, signal, doFetch,
    body: completionBody({ model, messages, tools, stream: false, endpoint }),
  });

  const json = await res.json();
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  // Reuse the SAME accumulator so a whole-body response and a streamed one produce
  // identical call objects — including the same validation and the same refusals.
  const acc = createToolCallAccumulator();
  if (Array.isArray(msg.tool_calls)) {
    acc.push(msg.tool_calls.map((tc, i) => ({ ...tc, index: Number.isInteger(tc.index) ? tc.index : i })));
  }
  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCalls: acc.finish(),
    usage: json?.usage ?? null,
    finishReason: choice?.finish_reason ?? null,
  };
}

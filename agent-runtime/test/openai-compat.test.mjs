// OpenAI-compatible chat adapter — streamChat SSE parsing + request shape + SSRF guard
// + pickChatBackend capability routing. Hermetic: fetch is INJECTED (no network); SSRF
// uses a literal loopback IP so assertSafeHttpUrl rejects without DNS. No secret must
// ever appear in a thrown error message.
import { test } from "node:test";
import assert from "node:assert/strict";

import { streamChat, resolveEndpoint, pickChatBackend } from "../providers/adapters/openai-compat.mjs";

// ── helpers ──────────────────────────────────────────────────────────────────
// A body that yields the SSE text in small byte chunks (splits mid-line) so the
// adapter's line-buffering is exercised, not just whole-line input.
function byteStream(text) {
  const bytes = new TextEncoder().encode(text);
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < bytes.length; i += 7) yield bytes.slice(i, i + 7);
    },
  };
}

function mockFetch(bodyText, { ok = true, status = 200, errBody = "" } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (!ok) return { ok, status, text: async () => errBody, body: null };
    return { ok, status, text: async () => bodyText, body: byteStream(bodyText) };
  };
  fn.calls = calls;
  return fn;
}

async function collect(gen) {
  const tokens = [];
  let r;
  for (;;) { r = await gen.next(); if (r.done) break; tokens.push(r.value); }
  return { tokens, usage: r.value };
}

const SSE_OK =
  'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n' +
  "data: [DONE]\n\n" +
  'data: {"choices":[{"delta":{"content":"AFTER-DONE"}}]}\n\n';

// ── endpoint resolution ───────────────────────────────────────────────────────
test("resolveEndpoint appends /chat/completions unless already present", () => {
  assert.equal(resolveEndpoint("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(resolveEndpoint("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(resolveEndpoint("https://x/v1/chat/completions"), "https://x/v1/chat/completions");
  assert.equal(resolveEndpoint("https://x/v1/chat/completions/"), "https://x/v1/chat/completions");
});

// ── streamChat parsing + request shape ────────────────────────────────────────
test("streamChat yields delta content in order and captures usage; stops at [DONE]", async () => {
  const fetchImpl = mockFetch(SSE_OK);
  const gen = streamChat({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-secret-KEY",
    model: "nvidia/model:free",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl,
  });
  const { tokens, usage } = await collect(gen);
  assert.deepEqual(tokens, ["Hello", " world"], "content after [DONE] is never yielded");
  assert.equal(usage.total_tokens, 7);
});

test("streamChat builds the correct request: endpoint, Bearer header, model+stream in body", async () => {
  const fetchImpl = mockFetch(SSE_OK);
  await collect(streamChat({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-secret-KEY",
    model: "gpt-x",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    fetchImpl,
  }));
  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, "https://api.example.com/v1/chat/completions");
  assert.equal(opts.method, "POST");
  assert.equal(opts.redirect, "manual");
  assert.equal(opts.headers.Authorization, "Bearer sk-secret-KEY");
  assert.equal(opts.headers["Content-Type"], "application/json");
  assert.ok(opts.headers["HTTP-Referer"]);
  assert.ok(opts.headers["X-Title"]);
  const body = JSON.parse(opts.body);
  assert.equal(body.model, "gpt-x");
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
});

test("streamChat rejects a private baseUrl via the SSRF guard, without fetching", async () => {
  const fetchImpl = mockFetch(SSE_OK);
  const gen = streamChat({
    baseUrl: "http://127.0.0.1:9000/v1",
    apiKey: "sk-secret-KEY",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl,
  });
  await assert.rejects(() => collect(gen), /block/i);
  assert.equal(fetchImpl.calls.length, 0, "guard blocks before any fetch");
});

test("streamChat throws a clear error on non-2xx that includes status but NOT the api key", async () => {
  const fetchImpl = mockFetch("", { ok: false, status: 500, errBody: "upstream boom" });
  const gen = streamChat({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-secret-LEAK",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl,
  });
  await assert.rejects(() => collect(gen), (e) => {
    assert.match(e.message, /500/);
    assert.ok(!e.message.includes("sk-secret-LEAK"), "api key must never appear in the error");
    return true;
  });
});

// ── pickChatBackend capability routing ────────────────────────────────────────
test("pickChatBackend → adapter for a chat_only openai-compatible account with key+baseUrl", () => {
  assert.equal(pickChatBackend({ providerType: "custom", capability: "chat_only", hasSecret: true, baseUrl: "https://x/v1" }), "adapter");
});

test("pickChatBackend → cli for claude/swarm, null, or missing key/baseUrl", () => {
  assert.equal(pickChatBackend({ providerType: "claude", capability: "swarm", hasSecret: true, baseUrl: "https://x/v1" }), "cli");
  assert.equal(pickChatBackend(null), "cli");
  assert.equal(pickChatBackend({ providerType: "custom", capability: "chat_only", hasSecret: false, baseUrl: "https://x/v1" }), "cli");
  assert.equal(pickChatBackend({ providerType: "custom", capability: "chat_only", hasSecret: true }), "cli");
  assert.equal(pickChatBackend({ providerType: "claude", capability: "swarm", hasSecret: false }), "cli");
});

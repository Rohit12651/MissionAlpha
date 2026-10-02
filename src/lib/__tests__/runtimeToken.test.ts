// Security review LOW: the runtime token was cached forever after a failure. One failed
// /api/runtime-token fetch (runtime still booting, a 401 while the token file is rewritten)
// left every later call with "" for the life of the window, so every authed call 401'd until
// a reload. A good token is still cached; a failure is not.
import { test } from "node:test";
import assert from "node:assert/strict";

type Reply = "down" | "500" | string;
function stubFetch(replies: Reply[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const r = replies.shift() ?? "down";
    if (r === "down") throw new TypeError("Failed to fetch");
    if (r === "500") return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ token: r }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

test("a failed token fetch is not cached: the next call asks again and gets the token", async () => {
  const calls = stubFetch(["down", "tok-1"]);
  const { runtimeToken } = await import(`../runtimeBase.ts?a=${Date.now()}`);
  assert.equal(await runtimeToken(), "");
  assert.equal(await runtimeToken(), "tok-1");
  assert.equal(calls.length, 2);
});

test("an HTTP error is a failure too, not a token", async () => {
  stubFetch(["500", "tok-2"]);
  const { runtimeToken } = await import(`../runtimeBase.ts?b=${Date.now()}`);
  assert.equal(await runtimeToken(), "");
  assert.equal(await runtimeToken(), "tok-2");
});

test("a good token is cached: one fetch serves every caller", async () => {
  const calls = stubFetch(["tok-3", "tok-other"]);
  const { runtimeToken } = await import(`../runtimeBase.ts?c=${Date.now()}`);
  const [a, b] = await Promise.all([runtimeToken(), runtimeToken()]);
  assert.equal(a, "tok-3"); assert.equal(b, "tok-3");
  assert.equal(await runtimeToken(), "tok-3");
  assert.equal(calls.length, 1);
});

test("packaged (bridge): a failed getRuntimeToken is not cached either", async () => {
  const replies = [Promise.reject(new Error("main not ready")), Promise.resolve("tok-4")];
  (globalThis as { missionAlpha?: unknown }).missionAlpha = { isPackaged: true, runtimeBase: "http://127.0.0.1:3005", getRuntimeToken: () => replies.shift()!, onPreflight: () => {} };
  try {
    const { runtimeToken } = await import(`../runtimeBase.ts?d=${Date.now()}`);
    assert.equal(await runtimeToken(), "");
    assert.equal(await runtimeToken(), "tok-4");
  } finally {
    delete (globalThis as { missionAlpha?: unknown }).missionAlpha;
  }
});

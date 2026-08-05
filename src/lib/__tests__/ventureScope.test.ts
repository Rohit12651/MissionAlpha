// B5 — the venture scope is now a SINGLE app-wide source (ventureScope.ts): a tiny
// module store backed by `ma.bos.venture`, read through a `useVenture()` hook so every
// BOS surface — sidebar, deck, vault, workflows, schedule, and the Command Center —
// scopes off the same value and re-renders when it changes. These tests pin the pure
// store contract (default null, persist, notify, clear, normalize) without React.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getVenture, setVenture, subscribeVenture, reloadVenture } from "../ventureScope.ts";
import { VENTURE_STORAGE_KEY } from "../vaultClient.ts";

// A minimal in-memory localStorage the store reads at CALL time (not import time), so a
// pure node test can exercise persistence exactly as the browser would.
function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const m = new Map<string, string>(Object.entries(initial));
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  return m;
}

beforeEach(() => {
  installStorage();
  setVenture(null); // reset the module store between tests
});

test("default is null (all ventures) when nothing is stored", () => {
  installStorage();
  reloadVenture();
  assert.equal(getVenture(), null);
});

test("setVenture persists the slug and notifies subscribers", () => {
  const store = installStorage();
  let fired = 0;
  const off = subscribeVenture(() => { fired += 1; });
  setVenture("waahyu");
  assert.equal(getVenture(), "waahyu");
  assert.equal(store.get(VENTURE_STORAGE_KEY), "waahyu", "persisted to localStorage");
  assert.equal(fired, 1, "subscriber notified exactly once");
  off();
});

test('setVenture("all") and setVenture(null) clear the scope and remove the key', () => {
  const store = installStorage({ [VENTURE_STORAGE_KEY]: "waahyu" });
  reloadVenture();
  assert.equal(getVenture(), "waahyu");
  setVenture("all");
  assert.equal(getVenture(), null);
  assert.equal(store.has(VENTURE_STORAGE_KEY), false, "the key is removed, not left stale");
  setVenture("waahyu");
  setVenture(null);
  assert.equal(getVenture(), null);
  assert.equal(store.has(VENTURE_STORAGE_KEY), false);
});

test("a non-slug value normalizes to null rather than being sent downstream", () => {
  installStorage();
  setVenture("../etc/passwd");
  assert.equal(getVenture(), null);
  setVenture("Bad Slug!");
  assert.equal(getVenture(), null);
});

test("setting the SAME value does not re-notify (only real changes broadcast)", () => {
  installStorage();
  setVenture("acme");
  let fired = 0;
  const off = subscribeVenture(() => { fired += 1; });
  setVenture("acme"); // no change
  assert.equal(fired, 0, "unchanged scope must not churn the subscribers");
  setVenture("waahyu"); // change
  assert.equal(fired, 1);
  off();
});

test("an unsubscribed listener stops receiving notifications", () => {
  installStorage();
  let fired = 0;
  const off = subscribeVenture(() => { fired += 1; });
  setVenture("acme");
  assert.equal(fired, 1);
  off();
  setVenture("waahyu");
  assert.equal(fired, 1, "no notification after unsubscribe");
});

test("reloadVenture picks up an out-of-band localStorage change", () => {
  const store = installStorage();
  store.set(VENTURE_STORAGE_KEY, "acme"); // e.g. another tab wrote it
  assert.equal(getVenture(), null, "store is unaware until reloaded");
  reloadVenture();
  assert.equal(getVenture(), "acme");
});

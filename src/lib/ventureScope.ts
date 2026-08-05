// B5 — the venture scope, promoted to a SINGLE app-wide source.
//
// B2 shipped the scope as `ma.bos.venture` and wired it to the Vault page + the deck's
// records read only ("app-wide scoping lands in B5"). B5 makes good on that: this module
// is the one place the scope lives. It is a tiny module store (no Context tree needed)
// read through `useVenture()`, which subscribes with React's own `useSyncExternalStore`
// — so a change from ANY writer (the sidebar switcher, the Command Center's ventures
// panel) re-renders EVERY open surface that reads it, and each re-fetches scoped.
//
// Kept deliberately minimal because it is ALWAYS mounted (the sidebar): it reuses the
// vault client's `normalizeVenture` + storage key rather than re-declaring either, and
// adds nothing to the module graph beyond a Set and the store functions. `null` means
// "All ventures" (no filter) — the same contract every scoped fetcher already honours.
import { useSyncExternalStore } from "react";
import { normalizeVenture, VENTURE_STORAGE_KEY } from "./vaultClient.ts";

type Listener = () => void;
const listeners = new Set<Listener>();

// Read localStorage at CALL time (guarded): private mode, quota, or a server/test
// context with no `localStorage` all degrade to "All ventures" rather than throwing.
function fromStorage(): string | null {
  try {
    return normalizeVenture((globalThis as { localStorage?: Storage }).localStorage?.getItem(VENTURE_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

// The one source of truth. Initialised from storage at module load; every read after
// that is O(1) off this value, so `getSnapshot` is stable for `useSyncExternalStore`.
let current: string | null = fromStorage();

/** The current scope: a venture slug, or null for "All ventures". */
export function getVenture(): string | null {
  return current;
}

/**
 * Set the scope. Normalises (a non-slug or "all" becomes null), persists to
 * localStorage (idempotently), and notifies subscribers ONLY when the value actually
 * changed — an unchanged write must not churn every open page's fetch.
 */
export function setVenture(next: string | null): string | null {
  const v = normalizeVenture(next);
  const changed = v !== current;
  current = v;
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (v) ls?.setItem(VENTURE_STORAGE_KEY, v);
    else ls?.removeItem(VENTURE_STORAGE_KEY);
  } catch {
    /* private mode / quota — the scope still applies for this session */
  }
  if (changed) for (const fn of listeners) fn();
  return v;
}

/** Re-read localStorage into the store (e.g. a value another tab wrote). */
export function reloadVenture(): string | null {
  return setVenture(fromStorage());
}

/** Subscribe to scope changes; returns an unsubscribe. */
export function subscribeVenture(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * The app-wide hook. `venture` re-renders the caller on every change; `setVenture`
 * broadcasts to all subscribers. This is the ONE way BOS surfaces read/write the scope.
 */
export function useVenture(): { venture: string | null; setVenture: (v: string | null) => void } {
  const venture = useSyncExternalStore(subscribeVenture, getVenture, getVenture);
  return { venture, setVenture };
}

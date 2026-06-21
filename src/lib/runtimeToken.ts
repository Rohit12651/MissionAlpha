// Shared runtime auth token (same-origin via vite), cached once. Used by App for
// thread fork/resume; ChatPane keeps its own copy of this pattern for chat calls.
let tokenPromise: Promise<string> | null = null;

export function runtimeToken(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = fetch("/api/runtime-token", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { token: "" }))
      .then((j) => (j as { token?: string }).token ?? "")
      .catch(() => "");
  }
  return tokenPromise;
}

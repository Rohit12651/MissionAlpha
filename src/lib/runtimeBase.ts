// Runtime base + token source. Dev (vite): base "" (proxy) + token from /api/runtime-token.
// Packaged (electron): base http://127.0.0.1:3005 + token from the contextBridge.
interface MABridge { isPackaged: boolean; runtimeBase: string; getRuntimeToken: () => Promise<string>; }
const bridge: MABridge | undefined = (globalThis as any).missionAlpha;

export const RUNTIME_BASE = bridge?.isPackaged ? bridge.runtimeBase : "";
export function runtimeUrl(path: string): string { return RUNTIME_BASE + path; }

let tokenPromise: Promise<string> | null = null;
export function runtimeToken(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = bridge?.isPackaged
      ? bridge.getRuntimeToken().catch(() => "")
      : fetch("/api/runtime-token", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : { token: "" }))
          .then((j) => (j as { token?: string }).token ?? "").catch(() => "");
  }
  return tokenPromise;
}

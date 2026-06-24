// Runtime base + token source. Dev (vite): base "" (proxy) + token from /api/runtime-token.
// Packaged (electron): base http://127.0.0.1:3005 + token from the contextBridge.

// Host-dependency preflight result pushed from electron/main.cjs over the
// contextBridge (electron/preflight.js shape). Undefined in dev/vite where the
// bridge is absent — every consumer MUST optional-chain `window.missionAlpha`.
export interface PreflightResult {
  claude: boolean;
  docker: boolean;
  auth: boolean;
  ok: boolean;
  blocking: boolean;
  messages: string[];
}

interface MABridge {
  isPackaged: boolean;
  runtimeBase: string;
  getRuntimeToken: () => Promise<string>;
  onPreflight: (cb: (result: PreflightResult) => void) => void;
  // Project folder hot-swap (added with the project-picker feature).
  pickFolder?: () => Promise<string | null>;
  getRepoRoot?: () => Promise<string | null>;
  setRepoRoot?: (path: string) => Promise<{ ok: boolean; error?: string }>;
}

// Augment the global so consumers read a typed (optional) bridge — never crashes
// when missionAlpha is undefined (dev, or before preload runs).
declare global {
  interface Window {
    missionAlpha?: MABridge;
  }
}

const bridge: MABridge | undefined = (globalThis as { missionAlpha?: MABridge }).missionAlpha;

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

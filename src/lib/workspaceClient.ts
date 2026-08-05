// P5 — workspace + gh-status client. The PURE half (labels, path display, PR-URL
// validation) has zero DOM and zero network so it runs under
// `node --experimental-strip-types`. Token pattern cloned from inboxClient.ts.
//
// HONESTY RULE: every label here states what will ACTUALLY happen. When `gh` is
// missing or unauthenticated, the copy says "commits to a local branch" — it never
// implies a pull request the runtime cannot open.
import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

export interface GhStatus {
  installed: boolean;
  authenticated: boolean;
  hasRemote: boolean;
}

export interface WorkspaceInfo {
  /** The root THIS runtime process booted with. */
  repoPath: string;
  /** The persisted choice — differs from `repoPath` until the runtime restarts. */
  configured: string | null;
  configDir: string;
  isGit: boolean;
  seedDirs: string[];
  /** RUNTIME_REPO_ROOT is set: the env pin wins and a UI change cannot take effect. */
  envPinned: boolean;
  gh: GhStatus;
}

export interface WorkspaceSetResult {
  ok: boolean;
  error?: string;
  repoPath?: string;
  active?: string;
  restartRequired?: boolean;
  envPinned?: boolean;
}

/** How a Delivery left the runtime (agent-runtime/pr.mjs). */
export type DeliveryMode = "pr" | "branch" | "apply" | null;

// ── pure helpers ────────────────────────────────────────────────────────────

export function displayPath(p: string | null | undefined, home?: string): string {
  if (!p) return "No workspace selected";
  const h = home ?? "";
  return h && p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}

/**
 * One honest sentence about what Approve will actually do. Every non-ready state
 * names the branch fallback, so the operator is never surprised by a missing PR.
 */
export function ghLabel(s: GhStatus): string {
  if (!s.installed) return "gh not installed — approvals commit to a local branch";
  if (!s.authenticated) return "gh not authenticated — approvals commit to a local branch";
  if (!s.hasRemote) return "no remote on this repo — approvals commit to a local branch";
  return "gh ready — approvals open a pull request";
}

/** Semantic tone for the gh indicator dot. Ready is the only green. */
export function ghTone(s: GhStatus): "green" | "amber" {
  return s.installed && s.authenticated && s.hasRemote ? "green" : "amber";
}

export function modeLabel(mode: DeliveryMode, branch: string | null): string {
  switch (mode) {
    case "pr":
      return "pull request opened";
    case "branch":
      return `committed to branch ${branch ?? "(unknown)"}`;
    case "apply":
      return "applied directly to the working tree";
    default:
      return "";
  }
}

const GH_HOST = /^(.+\.)?github\.com$/;

/**
 * Only an https GitHub URL may become a clickable link. The PR URL originates in
 * `gh` stdout, which is a subprocess boundary — treat it as untrusted and validate
 * the PARSED origin, never a substring match (`https://evil.tld/github.com/x` and
 * `https://github.com.evil.tld/x` both have to fail).
 */
export function isSafePrUrl(u: string | null | undefined): boolean {
  if (!u) return false;
  try {
    const p = new URL(u);
    return p.protocol === "https:" && GH_HOST.test(p.hostname);
  } catch {
    return false;
  }
}

// ── fetchers ────────────────────────────────────────────────────────────────

async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
  // 400 carries the validator's readable reason and IS the useful answer; every
  // other non-2xx is a transport failure.
  if (!r.ok && r.status !== 400) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const getWorkspace = () => authedJson<WorkspaceInfo>("/runtime/workspace");

export const setWorkspace = (repoPath: string) =>
  authedJson<WorkspaceSetResult>("/runtime/workspace", { method: "POST", body: JSON.stringify({ repoPath }) });

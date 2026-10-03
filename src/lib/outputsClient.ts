// B7 — Outputs client: typed fetchers over the vite-proxied /runtime/outputs route, the
// audit-bundle download helper (fetch → blob → save, no new lib), plus the PURE view-model
// the registry rows are made of (icon key, label, meta line). The pure half has zero DOM and
// zero network so it is unit-testable under `node --experimental-strip-types`; the download
// helper is the only DOM-touching function and is never called at import time.
//
// HONEST BY CONSTRUCTION: `generators` are the REAL always-available capabilities the server
// reports (currently just the audit export) and `outputs` are artifacts the runtime has
// actually produced. The client never fabricates a file list — an empty produced set renders
// the generator + an honest empty state.
//
// Token pattern is cloned from cadenceClient.ts: same same-origin runtime
// token, same x-runtime-token header, same runtimeUrl() base (dev-proxied AND packaged).

import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

/** The audit export — the one generator the server always reports. Pinned by a test against
 *  agent-runtime/outputs.mjs AUDIT_GENERATOR. */
export const AUDIT_KIND = "audit";
export const AUDIT_EXPORT_PATH = "/runtime/audit/export";

/** One PRODUCED artifact — mirrors agent-runtime/outputs.mjs hydrate() exactly. */
export interface OutputRecord {
  id: string;
  kind: string;
  /** The owning venture slug, or null for a GLOBAL artifact (the audit bundle). */
  venture: string | null;
  label: string;
  /** The download path (fetch → blob target). A link only — never executed. */
  ref: string;
  /** Absolute-UTC ms the artifact was produced. */
  createdAt: number;
}

/** One always-available generator — mirrors agent-runtime/outputs.mjs AUDIT_GENERATOR. */
export interface OutputGenerator {
  kind: string;
  label: string;
  ref: string;
  desc: string;
}

export interface OutputsResponse {
  generators: OutputGenerator[];
  outputs: OutputRecord[];
}

export type AuditFormat = "json" | "csv";

// ── pure helpers ──────────────────────────────────────────────────────────────

// ── fetchers (cadenceClient.ts token pattern) ───────────────────────────────
async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
  if (!r.ok && r.status !== 400 && r.status !== 403 && r.status !== 404) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** GET /runtime/outputs — the venture-scoped registry: always-available generators + the
 *  produced-artifact list (newest first). Viewer-readable. */
export const listOutputs = (venture: string | null) =>
  authedJson<OutputsResponse>(`/runtime/outputs${venture ? `?venture=${encodeURIComponent(venture)}` : ""}`);

/** Build the audit-export download path with an optional date range + format. */
export function auditExportPath(opts: { from?: string; to?: string; format?: AuditFormat } = {}): string {
  const p = new URLSearchParams();
  if (opts.from) p.set("from", opts.from);
  if (opts.to) p.set("to", opts.to);
  p.set("format", opts.format === "csv" ? "csv" : "json");
  return `${AUDIT_EXPORT_PATH}?${p.toString()}`;
}

/** Filename from a Content-Disposition header, or a sensible default. */
function filenameFrom(disposition: string | null, fallback: string): string {
  const m = disposition ? /filename="?([^";]+)"?/.exec(disposition) : null;
  return m ? m[1] : fallback;
}

/**
 * Download the audit bundle: fetch it token-gated (a browser <a download> cannot set the
 * x-runtime-token header, so the download MUST go through fetch), read the response as a
 * blob, and save it via a transient object-URL anchor. No new dependency. Throws on a
 * non-2xx response so the caller can surface an inline error instead of a silent no-op.
 */
export async function downloadAudit(opts: { from?: string; to?: string; format?: AuditFormat } = {}): Promise<void> {
  const format: AuditFormat = opts.format === "csv" ? "csv" : "json";
  const path = auditExportPath({ ...opts, format });
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    cache: "no-store",
    headers: { "x-runtime-token": token },
  });
  if (!r.ok) throw new Error(`export failed (HTTP ${r.status})`);
  const blob = await r.blob();
  const stamp = new Date().toISOString().slice(0, 10);
  const name = filenameFrom(r.headers.get("content-disposition"), `mission-audit-${stamp}.${format}`);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the click's navigation has claimed the URL first.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

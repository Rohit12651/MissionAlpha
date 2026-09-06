// Phase 13 / task 13.2 — the Jira client. Typed fetchers over the vite-proxied /runtime/jira
// routes, plus the PURE layer JiraPicker renders from (zero DOM, zero network, so it is
// unit-testable under `node --experimental-strip-types`).
//
// Token pattern is cloned verbatim from jobsClient.ts / rosterClient.ts.
//
// THE PARSER IS DEFENSIVE for a sharper reason than the roster's: these rows are SUMMARIES A
// STRANGER WROTE. A ticket title is arbitrary text from whoever can file an issue, so it is
// dropped if unusable, capped if long, and rendered by React as a text node — never markup.
// Nothing here is the security control (the runtime fences the text before it reaches any
// prompt); this is the window, and it must not be the reason the board white-screens.

import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

/** Mirrors the adapter's MAX_JIRA_SUMMARY. A picker row is one line, not a paragraph. */
export const MAX_TICKET_SUMMARY = 300;

export interface JiraTicket {
  key: string;
  summary: string;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v ? v : fallback);

/** PURE. Parse a `/runtime/jira/tickets` payload. A row with no key is dropped. */
export function parseTickets(raw: unknown): JiraTicket[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const rows = (raw as { issues?: unknown }).issues;
  if (!Array.isArray(rows)) return [];
  const out: JiraTicket[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const rec = r as Record<string, unknown>;
    const key = str(rec.key);
    if (!key) continue;
    out.push({ key, summary: str(rec.summary, "(no summary)").slice(0, MAX_TICKET_SUMMARY) });
  }
  return out;
}

/**
 * PURE. Turn a runtime error body into one line an operator can act on.
 * The runtime already says WHY (no account, bad token, 401 from Jira); repeating it verbatim
 * beats a generic "could not load tickets", which tells nobody what to change.
 */
export function ticketError(raw: unknown, status: number): string {
  const msg = raw && typeof raw === "object" ? str((raw as { error?: unknown }).error) : "";
  if (msg) return msg;
  return status === 401 ? "not authorised" : `jira unavailable (HTTP ${status})`;
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await runtimeToken();
  return fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
}

/** List tickets for a JQL. Throws with the runtime's own reason so the UI can show it. */
export async function fetchTickets(jql: string): Promise<JiraTicket[]> {
  const res = await authed(`/runtime/jira/tickets?jql=${encodeURIComponent(jql)}`);
  if (!res.ok) throw new Error(ticketError(await res.json().catch(() => null), res.status));
  return parseTickets(await res.json());
}

/**
 * Turn one ticket into a Job. A 409 is NOT an error to the operator: the ticket already has a
 * job, which is what they were asking for. It comes back flagged so the UI can say "already
 * queued" instead of "failed".
 */
export async function createJobFromTicket(key: string): Promise<{ id: string; duplicate: boolean }> {
  const res = await authed("/runtime/jobs/from-jira", { method: "POST", body: JSON.stringify({ key }) });
  const body = await res.json().catch(() => null);
  if (res.status === 409) {
    const id = str((body as { job?: { id?: unknown } } | null)?.job?.id);
    return { id, duplicate: true };
  }
  if (!res.ok) throw new Error(ticketError(body, res.status));
  return { id: str((body as { id?: unknown } | null)?.id), duplicate: false };
}

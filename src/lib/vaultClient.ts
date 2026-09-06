// B2 / ADR-055 — Knowledge Vault client: typed fetchers over the vite-proxied
// /runtime/vault routes, plus the PURE layer the Vault UI is actually made of (the
// markdown line parser, the node meta table, the venture-scope helpers). The pure
// half has zero DOM and zero network so it is unit-testable under
// `node --experimental-strip-types`.
//
// Token pattern is cloned verbatim from inboxClient.ts: same same-origin runtime
// token, same x-runtime-token header, same runtimeUrl() base so it works dev-proxied
// AND packaged.
//
// RENDERING RULE (BLOCKING, B2): a record body is AGENT-AUTHORED text. It is never
// handed to innerHTML / dangerouslySetInnerHTML anywhere. `parseMdLines` turns it into
// a typed array of lines, and the viewer renders each line's `text` as a React TEXT
// NODE — so markup inside a body is DISPLAYED, never executed. That is why this parser
// returns data instead of a string of HTML: there is no HTML to get wrong.
import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

// ── Node taxonomy — the client mirror of agent-runtime/vault.mjs VAULT_NODES ──
// Pinned by a unit test. The server CHECK-constrains the same six, so a seventh node
// is a migration + an ADR amendment, never a client-side addition.
export const VAULT_NODES = ["ventures", "market", "content", "pipeline", "tech", "decisions"] as const;
export type VaultNode = (typeof VAULT_NODES)[number];

export interface VaultNodeMeta {
  /** Display label on the graph + the crumb. */
  label: string;
  /** One line explaining what lands here — the empty state uses it verbatim. */
  blurb: string;
}

/** Label + blurb per node. Closed record: every node has an entry, no fallback path. */
export const NODE_META: Record<VaultNode, VaultNodeMeta> = {
  ventures: { label: "Ventures", blurb: "Roll-ups and performance across every venture." },
  market: { label: "Market", blurb: "Competitor sweeps, vendor notes and inbox intel." },
  content: { label: "Content", blurb: "Briefs, angles and what last week's content did." },
  pipeline: { label: "Pipeline", blurb: "Leads, follow-ups and deals that need a nudge." },
  tech: { label: "Tech", blurb: "Repo health, workflow audits and build handoffs." },
  decisions: { label: "Decisions", blurb: "Every approval, rejection and change request you made." },
};

/** True for a string the server would accept as a node. Narrows the type. */
export function isVaultNode(s: string): s is VaultNode {
  return (VAULT_NODES as readonly string[]).includes(s);
}

export const nodeLabel = (n: string): string => (isVaultNode(n) ? NODE_META[n].label : n);

// ── Types — mirror agent-runtime/vault.mjs hydrate() exactly ────────────────
export interface VaultRecordMeta {
  id: string;
  venture: string;
  node: VaultNode;
  title: string;
  /** The agent id (completion record) or the deciding identity (decision record). */
  author: string;
  /** The run/task/delivery this record came from, or null for a hand-written one. */
  sourceRun: string | null;
  createdAt: string;
  /** First 240 scrubbed chars of the body — what `q` searches. */
  excerpt: string;
}

/** GET /runtime/vault — the record list (metadata only; bodies stay behind /record). */
export interface VaultList {
  records: VaultRecordMeta[];
}

/** GET /runtime/vault/record?id — one record. */
export interface VaultRecord {
  meta: VaultRecordMeta;
  body: string;
}

export interface VentureRef {
  id: string;
  name: string;
  createdAt: string;
  records: number;
}

/** GET /runtime/vault/stats. `byNode` is zero-filled across the whole taxonomy. */
export interface VaultStats {
  total: number;
  byNode: Record<VaultNode, number>;
  byVenture: Record<string, number>;
  ventures: VentureRef[];
}

// ── Venture scope ───────────────────────────────────────────────────────────
// The chosen scope lives in localStorage so it survives a reload. `null` = ALL
// ventures (no filter) — the sidebar's "All ventures" row. B5 makes this scope
// app-wide; B2 wires it to the Vault page and the deck's RECORDS READ only.
export const VENTURE_STORAGE_KEY = "ma.bos.venture";

/**
 * Normalise a stored/queried venture into either a slug or null (= all). Anything
 * that is not slug-shaped becomes null rather than being sent to the server, so a
 * corrupted localStorage value degrades to "all ventures" instead of an empty page.
 */
export function normalizeVenture(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s === "all") return null;
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) ? s : null;
}

/** Venture rows for the switcher: every known venture with its live record count. */
export function ventureOptions(stats: VaultStats | null): VentureRef[] {
  if (!stats) return [];
  const byId = new Map(stats.ventures?.map((v) => [v.id, v]) ?? []);
  // byVenture is the authority on which scopes exist (it is zero-filled from the
  // ventures table), so a venture the `ventures` array somehow missed still lists.
  return Object.keys(stats.byVenture ?? {})
    .sort()
    .map((id) => byId.get(id) ?? { id, name: id, createdAt: "", records: stats.byVenture[id] ?? 0 });
}

// ── Markdown → typed lines (NO innerHTML, ever) ─────────────────────────────
export type MdKind = "h1" | "h2" | "p" | "li" | "code";

export interface MdLine {
  kind: MdKind;
  /** The line's TEXT. Rendered as a React text node — never as markup. */
  text: string;
}

/**
 * Parse a record body into renderable lines. Deliberately small: headings, list
 * items, fenced code and paragraphs. Everything else is a paragraph, and inline
 * markers (`**`, `_`, backticks, links) are left VERBATIM in the text — a half-
 * implemented inline renderer is how markup leaks back into a DOM sink, and showing
 * `**bold**` literally is honest where silently swallowing it is not.
 *
 * Blank lines are dropped (they carry no content once each line is its own element);
 * blank lines INSIDE a fence are preserved, because there they are content.
 */
export function parseMdLines(body: string): MdLine[] {
  const out: MdLine[] = [];
  if (typeof body !== "string" || !body) return out;
  let inFence = false;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { out.push({ kind: "code", text: line }); continue; }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{2,}\s+/.test(trimmed)) { out.push({ kind: "h2", text: trimmed.replace(/^#+\s+/, "") }); continue; }
    if (/^#\s+/.test(trimmed)) { out.push({ kind: "h1", text: trimmed.replace(/^#\s+/, "") }); continue; }
    if (/^([-*+]|\d+\.)\s+/.test(trimmed)) { out.push({ kind: "li", text: trimmed.replace(/^([-*+]|\d+\.)\s+/, "") }); continue; }
    out.push({ kind: "p", text: trimmed });
  }
  return out;
}

// ── Formatting ──────────────────────────────────────────────────────────────
/** `2026-07-30 14:05` in local time. Empty string for an unparseable stamp. */
export function recordDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `N records` / `1 record` / `no records`. */
export function recordCountLabel(n: number): string {
  const c = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (c === 0) return "no records";
  return `${c} record${c === 1 ? "" : "s"}`;
}

// ── Query builders ──────────────────────────────────────────────────────────
export interface VaultQuery {
  venture?: string | null;
  node?: VaultNode | null;
  q?: string;
  limit?: number;
  offset?: number;
}

/** Clamps `limit` to the server's own [1,200] so the client never sends a value it reshapes. */
export function vaultQuery(q: VaultQuery = {}): string {
  const p = new URLSearchParams();
  const venture = normalizeVenture(q.venture);
  if (venture) p.set("venture", venture);
  if (q.node && isVaultNode(q.node)) p.set("node", q.node);
  const term = typeof q.q === "string" ? q.q.trim() : "";
  if (term) p.set("q", term.slice(0, 120));
  if (q.limit !== undefined) p.set("limit", String(Math.min(Math.max(Math.floor(q.limit) || 1, 1), 200)));
  if (q.offset !== undefined) p.set("offset", String(Math.max(Math.floor(q.offset) || 0, 0)));
  const s = p.toString().replace(/\+/g, "%20");
  return s ? `/runtime/vault?${s}` : "/runtime/vault";
}

export const statsQuery = (venture?: string | null): string => {
  const v = normalizeVenture(venture);
  return v ? `/runtime/vault/stats?venture=${encodeURIComponent(v)}` : "/runtime/vault/stats";
};

// ── Fetchers (inboxClient.ts token pattern) ─────────────────────────────────
async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
  // 400 (bad node/venture/title) and 403 (viewer) carry a JSON body the caller renders;
  // every other non-2xx is a transport-level failure.
  if (!r.ok && r.status !== 400 && r.status !== 403) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const listVault = (q: VaultQuery = {}) => authedJson<VaultList>(vaultQuery(q));

export const getVaultRecord = (id: string) =>
  authedJson<VaultRecord & { error?: string }>(`/runtime/vault/record?id=${encodeURIComponent(id)}`);

export const getVaultStats = (venture?: string | null) => authedJson<VaultStats>(statsQuery(venture));

// MUNDER-ADOPTION A4 — condenser status (GET /runtime/vault/reflect): config + last sweep.
export interface VaultReflectLaneResult {
  venture: string;
  node: string;
  aborted: boolean;
  reason?: string;
  evicted?: number;
  bytesBefore?: number;
  bytesAfter?: number;
}
export interface VaultReflectStatus {
  keepK: number;
  budgetBytes: number;
  minCoverage: number;
  coldRoot: string;
  last: { at: number; results: VaultReflectLaneResult[] } | null;
}
export const getVaultReflect = () => authedJson<VaultReflectStatus>("/runtime/vault/reflect");

/**
 * POST /runtime/vault/record. Approver-gated server-side when auth is active — a
 * viewer gets 403 with a readable body, which the caller surfaces rather than
 * pretending the write happened. The AUTHOR is set server-side from the session and
 * is deliberately not a parameter here.
 */
export const createVaultRecord = (body: { venture: string; node: VaultNode; title: string; body: string }) =>
  authedJson<{ record?: VaultRecordMeta; error?: string }>("/runtime/vault/record", {
    method: "POST",
    body: JSON.stringify(body),
  });

// Inbox client (P3 / ADR-051) — typed fetchers over the vite-proxied /inbox
// routes the P2 Delivery engine serves, plus the PURE list helpers the Inbox UI
// is actually made of (filters, badge math, labels). The pure half has zero DOM
// and zero network so it is unit-testable under `node --experimental-strip-types`.
//
// Token pattern is cloned verbatim from factoryClient.ts: same same-origin
// runtime token, same x-runtime-token header, same runtimeUrl() base so it works
// dev-proxied AND packaged.
//
// HONESTY RULE (P6/ADR-053 owns risk + SLA): `risk.band`, `risk.score` and
// `slaDeadline` are NULL in every P2-minted Delivery, and `auto_approved` is
// blocked at the engine (deliveries.mjs). This module renders that truth —
// `unrated`, no countdown — and never fabricates a band or a deadline.
import type { TrustStamp, InjectFlags } from "./externalTrust.ts";
import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

// ── Types — mirror agent-runtime/deliveries.mjs hydrate() exactly ────────────
export type DeliveryStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "auto_approved";
export type DeliverySource = "swarm" | "claude-code" | "github-pr" | "slack" | "external";
/**
 * `failure` (P4 / ADR-051 §9) is the diff-less "agent stuck — needs you" row. `question`,
 * `design-approval` (S2) and `release-approval` (S5) are the diff-less HUMAN-GATE rows a Story
 * pipeline lands: a clarify question the BOSS answers, the architect design gate the BOSS decides,
 * and the release-accept gate the BOSS decides before a deploy executes. Mirrors
 * agent-runtime/deliveries.mjs KINDS exactly.
 */
export type DeliveryKind = "code" | "doc" | "post" | "command" | "failure" | "question" | "design-approval" | "release-approval" | "job-approval";
export type RiskBand = "low" | "medium" | "high" | null;
export type DecideVerb = "approve" | "reject" | "request_changes";

export interface Diffstat {
  files: number;
  additions: number;
  deletions: number;
}

export interface Delivery {
  id: string;
  agentId: string;
  taskId: string | null;
  title: string;
  summary: string;
  source: DeliverySource;
  kind: DeliveryKind;
  diffstat: Diffstat;
  /** Flat mirrors of `diffstat` the engine also returns; kept for parity. */
  diffFiles: number;
  diffAdditions: number;
  diffDeletions: number;
  changedPaths: string[];
  risk: { score: number | null; band: RiskBand; reasons: string[] };
  status: DeliveryStatus;
  /** Absolute UTC ISO deadline. NULL until P6 — no countdown is rendered while null. */
  slaDeadline: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  feedback: string | null;
  auditRef: string;
  /**
   * P5 — HOW this Delivery left the runtime (`agent-runtime/pr.mjs`). Null while
   * pending. 'pr' = a real pull request was opened; 'branch' = the commit is on
   * `branch` and no PR could be opened; 'apply' = written straight into the
   * working tree (non-git target, or a manual /run delivery).
   */
  mode: "pr" | "branch" | "apply" | null;
  /** The `ma/task/<id>` branch the approved commit landed on. */
  branch: string | null;
  /** The GitHub PR URL — present only when `mode === "pr"`. */
  prUrl: string | null;
  /**
   * P6 — SLA escalation stage. Null while inside the first half of the window;
   * 'halflife' once the sweep re-notified; 'expired' once past the deadline. The
   * countdown itself is rendered from `slaDeadline` (drift-free), this only marks
   * how far the server-side escalation has advanced.
   */
  slaState: "halflife" | "expired" | null;
  /**
   * P7 — external ingestion (ADR-054). `externalKey` is the idempotency key (repo#PR@sha
   * or session id); `externalMeta` carries source-specific render + routing data. Both
   * null for swarm rows.
   */
  externalKey?: string | null;
  externalMeta?: ExternalMeta | null;
  /**
   * P9 — advisory assignment: the approver name expected to decide this delivery, or
   * null. A hint only — any approver may still decide. Set via `assignDelivery`.
   */
  assignee?: string | null;
  /**
   * S2 — the Story a HUMAN-GATE delivery (`question` / `design-approval`) belongs to, or
   * null for every non-gate row. Used to route an answer/decision back to its Story.
   */
  storyId?: string | null;
}

/** Source-specific metadata an adapter attaches to an external Delivery. */
export interface ExternalMeta {
  repo?: string;
  prNumber?: number;
  headSha?: string;
  url?: string | null;
  branch?: string;
  author?: string;
  sessionId?: string;
  readOnly?: boolean;
  workspaceSlug?: string;
  files?: number;
  updatedAt?: string;
  /**
   * R10 — the behavioural trust stamp for the SOURCE that ingested this row, taken at
   * ingest time. Advisory: it adds review friction and can never grant permission
   * (deliveries.mjs refuses auto-apply for any non-swarm source, producer-side).
   */
  trust?: TrustStamp | null;
  /**
   * R12 — prompt-injection patterns matched in the incoming title + body. A MARKER only:
   * the content was never filtered, rewritten or rejected.
   *
   * NOTE, and this bounds what the UI can honestly do: `inject-detect.flagSummary()`
   * keeps counts, severity and pattern ids but DISCARDS the character spans. The offsets
   * would not survive the scrub chain anyway — they are computed pre-scrub, and scrubbing
   * rewrites the string — so highlighting matched ranges in the review pane is NOT
   * possible from this payload, and guessing at them in a security surface would be worse
   * than showing none.
   */
  injectFlags?: InjectFlags | null;
}

/** One reviewable file, rebuilt server-side from the on-disk patch. */
export interface DeliveryChange {
  path: string;
  status: "new" | "modified";
  before: string | null;
  after: string;
  patch: string;
  /**
   * Phase 4 — can this file be edited before approval?
   *
   * False when the reviewed text is not the text on disk: the broker truncates at 4000
   * chars and the scrub layer redacts secrets before anyone sees the diff, and the
   * runtime fails closed on an edit to such a file. The client MUST honour this rather
   * than offering an Edit button whose refusal only arrives after Approve is pressed.
   * Optional so a pre-Phase-4 payload still type-checks; treat `undefined` as editable.
   */
  editable?: boolean;
  /** Why editing is unavailable, in words fit to show the operator. Null when editable. */
  editableReason?: string | null;
}

/** Phase 4 — a refusal bound to the file that caused it, for field-level display. */
export interface DeliveryEditError {
  path: string;
  message: string;
}

/** GET /inbox/:id — a Delivery plus its full change set. */
export interface DeliveryDetail extends Delivery {
  changes: DeliveryChange[];
}

export interface InboxCounts {
  [status: string]: number;
}

export interface InboxList {
  deliveries: Delivery[];
  counts: InboxCounts;
}

/** POST /inbox/:id/<verb> result — the decided Delivery + per-verb side-effect fields. */
export interface DecideResult extends Partial<Delivery> {
  code?: number;
  error?: string;
  applyResults?: { path: string; ok?: boolean; error?: string }[];
  applyError?: string;
  discardError?: string;
  rerun?: unknown;
  rerunError?: string;
  /** P5 — why the ladder stopped where it did (e.g. "no remote configured"). */
  modeReason?: string;
  /** P5 — approved paths the broker guards refused before staging. */
  refusedPaths?: string[];
  /** P5 — the ladder itself faulted; the broker apply ran as the fallback. */
  deliverError?: string;
  /** Phase 4 — paths the operator revised before approving. Absent on a plain approve. */
  editedPaths?: string[];
  /** Phase 4 — refusals attributable to a specific file, for field-level display. */
  editErrors?: DeliveryEditError[];
}

// ── Filters (the merged mockup's five pills) ────────────────────────────────
export const INBOX_FILTERS = ["All", "High risk", "My swarm", "External", "Failures"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/**
 * S2/S5 — the diff-less HUMAN-GATE kinds. `question` is answered; `design-approval` and
 * `release-approval` are decided (approve / request-changes / reject). Mirrors deliveries.mjs GATE_KINDS.
 */
// Phase 11 — `job-approval` is the JOB gate: ONE decision that ships every task in a job.
export const GATE_KINDS: readonly DeliveryKind[] = ["question", "design-approval", "release-approval", "job-approval"];
export const isGate = (d: Delivery): boolean => GATE_KINDS.includes(d.kind);
export const isQuestion = (d: Delivery): boolean => d.kind === "question";
export const isDesignGate = (d: Delivery): boolean => d.kind === "design-approval";
export const isReleaseGate = (d: Delivery): boolean => d.kind === "release-approval";

/** Short label for a gate chip on the card / review pane. */
const GATE_LABEL: Partial<Record<DeliveryKind, string>> = {
  question: "clarify question",
  "design-approval": "design gate",
  "release-approval": "release gate",
};
export const gateLabel = (kind: DeliveryKind): string | null => GATE_LABEL[kind] ?? null;

/**
 * A failure Delivery: the runtime minted it because an agent got terminally stuck
 * (retry budget spent, or a non-retryable guard verdict). `kind === "failure"` is the
 * P4 signal; the diff-less fallback keeps any row minted before P4 classified right — but a
 * diff-less HUMAN-GATE (question / design-approval) is NOT a failure, so it is excluded.
 */
export const isFailure = (d: Delivery): boolean =>
  d.kind === "failure" || (d.changedPaths.length === 0 && !GATE_KINDS.includes(d.kind));

/**
 * Filter predicate. Unknown filter strings fail OPEN (match everything) so a
 * future filter name can never blank the operator's list.
 */
export function matchesFilter(d: Delivery, filter: InboxFilter): boolean {
  switch (filter) {
    case "High risk":
      return d.risk.band === "high";
    case "My swarm":
      return d.source === "swarm";
    case "External":
      return d.source !== "swarm";
    case "Failures":
      return isFailure(d);
    default:
      return true;
  }
}

// ── Badge math ──────────────────────────────────────────────────────────────
export const isPending = (d: Delivery): boolean => d.status === "pending";
export const pendingCount = (list: readonly Delivery[]): number => list.filter(isPending).length;

// ── Labels ──────────────────────────────────────────────────────────────────
const RISK_LABEL: Record<"low" | "medium" | "high", string> = {
  low: "low risk",
  medium: "medium",
  high: "high risk",
};
const RISK_TONE: Record<"low" | "medium" | "high", string> = {
  low: "green",
  medium: "amber",
  high: "red",
};

/** `unrated` while P2 leaves the band null — never an invented band. */
export const riskLabel = (band: RiskBand): string => (band ? RISK_LABEL[band] : "unrated");
export const riskTone = (band: RiskBand): string => (band ? RISK_TONE[band] : "muted");

export function diffstatLabel(d: Delivery): { files: string; add: string; del: string } {
  const n = d.diffstat.files;
  return {
    files: n === 0 ? "no files" : `${n} file${n === 1 ? "" : "s"}`,
    add: `+${d.diffstat.additions}`,
    del: `−${d.diffstat.deletions}`, // U+2212 minus, matching the mockup
  };
}

const DECIDED_LABEL: Record<DeliveryStatus, string> = {
  pending: "pending",
  approved: "approved · applied",
  rejected: "rejected",
  changes_requested: "changes requested",
  auto_approved: "auto-approved",
};
export const decidedLabel = (s: DeliveryStatus): string => DECIDED_LABEL[s] ?? String(s);

// ── Source (P7 / ADR-054) ────────────────────────────────────────────────────
const SOURCE_LABEL: Record<DeliverySource, string> = {
  swarm: "swarm",
  "github-pr": "GitHub PR",
  "claude-code": "Claude Code",
  slack: "Slack", // MUNDER-ADOPTION A7
  external: "external",
};
export const sourceLabel = (s: DeliverySource): string => SOURCE_LABEL[s] ?? String(s);

// Chip tone per source: github-pr gets its own brass identity, claude-code reads as a
// muted/grey read-only origin, swarm stays neutral.
const SOURCE_TONE: Record<DeliverySource, string> = {
  swarm: "muted",
  "github-pr": "brass",
  "claude-code": "grey",
  slack: "green", // MUNDER-ADOPTION A7 — an ingress request, visually distinct from code sources
  external: "muted",
};
export const sourceTone = (s: DeliverySource): string => SOURCE_TONE[s] ?? "muted";

/** Read-only sources carry no decide action in v1 (visibility only). */
export const READ_ONLY_SOURCES: readonly DeliverySource[] = ["claude-code", "slack"];
export const isReadOnlySource = (s: DeliverySource): boolean => READ_ONLY_SOURCES.includes(s);
export const isReadOnly = (d: Delivery): boolean => isReadOnlySource(d.source);

/** The literal a human must type to unlock Approve on a high-risk Delivery. */
export const TYPED_CONFIRM = "APPLY";

/**
 * Is Approve locked? TRUE only for `band === "high"` until the operator has typed
 * the confirmation exactly (case- and whitespace-sensitive on purpose — this is a
 * deliberate friction gate, not a search box).
 *
 * P2 always writes a null band, so today this returns false for every real
 * Delivery. It is live code, not a stub: the moment ADR-053 (P6) writes
 * `band: "high"`, Approve is already gated with no component change.
 */
export interface ApproveKind {
  /** A design-approval gate: advances a story to Plan. Writes nothing. */
  designGate?: boolean;
  /** A diff-less "agent is stuck" row. Approving it decides a failure, not a change. */
  failure?: boolean;
}

/**
 * Does the operator still owe a typed confirmation before Approve can fire?
 *
 * The confirmation exists to slow down a high-risk ACT. Which deliveries that covers is a
 * judgement, and it is made once, here:
 *   • a high-band DIFF          → yes. Approving writes those files.
 *   • a RELEASE gate            → yes. It carries no diff, but approving it DEPLOYS.
 *   • a DESIGN gate             → no. It advances a story to Plan and writes nothing.
 *   • a FAILURE row             → no. Deciding a stuck-agent row changes no code.
 *
 * WHY IT TAKES THE KIND AT ALL: ReviewPane rendered the confirm INPUT under
 * `isHigh && !failure && !gate` while computing this from the band ALONE. On a high-band
 * design gate that produced a permanently disabled Approve button whose tooltip told the
 * operator to type APPLY into a field that was not on the page — so no gate on this install
 * had ever been approved from the UI; every one went through curl. Found by trying to click
 * it. Both the field and the button now read this one predicate, so they cannot disagree
 * again, and the release gate KEEPS its friction rather than losing it to the same fix.
 *
 * Split in two on purpose: `needsTypedConfirm` says whether this delivery has a confirmation
 * step at all, and `isApproveBlocked` says whether it is still outstanding. Rendering the
 * FIELD from the blocked flag made the input vanish the instant the word was typed into it.
 */
export function needsTypedConfirm(band: RiskBand, kind: ApproveKind = {}): boolean {
  if (kind.designGate || kind.failure) return false;
  return band === "high";
}

export function isApproveBlocked(band: RiskBand, typed: string, kind: ApproveKind = {}): boolean {
  return needsTypedConfirm(band, kind) && typed !== TYPED_CONFIRM;
}

// ── SLA countdown formatter (pure — drift-free, rendered from the absolute deadline) ─
export interface SlaView {
  /** e.g. "SLA 01:23:45", "SLA 04:12", or "SLA expired". */
  label: string;
  /** Under one hour remaining — the timer turns red. */
  hot: boolean;
  /** Past the deadline. */
  expired: boolean;
  /** Whole seconds left (>= 0), for tick scheduling. */
  secondsLeft: number;
}

const HOUR_MS = 3_600_000;

/** Format the time between now and an absolute UTC deadline. Null deadline ⇒ null. */
export function formatSla(deadline: string | null, nowMs: number = Date.now()): SlaView | null {
  if (!deadline) return null;
  const ms = Date.parse(deadline) - nowMs;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return { label: "SLA expired", hot: true, expired: true, secondsLeft: 0 };
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return { label: `SLA ${clock}`, hot: ms < HOUR_MS, expired: false, secondsLeft: total };
}

/** Up to two uppercase initials for the card avatar. */
export function avatarFor(agentId: string): string {
  const parts = String(agentId).split(/[^a-z0-9]+/i).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ── Route builders ──────────────────────────────────────────────────────────
const VERB_SEGMENT: Record<DecideVerb, string> = {
  approve: "approve",
  reject: "reject",
  request_changes: "request-changes",
};

export const decidePath = (id: string, verb: DecideVerb): string =>
  `/inbox/${encodeURIComponent(id)}/${VERB_SEGMENT[verb]}`;

export interface ListQuery {
  status?: DeliveryStatus;
  agentId?: string;
  limit?: number;
  offset?: number;
}

/** Clamps `limit` to the server's own [1,200] so the client never sends a value it reshapes. */
export function listQuery(q: ListQuery = {}): string {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.agentId) p.set("agentId", q.agentId);
  if (q.limit !== undefined) p.set("limit", String(Math.min(Math.max(Math.floor(q.limit) || 1, 1), 200)));
  if (q.offset !== undefined) p.set("offset", String(Math.max(Math.floor(q.offset) || 0, 0)));
  const s = p.toString().replace(/\+/g, "%20");
  return s ? `/inbox?${s}` : "/inbox";
}

// ── Fetchers (factoryClient.ts token pattern) ───────────────────────────────
async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
  if (!r.ok && r.status !== 409 && r.status !== 400) {
    // 409 (already decided) / 400 (feedback required) carry a useful JSON body the
    // caller renders; every other non-2xx is a transport-level failure.
    throw new Error(`HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

export const listInbox = (q: ListQuery = {}, signal?: AbortSignal) => authedJson<InboxList>(listQuery(q), { signal });

export const getDelivery = (id: string) =>
  authedJson<DeliveryDetail & { error?: string }>(`/inbox/${encodeURIComponent(id)}`);

/**
 * Phase 4 — an operator revision of the agent's proposal, sent with an approve.
 *
 * `after` is the FULL new body of that file, not a diff. The runtime validates it against
 * the delivery's own changedPaths, re-runs the broker's path guards, refuses if the text
 * the reviewer saw was scrubbed or truncated, stages it into the agent's workdir, and
 * then approves through the completely unchanged apply path.
 */
export interface DeliveryEdit {
  path: string;
  after: string;
}

export const decideDelivery = (
  id: string,
  verb: DecideVerb,
  body: { by?: string; feedback?: string; edits?: DeliveryEdit[] } = {},
) => authedJson<DecideResult>(decidePath(id, verb), { method: "POST", body: JSON.stringify(body) });

/**
 * Phase 2/3 — POST /inbox/bulk-decide. Decides many deliveries in ONE call.
 *
 * This is not a second decision path: the runtime loops the same `deliveries.decide()`
 * the single route uses, so every policy/broker/audit guard still applies per item.
 * Two extra server gates apply — a hard cap of 200 ids, and `confirmHighRisk` is
 * REQUIRED to bulk-approve anything in the high band (the single-delivery UI makes the
 * human type a confirm phrase; bulk must not become the way around that). Without it the
 * whole batch is refused and nothing is decided.
 */
export interface BulkDecideResult {
  ok?: boolean;
  requested?: number;
  decided?: number;
  results?: { id: string; ok: boolean; error?: string }[];
  error?: string;
  highRiskIds?: string[];
}

export const bulkDecide = (
  ids: readonly string[],
  decision: DecideVerb,
  body: { feedback?: string; confirmHighRisk?: boolean } = {},
) =>
  authedJson<BulkDecideResult>("/inbox/bulk-decide", {
    method: "POST",
    body: JSON.stringify({ ids, decision, ...body }),
  });

/**
 * P9 — POST /inbox/:id/assign {assignee}. Set (or clear, with null) the advisory
 * assignee. Approver-gated server-side when auth is active. Returns the updated
 * Delivery so the caller can update optimistically.
 */
export const assignDelivery = (id: string, assignee: string | null) =>
  authedJson<DecideResult>(`/inbox/${encodeURIComponent(id)}/assign`, {
    method: "POST",
    body: JSON.stringify({ assignee }),
  });

/**
 * S2 — answer a `question` gate. POST /runtime/stories/:storyId/answer {deliveryId, answer}.
 * Approver-gated server-side when auth is active. The runtime stores the answer on the story,
 * resolves this question gate, and (once every question is answered) re-runs requirements and
 * advances into design. Returns the pipeline's structured result (or {code, error}).
 */
export interface AnswerResult {
  code?: number;
  error?: string;
  status?: string;
  remaining?: number;
}
export const answerStoryQuestion = (storyId: string, deliveryId: string, answer: string) =>
  authedJson<AnswerResult>(`/runtime/stories/${encodeURIComponent(storyId)}/answer`, {
    method: "POST",
    body: JSON.stringify({ deliveryId, answer }),
  });

// ── queue snapshot (P4) ─────────────────────────────────────────────────────

/** One task row from GET /runtime/engine/runs. */
export interface QueueRunTask {
  taskId: string;
  goalId: string;
  agentId: string;
  status: string;
  engineState: string | null;
  attempts: number;
  priority: string;
  error: { kind?: string; msg?: string } | null;
}

export interface QueueRuns {
  tasks: QueueRunTask[];
  counts: Record<string, number>;
  inflight: number;
  maxInflight: number;
}

/**
 * Authoritative queue snapshot. Read on mount, on SSE resync, and on a debounced
 * trailing edge after a burst of task or delivery events — never on a timer. The v1
 * event catalog is closed and has no success-terminal name, so a task reaching DONE
 * leaves the queue without a frame; this read is how the strip learns.
 */
export const fetchQueueRuns = () => authedJson<QueueRuns>("/runtime/engine/runs");

/** POST /runtime/events/ticket — short-lived, single-use SSE credential (ADR-052 §6). */
export const mintEventTicket = () =>
  authedJson<{ ticket?: string; expiresAt?: number; ttlMs?: number; error?: string }>(
    "/runtime/events/ticket",
    { method: "POST" },
  );

// ── P6 / ADR-053 — the per-band risk policy (Settings → PolicyEditor) ────────
export type LowBehavior = "auto_approve" | "notify" | "human";
export type MedBehavior = "human" | "notify";
export type HighBehavior = "human" | "typed_confirm";
export interface PolicyBands {
  low: LowBehavior;
  medium: MedBehavior;
  high: HighBehavior;
}
/**
 * PHASE 2 TASK 2.2 — the diff-size ceiling. A band ceiling alone is not a bound: "low
 * risk" is a classifier's opinion about the KIND of change and says nothing about its
 * size, and a low-risk rewrite of forty files is still forty files nobody read.
 */
export interface PolicyLimits {
  maxFiles: number;
  maxLines: number;
}
export interface PolicyDoc {
  bands: PolicyBands;
  denyList: string[];
  limits: PolicyLimits;
  /**
   * The auto-approve path ALLOWLIST — deny-by-default, so a path nobody foresaw is
   * refused rather than permitted. This is the opposite polarity to `denyList`, which can
   * only ever refuse what someone thought to name. An empty list allows nothing.
   */
  allowList: string[];
  /** false ⇒ the file was corrupt and the runtime fell back to all-human. */
  valid: boolean;
  /** Effective SLA windows (ms) after env > policy > default resolution. */
  sla: { low: number; medium: number; high: number };
}

/** The behaviour options each band may take, in menu order. */
export const BEHAVIOR_OPTIONS: {
  low: LowBehavior[];
  medium: MedBehavior[];
  high: HighBehavior[];
} = {
  low: ["auto_approve", "notify", "human"],
  medium: ["human", "notify"],
  high: ["typed_confirm", "human"],
};

export const BEHAVIOR_LABEL: Record<string, string> = {
  auto_approve: "Auto-approve",
  notify: "Notify + hold for you",
  human: "Hold for you",
  typed_confirm: "Typed confirm (APPLY)",
};

/** Pure reducer: set one band's behaviour, returning a NEW bands object. */
export function setBand<K extends keyof PolicyBands>(bands: PolicyBands, band: K, value: PolicyBands[K]): PolicyBands {
  return { ...bands, [band]: value };
}

/** Pure: add a trimmed deny glob if non-empty and not already present (new array). */
export function addDeny(list: readonly string[], glob: string): string[] {
  const g = glob.trim();
  if (!g || list.includes(g)) return [...list];
  return [...list, g];
}

/** Pure: remove a deny glob (new array). */
export function removeDeny(list: readonly string[], glob: string): string[] {
  return list.filter((g) => g !== glob);
}

/**
 * Pure: clamp a typed ceiling into something the server will accept.
 *
 * The server rejects 0 and negatives outright (a ceiling of 0 is indistinguishable from
 * "unset" on the next load, and "unset" falls back to a more permissive default). The
 * editor should not let the operator type a value that will bounce, so this normalises
 * to the nearest legal one and the field shows what will actually be saved.
 */
export function clampLimit(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

export const getPolicy = () => authedJson<PolicyDoc>("/runtime/policy");

export const putPolicy = (body: { bands: PolicyBands; denyList?: string[]; limits?: PolicyLimits; allowList?: string[] }) =>
  authedJson<{ ok?: boolean; error?: string } & Partial<PolicyDoc>>("/runtime/policy", {
    method: "POST",
    body: JSON.stringify(body),
  });

// ── P7 / ADR-054 — the ingestion adapters (Settings → AdapterSettings) ───────
export type GithubAdapterState = "disabled" | "idle" | "running" | "error" | "gh-not-authed";
export type ClaudeAdapterState = "disabled" | "idle" | "running" | "error";

export interface GithubAdapterStatus {
  adapter: "github";
  enabled: boolean;
  running: boolean;
  state: GithubAdapterState;
  authenticated: boolean | null;
  lastPollAt: string | null;
  lastError: string | null;
  botAuthors: string[];
  repo: string | null;
  pollIntervalMs: number;
  mergeOnApprove: boolean;
  counts: { minted: number; reconciled: number; prsSeen: number };
}
export interface ClaudeAdapterStatus {
  adapter: "claude-code";
  enabled: boolean;
  running: boolean;
  state: ClaudeAdapterState;
  readOnly: boolean;
  workspaceSlug: string;
  dir: string;
  lastScanAt: string | null;
  lastError: string | null;
  counts: { minted: number; seen: number; scans: number };
}
export interface AdaptersStatus {
  valid: boolean;
  github: GithubAdapterStatus | null;
  claudeCode: ClaudeAdapterStatus | null;
}
export interface AdaptersConfig {
  github: { enabled: boolean; botAuthors: string[]; repo?: string | null; pollIntervalMs?: number; mergeOnApprove?: boolean };
  claudeCode: { enabled: boolean; workspaceSlug: string; debounceMs?: number };
}

/** Human labels for an adapter state — drives the Settings status dot. */
export const ADAPTER_STATE_LABEL: Record<string, string> = {
  disabled: "Disabled",
  idle: "Idle",
  running: "Running",
  error: "Error",
  "gh-not-authed": "gh not authenticated",
};
export const adapterStateTone = (state: string): "green" | "amber" | "red" | "muted" => {
  if (state === "running") return "green";
  if (state === "error") return "red";
  if (state === "gh-not-authed") return "amber";
  return "muted";
};

export const getAdapters = () => authedJson<AdaptersStatus>("/runtime/adapters");
export const putAdapters = (body: AdaptersConfig) =>
  authedJson<{ ok?: boolean; error?: string } & Partial<AdaptersStatus>>("/runtime/adapters", {
    method: "POST",
    body: JSON.stringify(body),
  });

// ── P10 — dogfood scoreboard ────────────────────────────────────────────────
// "N deliveries approved ÷ human-minutes" over a window. Read-only, computed live from
// decision timestamps (decidedAt − createdAt). Never a dollar figure.
export interface Scoreboard {
  windowMs: number;
  since: string;
  approved: number;
  autoApproved: number;
  /**
   * B1 — every decision a human made in the window (approved + rejected +
   * changes_requested). Excludes pending (undecided) and auto_approved (no human).
   */
  decided: number;
  humanMinutes: number;
  avgMinutes: number | null;
  perHour: number | null;
}
export const getScoreboard = (window = "7d") =>
  authedJson<Scoreboard>(`/runtime/scoreboard?window=${encodeURIComponent(window)}`);

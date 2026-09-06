// SESSION 14 (option A) — the collaboration thread, as a PURE view-model.
//
// WHY THIS EXISTS. The agents in this system genuinely collaborate: pm-analyst hands a spec
// to the architect, the architect hands a design to the tech-lead, the tech-lead fans work
// out to the build seats, and the reviewer hands work BACK with evidence. None of it was
// visible — StoryDetail's Timeline rendered the raw machine rows ("plan-drafted |
// vault:plan-… | 22:37"), which say what happened but never who did it, who received it, or
// why.
//
// THE ONE RULE THIS MODULE OBEYS: it never invents an author. A stage→seat lookup table
// would let it label every row with a plausible name, and the label would be a guess
// presented as fact — the exact class of defect this session was spent removing from the
// pipeline. A row whose author the server did not record renders as an EVENT, not as a
// handoff by nobody-knows-who. Attribution comes from story_log's `by_agent` / `to_agent`,
// written by the driver that actually dispatched the seat.
//
// PURE: no React, no fetch, no clock. Every rule here is provable in a unit test.

import type { StoryLogRow, StoryBuild } from "./storiesClient";
import type { Delivery } from "./inboxClient";

/**
 * What a row IS, which is what decides how it reads:
 *  handoff  — one seat passed work to another (or to a stage with no single receiver)
 *  rework   — work bounced BACKWARDS for fixing, usually carrying evidence
 *  failure  — a seat could not deliver; the reason travels with it
 *  gate     — a human is being asked to decide
 *  mail     — one seat MESSAGED another (Phase 8). A conversation, not a transition:
 *             rendering it as a handoff would read as "work moved" when somebody only
 *             asked a question.
 *  mail-refused — the routing rules dropped a message. Kept and marked, never hidden: the
 *             moment the rules bite is exactly the moment an operator needs to see them.
 *  event    — something happened that nobody attributed. Shown, never dropped.
 */
export type ThreadKind = "handoff" | "rework" | "failure" | "gate" | "event" | "mail" | "mail-refused";

export interface ThreadEntry {
  /** Stable, unique — React list identity. */
  key: string;
  kind: ThreadKind;
  ts: number;
  /** The raw event name (or the gate's title). Never prettified here — that is the view's job. */
  label: string;
  stage: string;
  /** The seat that did the work. `null` when the server recorded none — NEVER guessed. */
  from: string | null;
  /** The seat(s) picking it up. `null` when there is no single receiver (e.g. a human gate). */
  to: string | null;
  /** `vault:…` pointer to the artifact this row produced, when it produced one. */
  artifactRef: string | null;
  /** A one-line reason — a failure message, a reject reason. */
  detail: string | null;
  /** Structured handback evidence, when the sender supplied any. */
  evidence: string[] | null;
}

/** A `vault:<id>` ref carries an artifact; anything else is a reason/pointer, not a document. */
export function artifactIdOf(ref: string | null | undefined): string | null {
  const s = typeof ref === "string" ? ref.trim() : "";
  return s.startsWith("vault:") ? s.slice("vault:".length) || null : null;
}

const asText = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

/**
 * Who picks up a `plan` handoff. The tech-lead's decompose spawns ONE goal PER SEAT, so the
 * server deliberately records no single `to_agent` for it. The receivers are read from the
 * REAL goal set rather than assumed — if the decompose chose one seat, one name shows.
 */
function planReceivers(build: StoryBuild | null | undefined): string | null {
  const goals = Array.isArray(build?.goals) ? build.goals : [];
  const seats = [...new Set(goals.map((g) => asText(g?.seat)).filter((s): s is string => !!s))];
  return seats.length ? seats.join(" + ") : null;
}

function entryFromLog(r: StoryLogRow, build: StoryBuild | null | undefined): ThreadEntry {
  const event = asText(r.event) || "event";
  const from = asText((r as { byAgent?: string }).byAgent);
  const explicitTo = asText((r as { toAgent?: string }).toAgent);
  const rawEvidence = (r as { evidence?: unknown }).evidence;
  const evidence = Array.isArray(rawEvidence)
    ? rawEvidence.map((e) => asText(e)).filter((e): e is string => !!e)
    : null;
  const ref = asText(r.ref);
  const artifactRef = artifactIdOf(ref) ? ref : null;
  // A ref that is NOT a vault pointer is a reason line (failStage writes the error there).
  const detail = artifactRef ? null : ref;

  // `plan-drafted` fans out; its receivers come from the goals that were actually spawned.
  const to = explicitTo ?? (event === "plan-drafted" ? planReceivers(build) : null);

  let kind: ThreadKind;
  // Mail is checked BEFORE the `from` fall-through: a mail row is attributed, so it would
  // otherwise be classified as a handoff and read as work changing hands.
  if (event === "mail" || event === "mail-refused") kind = event;
  else if (event.endsWith("-failed")) kind = "failure";
  else if (event === "reject") kind = "rework";
  else if (from) kind = "handoff";
  else kind = "event"; // unattributed — shown as what it is, never dressed up as a handoff

  return {
    key: `log-${r.seq}`,
    kind,
    ts: Number(r.ts) || 0,
    label: event,
    stage: asText(r.stage) || "",
    from,
    to,
    artifactRef,
    detail,
    evidence: evidence && evidence.length ? evidence : null,
  };
}

function entryFromGate(g: Delivery): ThreadEntry | null {
  const id = asText((g as { id?: string }).id);
  if (!id) return null;
  const createdAt = (g as { createdAt?: string }).createdAt;
  const ts = Date.parse(String(createdAt ?? ""));
  return {
    key: `gate-${id}`,
    kind: "gate",
    ts: Number.isFinite(ts) ? ts : 0,
    label: asText((g as { title?: string }).title) || "needs your decision",
    stage: "",
    // The seat that RAISED the question. The receiver is the operator, which the row's own
    // wording says — naming a person as `to` would imply a seat that does not exist.
    from: asText((g as { agentId?: string }).agentId),
    to: null,
    artifactRef: null,
    detail: null,
    evidence: null,
  };
}

export interface ThreadInput {
  log: readonly StoryLogRow[] | null | undefined;
  /** The story's PENDING gates (already filtered by the caller). */
  gates: readonly Delivery[] | null | undefined;
  build: StoryBuild | null | undefined;
}

/**
 * Fold the transition log, the open human gates and the build fan-out into ONE
 * chronological thread. Degenerate input yields an empty thread rather than throwing — the
 * story overlay must still render when a projection is missing.
 */
export function buildThread(input: ThreadInput | null | undefined): ThreadEntry[] {
  if (!input || typeof input !== "object") return [];
  const log = Array.isArray(input.log) ? input.log : [];
  const gates = Array.isArray(input.gates) ? input.gates : [];
  const out: ThreadEntry[] = [];
  for (const r of log) {
    if (r && typeof r === "object") out.push(entryFromLog(r, input.build));
  }
  for (const g of gates) {
    const e = g && typeof g === "object" ? entryFromGate(g) : null;
    if (e) out.push(e);
  }
  // Oldest first. A gate rendered after later work reads as though the human was asked last.
  // Ties keep insertion order (log rows before gates) — Array.prototype.sort is stable.
  return out.sort((a, b) => a.ts - b.ts);
}

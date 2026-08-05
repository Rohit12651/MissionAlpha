// B3 — the Captain's console: turn one line of plain text from the BOSS into
// (a) a Knowledge-Vault record of the routing decision and (b) a real queued task
// for the station that owns the work.
//
// ── WHAT THE ROUTER IS (read this before calling it "AI") ───────────────────
// `classify` is a LABELED DETERMINISTIC HEURISTIC, not a classifier. It is a
// CLOSED, ORDERED keyword table matched on WORD BOUNDARIES, case-insensitively,
// and the FIRST TABLE ROW that matches wins — table order decides, NOT the position
// of the keyword in the sentence. Nothing here calls a model, and nothing here
// pretends to understand the order. A cli-backed classification pass is the
// disclosed later upgrade (ADR note); until it lands, this is the honest v1 and
// every one of its rough edges is pinned by a test rather than hidden:
//   • "testing" does NOT match `test` (word boundary).
//   • "review the design" routes to the architect, not the reviewer (table order).
//   • a plural ("pipelines") does NOT match the singular keyword.
// Those are the documented costs of a deterministic table. They are visible in
// test/captain.test.mjs, so changing any of them is a deliberate edit, never drift.
//
// ── SECURITY ────────────────────────────────────────────────────────────────
//   • The AUTHOR is `by` — a SERVER-DERIVED identity the caller passes in. There is
//     no author field on the order itself: server.mjs reads it from the session,
//     exactly like the B2 vault POST, and a client-supplied `author`/`node`/
//     `venture`/`id` on the input object is ignored outright (pinned by a test).
//   • Text is CAPPED at 2000 chars and REFUSED over it — never silently truncated,
//     because a truncated order is a different order.
//   • Nothing is scrubbed twice: the record goes through vault.write(), which owns
//     the shared scrub, the control-char strip, the slug-only path containment and
//     the 32KB body cap. This module adds NO second SECRET_RE and NO second path
//     rule — it only asserts the end-to-end result in its tests.
//   • The vault record is written BEFORE the task is queued, and a queue failure
//     REPORTS the record it already wrote instead of hiding it. The record is a
//     record of the ROUTING DECISION ("the Captain sent this to X"), which stays
//     true even when the backlog is full — it never claims the task ran.

import { nodeForAgent, slugify } from "./vault.mjs";

/** Hard cap on one order. Over this is a REFUSAL, never a truncation. */
export const MAX_CAPTAIN_TEXT = 2000;
/** How much of the order becomes the record's title (the vault caps titles at 200). */
export const CAPTAIN_TITLE_CHARS = 80;
/** Provenance stamped on every record this module writes. */
export const CAPTAIN_SOURCE_RUN = "captain-route";
/** Where an order nobody else owns lands: the Tech Lead keeps it. */
export const CAPTAIN_AGENT = "tech-lead";

/**
 * The CLOSED routing table. Order is contract: the first row with a keyword present
 * wins. Every `agentId` is one of the seeded SE seats from seed-stations.mjs — pinned
 * by a test, so a renamed seat breaks here loudly rather than routing work into a void.
 * `tech-lead` is deliberately NOT a row: it is the fallback, so an order that matches
 * nothing stays with it rather than being routed twice.
 */
export const ROUTING_RULES = Object.freeze([
  Object.freeze({ agentId: "pm-analyst", keywords: Object.freeze(["requirement", "spec", "story", "scope", "acceptance"]) }),
  Object.freeze({ agentId: "architect", keywords: Object.freeze(["design", "architecture", "schema", "contract", "tradeoff"]) }),
  Object.freeze({ agentId: "sr-backend", keywords: Object.freeze(["api", "endpoint", "backend", "migration", "route"]) }),
  Object.freeze({ agentId: "sr-frontend", keywords: Object.freeze(["ui", "frontend", "component", "screen", "page"]) }),
  Object.freeze({ agentId: "reviewer", keywords: Object.freeze(["review", "diff", "refactor", "lint", "cleanup"]) }),
  Object.freeze({ agentId: "qa", keywords: Object.freeze(["test", "tests", "qa", "regression", "e2e"]) }),
  Object.freeze({ agentId: "devops", keywords: Object.freeze(["deploy", "build", "ci", "pipeline", "release"]) }),
  Object.freeze({ agentId: "sre", keywords: Object.freeze(["monitor", "incident", "outage", "health", "alert"]) }),
  Object.freeze({ agentId: "docs-writer", keywords: Object.freeze(["docs", "documentation", "readme", "notes", "changelog"]) }),
]);

// One compiled matcher per keyword, built ONCE at module load. `\b…\b` is the word
// boundary the doc specifies; the keywords are static literals from the table above,
// but they are escaped anyway so adding one with a metachar can never widen the match.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MATCHERS = ROUTING_RULES.map((rule) => ({
  agentId: rule.agentId,
  probes: rule.keywords.map((kw) => ({ kw, re: new RegExp(`\\b${escapeRe(kw)}\\b`, "i") })),
}));

/**
 * Which agent owns this order.
 * @returns {{agentId: string, matched: string|null}} — `matched` is the keyword that
 * decided it, or null when nothing matched and the Captain keeps it. TOTAL: any
 * non-string, empty or hostile input yields the Captain, never a throw.
 */
export function classify(text) {
  if (typeof text !== "string" || !text.trim()) return { agentId: CAPTAIN_AGENT, matched: null };
  for (const rule of MATCHERS) {
    for (const probe of rule.probes) {
      if (probe.re.test(text)) return { agentId: rule.agentId, matched: probe.kw };
    }
  }
  return { agentId: CAPTAIN_AGENT, matched: null };
}

/** The routing note appended to every record — the audit trail of WHY it went there. */
function routingNote(agentId, matched) {
  return matched
    ? `Routed to \`${agentId}\` by the Captain console.\n\nRule: the keyword \`${matched}\` matched the deterministic routing table (first table row wins, word boundaries, case-insensitive). This is a keyword rule, not a model classification.`
    : `Kept by the Captain (\`${agentId}\`).\n\nRule: no keyword in the deterministic routing table matched, so nothing was delegated. This is a keyword rule, not a model classification.`;
}

/**
 * Route one order: record the decision in shared memory, then queue the work.
 *
 * @param {object}   input
 * @param {string}   input.text  the BOSS's order (≤ MAX_CAPTAIN_TEXT, refused over)
 * @param {string}   input.by    the SERVER-DERIVED author (session identity / 'boss')
 * @param {object}   input.deps  { vault, enqueue, venture? } — injected, same seam
 *                               style as the engine's vault hooks in server.mjs
 * @returns {{agentId,matched,recordId,taskId}|{code,error,...}} a verdict, never a
 * throw for bad INPUT. A missing dependency IS thrown — that is a wiring bug, not
 * something an operator can cause.
 */
export function route(input = {}) {
  const deps = input.deps || {};
  const vault = deps.vault;
  if (!vault || typeof vault.write !== "function") throw new Error("captain.route: vault dependency required");
  const enqueue = deps.enqueue;
  if (typeof enqueue !== "function") throw new Error("captain.route: enqueue dependency required");
  const venture = deps.venture || "waahyu";

  if (typeof input.text !== "string") return { code: 400, error: "text required" };
  const text = input.text.trim();
  if (!text) return { code: 400, error: "text required" };
  if (text.length > MAX_CAPTAIN_TEXT) {
    return { code: 400, error: `text too long — ${MAX_CAPTAIN_TEXT} characters maximum` };
  }
  // The author is server-derived, so a non-string is a wiring mistake at the caller,
  // and an unslugifiable one ("___", "@@@") must REFUSE rather than fall back to a
  // different identity (the sr-security MED-2 rule from B2).
  if (typeof input.by !== "string" || !slugify(input.by)) return { code: 400, error: "author required" };

  const { agentId, matched } = classify(text);

  // (1) the record. `node`, `venture` and `id` are decided HERE — never read off the
  // input object — so a crafted body cannot pick its own lane or its own path.
  const written = vault.write({
    venture,
    node: nodeForAgent(agentId),
    title: text.slice(0, CAPTAIN_TITLE_CHARS),
    body: `## Order\n\n${text}\n\n## Routing\n\n${routingNote(agentId, matched)}\n`,
    author: input.by,
    sourceRun: CAPTAIN_SOURCE_RUN,
  });
  if (written?.error) return { code: written.code || 400, error: written.error };

  // (2) the task, through the caller's own enqueue seam (server.mjs hands it the
  // SHIPPED engine.enqueueGoal — this module never touches the queue directly).
  const queued = enqueue({ agentId, text });
  if (!queued || queued.error) {
    return {
      code: 503,
      error: queued?.error || "could not queue the task",
      agentId,
      matched,
      recordId: written.id,
    };
  }

  return { agentId, matched, recordId: written.id, taskId: queued.taskId, goalId: queued.goalId ?? null };
}

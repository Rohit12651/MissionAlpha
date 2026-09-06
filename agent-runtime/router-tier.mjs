// Phase 1 / R3 — the TIER ROUTER. Decides how expensive a task is ALLOWED to be before
// anything spawns.
//
// WHAT THIS IS (read before calling it "AI"): a LABELED DETERMINISTIC TABLE, exactly the
// honesty convention captain.mjs established. Nothing here calls a model. Nothing here
// learns. It is a CLOSED, ORDERED intent table matched on word boundaries, and the first
// row that matches wins. ruflo ships the same idea and brands it "self-learning routing";
// its implementation is a 62-line regex table with a hardcoded `confidence: 0.8`. Ours is
// the same class of thing and says so.
//
// THE THREE TIERS:
//   0 — DETERMINISTIC CODEMOD. No model, no tokens, ~milliseconds. The transform is a
//       pure AST/string operation whose output is fully predictable from its input.
//   1 — CHEAP MODEL. Small, well-specified edits where a small model is sufficient.
//   2 — FULL MODEL. Everything else.
//
// FAIL-EXPENSIVE, NEVER FAIL-WRONG. An unrecognized task routes to tier 2. Misrouting a
// hard task to a cheap model produces confidently wrong code that a human then has to
// catch; misrouting an easy task to an expensive model costs a few cents. The asymmetry
// is not close, so the default is always the expensive, correct one.
//
// LAW 1 (non-negotiable): tier 0 does NOT mean "writes to the repo". A codemod produces a
// DIFF IN THE WORKTREE which then flows through the identical path every model-authored
// diff flows through — risk classify → band → policy → Inbox → human → broker. This module
// chooses a *generator*, never a destination. There is no cheap path to the repo.

/** Closed tier set. */
export const TIERS = Object.freeze({ CODEMOD: 0, CHEAP: 1, FULL: 2 });

/**
 * The Tier-0 intent table. A task only reaches a codemod when its intent is one of these
 * AND the codemod module actually implements it. Adding a row here is a deliberate,
 * reviewed change — never a config-time decision, because a codemod runs unattended.
 *
 * Order matters: first match wins, so more specific patterns come first.
 */
export const CODEMOD_INTENTS = Object.freeze([
  Object.freeze({ intent: "remove-console", re: /\b(remove|strip|delete)\b.{0,24}\bconsole\.(log|debug|info)\b/i }),
  Object.freeze({ intent: "remove-console", re: /\bremove\b.{0,16}\b(console|debug)\s+(statements?|logs?|logging)\b/i }),
  Object.freeze({ intent: "var-to-const", re: /\b(convert|change|replace|migrate)\b.{0,24}\bvar\b.{0,16}\b(to|with|into)\b.{0,12}\b(const|let)\b/i }),
]);

/**
 * Tier-1 shapes: narrow, mechanical-but-judgement edits. Deliberately conservative — this
 * table is the one that can produce a WRONG answer cheaply, so it stays small.
 */
export const CHEAP_INTENTS = Object.freeze([
  Object.freeze({ intent: "typo-fix", re: /\bfix\b.{0,16}\btypos?\b/i }),
  Object.freeze({ intent: "rename-symbol", re: /\brename\b.{0,24}\b(variable|function|symbol|method|param(eter)?)\b/i }),
  Object.freeze({ intent: "add-comment", re: /\badd\b.{0,16}\b(a\s+)?(comment|jsdoc|docstring)\b/i }),
  Object.freeze({ intent: "format", re: /\b(format|prettier|reformat)\b.{0,16}\b(this|the)?\s*(file|code)\b/i }),
]);

/**
 * Anything matching these is FORCED to tier 2 regardless of any other match. A task that
 * touches security, auth, money, migrations or deletion is never cheap, and never
 * mechanical, even if it is phrased mechanically ("just remove the console.log in auth").
 */
export const FORCE_FULL = Object.freeze([
  /\b(auth|authn|authz|login|password|token|secret|credential|crypto|encrypt)\w*/i,
  /\b(payment|billing|charge|refund|stripe|invoice)\w*/i,
  /\b(migration|schema|drop\s+table|alter\s+table)\b/i,
  /\b(delete|remove)\b.{0,16}\b(file|directory|table|user|account)s?\b/i,
  /\b(security|vulnerab|injection|xss|csrf)\w*/i,
]);

// ── Phase 6 / 6.5 — an EXPLICIT tier is never overridden ─────────────────────────────
//
// Model-tier NAMES the providers registry understands, mapped to this module's numeric
// tiers. `opus` has no numeric tier of its own: it is an ESCALATION, so it maps to FULL —
// certainly not cheap, and never a codemod.
//
// modelForTier(FULL) is "sonnet", which would ERASE an opus escalation on the way back out.
// So classifyTier echoes the requested NAME in `requestedTier`, and a caller acting on an
// explicit request must use THAT field, never modelForTier(result.tier).
//
// hasOwnProperty (not `in`, not a bare lookup) so prototype keys — "toString",
// "constructor", "__proto__" — can never resolve as a valid tier. Same discipline as
// server.mjs resolveTier (sr-security LOW).
export const TIER_BY_NAME = Object.freeze({
  haiku: TIERS.CHEAP,
  sonnet: TIERS.FULL,
  opus: TIERS.FULL,
});
function tierForName(name) {
  if (typeof name !== "string" || !name) return null;
  if (!Object.prototype.hasOwnProperty.call(TIER_BY_NAME, name)) return null;
  return TIER_BY_NAME[name];
}

// The intent tables are written for a ONE-LINE ask ("add a jsdoc comment to foo"). Run
// against a multi-sentence brief they match on a SUBORDINATE clause and then classify the
// whole task by it — which is exactly what happened on 2026-09-02: a four-sentence brief
// whose third sentence read "Add a short JSDoc comment." was routed to a cheap model.
//
// So the intent tables now only get to answer when the task IS a one-line ask. FORCE_FULL
// is deliberately NOT gated this way: its job is to REFUSE cheapness, never to grant it, so
// silencing it on long text would be the one direction that fails wrong instead of expensive.
const MAX_INTENT_LINE = 140;
// Written with explicit escapes, never with literal separator characters: U+2028/U+2029 are
// INVISIBLE in an editor, and a matcher you cannot see is how a guard ships vacuous
// (PES addendum #13). LF, CR and both Unicode line separators all end a "line".
const LINE_BREAK = /[\n\r\u2028\u2029]/;
function isOneLineAsk(text) {
  const t = text.trim();
  return t.length <= MAX_INTENT_LINE && !LINE_BREAK.test(t);
}

/**
 * classifyTier(task, { requestedTier }) → { tier, intent, reason, requestedTier }
 *
 * `task` is the free text of the goal. `requestedTier` is the tier the CALLER explicitly
 * asked for (a name from TIER_BY_NAME), or null when nobody chose — engine.mjs records
 * exactly that distinction, because `tier` has defaulted to "sonnet" since ADR-024 and so
 * cannot tell an explicit request from an omission.
 *
 * A valid explicit request wins BEFORE any regex runs. Never throws — an unusable input is
 * tier 2.
 *
 * DISCLOSED RESIDUAL: because the short-circuit is before FORCE_FULL, an operator who
 * explicitly asks for `haiku` on an auth/payment task now gets haiku (pre-fix they silently
 * got sonnet). That is the specified behaviour — a router that overrides a human's stated
 * choice is the defect this task exists to fix — and it is pinned by SENSITIVE-3 in
 * test/router-tier-explicit.test.mjs so it stays a decision, not a surprise. Every
 * downstream control (risk classify → band → policy → Inbox → human) is unchanged.
 */
export function classifyTier(task, opts) {
  const text = typeof task === "string" ? task : "";
  const requested = opts && typeof opts === "object" ? opts.requestedTier : null;
  const explicit = tierForName(requested);
  // The sensitive-domain FLOOR is checked FIRST, for every length and every request. An
  // explicit tier may RAISE the model above the floor, never lower it below: "haiku" on an
  // auth task would be a security regression dressed as operator intent (Phase 6 review).
  const sensitive = text.trim() ? FORCE_FULL.map((re) => re.exec(text)).find(Boolean) : null;
  if (explicit !== null) {
    if (sensitive && explicit < TIERS.FULL) {
      return { tier: TIERS.FULL, intent: null, reason: `sensitive-domain match '${sensitive[0]}' — explicit '${requested}' raised to full`, requestedTier: requested };
    }
    return { tier: explicit, intent: null, reason: "explicit tier requested", requestedTier: requested };
  }
  if (!text.trim()) return { tier: TIERS.FULL, intent: null, reason: "empty task — defaulting to full model", requestedTier: null };

  if (sensitive) return { tier: TIERS.FULL, intent: null, reason: `sensitive-domain match '${sensitive[0]}' — never cheap`, requestedTier: null };
  if (!isOneLineAsk(text)) {
    return { tier: TIERS.FULL, intent: null, reason: `task is not a one-line ask (${text.trim().length} chars) — full model`, requestedTier: null };
  }
  for (const row of CODEMOD_INTENTS) {
    if (row.re.test(text)) return { tier: TIERS.CODEMOD, intent: row.intent, reason: `deterministic intent '${row.intent}'`, requestedTier: null };
  }
  for (const row of CHEAP_INTENTS) {
    if (row.re.test(text)) return { tier: TIERS.CHEAP, intent: row.intent, reason: `mechanical intent '${row.intent}'`, requestedTier: null };
  }
  return { tier: TIERS.FULL, intent: null, reason: "no mechanical intent matched — full model", requestedTier: null };
}

/**
 * Rough token-savings estimate for telemetry ONLY. This is an ESTIMATE and is labelled as
 * one everywhere it surfaces — the repo's spend.mjs law is that a number you did not
 * measure is never presented as a measurement. Tier 0 saves the whole spawn; tier 1 saves
 * the delta between a full model and a cheap one, which we cannot know without both, so
 * it is reported as null rather than invented.
 */
export function estimateSavings(tier, baselineTokens = 8000) {
  if (tier === TIERS.CODEMOD) return { estTokensSaved: baselineTokens, basis: "full spawn avoided" };
  if (tier === TIERS.CHEAP) return { estTokensSaved: null, basis: "cheaper model — delta not measured" };
  return { estTokensSaved: 0, basis: "full model" };
}

/** Model tier name the providers registry understands. */
export function modelForTier(tier) {
  if (tier === TIERS.CHEAP) return "haiku";
  if (tier === TIERS.FULL) return "sonnet";
  return null; // tier 0 consults no model at all
}

// ── Target extraction (R3 wiring) ────────────────────────────────────────────
//
// A codemod is deterministic only if it knows WHICH FILES to run against. The intent table
// above answers "what transform"; this answers "on what". It reads ONLY explicit paths out
// of the task text.
//
// IT DELIBERATELY DOES NOT GUESS. No globbing, no "probably the src directory", no
// walking the worktree looking for candidates. A task that names no file yields no
// targets, and the dispatcher then falls through to tier 2 — the same fail-expensive rule
// the classifier uses. An unattended mechanical edit across files nobody named is not a
// small task; inferring the target set is exactly how a $0 path turns into a large
// unreviewed diff.
//
// Refusals here are advisory-early, not the security boundary: applyCodemod re-checks
// containment, extension and symlink status against the real worktree. Rejecting absolute
// and traversal paths at this layer keeps them out of logs and telemetry too.

/** Bound on how many distinct paths a single task text may contribute. */
export const TARGET_SCAN_CAP = 100;

// Path-shaped token ending in a codemod-eligible extension. Mirrors codemod.mjs
// CODEMOD_EXTS — the two must stay in step, and TARGETS-5 pins the refusal side.
const PATH_TOKEN = /[A-Za-z0-9_./-]+\.(?:js|jsx|mjs|cjs|ts|tsx)\b/g;

/**
 * extractTargets(task) → string[] of worktree-relative paths, in first-seen order.
 * Never throws. A non-string input yields [].
 */
export function extractTargets(task) {
  if (typeof task !== "string" || !task) return [];
  const seen = new Set();
  const out = [];
  PATH_TOKEN.lastIndex = 0; // the regex is module-level and /g — never trust its lastIndex
  for (const m of task.matchAll(PATH_TOKEN)) {
    const p = m[0];
    if (p.startsWith("/")) continue;                 // absolute — not worktree-relative
    if (/(^|\/)\.\.(\/|$)/.test(p)) continue;        // traversal
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= TARGET_SCAN_CAP) break;
  }
  return out;
}

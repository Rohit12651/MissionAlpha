// Phase 3 / R10 — BEHAVIOURAL TRUST SCORING for ingestion sources.
//
// THE IDEA, borrowed from the one genuinely good part of ruflo's federation design:
// a remote party earns standing from OBSERVED behaviour rather than from configuration.
// Upgrades require history; a single threat signal downgrades instantly.
//
// LAW 4 — TRUST ADDS FRICTION, IT NEVER REMOVES IT. This is the entire safety argument
// for the module and it is structural, not a convention:
//
//   • The floor is enforced ELSEWHERE and this module cannot reach it. `deliveries.mjs`
//     line ~1219 refuses `autoApprove` for any row whose source !== "swarm", producer-side,
//     before any policy is consulted. External deliveries therefore never auto-apply no
//     matter what a trust score says. Verified in code, not assumed.
//   • This module exports ONLY a friction LEVEL, and the level ladder is one-directional:
//     `none` (the baseline every external delivery already has) → `notice` → `confirm`.
//     There is no value it can return that means "less than baseline". `frictionFor` is a
//     total function over the score domain and its minimum output is `none`.
//   • Nothing here imports, reads, or returns a band, a policy verdict, or an apply
//     decision. A tempting future edit is to let high trust relax a band; that would
//     invert the whole design, and the tests assert the module has no such output.
//
// The honest framing: a high-trust source is treated NORMALLY. A low-trust source is
// treated with MORE suspicion. Trust never buys a shortcut.
//
// PURE. History is passed in; persistence is the caller's problem.

/** Friction ladder. Index order IS the severity order — `none` is the floor. */
export const FRICTION = Object.freeze(["none", "notice", "confirm"]);

/** Minimum observations before a source may be scored above the cold-start default. */
export const MIN_OBSERVATIONS = 10;

/** Rolling window. Behaviour older than this stops counting. */
export const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Cold-start score. Deliberately low — an unknown source is not a trusted one — but
 * deliberately NOT the bottom tier.
 *
 * At 0.35 a brand-new source scored `suspect`, the same tier a source that actually
 * tripped a threat detector gets. That collapses two very different situations into one
 * label and throws away the distinction the operator most needs: "I have never seen this
 * before" versus "I have seen this and it misbehaved". 0.4 is the `notice` boundary, so
 * cold-start reads as `watch` and `suspect` stays earned.
 */
export const COLD_START_SCORE = 0.4;

/** Component weights. Mirrors the ruflo formula that was worth keeping. */
export const WEIGHTS = Object.freeze({ success: 0.4, uptime: 0.2, threat: 0.2, integrity: 0.2 });

function ratio(num, den) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return Math.max(0, Math.min(1, num / den));
}

/**
 * score(history, now) → { score, observations, components, coldStart, threatHit }
 *
 * `history` = {
 *   decisions: [{ at, status }]      approved | rejected | changes_requested
 *   polls:     [{ at, ok }]          adapter poll health
 *   threats:   [{ at }]              injection flags / scrub hits attributed to the source
 *   integrity: [{ at, ok }]          two-way sync consistency checks
 * }
 *
 * Never throws. Missing sections score as UNKNOWN (null component), not as zero — the
 * spend.mjs "null is not zero" law: an unmeasured dimension must not look like a failure.
 */
export function score(history = {}, now = Date.now()) {
  const h = history && typeof history === "object" ? history : {};
  const since = now - WINDOW_MS;
  const win = (arr) => (Array.isArray(arr) ? arr.filter((e) => e && Number(e.at) >= since) : []);

  const decisions = win(h.decisions);
  const polls = win(h.polls);
  const threats = win(h.threats);
  const integrity = win(h.integrity);

  const components = {
    success: ratio(decisions.filter((d) => d.status === "approved").length, decisions.length),
    uptime: ratio(polls.filter((p) => p.ok).length, polls.length),
    // A threat is a hard signal: any hit inside the window drives this component to 0.
    threat: threats.length ? 0 : (polls.length || decisions.length ? 1 : null),
    integrity: ratio(integrity.filter((i) => i.ok).length, integrity.length),
  };

  const observations = decisions.length + polls.length + integrity.length;

  // Weighted mean over MEASURED components only. Renormalising rather than treating an
  // absent dimension as zero keeps an adapter that simply has no integrity checks yet
  // from being punished for it.
  let acc = 0;
  let wsum = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const v = components[k];
    if (v === null || v === undefined) continue;
    acc += v * w;
    wsum += w;
  }
  const measured = wsum > 0 ? acc / wsum : null;

  const coldStart = observations < MIN_OBSERVATIONS;
  // An UPGRADE requires history. A DOWNGRADE does not — a threat hit applies immediately,
  // even on a source with two observations.
  const threatHit = threats.length > 0;
  let final;
  if (threatHit) final = 0;
  else if (measured === null) final = COLD_START_SCORE;
  else if (coldStart) final = Math.min(COLD_START_SCORE, measured);
  else final = measured;

  return {
    score: Number(final.toFixed(3)),
    observations,
    components,
    coldStart,
    threatHit,
  };
}

/**
 * frictionFor(score) → one of FRICTION.
 *
 * MONOTONIC AND FLOORED. The lowest value this can ever return is `none`, which is the
 * treatment every external delivery already receives today. A high score therefore
 * produces exactly the status quo — it buys nothing.
 */
export function frictionFor(s) {
  const v = Number(s);
  if (!Number.isFinite(v)) return "confirm"; // unknown is suspicious, not trusted
  if (v >= 0.75) return "none";
  if (v >= 0.4) return "notice";
  return "confirm";
}

/** Human-facing tier label for the card chip. Identity only. */
export function tierFor(s) {
  const f = frictionFor(s);
  return f === "none" ? "trusted" : f === "notice" ? "watch" : "suspect";
}

/**
 * Create a trust store over an injected persistence seam.
 *
 * `load`/`save` handle a plain object keyed by source id. Absent seams degrade to
 * in-memory, because a trust store that cannot persist must not block ingestion.
 */
export function createTrust(deps = {}) {
  const load = typeof deps.load === "function" ? deps.load : () => ({});
  const save = typeof deps.save === "function" ? deps.save : () => true;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const MAX_EVENTS = 500; // per source per bucket — bounded, oldest dropped

  // null-proto: a source literally named "__proto__" is an ordinary key.
  let store = Object.create(null);
  try {
    const raw = load() || {};
    for (const [k, v] of Object.entries(raw)) if (v && typeof v === "object") store[k] = v;
  } catch (e) { log(`[trust] load failed: ${e?.message}`); }

  function bucket(sourceId, name) {
    const id = String(sourceId || "").slice(0, 120);
    if (!id) return null;
    if (!store[id]) store[id] = { decisions: [], polls: [], threats: [], integrity: [] };
    if (!Array.isArray(store[id][name])) store[id][name] = [];
    return store[id][name];
  }

  function record(sourceId, kind, payload = {}) {
    try {
      const b = bucket(sourceId, kind);
      if (!b) return false;
      b.push({ at: now(), ...payload });
      if (b.length > MAX_EVENTS) b.splice(0, b.length - MAX_EVENTS);
      save({ ...store });
      return true;
    } catch (e) {
      // Trust bookkeeping must NEVER block ingestion. A failure here is a lost datapoint.
      log(`[trust] record failed: ${e?.message}`);
      return false;
    }
  }

  function scoreFor(sourceId) {
    return score(store[String(sourceId)] || {}, now());
  }

  /** The shape stamped on a delivery row / rendered as a chip. No history, no raw events. */
  function stampFor(sourceId) {
    const s = scoreFor(sourceId);
    return {
      source: String(sourceId || ""),
      score: s.score,
      tier: tierFor(s.score),
      friction: frictionFor(s.score),
      observations: s.observations,
      coldStart: s.coldStart,
    };
  }

  function all() {
    return Object.fromEntries(Object.keys(store).map((id) => [id, stampFor(id)]));
  }

  return { record, scoreFor, stampFor, all, FRICTION };
}

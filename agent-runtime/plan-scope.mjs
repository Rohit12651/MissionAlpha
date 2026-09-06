// SESSION 16 — the APPLIABLE SCOPE, phrased for the agents that must write inside it.
//
// THE DEFECT THIS REPLACES. `pipeline.mjs` stamped step 0 of every goal with a per-SEAT
// file scope invented in place:
//
//     `[file-scope: ${seat === "sr-backend" ? "services/** (backend)" : "src/** (frontend)"}]`
//
// `services/` is a directory from a DIFFERENT repo (the Waahyu platform). It does not
// exist here and is not in SEED_DIRS, so a change written there could never be applied.
// Measured on story_8361a8dcc534a7b3 / goal_1b5dd94116b2: the tech-lead's decompose was
// correct and specific — "CREATE new file src/lib/buildHealth.ts" — and the runtime
// prefixed that exact step with a header telling the seat its scope was `services/**`.
// The seat was handed a contradiction by its own harness, and the resulting wandering was
// then recorded as the model going off-brief.
//
// TWO RULES, both learned from that.
//
//   1. THIS HEADER STATES THE REPO-WIDE ROOTS, NOT THE SEAT'S SCOPE. Phase 7 added a
//      per-seat writeScope to guards.applyAllowed which narrows a `role:"worker"` seat below
//      those roots, so the old wording ("applyAllowed does not take a seat") is now false.
//      The header deliberately stays repo-wide anyway: it is a hint to the model, the broker
//      is the enforcement, and quoting the superset can only ever be safe. Inventing a
//      narrower value HERE would be a guess, and a guess that contradicts a concrete
//      instruction is worse than silence.
//
//   2. NO HINT BEATS A FALSE HINT. Every function here returns "" when it has no usable
//      source, rather than falling back to a literal. A hard-coded fallback is precisely
//      what drifted away from SEED_DIRS and produced the bug; a missing sentence costs a
//      little precision, a wrong one costs the whole task.
//
// PURITY. No imports, no I/O, no module-level state — the caller passes the seed list in.
// `pipeline.mjs` takes every dependency through an injected seam and must keep doing so;
// `server.mjs` owns the single source of truth (`guards.SEED_DIRS`) and passes it down.

/**
 * Normalise a raw seed-dir list into clean, deduped, repo-relative roots.
 * Total: any non-array, or entries that normalise to nothing, yield [].
 */
export function appliableRoots(seedDirs) {
  if (!Array.isArray(seedDirs)) return [];
  const out = [];
  for (const d of seedDirs) {
    if (typeof d !== "string") continue;
    const s = d.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "").trim();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * The header stamped on step 0 of a build goal. Names the real appliable roots and says
 * plainly what falls outside them. Empty when there is no usable scope (rule 2).
 */
export function fileScopeHint(seedDirs) {
  const roots = appliableRoots(seedDirs);
  if (!roots.length) return "";
  return `[file-scope: ${roots.map((r) => `${r}/**`).join(", ")} — a change outside these paths cannot be applied]`;
}

/**
 * The sentence added to the tech-lead's decompose prompt, so the plan is AUTHORED in
 * scope instead of being corrected afterwards. Empty when there is no usable scope.
 */
export function planScopeBrief(seedDirs) {
  const roots = appliableRoots(seedDirs);
  if (!roots.length) return "";
  return (
    `Appliable scope: ONLY files under ${roots.map((r) => `${r}/`).join(", ")} can be applied — ` +
    `a step naming a path outside them produces work that is discarded on delivery. ` +
    `Every step that creates or edits a file MUST name its concrete repo-relative path, ` +
    `and that path must sit under one of those roots.`
  );
}

/**
 * The shape a build goal must have to be SCORABLE by the engine.
 *
 * Live evidence, same story as above (story_8361a8dcc534a7b3, goal_17ebc054a370): the
 * tech-lead authored an sr-frontend goal that was an explicit no-op — "SCOPE LOCK: this is
 * a READ-ONLY guard goal. Do not create or modify ANY file. Your diff budget is 0 added /
 * 0 modified / 0 deleted." As a piece of engineering judgement that is defensible. As a
 * unit of work for THIS engine it cannot succeed: engine.mjs treats a task that produced no
 * changes as `empty-diff`, retries it to its attempt budget and then fails it terminally,
 * which blocks the story. A seat that followed its brief exactly was recorded as stuck.
 *
 * Loosening the engine is the wrong side to fix. "Produced nothing" is precisely the signal
 * that catches a seat which did no work, and the intent flag that would exempt a goal would
 * be agent-authored — i.e. untrusted, and trivially the thing a stuck seat claims. So the
 * decompose is told the rule instead, and keeps its verification steps by attaching them to
 * the goal that makes the change.
 *
 * Constant by design: it takes no configuration to be true of this engine.
 */
export function planGoalShapeBrief() {
  return (
    "Goal shape: EVERY goal you emit must end in at least one concrete file change. " +
    "A seat that produces no diff is recorded as `empty-diff`, retried to its attempt budget " +
    "and then failed terminally, which blocks the story — so a read-only, audit-only or " +
    "\"confirm no change is needed\" goal cannot succeed no matter how well the seat performs. " +
    "Keep verification steps: attach them to the goal that makes the change, as checks on that " +
    "seat's own diff, rather than giving them a goal of their own."
  );
}

// ADR-050 A2 — Pure gap detector.
//
// detectGaps(manifest, index) compares a feature manifest's `needs` against the
// capability index of installed agents and returns which needs are covered vs. missing.
//
// PURE: no I/O, no registry access. Takes the index as a parameter so callers
// (the /detect-gaps endpoint) inject it fresh; tests pass mocks.

/**
 * Detect capability gaps between what a feature needs and what the installed
 * builtin agents (plus any minted agents in the index) can cover.
 *
 * @param {object} manifest - shape: { needs: { langs?:string[], frameworks?:string[], dbs?:string[] } }
 * @param {Map<string, {langs:string[], frameworks:string[], dbs:string[]}>} index
 *   - capability index (from capabilityIndex() or merged with minted agents)
 * @returns {{ gaps: Array<{kind:string,value:string}>, covered: Array<{kind:string,value:string}> }}
 */
export function detectGaps(manifest, index) {
  const needs = manifest?.needs ?? {};
  const needLangs = normalise(needs.langs);
  const needFrameworks = normalise(needs.frameworks);
  const needDbs = normalise(needs.dbs);

  // Flatten all capabilities across all agents in the index into three sets.
  const haveLangs = new Set();
  const haveFrameworks = new Set();
  const haveDbs = new Set();
  for (const caps of index.values()) {
    for (const l of caps.langs ?? []) haveLangs.add(l.toLowerCase());
    for (const f of caps.frameworks ?? []) haveFrameworks.add(f.toLowerCase());
    for (const d of caps.dbs ?? []) haveDbs.add(d.toLowerCase());
  }

  const gaps = [];
  const covered = [];

  for (const v of needLangs) {
    if (haveLangs.has(v)) covered.push({ kind: "lang", value: v });
    else gaps.push({ kind: "lang", value: v });
  }
  for (const v of needFrameworks) {
    if (haveFrameworks.has(v)) covered.push({ kind: "framework", value: v });
    else gaps.push({ kind: "framework", value: v });
  }
  for (const v of needDbs) {
    if (haveDbs.has(v)) covered.push({ kind: "db", value: v });
    else gaps.push({ kind: "db", value: v });
  }

  return { gaps, covered };
}

/** Normalise a string array: lowercase, trim, dedupe, drop empties. */
function normalise(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
}

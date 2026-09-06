// PHASE 9 — the type-scale sweep, as a deterministic transform.
//
// The mapping is DECIDED in docs/superpowers/specs/type-scale.md (Task 8.0). This module
// executes it; it makes no judgement calls of its own. Every size in the tree maps to
// exactly one of nine steps, and the 12px floor is absolute.
//
// WHY A CODEMOD AND NOT 64 HAND-EDITS. There are 556 `text-[Npx]` sites across 64 `.tsx`
// files and 176 CSS declarations. Hand-editing that many sites is where a typo becomes a
// visual regression nobody spots, and there are ZERO component tests to catch one. A pure
// function with its own unit tests is auditable; a thousand keystrokes are not. The
// screenshot suite still gates every batch — this reduces the number of ways a batch can
// be wrong, it does not replace the net.
//
// SCOPING DECISION, made deliberately: the sweep emits PLAIN PX on the ladder
// (`text-[12px]`), NOT `text-[length:var(--type-1)]`.
//   * The valuable, risky change is collapsing 15 sizes to 9 and enforcing the floor.
//   * Introducing a brand-new Tailwind idiom at 556 sites in the SAME change would make
//     every visual diff harder to attribute, and doubles the blast radius if the
//     `length:` syntax interacts badly with the existing config. There is currently zero
//     usage of it in the tree.
//   * The px values ARE the ladder, and the grep gates in the spec enforce them.
// Tokenising the call sites is a clean follow-up once the sizes are already correct.

/** The nine steps, in px. Mirrors src/theme/tokens.css and the spec's table. */
export const LADDER = Object.freeze([12, 13, 14, 16, 19, 22, 26, 30, 36]);

/** The absolute floor. Nothing renders smaller, on any surface. */
export const FLOOR_PX = 12;

/**
 * THE MAPPING, verbatim from docs/superpowers/specs/type-scale.md §3.
 * Every size measured in the tree appears here explicitly — an unlisted size is a
 * deliberate error rather than a silent nearest-match, because a size nobody decided on
 * is exactly what this sweep exists to remove.
 */
const MAP = new Map([
  [8, 12], [8.5, 12], [9, 12], [9.5, 12], [10, 12], [10.5, 12], [11, 12], [11.5, 12],
  [12, 12], [12.5, 12],
  [13, 13], [13.5, 13],
  [14, 14],
  [15, 16], [16, 16],
  [17, 19], [19, 19], [20, 19],
  [22, 22],
  [24, 26], [25, 26], [26, 26],
  [30, 30],
  [36, 36],
]);

/**
 * Map one size onto the ladder.
 * @returns {number|null} the ladder step, or null when the size is not in the decided
 *   mapping — the caller MUST surface that rather than guessing.
 */
export function mapSize(px) {
  const n = Number(px);
  if (!Number.isFinite(n) || n <= 0) return null;
  return MAP.has(n) ? MAP.get(n) : null;
}

const TSX_RE = /text-\[(\d+(?:\.\d+)?)px\]/g;
const CSS_RE = /(font-size:\s*)(\d+(?:\.\d+)?)px/g;

/**
 * Rewrite `text-[Npx]` occurrences in a .tsx source.
 * @returns {{code: string, changed: number, unmapped: number[]}}
 */
export function sweepTsx(source) {
  const unmapped = [];
  let changed = 0;
  const code = String(source).replace(TSX_RE, (whole, px) => {
    const to = mapSize(px);
    if (to === null) { unmapped.push(Number(px)); return whole; }
    if (to === Number(px)) return whole; // already on the ladder
    changed += 1;
    return `text-[${to}px]`;
  });
  return { code, changed, unmapped };
}

/**
 * Rewrite `font-size: Npx` declarations in a stylesheet.
 * @returns {{code: string, changed: number, unmapped: number[]}}
 */
export function sweepCss(source) {
  const unmapped = [];
  let changed = 0;
  const code = String(source).replace(CSS_RE, (whole, head, px) => {
    const to = mapSize(px);
    if (to === null) { unmapped.push(Number(px)); return whole; }
    if (to === Number(px)) return whole;
    changed += 1;
    return `${head}${to}px`;
  });
  return { code, changed, unmapped };
}

/** Every sub-floor size still present. The Phase 9 exit gate, as a function. */
export function subFloorSizes(source) {
  const out = [];
  for (const re of [TSX_RE, CSS_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(String(source))) !== null) {
      const px = Number(m[m.length - 1]);
      if (Number.isFinite(px) && px < FLOOR_PX) out.push(px);
    }
  }
  return out;
}

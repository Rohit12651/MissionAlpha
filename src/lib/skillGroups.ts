// Pure grouping + virtualization helpers for the Skills palette (C3).
// No React, no DOM — unit-tested in src/lib/__tests__/skillGroups.test.ts.
import type { MissionSkill } from "./missionSkills.ts";

export interface SkillGroup {
  family: string;
  count: number;
  items: MissionSkill[];
}

export interface FlatRow {
  type: "header" | "item";
  family: string;
  count?: number;
  skill?: MissionSkill;
}

// Preferred family order: prompts + workflow + the dev families first, the long tail mid,
// misc last. Families not listed fall just before misc, alpha-ordered.
export const FAMILY_ORDER: string[] = [
  "prompts", "commands", "curated", "user",
  "sp · workflow", "engineering", "ui/ux", "data", "product",
  "mcp", "plugin-dev", "documents", "claude-mem", "caveman", "headroom", "graphify",
  "hyperframes", "gstack",
  "marketing", "sales", "hr", "operations", "support", "finance", "legal",
  "knowledge-work", "community", "ecc", "integrations", "misc",
];

function rank(family: string): number {
  const i = FAMILY_ORDER.indexOf(family);
  return i === -1 ? FAMILY_ORDER.length - 1.5 : i; // unknown families just before misc
}

function matches(s: MissionSkill, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return s.id.toLowerCase().includes(n) || s.hint.toLowerCase().includes(n) ||
    s.title.toLowerCase().includes(n) || s.source.toLowerCase().includes(n);
}

/** Pure: group skills by a key (default: family), filter by query, sort items by id, drop
 *  empties. `keyOf` lets a surface group by a different dimension (the palette groups by
 *  `source`) without duplicating the grouping/virtualization machinery. */
export function groupSkills(
  skills: readonly MissionSkill[],
  query: string,
  keyOf: (s: MissionSkill) => string = (s) => s.family,
): SkillGroup[] {
  const q = query.trim();
  const byFam = new Map<string, MissionSkill[]>();
  for (const s of skills) {
    if (!matches(s, q)) continue;
    const k = keyOf(s) || s.family;
    const arr = byFam.get(k);
    if (arr) arr.push(s);
    else byFam.set(k, [s]);
  }
  const groups: SkillGroup[] = [];
  for (const [family, items] of byFam) {
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    groups.push({ family, count: items.length, items });
  }
  groups.sort((a, b) => rank(a.family) - rank(b.family) || (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
  return groups;
}

/** Pure: flatten groups to a render list — a header per family + item rows for expanded families. */
export function flattenRows(groups: SkillGroup[], collapsed: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const g of groups) {
    rows.push({ type: "header", family: g.family, count: g.count });
    if (!collapsed.has(g.family)) for (const s of g.items) rows.push({ type: "item", family: g.family, skill: s });
  }
  return rows;
}

/** Pure: cumulative top offset per row + total height, given fixed header/item heights. */
export function rowOffsets(rows: FlatRow[], headerH: number, itemH: number): { tops: number[]; total: number } {
  const tops: number[] = [];
  let y = 0;
  for (const r of rows) {
    tops.push(y);
    y += r.type === "header" ? headerH : itemH;
  }
  return { tops, total: y };
}

/** Pure: first/last row index intersecting [scrollTop, scrollTop+viewportH], padded by overscan.
 *  `tops` is strictly increasing → binary-search the start (O(log n)); a row whose top equals
 *  scrollTop sits at the viewport edge and IS visible, so it's included. */
export function visibleSlice(
  tops: number[],
  _itemH: number,
  scrollTop: number,
  viewportH: number,
  overscan: number,
): { start: number; end: number } {
  const n = tops.length;
  if (n === 0) return { start: 0, end: 0 };
  // start = last index where tops[i] <= scrollTop (the row covering the top edge).
  let lo = 0, hi = n - 1, start = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (tops[mid] <= scrollTop) { start = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  let end = start;
  const bottom = scrollTop + viewportH;
  while (end < n && tops[end] < bottom) end++;
  return { start: Math.max(0, start - overscan), end: Math.min(n, end + overscan) };
}

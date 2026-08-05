// Pure helpers for the P1 wide skills roster. No fs — unit-tested in
// scripts/lib/__tests__/skills-roster.test.mjs. The fs walk lives in skills-scan.mjs.

// A "repo roster" line in ~/.claude/CLAUDE.md is a single backtick span holding 5+
// comma-separated slug names. Anything shorter (an inline command like `npm run dev`)
// is not a roster and is ignored.
const MIN_ROSTER_ENTRIES = 5;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Pure: extract the WaahyuTools repo names from a CLAUDE.md body. Sorted + deduped. */
export function parseToolRepos(claudeMd) {
  const found = new Set();
  for (const m of String(claudeMd || "").matchAll(/`([^`\n]+)`/g)) {
    const parts = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length < MIN_ROSTER_ENTRIES) continue;
    if (!parts.every((p) => SLUG_RE.test(p))) continue;
    for (const p of parts) found.add(p);
  }
  return [...found].sort();
}

// Sources render in this order in the UI; unlisted prefixes fall between plugins and tools.
const SOURCE_RANK = (s) =>
  (s === "curated" ? 0 : s === "user" ? 1 : s.startsWith("plugin:") ? 2 : s.startsWith("tools:") ? 4 : 3);

/** Pure: one row per skill id (first source wins), sorted source-rank → source → id. */
export function dedupeRoster(rows) {
  const seen = new Map();
  const ordered = [...rows].sort(
    (a, b) => SOURCE_RANK(a.source) - SOURCE_RANK(b.source) ||
      (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const r of ordered) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

/** Pure: render the committed roster artifact. Deterministic; omits a redundant description. */
export function rosterJson(rows) {
  const out = rows.map((r) => (r.description && r.description !== r.id
    ? { id: r.id, name: r.name, source: r.source, family: r.family, description: r.description }
    : { id: r.id, name: r.name, source: r.source, family: r.family }));
  return JSON.stringify(out, null, 0) + "\n";
}

/** Pure: {source: count} summary for the generator's console line. */
export function countBySource(rows) {
  return rows.reduce((m, r) => ((m[r.source] = (m[r.source] || 0) + 1), m), {});
}

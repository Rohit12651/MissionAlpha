// Command palette model (gap #27) — pure matcher + command descriptor types.
// The descriptors' `run` closures live where they're built (App); the MATCHING is
// pure and unit-tested here so keyboard nav behavior is verifiable without a DOM.

export interface PaletteCommand {
  id: string;
  title: string;
  group: string; // "Navigate" | "Model" | "Connectors" | "Goal" | "Settings" | "Agents"
  keywords?: string;
  hint?: string;
  run: () => void;
}

/**
 * Subsequence fuzzy score: every query char must appear in order. Returns a score
 * (higher = better; contiguous + word-start matches score higher) or -1 for no match.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1;
      if (ti === prevMatch + 1) score += 2; // contiguous run bonus
      if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "/" || t[ti - 1] === ":") score += 3; // word-start
      prevMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

/** Filter + rank commands against a query over title + group + keywords. */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim();
  if (!q) return commands;
  const scored = commands
    .map((c) => {
      const hay = `${c.title} ${c.group} ${c.keywords ?? ""}`;
      // Best of: score against the haystack, and a boosted score against the title alone.
      const s = Math.max(fuzzyScore(q, hay), fuzzyScore(q, c.title) * 2);
      return { c, s };
    })
    .filter((x) => x.s >= 0);
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.c);
}

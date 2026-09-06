// Phase 3 (UI) — R10 adapter trust + R12 injection flags, made visible.
//
// Both have ridden on `externalMeta` since sessions 6 and 10, persisted and rendered by
// nobody. The runtime has been scoring every ingestion source and flagging crafted PR
// bodies the whole time, and the operator deciding those rows could not see either.
//
// LAW 4 APPLIES TO PIXELS, NOT ONLY TO CODE. Trust adds FRICTION; it never grants
// permission. `deliveries.mjs` enforces that producer-side — an external row can never
// auto-apply regardless of score — but a UI can break the same law visually: a green
// "trusted" badge sitting next to an Approve button IS a recommendation to approve, no
// matter what the backend refuses. So the best tier is the QUIETEST chip here, not the
// most affirmative one. `trusted` is the baseline, not a reward.
//
// R12 IS FLAG-ONLY. Content is never filtered, rewritten or rejected — the operator sees
// the original with a marker. The chip must therefore never imply removal: an operator who
// believes the text was cleaned will stop reading the thing they are there to judge.

/** The stamp `trust.stampFor()` writes onto an external Delivery's `externalMeta`. */
export interface TrustStamp {
  source: string;
  score: number;
  tier: "trusted" | "watch" | "suspect";
  friction: "none" | "notice" | "confirm";
  observations: number;
  coldStart: boolean;
}

/** What `inject-detect.flagSummary()` writes. NOTE: it carries NO spans (see below). */
export interface InjectFlags {
  count: number;
  maxSeverity: "low" | "medium" | "high" | "critical";
  score: number;
  patterns: string[];
}

export interface Chip {
  label: string;
  /** A `helm-chip` data-tone value. */
  tone: "muted" | "amber" | "red";
  title: string;
}

const TIERS = new Set(["trusted", "watch", "suspect"]);

/**
 * trustChip(stamp) → Chip | null
 *
 * `null` for an absent or malformed stamp, and that is deliberate in both directions:
 * defaulting an unscored source to `trusted` is an unearned claim, and defaulting it to
 * `suspect` slanders a source nobody has measured. Absence is absence.
 */
export function trustChip(stamp: TrustStamp | null | undefined): Chip | null {
  if (!stamp || typeof stamp !== "object") return null;
  const tier = (stamp as TrustStamp).tier;
  if (typeof tier !== "string" || !TIERS.has(tier)) return null;

  const obs = Number.isFinite(Number(stamp.observations)) ? Number(stamp.observations) : 0;
  // Cold start is its OWN word. Folding "never seen this source" into "seen it, it
  // misbehaved" discards the distinction the operator most needs — the runtime already
  // keeps them apart (trust.mjs moved cold-start off the `suspect` boundary for exactly
  // this reason), so the chip does too.
  const label = stamp.coldStart ? "source: new" : `source: ${tier}`;
  const tone: Chip["tone"] = tier === "suspect" ? "red" : tier === "watch" ? "amber" : "muted";

  return {
    label,
    tone,
    title:
      `Behavioural trust for ${stamp.source || "this source"}: ${tier}` +
      ` (${obs} observation${obs === 1 ? "" : "s"}).` +
      ` Trust adds review friction only — it can never let an external delivery apply itself.`,
  };
}

const SEVERE = new Set(["medium", "low"]);

/**
 * injectionChip(flags) → Chip | null
 *
 * An unrecognised severity resolves to the WORSE tone. A severity this build does not know
 * is not a reason to relax — fail-suspicious, the same rule trust.mjs uses for an
 * unparseable score.
 */
export function injectionChip(flags: InjectFlags | null | undefined): Chip | null {
  if (!flags || typeof flags !== "object") return null;
  const count = Number((flags as InjectFlags).count);
  if (!Number.isFinite(count) || count <= 0) return null;

  const patterns = Array.isArray(flags.patterns) ? flags.patterns : [];
  const tone: Chip["tone"] = SEVERE.has(String(flags.maxSeverity)) ? "amber" : "red";

  return {
    label: `injection: ${count} flagged`,
    tone,
    title:
      `${count} prompt-injection pattern${count === 1 ? "" : "s"} matched` +
      (patterns.length ? ` (${patterns.join(", ")})` : "") +
      `. This is a MARKER only — the content has not been altered, filtered or removed.` +
      ` Read the original text below and judge it yourself.`,
  };
}

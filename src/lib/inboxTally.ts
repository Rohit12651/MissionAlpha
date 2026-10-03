// Phase G (D-7) — the shell's "N deliveries await you · M need you", from real inbox items.
// Questions, design gates and failure clusters are inbox items in their own right, so
// "need you" is every pending item and "deliveries" is the code-shaped subset.

export type InboxKind = "delivery" | "gate" | "question" | "cluster";

const NON_DELIVERY: Readonly<Record<string, InboxKind>> = {
  "design-approval": "gate",
  question: "question",
  failure: "cluster",
};

/** A kind this build does not know is still something waiting on the BOSS: count it. */
export function inboxKindOf(kind: string): InboxKind {
  return NON_DELIVERY[kind] ?? "delivery";
}

export function tallyPending(items: readonly { kind: string; status: string }[]): { deliveries: number; needYou: number } {
  const pending = items.filter((i) => i.status === "pending");
  return {
    deliveries: pending.filter((i) => inboxKindOf(i.kind) === "delivery").length,
    needYou: pending.length,
  };
}

// ── G4 — the Inbox page (mockup RENDER.inbox): filters, queue strip, bulk rule ──

export type InboxKindFilter = "all" | InboxKind | "high";

/** The mockup's filter pills, in order. */
export const INBOX_KIND_FILTERS: readonly (readonly [InboxKindFilter, string])[] = [
  ["all", "All"], ["delivery", "Deliveries"], ["question", "Questions"], ["gate", "Gates"], ["cluster", "Clusters"], ["high", "High risk"],
];

interface Rated { kind: string; risk: { band: string | null } }

export function matchesKindFilter(d: Rated, f: InboxKindFilter): boolean {
  if (f === "all") return true;
  if (f === "high") return d.risk.band === "high";
  return inboxKindOf(d.kind) === f;
}

/** The Queue strip: pending items per kind, and the oldest pending item's creation time (epoch ms). */
export function queueSummary(items: readonly { kind: string; status: string; createdAt?: string }[]): {
  waiting: number; byKind: Record<InboxKind, number>; oldestAt: number | null;
} {
  const byKind: Record<InboxKind, number> = { delivery: 0, question: 0, gate: 0, cluster: 0 };
  let oldestAt: number | null = null;
  const pending = items.filter((i) => i.status === "pending");
  for (const i of pending) {
    byKind[inboxKindOf(i.kind)] += 1;
    const at = i.createdAt ? Date.parse(i.createdAt) : NaN;
    if (!Number.isNaN(at) && (oldestAt === null || at < oldestAt)) oldestAt = at;
  }
  return { waiting: pending.length, byKind, oldestAt };
}

/** Bulk approval offers pending deliveries only, never high risk: those need a typed APPLY. */
export function isBulkSelectable(d: Rated & { status: string }): boolean {
  return d.status === "pending" && inboxKindOf(d.kind) === "delivery" && d.risk.band !== "high";
}

const two = (n: number) => String(n).padStart(2, "0");

/** The mockup's SLA text: total minutes:seconds left, "SLA due" once past. */
export function slaText(deadline: string, nowMs: number): string | null {
  const due = Date.parse(deadline);
  if (Number.isNaN(due)) return null;
  const s = Math.round((due - nowMs) / 1000);
  return s <= 0 ? "SLA due" : `SLA ${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

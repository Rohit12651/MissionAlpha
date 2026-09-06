// Inbox failure clustering — client model (Phase 2, excellence program).
//
// Mirrors agent-runtime/failure-signature.mjs. Kept as a SEPARATE pure module (not
// imported from the runtime) because the client bundle must not pull server code, and
// because this is the layer the UI unit-tests exercise without a DOM.
//
// SAFETY: only `kind: "failure"` deliveries matching the runtime's own
// "<agent> is stuck — <reason>" shape may collapse. A real code/design/clarify delivery
// ALWAYS keeps its own decision — merging two real code changes into one approval would
// be a correctness disaster. The matcher fails closed on anything unrecognised.
import type { Delivery } from "./inboxClient";

const STUCK_RE = /^([\w.-]+) is stuck — ([\w.-]+)/u;

/** Stable cluster key, or null when this delivery must NOT cluster. Never throws. */
export function failureSignature(d: Delivery | null | undefined): string | null {
  if (!d || typeof d !== "object") return null;
  if (d.kind !== "failure") return null;
  // ONLY pending work may collapse. Decided deliveries are HISTORY — clustering them
  // produced a "Dismiss all 4" button on four already-rejected rows, which the runtime
  // correctly refused with "already decided". Caught by live verification, not by tests.
  if (d.status !== "pending") return null;
  if (typeof d.title !== "string") return null;
  const m = STUCK_RE.exec(d.title);
  if (!m) return null;
  const agent = typeof d.agentId === "string" && d.agentId ? d.agentId : m[1];
  return `${agent}::${m[2]}`;
}

export interface ClusterGroup {
  kind: "cluster";
  key: string;
  agentId: string;
  reason: string;
  size: number;
  newestAt: number;
  members: Delivery[];
}
export interface SingleGroup {
  kind: "single";
  key: string;
  newestAt: number;
  delivery: Delivery;
}
export type InboxGroup = ClusterGroup | SingleGroup;

const at = (d: Delivery | undefined): number => Number(d?.createdAt) || 0;

/**
 * Group deliveries into clusters + singles, newest first.
 *
 * INVARIANTS (test-pinned):
 *  - every input appears EXACTLY once in the output
 *  - a signature with one member stays a `single` (a cluster of 1 is noise)
 *  - output order does not depend on input order
 */
export function groupDeliveries(deliveries: readonly Delivery[]): InboxGroup[] {
  const bySig = new Map<string, Delivery[]>();
  const out: InboxGroup[] = [];

  for (const d of deliveries) {
    const sig = failureSignature(d);
    if (sig === null) {
      out.push({ kind: "single", key: `single:${d.id}`, newestAt: at(d), delivery: d });
      continue;
    }
    const bucket = bySig.get(sig);
    if (bucket) bucket.push(d);
    else bySig.set(sig, [d]);
  }

  for (const [key, members] of bySig) {
    const newestAt = members.reduce((max, m) => Math.max(max, at(m)), 0);
    if (members.length === 1) {
      out.push({ kind: "single", key: `single:${members[0].id}`, newestAt, delivery: members[0] });
      continue;
    }
    const [agentId, reason] = key.split("::");
    out.push({ kind: "cluster", key, agentId, reason, size: members.length, newestAt, members });
  }

  // Newest first; key breaks ties so order is deterministic regardless of input order.
  out.sort((a, b) => b.newestAt - a.newestAt || a.key.localeCompare(b.key));
  return out;
}

/** How many decisions the human is spared by collapsing. 0 when nothing clusters. */
export function decisionsSaved(groups: readonly InboxGroup[]): number {
  return groups.reduce((n, g) => (g.kind === "cluster" ? n + (g.size - 1) : n), 0);
}

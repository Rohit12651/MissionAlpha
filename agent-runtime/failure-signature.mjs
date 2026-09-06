// Failure clustering (Phase 2, excellence program) — PURE, no I/O, no DB.
//
// THE PROBLEM, measured on the live runtime: the queue strip reads `tech-lead · 27 fail`,
// `sr-backend · 23 fail`, `sr-frontend · 19 fail`, `coo-station · 15 fail`,
// `cmo-station · 7 fail`, `sales-station · 6 fail` — 97 failures — and the Inbox renders
// them as ~20 near-identical cards ("tech-lead is stuck — spawn" x3, "— timeout" x2,
// "— empty-diff" x3, ...). That is ONE problem presented as TWENTY human decisions, and
// it is the single biggest reason the Inbox reads as a monitoring console rather than a
// decision surface.
//
// SAFETY RULE, enforced by tests: ONLY `kind: "failure"` deliveries whose title matches
// the runtime's own "<agent> is stuck — <reason>" shape may collapse. A real code /
// design / clarify delivery ALWAYS keeps its own individual decision. Merging two real
// code changes into one approval would be a correctness disaster, so the matcher is
// deliberately narrow and fails closed (returns null) on anything it does not recognise.

/** The exact shape the runtime mints for a stuck agent. Narrow on purpose. */
const STUCK_RE = /^(?<agent>[\w.-]+) is stuck — (?<reason>[\w.-]+)/u;

/**
 * A stable cluster key for a failure delivery, or `null` when the delivery must not
 * cluster. Never throws — malformed input is a `null`, not an exception, because this
 * runs inside a render path.
 */
export function failureSignature(delivery) {
  if (!delivery || typeof delivery !== "object") return null;
  if (delivery.kind !== "failure") return null;
  if (typeof delivery.title !== "string") return null;
  // ONLY pending work may collapse — decided deliveries are history, and offering a
  // bulk action on them yields "already decided" for every member.
  if (delivery.status !== "pending") return null;

  const m = STUCK_RE.exec(delivery.title);
  if (!m) return null;

  // Key on the delivery's OWN agentId, not the one parsed out of the title: the title is
  // display text and could drift, while agentId is the record's identity. The parsed
  // reason is what distinguishes "spawn" from "timeout" from "empty-diff".
  const agent = typeof delivery.agentId === "string" && delivery.agentId ? delivery.agentId : m.groups.agent;
  return `${agent}::${m.groups.reason}`;
}

/**
 * Group a delivery list into clusters + singles.
 *
 * Returns, in newest-first order:
 *   { kind: "cluster", key, agentId, reason, size, newestAt, members[] }
 *   { kind: "single",  key, newestAt, delivery }
 *
 * INVARIANTS (all test-pinned):
 *  - every input delivery appears EXACTLY once in the output — nothing is lost or doubled
 *  - a signature with only one member stays a `single` (a "cluster of 1" is just noise)
 *  - output order does not depend on input order
 */
export function groupBySignature(deliveries) {
  const list = Array.isArray(deliveries) ? deliveries : [];
  const bySig = new Map();
  const singles = [];

  for (const d of list) {
    const sig = failureSignature(d);
    if (sig === null) {
      singles.push({ kind: "single", key: `single:${d?.id}`, newestAt: Number(d?.createdAt) || 0, delivery: d });
      continue;
    }
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(d);
  }

  const out = [...singles];
  for (const [key, members] of bySig) {
    const newestAt = members.reduce((max, m) => Math.max(max, Number(m?.createdAt) || 0), 0);
    if (members.length === 1) {
      out.push({ kind: "single", key: `single:${members[0]?.id}`, newestAt, delivery: members[0] });
      continue;
    }
    const [agentId, reason] = key.split("::");
    out.push({ kind: "cluster", key, agentId, reason, size: members.length, newestAt, members });
  }

  // Newest first; `key` breaks ties so the order is deterministic regardless of input
  // order (a screenshot/regression net cannot tolerate a wobbling list).
  out.sort((a, b) => b.newestAt - a.newestAt || a.key.localeCompare(b.key));
  return out;
}

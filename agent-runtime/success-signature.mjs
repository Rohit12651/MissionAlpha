// Phase 2 / R5 — SUCCESS SIGNATURES. The mirror of failure-signature.mjs, and the piece
// that closes MissionAlpha's open loop.
//
// THE GAP THIS FILLS: today run #50 of a task shape is exactly as uninformed as run #1.
// Every approval is a human confirming "yes, this was the right change" — the highest-
// quality training signal the system will ever get — and it is currently discarded the
// instant the PR opens. failure-signature.mjs already clusters what went WRONG; nothing
// records what went RIGHT. This module records it, so retrieval (R6) can put it back into
// the next prompt.
//
// SAME NARROWNESS DISCIPLINE AS ITS MIRROR: the shape matcher is deliberately conservative
// and FAILS CLOSED (returns null) on anything it does not recognise. A wrong signature is
// worse than no signature — it would surface irrelevant prior art as if it were precedent,
// and the model would follow it. Nothing is recorded unless the shape is legible.
//
// SECURITY (Law 2): the record this produces is fed FORWARD into a later agent's prompt,
// which makes it a prompt-injection surface. This module therefore records IDENTITY AND
// SHAPE ONLY — agent, intent, file extensions, path roots, size band, tier — and never
// free text authored by an agent. There is no title, no diff body, no commit message, no
// model output in the record. Text that cannot enter cannot be injected. Retrieval (R6)
// still fences what it injects; this is defense in depth, not a substitute.

/** Delivery kinds that may produce a success signature. A failure never does. */
const SIGNABLE_KINDS = new Set(["code", "change", null, undefined]);

/**
 * Size bands — a coarse bucket, never a raw line count (that is noise, not signal).
 *
 * NULL IS NOT ZERO (the spend.mjs law, and a real bug this test caught): `Number(null)`
 * is 0 in JavaScript, so an ABSENT measurement would silently band as "xs" — the smallest
 * possible change — and every unmeasured approval would pollute the xs bucket. An absent
 * measurement is UNKNOWN and must stay unknown, so it is rejected before any coercion.
 */
export function sizeBand(changedLines) {
  if (changedLines === null || changedLines === undefined || changedLines === "") return null;
  if (typeof changedLines === "boolean") return null;
  const n = Number(changedLines);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 10) return "xs";
  if (n <= 50) return "s";
  if (n <= 200) return "m";
  return "l";
}

/** First path segment, lowercased. `src/lib/a.ts` → `src`. Null when unusable. */
function rootOf(p) {
  if (typeof p !== "string" || !p) return null;
  const seg = p.replace(/^[./]+/, "").split("/")[0];
  return seg && /^[\w.-]{1,40}$/.test(seg) ? seg.toLowerCase() : null;
}

function extOf(p) {
  if (typeof p !== "string") return null;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(p);
  return m ? `.${m[1].toLowerCase()}` : null;
}

/**
 * successSignature(delivery) → stable key string, or null when the delivery must not be
 * recorded. Never throws — this runs inside the decide path.
 *
 * Key shape: `<agentId>::<roots>::<exts>::<band>`
 * e.g. `senior-web-1::src::.tsx|.css::s`
 */
export function successSignature(delivery) {
  if (!delivery || typeof delivery !== "object") return null;
  // ONLY an approved delivery is a success. pending/rejected/changes-requested are not.
  if (delivery.status !== "approved") return null;
  if (!SIGNABLE_KINDS.has(delivery.kind)) return null;

  const agentId = typeof delivery.agentId === "string" && delivery.agentId ? delivery.agentId : null;
  if (!agentId || !/^[\w.-]{1,64}$/.test(agentId)) return null;

  const paths = Array.isArray(delivery.changedPaths) ? delivery.changedPaths.filter((p) => typeof p === "string") : [];
  if (!paths.length) return null; // no diff → nothing shaped to learn from

  const roots = [...new Set(paths.map(rootOf).filter(Boolean))].sort();
  const exts = [...new Set(paths.map(extOf).filter(Boolean))].sort();
  if (!roots.length || !exts.length) return null;

  const lines = Number.isFinite(delivery.diffAdditions) && Number.isFinite(delivery.diffDeletions)
    ? delivery.diffAdditions + delivery.diffDeletions
    : null;
  const band = sizeBand(lines) ?? "u";

  return `${agentId}::${roots.join("|")}::${exts.join("|")}::${band}`;
}

/**
 * Build the vault-ready record for an approved delivery. IDENTITY AND SHAPE ONLY — see the
 * Law-2 note in the header. Returns null when there is nothing legible to record.
 *
 * The id is STABLE per signature, so a second approval of the same shape UPDATES the one
 * record instead of piling near-duplicates into the vault (the pipeline.mjs convention).
 */
export function buildSuccessRecord(delivery, { now = Date.now } = {}) {
  const sig = successSignature(delivery);
  if (!sig) return null;

  const [agentId, roots, exts, band] = sig.split("::");
  // Slug must satisfy vault's SLUG_RE: ^[a-z0-9][a-z0-9-]{0,63}$
  const id = `pattern-${sig.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 55)}`;

  return {
    id,
    signature: sig,
    agentId,
    roots: roots.split("|"),
    exts: exts.split("|"),
    band,
    tier: typeof delivery.tier === "number" ? delivery.tier : null,
    fileCount: Array.isArray(delivery.changedPaths) ? delivery.changedPaths.length : null,
    approvedAt: Number(delivery.decidedAt) || now(),
    // The human-readable body the vault stores. Shape only — deliberately boring, and
    // deliberately free of any agent-authored text.
    title: `Pattern: ${agentId} · ${roots} · ${exts} (${band})`,
    body: [
      `Approved change shape for **${agentId}**.`,
      "",
      `- Path roots: ${roots.split("|").join(", ")}`,
      `- File types: ${exts.split("|").join(", ")}`,
      `- Size band: ${band}`,
      `- Files touched: ${Array.isArray(delivery.changedPaths) ? delivery.changedPaths.length : "?"}`,
      "",
      "This record is SHAPE ONLY. It carries no agent-authored text by design",
      "(it is fed forward into later prompts — see Law 2).",
    ].join("\n"),
  };
}

/**
 * Wire point: call on every decide. Writes through the injected vault (which owns scrub,
 * containment and the 32KB cap — no second scrub lives here, per the B2 law).
 *
 * NEVER throws and NEVER blocks the decision: a learning-store failure must not be able to
 * stop a human's approval from landing. Returns {recorded:boolean, id?, reason?}.
 */
export function createSuccessLearner(deps = {}) {
  const vault = deps.vault || null;
  const venture = deps.venture || "waahyu";
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const now = deps.now || Date.now;

  function onDecided(delivery) {
    try {
      const rec = buildSuccessRecord(delivery, { now });
      if (!rec) return { recorded: false, reason: "not a legible success shape" };
      if (!vault || typeof vault.write !== "function") return { recorded: false, reason: "no vault wired", record: rec };

      vault.write({
        id: rec.id,
        venture,
        node: "decisions",
        agent: rec.agentId,
        title: rec.title,
        body: rec.body,
        source: "success-signature",
      });
      return { recorded: true, id: rec.id, signature: rec.signature };
    } catch (e) {
      log(`[learn] success record skipped: ${e?.message}`);
      return { recorded: false, reason: e?.message || "error" };
    }
  }

  return { onDecided, buildSuccessRecord, successSignature };
}

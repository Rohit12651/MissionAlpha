// Phase 4 / Feature #7 — dynamic team routing (ADR-050 §Phase-4).
//
// Resolve a requirement's needed stack to the agent that OWNS it — built-in OR
// factory-minted. The "team" is BUILTIN ∪ MINTED: minted dev-agents (Phase 3) become
// first-class routable here. The engine enqueue route already accepts an arbitrary
// agentId, so routing is DATA, not new engine code.
//
// Pure module — no I/O. Callers pass the minted specs (e.g. factory.listAgents()).

import { capabilityIndex, capsForSpec } from "./capabilities.mjs";

const KINDS = ["langs", "frameworks", "dbs"];
const KIND_SINGULAR = { langs: "lang", frameworks: "framework", dbs: "db" };

// Merge built-ins + minted into one Map<agentId,{langs,frameworks,dbs}> and a Set of
// minted ids (for source tagging + tie-break). Built-ins are inserted first so a broad
// built-in is only chosen when no minted specialist covers the need.
export function fullIndex(mintedSpecs = []) {
  const index = capabilityIndex(); // Map (built-ins)
  const mintedIds = new Set();
  for (const spec of mintedSpecs) {
    if (!spec || !spec.id) continue;
    index.set(spec.id, capsForSpec(spec));
    mintedIds.add(spec.id);
  }
  return { index, mintedIds };
}

// Owner of a single need. TIE-BREAK: a MINTED specialist wins over a broad built-in —
// the minted agent is purpose-built for that stack, so it's the right owner.
function ownerFor(index, mintedIds, kind, value) {
  let builtin = null;
  for (const [agentId, caps] of index) {
    if ((caps[kind] || []).includes(value)) {
      if (mintedIds.has(agentId)) return { agentId, source: "minted" }; // minted wins
      if (!builtin) builtin = { agentId, source: "builtin" };
    }
  }
  return builtin; // null if nobody covers it
}

// Resolve a needs manifest → { assignments:[{kind,value,agentId,source}], unresolved:[{kind,value}] }.
export function resolveAgents(needs = {}, mintedSpecs = []) {
  const { index, mintedIds } = fullIndex(mintedSpecs);
  const assignments = [];
  const unresolved = [];
  const seen = new Set();
  for (const kind of KINDS) {
    for (const raw of needs[kind] || []) {
      const value = String(raw).toLowerCase().trim();
      if (!value) continue;
      const key = `${kind}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = { kind: KIND_SINGULAR[kind], value };
      const owner = ownerFor(index, mintedIds, kind, value);
      if (owner) assignments.push({ ...item, agentId: owner.agentId, source: owner.source });
      else unresolved.push(item);
    }
  }
  return { assignments, unresolved };
}

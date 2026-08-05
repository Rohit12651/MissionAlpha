// Pure helpers for removing an agent from the board. Routing depends on HOW the agent
// got there: imported pool agents un-pin (POST /factory/pool/remove); factory-created
// agents hard-delete (DELETE /factory/:id). The CEO is never removable. Builtin seed
// agents that are neither imported nor factory cannot be deleted (they are roster seeds).

export interface RemovableAgent {
  id: string;
  factory?: boolean;  // created via the Agent Factory
  imported?: boolean; // pinned from the .claude/agents pool
}

export type RemovableKind = "imported" | "factory" | "none";

// The CEO thread shows on the "ceo" card (and is chatted via the "boss" id alias) — never removable.
const PROTECTED = new Set(["ceo", "boss"]);
// Built-in swarm agents. These ids are RESERVED server-side (factory BUILTIN_IDS), so they
// can never legitimately be a factory mint — a `factory:true` flag on one of them is stale
// board state, not permission. Mirror of agent-runtime/factory.mjs BUILTIN_IDS.
const BUILTIN = new Set([
  "architect", "principal-ux-design", "principal-db-engineer",
  "senior-security-engineer", "senior-cicd-engineer", "senior-lead-dev",
  "senior-web-1", "senior-web-2", "principal-rn-mobile-1", "principal-rn-mobile-2",
  "senior-backend-1", "senior-backend-2", "senior-qa", "senior-code-reviewer",
  "memory-updater",
]);

export function removableKind(a: RemovableAgent): RemovableKind {
  if (PROTECTED.has(a.id)) return "none";
  // Un-pinning an IMPORTED pool agent is reversible (the .claude/agents source file is
  // untouched), so it stays available for built-ins too — you can always re-add them.
  if (a.imported) return "imported";
  // DESTRUCTIVE delete is different: a built-in id is reserved server-side and can never
  // be a legitimate factory mint, so a `factory:true` flag on one is stale board state.
  if (BUILTIN.has(a.id)) return "none";
  if (a.factory) return "factory"; // hard-delete a minted agent
  return "none";
}

/** Human-readable reason a removal control is absent. null when the agent IS removable. */
export function removalReason(a: RemovableAgent): string | null {
  if (PROTECTED.has(a.id)) return "The CEO is permanent.";
  if (a.imported) return null;
  if (BUILTIN.has(a.id)) return "Built-in swarm agent — not removable.";
  if (a.factory) return null;
  return "Roster seed — not created here, nothing to remove.";
}

export interface DeleteReq {
  method: "POST" | "DELETE";
  path: string;
  body?: { ids: string[] };
}

// Build the HTTP request for a removal, or null when nothing should be called.
export function deleteRequest(kind: RemovableKind, id: string): DeleteReq | null {
  if (kind === "imported") return { method: "POST", path: "/factory/pool/remove", body: { ids: [id] } };
  if (kind === "factory") return { method: "DELETE", path: `/factory/${encodeURIComponent(id)}` };
  return null;
}

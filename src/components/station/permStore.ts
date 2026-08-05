// CC-Primitives P5 — one tiny module store for per-station permission modes.
//
// WHY a store and not props: the same value is read in two places that are nowhere
// near each other in the tree — the chip on AgentCard (deep inside the kanban) and
// the segmented control in the drawer — and BOTH must reconcile on the same
// `station.perm.changed` frame. Threading it as props would mean touching the board,
// the columns and the card just to carry a string, and would re-render every card on
// every frame. This follows the EXISTING ventureScope.ts precedent exactly:
// useSyncExternalStore, no Context provider, per-subscriber re-render only.
//
// The fetch is lazy, single-flight and cached per agent id, so a board of N cards
// issues at most N gated GETs once — never one per render, never on a timer.
import { useEffect, useSyncExternalStore } from "react";
import { getPermMode, isPermMode, type PermMode, type PermModeDoc } from "../../lib/stationClient.ts";

type Listener = () => void;
const listeners = new Set<Listener>();

// Replaced immutably per agent so `getSnapshot` returns a STABLE reference between
// changes (useSyncExternalStore re-renders forever otherwise).
let docs: Record<string, PermModeDoc> = Object.create(null);
const inflight = new Set<string>();

function notify() {
  for (const fn of listeners) fn();
}

function write(agentId: string, next: PermModeDoc) {
  const cur = docs[agentId];
  if (cur && cur.permMode === next.permMode && cur.effective === next.effective && cur.global === next.global) return;
  docs = { ...docs, [agentId]: next };
  notify();
}

/** The cached doc for an agent, or undefined while it is still unknown. */
export function getPermDoc(agentId: string): PermModeDoc | undefined {
  return docs[agentId];
}

/** Subscribe to store changes; returns an unsubscribe. */
export function subscribePerm(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Lazy, single-flight read. `force` re-reads a cached agent (used after a frame).
 * A failure leaves the entry unknown — the chip stays absent rather than claiming
 * "no override" on a read the server never answered.
 */
export async function ensurePerm(agentId: string, force = false): Promise<void> {
  if (!agentId) return;
  if (inflight.has(agentId) || (!force && docs[agentId])) return;
  inflight.add(agentId);
  try {
    const doc = await getPermMode(agentId);
    if (doc && isPermMode(doc.effective)) {
      write(agentId, {
        agentId,
        permMode: isPermMode(doc.permMode) ? doc.permMode : null,
        global: isPermMode(doc.global) ? doc.global : undefined,
        effective: doc.effective,
      });
    }
  } catch {
    /* unknown stays unknown — see above */
  } finally {
    inflight.delete(agentId);
  }
}

/**
 * Optimistic local write (the toggle applies it before the PUT resolves, and rolls
 * back by calling this again with the previous value).
 */
export function setPermLocal(agentId: string, override: PermMode | null): void {
  const cur = docs[agentId];
  write(agentId, {
    agentId,
    permMode: override,
    global: cur?.global,
    effective: override ?? cur?.global ?? cur?.effective ?? "default",
  });
}

/**
 * Reconcile from a `station.perm.changed` SSE frame. The frame is identity + mode
 * only; anything malformed is ignored rather than poisoning the chip.
 */
export function applyPermFrame(data: Record<string, unknown>): void {
  const agentId = typeof data?.agentId === "string" ? data.agentId : "";
  if (!agentId) return;
  const mode = data?.permMode;
  if (isPermMode(mode)) setPermLocal(agentId, mode);
  else void ensurePerm(agentId, true);
}

/**
 * The hook both surfaces read. Triggers the lazy fetch on mount and re-renders ONLY
 * this subscriber when the agent's own entry changes.
 */
export function useStationPerm(agentId: string): PermModeDoc | undefined {
  const doc = useSyncExternalStore(
    subscribePerm,
    () => docs[agentId],
    () => docs[agentId],
  );
  useEffect(() => { void ensurePerm(agentId); }, [agentId]);
  return doc;
}

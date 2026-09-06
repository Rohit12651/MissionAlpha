// Multi-select model for the Inbox (Phase 3, excellence program). PURE — no React, no
// DOM, so the selection rules are unit-testable without rendering anything.
//
// Selection is a plain id Set plus an anchor for shift-range. It is deliberately NOT
// stored per-delivery: the list re-renders constantly off SSE, and a selection that
// lived on the row objects would be lost on every refresh.

export interface SelectionState {
  ids: ReadonlySet<string>;
  /** Last individually-toggled id — the origin for a shift-click range. */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { ids: new Set(), anchor: null };

export function toggle(state: SelectionState, id: string): SelectionState {
  const ids = new Set(state.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/**
 * Shift-click: select the inclusive range between the anchor and `id` in the CURRENT
 * visible order. Falls back to a plain toggle when there is no anchor, or when either
 * end is not in view (the list changed under us) — never throws, never selects nothing.
 */
export function selectRange(state: SelectionState, id: string, orderedIds: readonly string[]): SelectionState {
  if (!state.anchor) return toggle(state, id);
  const a = orderedIds.indexOf(state.anchor);
  const b = orderedIds.indexOf(id);
  if (a === -1 || b === -1) return toggle(state, id);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const ids = new Set(state.ids);
  for (let i = lo; i <= hi; i++) ids.add(orderedIds[i]);
  return { ids, anchor: id };
}

export function clear(): SelectionState {
  return EMPTY_SELECTION;
}

/** Drop ids that are no longer visible, so a stale selection can't be acted on. */
export function prune(state: SelectionState, visibleIds: readonly string[]): SelectionState {
  const visible = new Set(visibleIds);
  const ids = new Set([...state.ids].filter((id) => visible.has(id)));
  if (ids.size === state.ids.size) return state;
  return { ids, anchor: state.anchor && visible.has(state.anchor) ? state.anchor : null };
}

export const isSelected = (state: SelectionState, id: string): boolean => state.ids.has(id);
export const selectedCount = (state: SelectionState): number => state.ids.size;
export const selectedIds = (state: SelectionState): string[] => [...state.ids];

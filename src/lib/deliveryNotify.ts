// Delivery notification plumbing (P3, program plan §5.10 "one per delivery").
//
// Two surfaces, one policy:
//   · packaged Electron → native Notification + dock badge, over the EXISTING
//     window.missionAlpha contextBridge (no new IPC surface shape invented here).
//   · browser / dev     → document.title carries the count, which is the only
//     badge a tab has.
//
// The pure half is unit-tested; nothing in it touches the DOM or the bridge.

/** Bounded so a long-lived session can't grow the dedupe set without limit. */
export const SEEN_CAP = 500;

/**
 * True the first time a delivery id is offered, false forever after. Mutates
 * `seen` (bounded, FIFO-evicted) — one notification per Delivery, §5.10.
 */
export function shouldNotify(seen: Set<string>, id: string): boolean {
  if (!id || seen.has(id)) return false;
  seen.add(id);
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

/** Web fallback badge: "(3) MissionAlpha". Zero ⇒ the bare title, never "(0)". */
export function titleWithBadge(base: string, pending: number): string {
  const clean = base.replace(/^\(\d+\)\s*/, "");
  return pending > 0 ? `(${pending}) ${clean}` : clean;
}

/** One-line notification body from a delivery.created payload. */
export function notificationText(data: Record<string, unknown>): { title: string; body: string } {
  const agentId = typeof data.agentId === "string" && data.agentId ? data.agentId : "an agent";
  const raw = typeof data.title === "string" && data.title.trim() ? data.title.trim() : "New delivery";
  return { title: raw.slice(0, 120), body: `${agentId} — awaiting your decision` };
}

/**
 * Fire the platform notification, once per Delivery. In packaged Electron this
 * reaches the native Notification + dock badge over the existing contextBridge;
 * in dev/browser the bridge is absent and `syncTitleBadge` is the whole badge.
 * Never throws into the SSE callback.
 */
export function emitDeliveryNotification(
  data: Record<string, unknown>,
  pending: number,
  seen: Set<string>,
): void {
  const id = typeof data.id === "string" ? data.id : "";
  if (!shouldNotify(seen, id)) return;
  const { title, body } = notificationText(data);
  try {
    globalThis.window?.missionAlpha?.notifyDelivery?.({ id, title, body, pending });
  } catch {
    /* bridge is best-effort — the tab-title badge still carries the count */
  }
}

/**
 * Half-life re-notification body from a `delivery.sla_halflife` payload (program
 * plan §5.10 — re-notify only at the SLA half-life). The server fires the event
 * exactly once per delivery; the client dedupes again on a separate seen-set so a
 * reconnect replay cannot double-notify.
 */
export function slaNotificationText(data: Record<string, unknown>): { title: string; body: string } {
  const agentId = typeof data.agentId === "string" && data.agentId ? data.agentId : "an agent";
  const band = typeof data.band === "string" && data.band ? `${data.band} risk` : "";
  return {
    title: "Delivery still awaiting your decision",
    body: `${agentId}${band ? ` · ${band}` : ""} — halfway to its SLA`,
  };
}

/** Fire the SLA half-life re-notification, once per delivery. Never throws. */
export function emitSlaNotification(data: Record<string, unknown>, seen: Set<string>): void {
  const id = typeof data.id === "string" ? data.id : "";
  if (!shouldNotify(seen, id)) return;
  const { title, body } = slaNotificationText(data);
  try {
    globalThis.window?.missionAlpha?.notifyDelivery?.({ id, title, body, pending: 0 });
  } catch {
    /* bridge is best-effort */
  }
}

/** Web badge. Safe to call unconditionally — a no-op outside a document. */
export function syncTitleBadge(pending: number): void {
  if (typeof document === "undefined") return;
  document.title = titleWithBadge(document.title, pending);
}

// B0 — Business-OS nav registry.
//
// This is the ONLY source of sidebar items. Every entry resolves to something that
// already ships: a `view` flips the existing `shellView` (Inbox ⇄ Board), an
// `action` calls an existing setter (settings modal, factory signal, utility
// drawer, chat pane), or — since B1 — a `page` whose id comes from the CLOSED
// BosPage union. There are no free-form hrefs, so the mockup's failure mode — a
// nav item pointing at a surface that was never built — cannot be represented in
// this type, let alone rendered.
//
// B1+ adds new pages by widening BosPage; the render slot in App.tsx keys off
// that union, so a page nobody built is a compile error, never a blank screen.

import type { ShellView } from "../ViewToggle";

/** B1 — the closed set of BOS pages. A literal union, never a free-form href.
 *  B5 widened it with `center`: the cross-venture Command Center home.
 *  B6 widened it with `pipeline` (CRM-lite kanban) + `content` (the content engine);
 *  S0 (story pipeline) DELETED both, along with their stores, routes and client libs.
 *  Only the `lead.moved` / `content.changed` SSE names survive, RESERVED in the closed
 *  event catalog — nothing emits them. */
export type BosPage = "center" | "stories" | "deck" | "vault" | "brief" | "workflows" | "schedule" | "outputs" | "roadmap";

export type BosNavEntry =
  | { id: string; label: string; icon: string; kind: "view"; view: ShellView }
  | { id: string; label: string; icon: string; kind: "action"; action: "chat" | "sessions" | "factory" | "settings" }
  | { id: string; label: string; icon: string; kind: "page"; page: BosPage };

/** Closed registry — the ONLY source of sidebar items. Unknown ids cannot render. */
export const BOS_NAV: readonly BosNavEntry[] = [
  // B5 — the Command Center is the cross-venture home, so it takes the TOP slot (above
  // the CEO brief and the mission views). It is the landing surface: every number on it
  // is computed from the real stores, scoped by the app-wide venture switcher.
  { id: "center",   label: "Command center", icon: "center", kind: "page",   page: "center" },
  { id: "inbox",    label: "Inbox",         icon: "inbox",    kind: "view",   view: "inbox" },
  // S6 — Stories is the primary pipeline surface (the SE team's SDLC, story by story). It sits
  // directly under the Inbox (your gates) and ABOVE Missions: "the board keeps living under
  // Stories" — the raw agent board stays reachable one slot below, unchanged.
  { id: "stories",  label: "Stories",       icon: "stories",  kind: "page",   page: "stories" },
  { id: "missions", label: "Missions",      icon: "board",    kind: "view",   view: "board" },
  // B3 — the CEO brief sits ABOVE Agents (master spec §4 orders it there), so it takes
  // the slot directly after Missions and pushes the deck down one.
  { id: "brief",    label: "CEO brief",     icon: "brief",    kind: "page",   page: "brief" },
  { id: "deck",     label: "Agents",        icon: "deck",     kind: "page",   page: "deck" },
  // B4 — Automation: the standing cadences (Workflows) and today's watch (Schedule) sit
  // directly after Agents and before the Chat action, keeping the page cluster contiguous.
  { id: "workflows", label: "Workflows",    icon: "workflows", kind: "page",  page: "workflows" },
  { id: "schedule",  label: "Schedule",     icon: "schedule",  kind: "page",  page: "schedule" },
  // S0 — B6's Pipeline (CRM-lite kanban) and Content engine are gone from the product:
  // no nav entry, no page, no client lib, no route. Only the reserved SSE names remain.
  // B7 — Outputs (the artifact registry) sits directly after Automation, closing the
  // page cluster before the Chat action.
  { id: "outputs",   label: "Outputs",      icon: "outputs",   kind: "page",  page: "outputs" },
  { id: "chat",     label: "Chat",          icon: "chat",     kind: "action", action: "chat" },
  // B2 — the Knowledge Vault sits between Chat and Sessions: master spec §9 orders
  // Sessions UNDER Knowledge vault, so the vault takes the slot directly above it.
  { id: "vault",    label: "Knowledge vault", icon: "vault",  kind: "page",   page: "vault" },
  { id: "sessions", label: "Sessions",      icon: "replay",   kind: "action", action: "sessions" },
  { id: "factory",  label: "Agent Factory", icon: "factory",  kind: "action", action: "factory" },
  { id: "settings", label: "Settings",      icon: "settings", kind: "action", action: "settings" },
  // B7 — Roadmap is a read-only documentation surface (mirrors the program plan), so it
  // takes the LAST slot, after the operational pages and actions.
  { id: "roadmap",  label: "Roadmap",       icon: "roadmap",  kind: "page",   page: "roadmap" },
] as const;

export function resolveNav(id: string): BosNavEntry | null {
  return BOS_NAV.find((e) => e.id === id) ?? null;
}

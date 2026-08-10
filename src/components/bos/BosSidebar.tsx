// B0 — Business-OS sidebar. WRAPS the existing shell rather than replacing it:
// every item here dispatches into a setter that already ships, via the closed
// BOS_NAV registry (see bosNav.ts). The rail is a <nav>, never a <main> — the one
// <main id="ma-main"> per view still belongs to the Inbox / Board branch, so the
// skip link keeps exactly one target.
//
// Icons are the SAME lucide glyphs already used elsewhere in the shell (Inbox in
// the inbox empty state, LayoutDashboard/MessageSquare in App, History in the
// utility drawer, Factory in the Agent Factory, Settings in the TitleBar) so the
// sidebar adds no new icon vocabulary.

import { memo, useEffect, useRef, useState } from "react";
import {
  Inbox,
  LayoutDashboard,
  MessageSquare,
  History,
  Factory,
  Users,
  Library,
  Compass,
  Workflow,
  CalendarClock,
  Gauge,
  PackageOpen,
  GitBranch,
  Map as MapIcon,
  KeyRound,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { BOS_NAV, type BosNavEntry, type BosPage } from "./bosNav";
import type { ShellView } from "../ViewToggle";
import type { AgentState } from "../../data/types";
import { agentAccent, tok } from "../../lib/agentMeta";
import type { VentureRef } from "../../lib/vaultClient";

/** Registry icon key → the glyph. Keys are closed by BOS_NAV, so no fallback path. */
const ICONS: Record<string, LucideIcon> = {
  inbox: Inbox,
  board: LayoutDashboard,
  // B5 — the Command Center. Gauge reads as a cockpit dial, distinct from the deck's
  // captain compass and the board glyph; it is the one new icon this phase adds.
  center: Gauge,
  // S6 — Stories, the SDLC pipeline. GitBranch reads as a branching flow of work — distinct
  // from the board's grid and the roadmap's map; the one new glyph this phase adds.
  stories: GitBranch,
  // B1 — the Command deck. Users is already the shell's "agents" glyph (App.tsx's
  // mobile pane toggle), so the deck adds no new icon vocabulary.
  deck: Users,
  // B2 — the Knowledge Vault. Library is lucide's shelf-of-records glyph; it is the
  // only new icon this phase adds, and it adds exactly one.
  vault: Library,
  // B3 — the CEO brief. Compass matches the deck's captain emblem and the console dial,
  // so the three captain surfaces read as one motif. One new glyph, as in B2.
  brief: Compass,
  // B4 — Automation. Workflow is lucide's node-graph glyph (the cadence table) and
  // CalendarClock its scheduled-time sibling; the two Automation surfaces read together.
  workflows: Workflow,
  schedule: CalendarClock,
  // CC-Primitives P6 — engineering-only scope: the pipeline/content nav entries (and
  // their glyphs) are cut; BOS_NAV can no longer emit those icon keys.
  // B7 — Outputs (an opening box: produced artifacts) and Roadmap (a map: the program's
  // documented phase status). Two new glyphs closing the one-per-phase discipline.
  outputs: PackageOpen,
  roadmap: MapIcon,
  chat: MessageSquare,
  replay: History,
  factory: Factory,
  // Multi-Provider Credentials — Accounts. KeyRound reads as a credential/identity
  // glyph, distinct from the settings gear; the one new icon this feature adds.
  accounts: KeyRound,
  settings: SettingsIcon,
};

export interface BosSidebarProps {
  shellView: ShellView;
  /** B1 — the BOS page currently occupying the main slot, or null when a view owns it. */
  bosPage: BosPage | null;
  pending: number;
  agents: readonly AgentState[];
  /** App owns the dispatch — the sidebar never touches app state directly. */
  onNav: (entry: BosNavEntry) => void;
  /** Existing openAgent — opens the read-only inspect drawer. */
  onAgent: (id: string) => void;
  /** B2 — the current venture scope; null = all ventures. */
  venture: string | null;
  /** B2 — every venture the runtime knows about, with live record counts. */
  ventures: readonly VentureRef[];
  /** B2 — App owns the scope (it persists it and passes it down). */
  onVenture: (id: string | null) => void;
}

// ── B2 venture switcher ──────────────────────────────────────────────────────
// A real popover, not the B0 disabled pill. Keyboard-complete because it is a menu
// and a menu that only works with a mouse is not shipped: ↑/↓ move, Home/End jump,
// Enter/Space choose, Esc closes and returns focus to the trigger. Focus is moved to
// the active row on every step, so the browser's own focus ring (the ONE ring in
// index.css) marks position — no second ring, no roving-tabindex bookkeeping.
//
// SCOPE, HONESTLY: as of B5 this is APP-WIDE. It writes the one venture-scope store
// (ventureScope.ts) that the vault, the deck, workflows, the schedule and the Command
// Center all read, so choosing here re-scopes every open surface. The trigger title
// states that plainly rather than implying a narrower filter.
const ALL_VENTURES = "__all__";

function VentureSwitcher({
  venture,
  ventures,
  onVenture,
}: {
  venture: string | null;
  ventures: readonly VentureRef[];
  onVenture: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const rows: { key: string; label: string; note: string; value: string | null }[] = [
    { key: ALL_VENTURES, label: "All ventures", note: "no filter", value: null },
    ...ventures.map((v) => ({ key: v.id, label: v.name || v.id, note: `${v.records}`, value: v.id })),
  ];
  const currentIndex = Math.max(0, rows.findIndex((r) => r.value === venture));
  const currentLabel = rows[currentIndex]?.label ?? "All ventures";

  // Opening focuses the current row; closing hands focus back to the trigger. Without
  // that round trip a keyboard user lands at the top of the document on Esc.
  useEffect(() => {
    if (!open) return;
    setActive(currentIndex);
    const id = requestAnimationFrame(() => {
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-vrow]")[currentIndex]?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusRow = (i: number) => {
    const n = rows.length;
    const next = ((i % n) + n) % n;
    setActive(next);
    listRef.current?.querySelectorAll<HTMLButtonElement>("[data-vrow]")[next]?.focus();
  };
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const choose = (v: string | null) => { onVenture(v); close(); };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); focusRow(active + 1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); focusRow(active - 1); return; }
    if (e.key === "Home") { e.preventDefault(); focusRow(0); return; }
    if (e.key === "End") { e.preventDefault(); focusRow(rows.length - 1); return; }
  };

  return (
    <div className="bos-venture-wrap">
      {open && (
        <div
          ref={listRef}
          className="bos-venture-pop"
          role="menu"
          aria-label="Choose a venture"
          onKeyDown={onListKeyDown}
          // A click outside must close it. blur-with-relatedTarget keeps that from
          // firing while focus moves BETWEEN rows inside the popover.
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
        >
          {rows.map((r, i) => (
            <button
              key={r.key}
              type="button"
              data-vrow
              role="menuitemradio"
              aria-checked={r.value === venture}
              className="bos-venture-row"
              data-current={r.value === venture ? "true" : undefined}
              tabIndex={i === active ? 0 : -1}
              onClick={() => choose(r.value)}
            >
              <span className="bos-venture-row-name">{r.label}</span>
              <span className="bos-venture-row-note helm-mono">{r.note}</span>
            </button>
          ))}
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        className="bos-venture"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Scopes every Business-OS surface — the vault, the deck, workflows, the schedule and the command center."
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); }
        }}
      >
        <span>Venture</span>
        <span className="bos-venture-name">{currentLabel}</span>
        <span aria-hidden>▾</span>
      </button>
    </div>
  );
}

function NavIcon({ name }: { name: string }) {
  const Glyph = ICONS[name];
  return Glyph ? <Glyph size={15} aria-hidden className="bos-item-icon" /> : null;
}

export const BosSidebar = memo(function BosSidebar({
  shellView,
  bosPage,
  pending,
  agents,
  onNav,
  onAgent,
  venture,
  ventures,
  onVenture,
}: BosSidebarProps) {
  // A page and a view can never both be current: while a BOS page owns the main slot
  // bosPage is set, and every view entry clears it on dispatch.
  const isCurrent = (e: BosNavEntry) =>
    e.kind === "page" ? e.page === bosPage : e.kind === "view" && bosPage === null && e.view === shellView;
  const inboxEntry = BOS_NAV.find((e) => e.id === "inbox");
  const rest = BOS_NAV.filter((e) => e.id !== "inbox");

  return (
    <nav className="bos-side" aria-label="Business OS">
      <div className="bos-brand">
        {/* Compass rose — the helm mark. Decorative; the name beside it is the label. */}
        <svg className="bos-brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
          <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.3" />
          <path d="M15.4 8.6 10.9 10.9 8.6 15.4l4.5-2.3 2.3-4.5Z" fill="currentColor" />
        </svg>
        <span className="min-w-0">
          <span className="bos-brand-name">Helm</span>
          <span className="bos-brand-sub">Business OS</span>
        </span>
      </div>

      {inboxEntry && (
        <button
          type="button"
          className="bos-inbox-pin"
          aria-current={isCurrent(inboxEntry) ? "true" : undefined}
          onClick={() => onNav(inboxEntry)}
        >
          <NavIcon name={inboxEntry.icon} />
          <span className="bos-item-label">{inboxEntry.label}</span>
          {pending > 0 && (
            <span className="helm-badge" aria-label={`${pending} awaiting your decision`}>
              {pending}
            </span>
          )}
        </button>
      )}

      <div className="bos-group">
        <span className="bos-label">Workspace</span>
        {rest.map((e) => (
          <button
            key={e.id}
            type="button"
            className="bos-item"
            aria-current={isCurrent(e) ? "true" : undefined}
            onClick={() => onNav(e)}
          >
            <NavIcon name={e.icon} />
            <span className="bos-item-label">{e.label}</span>
          </button>
        ))}
      </div>

      <div className="bos-group">
        <span className="bos-label">Agents</span>
        {agents.length === 0 ? (
          <p className="bos-empty">No agents yet.</p>
        ) : (
          agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className="bos-agent"
              onClick={() => onAgent(a.id)}
              aria-label={`Inspect ${a.id}`}
            >
              <span
                className="bos-agent-dot"
                aria-hidden
                style={{ backgroundColor: tok(agentAccent(a)) }}
              />
              <span className="bos-agent-name">{a.id}</span>
              <span className="bos-agent-role">{a.role || "agent"}</span>
            </button>
          ))
        )}
      </div>

      {/* B5 — the switcher writes the app-wide venture-scope store; the vault, the deck,
          workflows, the schedule and the Command Center all re-scope off this one value. */}
      <VentureSwitcher venture={venture} ventures={ventures} onVenture={onVenture} />
    </nav>
  );
});

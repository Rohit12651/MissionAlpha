// B0 — Business-OS sidebar. WRAPS the existing shell rather than replacing it: every item
// here dispatches into a setter that already ships, via the closed BOS_NAV registry
// (see bosNav.ts). The rail is a landmark, never a <main> — the one <main id="ma-main"> per
// view still belongs to the page branch, so the skip link keeps exactly one target.
//
// Phase G (ADR G-2): markup and classes are the approved mockup's `.sb` verbatim
// (docs/mockups/missionalpha-sketchbook.html). The `bos-*` classes that remain are
// unstyled hooks the visual harness navigates by (test/visual/pages.mjs); bos.css no longer
// styles them.

import { memo, useEffect, useRef, useState } from "react";
import { BOS_NAV, type BosNavEntry, type BosPage } from "./bosNav";
import type { ShellView } from "../ViewToggle";
import type { AgentState } from "../../data/types";
import type { VentureRef } from "../../lib/vaultClient";
import { deckOrder, stationBadge, stationById, BADGE_LABEL, type StationBadgeId } from "../../lib/stationMeta";
import { getWorkspace, displayPath } from "../../lib/workspaceClient";

const WATCH_DOT: Record<StationBadgeId, string> = { on: "ok", standby: "warn", off: "muted" };

export interface BosSidebarProps {
  shellView: ShellView;
  /** B1 — the BOS page currently occupying the main slot, or null when a view owns it. */
  bosPage: BosPage | null;
  /** Every pending inbox item (D-7). */
  pending: number;
  agents: readonly AgentState[];
  /** App owns the dispatch — the sidebar never touches app state directly. */
  onNav: (entry: BosNavEntry) => void;
  /** Existing openAgent — opens the inspect drawer. */
  onAgent: (id: string) => void;
  /** The wordmark returns to the splash (D-3). */
  onBrand?: () => void;
  venture: string | null;
  ventures: readonly VentureRef[];
  onVenture: (id: string | null) => void;
}

export function isCurrentEntry(e: BosNavEntry, bosPage: BosPage | null, shellView: ShellView): boolean {
  return e.kind === "page" ? e.page === bosPage : e.kind === "view" && bosPage === null && e.view === shellView;
}

// ── venture switcher ─────────────────────────────────────────────────────────
// Keyboard-complete menu: ↑/↓ move, Home/End jump, Enter/Space choose, Esc closes and
// returns focus to the trigger. Always rendered with [hidden] so the mockup's CSS
// enter/exit transition runs. APP-WIDE scope: it writes the one venture-scope store every
// Business-OS surface reads.
function VentureSwitcher({ venture, ventures, onVenture }: {
  venture: string | null;
  ventures: readonly VentureRef[];
  onVenture: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const total = ventures.reduce((n, v) => n + v.records, 0);
  const rows: { key: string; label: string; note: string; value: string | null }[] = [
    { key: "__all__", label: "All ventures", note: `${total} records`, value: null },
    ...ventures.map((v) => ({ key: v.id, label: v.name || v.id, note: `${v.records} records`, value: v.id })),
  ];
  const currentIndex = Math.max(0, rows.findIndex((r) => r.value === venture));
  const currentLabel = rows[currentIndex]?.label ?? "All ventures";

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
    const keys: Record<string, () => void> = {
      Escape: close,
      ArrowDown: () => focusRow(active + 1),
      ArrowUp: () => focusRow(active - 1),
      Home: () => focusRow(0),
      End: () => focusRow(rows.length - 1),
    };
    const run = keys[e.key];
    if (run) { e.preventDefault(); run(); }
  };

  return (
    <div className="venture">
      <button
        ref={triggerRef}
        className="venture-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Scopes every Business-OS surface — the vault, the deck, workflows, the schedule and the command center."
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); } }}
      >
        <span><span className="sub" style={{ display: "block" }}>Venture</span><b>{currentLabel}</b></span>
        <svg width="16" height="16" aria-hidden="true"><use href="#chev" /></svg>
      </button>
      <div
        ref={listRef}
        className="venture-menu"
        role="menu"
        aria-label="Choose a venture"
        hidden={!open}
        onKeyDown={onListKeyDown}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
      >
        {rows.map((r, i) => (
          <button
            key={r.key}
            type="button"
            data-vrow
            role="menuitemradio"
            aria-checked={r.value === venture}
            tabIndex={i === active ? 0 : -1}
            onClick={() => choose(r.value)}
          >
            <span>{r.label}</span><span className="sub">{r.note}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Below lg the rail is hidden; the mockup's `.mtabs` pill row carries the same entries. */
export function BosMobileTabs({ bosPage, shellView, onNav }: {
  bosPage: BosPage | null;
  shellView: ShellView;
  onNav: (entry: BosNavEntry) => void;
}) {
  return (
    <div className="mtabs" role="tablist" aria-label="Pages">
      {BOS_NAV.map((e) => (
        <button key={e.id} className="pill" type="button" role="tab" aria-selected={isCurrentEntry(e, bosPage, shellView)} onClick={() => onNav(e)}>
          {e.label}
        </button>
      ))}
    </div>
  );
}

export const BosSidebar = memo(function BosSidebar({
  shellView, bosPage, pending, agents, onNav, onAgent, onBrand, venture, ventures, onVenture,
}: BosSidebarProps) {
  const [repo, setRepo] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getWorkspace()
      .then((w) => { if (live) setRepo(w.repoPath ? displayPath(w.repoPath) : null); })
      .catch(() => { if (live) setRepo(null); });
    return () => { live = false; };
  }, []);

  const inboxEntry = BOS_NAV.find((e) => e.id === "inbox");
  const rest = BOS_NAV.filter((e) => e.id !== "inbox");
  const current = (e: BosNavEntry) => (isCurrentEntry(e, bosPage, shellView) ? "page" : undefined);

  return (
    <aside className="sb bos-side" aria-label="Business OS">
      <div className="sb-brand">
        <a className="wordmark" href="#" aria-label="MissionAlpha, back to the splash"
          onClick={(e) => { e.preventDefault(); onBrand?.(); }}>
          <b>MISSIONALPHA</b>
        </a>
        <span className="sub">helm · business os</span>
      </div>

      {inboxEntry && (
        <button className="sb-pin bos-inbox-pin" type="button" aria-current={current(inboxEntry)} onClick={() => onNav(inboxEntry)}>
          <span>{inboxEntry.label}</span>
          <span className="badge" aria-label={`${pending} awaiting your decision`}>{pending}</span>
        </button>
      )}

      <nav aria-label="Workspace">
        <p className="sb-group">Workspace</p>
        <ul>
          {rest.map((e) => (
            <li key={e.id}>
              <button className="sb-link bos-item" type="button" aria-current={current(e)} onClick={() => onNav(e)}>
                <svg aria-hidden="true"><use href={`#i-${e.icon}`} /></svg>
                {e.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div>
        <p className="sb-group">Agents</p>
        <div>
          {deckOrder(agents).map((a) => {
            const badge = stationBadge(a);
            const st = stationById(a.id);
            return (
              <button key={a.id} className="sb-agent" type="button" aria-label={`Inspect ${st?.name ?? a.id}`} onClick={() => onAgent(a.id)}>
                <span className={`dot ${WATCH_DOT[badge]}${badge === "on" ? " live" : ""}`} />
                <span><b>{st?.name ?? a.id}</b><small>{`${st?.role ?? (a.role || "agent")} · ${BADGE_LABEL[badge].toLowerCase()}`}</small></span>
              </button>
            );
          })}
        </div>
      </div>

      <svg className="sb-sprig" viewBox="0 0 220 320" aria-hidden="true"><use href="#sprig" /></svg>
      {/* The mockup's second line is a mockup disclaimer ("example data played by a script");
          in the app that would be false, so it says what is true instead. */}
      <p className="sb-note">{repo && <>{repo}<br /></>}Local swarm: stations and jobs come from your runtime.</p>

      <VentureSwitcher venture={venture} ventures={ventures} onVenture={onVenture} />
    </aside>
  );
});

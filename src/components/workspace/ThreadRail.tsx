import { Crown, Bot, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { tok } from "../../lib/agentMeta";

export interface ThreadInfo {
  id: string;
  title: string;
  accent: string; // token name
  pinned?: boolean;
}

// ThreadRail — left navigation (chat-first-ux §1). Boss/CEO pinned on top, then one
// thread per agent. Active row = bg + 3px left accent bar + aria-current (not color
// alone). Collapsible to an icon rail.

export function ThreadRail({
  threads,
  activeId,
  onSelect,
  collapsed,
  onToggleCollapsed,
}: {
  threads: ThreadInfo[];
  activeId: string;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const pinned = threads.filter((t) => t.pinned);
  const rest = threads.filter((t) => !t.pinned);

  const Row = (t: ThreadInfo) => {
    const active = t.id === activeId;
    const ac = tok(t.accent);
    return (
      <li key={t.id}>
        <button
          type="button"
          onClick={() => onSelect(t.id)}
          aria-current={active ? "page" : undefined}
          title={t.title}
          className="relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2"
          style={{
            backgroundColor: active ? tok("panel-2") : "transparent",
          }}
        >
          {active && (
            <span className="absolute inset-y-1 left-0 w-[3px] rounded-full" style={{ backgroundColor: ac }} aria-hidden />
          )}
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" style={{ color: ac }} aria-hidden>
            {t.pinned ? <Crown size={14} /> : <Bot size={13} />}
          </span>
          {!collapsed && (
            <span className="truncate text-[13px]" style={{ color: active ? tok("text") : tok("muted") }}>
              {t.title}
            </span>
          )}
        </button>
      </li>
    );
  };

  return (
    <nav
      aria-label="Threads"
      className="flex h-full flex-col border-r"
      style={{ backgroundColor: tok("bg"), borderColor: tok("border"), width: collapsed ? 56 : 264 }}
    >
      <div className="flex items-center justify-between px-3 py-3" style={{ borderBottom: `1px solid ${tok("border")}` }}>
        {!collapsed && (
          <span className="font-mono text-[10px] font-semibold uppercase tracking-widest" style={{ color: tok("muted") }}>
            Threads
          </span>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand threads" : "Collapse threads"}
          className="rounded-md p-1 outline-none transition-colors focus-visible:ring-2"
          style={{ color: tok("muted") }}
        >
          {collapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ul className="space-y-0.5">{pinned.map(Row)}</ul>
        {rest.length > 0 && (
          <>
            <div className="my-2 h-px" style={{ backgroundColor: tok("border") }} aria-hidden />
            {!collapsed && (
              <div className="px-3 pb-1 font-mono text-[9px] uppercase tracking-widest" style={{ color: tok("muted") }}>
                Agents
              </div>
            )}
            <ul className="space-y-0.5">{rest.map(Row)}</ul>
          </>
        )}
      </div>
    </nav>
  );
}

import { motion } from "framer-motion";
import {
  Settings as SettingsIcon,
  Command,
  ScrollText,
  Wrench,
  History,
  Sparkles,
  Library,
  type LucideIcon,
} from "lucide-react";
import type { Counts } from "../../data/types";
import { tok } from "../../lib/agentMeta";
import { ThemeToggle } from "../ThemeToggle";

/*
  Frameless title bar (F4). The Electron window is `frame:false` +
  `titleBarStyle:"hiddenInset"`, so this thin bar is BOTH the OS drag handle
  (`.app-drag`) and the home for the mockup's topbar content (status dot +
  "MissionAlpha" wordmark + status pills + nav). Interactive children opt back
  out with `.app-no-drag` or they'd be unclickable inside the drag region.

  Left padding clears the mac traffic-light controls (--traffic-light-inset).
  All hover/press motion is ≤160ms ease-out and disabled under
  prefers-reduced-motion (see :root reduce-motion net in index.css). Inert in
  the browser/dev — the app-region rules are simply ignored without a frame.
*/

const COUNT_PILLS: ReadonlyArray<{ key: keyof Counts; label: string; tone: string }> = [
  { key: "active", label: "active", tone: "done-green" },
  { key: "blocked", label: "blocked", tone: "blocked-amber" },
  { key: "stale", label: "stale", tone: "stale-red" },
  { key: "offline", label: "offline", tone: "muted" },
];

function CountPills({ counts }: { counts: Counts }) {
  return (
    <span
      className="hidden items-center gap-1.5 sm:flex"
      role="status"
      aria-live="polite"
      aria-label={`${counts.active} active, ${counts.blocked} blocked, ${counts.stale} stale, ${counts.offline} offline of ${counts.total} agents`}
    >
      {COUNT_PILLS.map((p) => {
        const c = tok(p.tone);
        return (
          <span
            key={p.key}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] tabular-nums"
            style={{
              color: c,
              backgroundColor: `color-mix(in oklch, ${c} 12%, transparent)`,
              border: `1px solid color-mix(in oklch, ${c} 26%, transparent)`,
            }}
          >
            <motion.span
              key={counts[p.key]}
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              className="font-semibold"
            >
              {counts[p.key]}
            </motion.span>
            <span className="opacity-80">{p.label}</span>
          </span>
        );
      })}
    </span>
  );
}

function NavButton({
  label,
  onClick,
  icon: Icon,
  active,
}: {
  label: string;
  onClick: () => void;
  icon: LucideIcon;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className="app-no-drag inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] outline-none transition-[background-color,color] duration-150 ease-out hover:bg-panel-2 active:scale-[0.97] focus-visible:ring-2 motion-reduce:transition-none motion-reduce:active:scale-100"
      style={{
        color: active ? tok("text") : tok("muted"),
        backgroundColor: active ? tok("panel-2") : "transparent",
      }}
    >
      <Icon size={16} aria-hidden />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

function IconButton({
  label,
  onClick,
  icon: Icon,
}: {
  label: string;
  onClick: () => void;
  icon: LucideIcon;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="app-no-drag rounded-md p-1.5 outline-none transition-[background-color,color] duration-150 ease-out hover:bg-panel-2 active:scale-[0.97] focus-visible:ring-2 motion-reduce:transition-none motion-reduce:active:scale-100"
      style={{ color: tok("muted") }}
    >
      <Icon size={18} aria-hidden />
    </button>
  );
}

export interface TitleBarProps {
  counts: Counts | null;
  reassurance: string;
  needYou: number;
  activeUtil: "audit" | "tools" | "replay" | null;
  onOpenUtil: (tab: "audit" | "tools" | "replay") => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  onOpenHero: () => void;
  onOpenSkills: () => void;
  /**
   * P3: the shell surface switch (Inbox ⇄ Board). Rendered ONLY when the
   * VITE_INBOX flag is on — when it is off this is undefined and the bar is
   * byte-identical to the pre-P3 cockpit.
   */
  shellToggle?: React.ReactNode;
  /** Deliveries awaiting a decision. Driven by SSE, not by polling. */
  pendingDeliveries?: number;
}

export function TitleBar({
  counts,
  reassurance,
  needYou,
  activeUtil,
  onOpenUtil,
  onOpenPalette,
  onOpenSettings,
  onOpenHero,
  onOpenSkills,
  shellToggle,
  pendingDeliveries = 0,
}: TitleBarProps) {
  const statusTone = needYou ? "blocked-amber" : "done-green";
  return (
    <header
      className="app-drag relative z-20 flex shrink-0 items-center gap-3 border-b border-border px-4"
      style={{
        height: "var(--titlebar-h)",
        paddingLeft: "var(--traffic-light-inset)",
      }}
    >
      <span className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{
            backgroundColor: tok(statusTone),
            boxShadow: `0 0 8px 1px ${tok(statusTone)}`,
          }}
          aria-hidden
        />
        <span className="text-sm font-semibold tracking-tight">MissionAlpha</span>
      </span>
      {shellToggle && <span className="ml-1">{shellToggle}</span>}
      {pendingDeliveries > 0 && (
        <span
          className="hidden items-center gap-1.5 text-[12px] md:inline-flex"
          role="status"
          aria-live="polite"
          style={{ color: tok("muted") }}
        >
          <span className="helm-badge">{pendingDeliveries}</span>
          {pendingDeliveries === 1 ? "delivery awaits you" : "deliveries await you"}
        </span>
      )}
      {counts && (
        <span className="hidden text-[12px] text-muted lg:inline">{reassurance}</span>
      )}
      {counts && (
        <span className="ml-1">
          <CountPills counts={counts} />
        </span>
      )}

      <div className="app-no-drag ml-auto flex items-center gap-1">
        <NavButton label="Skills" icon={Library} onClick={onOpenSkills} />
        <NavButton label="Swarm" icon={Sparkles} onClick={onOpenHero} />
        <NavButton
          label="Audit"
          icon={ScrollText}
          onClick={() => onOpenUtil("audit")}
          active={activeUtil === "audit"}
        />
        <NavButton
          label="Tools"
          icon={Wrench}
          onClick={() => onOpenUtil("tools")}
          active={activeUtil === "tools"}
        />
        <NavButton
          label="Replay"
          icon={History}
          onClick={() => onOpenUtil("replay")}
          active={activeUtil === "replay"}
        />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <IconButton label="Command palette (⌘K)" icon={Command} onClick={onOpenPalette} />
        <IconButton label="Settings" icon={SettingsIcon} onClick={onOpenSettings} />
        <span className="app-no-drag">
          <ThemeToggle />
        </span>
      </div>
    </header>
  );
}

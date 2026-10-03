import type { Counts } from "../../data/types";
import { useTheme } from "../../theme/useTheme";

/*
  Frameless title bar. Phase G (ADR G-2): markup and classes are the approved mockup's
  `.titlebar` verbatim (docs/mockups/missionalpha-sketchbook.html); data and handlers are
  unchanged. It is still the OS drag handle (`app-drag`) with interactive children opted out
  (`app-no-drag`). Under Electron, `[data-shell="electron"] .titlebar` adds the
  traffic-light inset — a browser render is mockup-identical, a framed window clears the
  OS controls.

  D-7: "N deliveries await you · M need you" — deliveries are the code-shaped pending inbox
  items, need-you is every pending inbox item (src/lib/inboxTally.ts).
*/

const COUNT_PILLS: ReadonlyArray<{ key: keyof Counts; label: string }> = [
  { key: "active", label: "active" },
  { key: "blocked", label: "blocked" },
  { key: "stale", label: "stale" },
  { key: "offline", label: "offline" },
];

function pillClass(key: keyof Counts, n: number): string {
  if (key === "active") return "chip ok";
  if (key === "blocked" && n > 0) return "chip bad";
  return "chip";
}

function TbButton({ icon, label, text, onClick, active }: {
  icon: string; label: string; text?: string; onClick: () => void; active?: boolean;
}) {
  return (
    <button className="tb-btn app-no-drag" type="button" aria-label={label} aria-pressed={active} onClick={onClick}>
      <svg aria-hidden="true"><use href={`#${icon}`} /></svg>
      {text && <span className="t">{text}</span>}
    </button>
  );
}

export interface TitleBarProps {
  counts: Counts | null;
  activeUtil: "audit" | "tools" | "replay" | null;
  onOpenUtil: (tab: "audit" | "tools" | "replay") => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  onOpenHero: () => void;
  onOpenSkills: () => void;
  onOpenInbox: () => void;
  /** Code-shaped pending inbox items (D-7); null until the first read ("—", never 0). */
  deliveries: number | null;
  /** Every pending inbox item (D-7); null until the first read. */
  needYou: number | null;
}

export function TitleBar({
  counts, activeUtil, onOpenUtil, onOpenPalette, onOpenSettings, onOpenHero, onOpenSkills, onOpenInbox,
  deliveries, needYou,
}: TitleBarProps) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <header className="titlebar app-drag" aria-label="MissionAlpha">
      <div className="tb-left">
        <span className="tb-mark"><span className={`glow${(needYou ?? 0) > 0 ? " amber" : ""}`} aria-hidden="true" />MISSIONALPHA</span>
        <button className="tb-await chip app-no-drag" type="button" onClick={onOpenInbox}>
          <span className="dot warn live" />
          {/* One text node per phrase, exactly as the mockup: split JSX text is shaped per
              node and its kerning drifts from the mockup's single run (G2 parity finding). */}
          {`${deliveries ?? "—"} deliver${deliveries === 1 ? "y awaits" : "ies await"} you`}
          <span className="why">{` · ${needYou ?? "—"} need you`}</span>
        </button>
        {counts && (
          <span className="tb-pills" role="status" aria-label="Runtime status">
            {COUNT_PILLS.map((p) => (
              <span key={p.key} className={pillClass(p.key, counts[p.key])}>
                {p.key === "active" && <span className="dot ok" />}
                {`${counts[p.key]} ${p.label}`}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="tb-right">
        <TbButton icon="i-skills" label="Skills palette" text="Skills" onClick={onOpenSkills} />
        <TbButton icon="i-swarm" label="Open the swarm view" text="Swarm" onClick={onOpenHero} />
        <TbButton icon="i-audit" label="Audit trail" text="Audit" onClick={() => onOpenUtil("audit")} active={activeUtil === "audit"} />
        <TbButton icon="i-tools" label="Tools" text="Tools" onClick={() => onOpenUtil("tools")} active={activeUtil === "tools"} />
        <TbButton icon="i-replay" label="Replay" text="Replay" onClick={() => onOpenUtil("replay")} active={activeUtil === "replay"} />
        <span className="tb-sep" aria-hidden="true" />
        <TbButton icon="i-search" label="Command palette, Command K" text="⌘K" onClick={onOpenPalette} />
        <TbButton icon="i-settings" label="Settings" onClick={onOpenSettings} />
        <button className="tb-btn app-no-drag" type="button" aria-label={dark ? "Switch to the cream theme" : "Switch to the dark theme"}
          aria-pressed={dark} onClick={toggle}>
          <svg aria-hidden="true"><use href="#i-moon" /></svg>
        </button>
      </div>
    </header>
  );
}

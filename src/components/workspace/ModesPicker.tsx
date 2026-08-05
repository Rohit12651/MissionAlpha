import { useCallback, useRef } from "react";
import { ShieldCheck, Pencil, Zap, Map as MapIcon } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { runtimeUrl } from "../../lib/runtimeBase";
import { isPermissionMode, type AgentMode } from "../../lib/agentModes";
import { runtimeToken } from "../../lib/runtimeToken";

// MODES picker (cockpit-ux-enhancements §6). A 4-segment pill controlling how
// tool-enabled agents handle permissions, plus a universal PLAN mode.
//   ASK   → --permission-mode default            (prompt before every tool)
//   EDITS → --permission-mode acceptEdits         (auto-accept edits; current default)
//   AUTO  → --permission-mode bypassPermissions   (no prompts — confirmed first)
//   PLAN  → prompt-prefix only, no server flag     (plan-only, all agents)
// CAVEAT: ASK/EDITS/AUTO only bite agents that actually have tools (RUNTIME_TOOLS=write
// or factory-write). A chat-only ("none") agent pushes no --permission-mode flag, so
// those three are inert for it; PLAN still works because it is message-level.

interface ModeDef {
  id: AgentMode;
  label: string;
  icon: typeof ShieldCheck;
  title: string;
  danger?: boolean;
}

const MODES: ModeDef[] = [
  { id: "default", label: "Ask", icon: ShieldCheck, title: "Ask before every tool call (tool-enabled agents)" },
  { id: "acceptEdits", label: "Edits", icon: Pencil, title: "Auto-accept edits, ask for other tools (tool-enabled agents)" },
  { id: "bypassPermissions", label: "Auto", icon: Zap, title: "No permission prompts (tool-enabled agents)", danger: true },
  { id: "plan", label: "Plan", icon: MapIcon, title: "Plan only — no execution (all agents)" },
];

export function ModesPicker({
  value,
  onChange,
  disabled,
}: {
  value: AgentMode;
  onChange: (m: AgentMode) => void;
  disabled?: boolean;
}) {
  const cyan = tok("accent-cyan");
  const red = tok("stale-red");
  const amber = tok("blocked-amber");
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = useCallback(
    async (m: AgentMode) => {
      if (m === value) return;
      // SECURITY — bypassPermissions removes ALL tool prompts. Require an explicit,
      // unambiguous confirmation before escalating. (Prose, not caveman, on purpose.)
      if (m === "bypassPermissions") {
        const ok = window.confirm(
          "Enable AUTO mode?\n\n" +
            "AUTO bypasses all permission prompts. Tool-enabled agents will run tool calls — including file writes — without asking.\n\n" +
            "Only use this when you fully trust the current task. Continue?",
        );
        if (!ok) return;
      }
      const prev = value;
      onChange(m); // optimistic
      // PLAN is message-level only — never touch the server permission mode. isPermissionMode
      // is a type guard, so inside this branch `m` narrows to PermissionMode at compile time.
      if (isPermissionMode(m)) {
        try {
          const token = await runtimeToken();
          const r = await fetch(runtimeUrl("/runtime/config"), {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-runtime-token": token },
            body: JSON.stringify({ permissionMode: m }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } catch {
          // Roll back so the UI never claims a mode the server didn't accept — a silent
          // desync would be SECURITY-relevant for bypassPermissions (UI shows safe, agent runs open).
          onChange(prev);
        }
      }
    },
    [value, onChange],
  );

  // APG radio-group keys — ←/→/Home/End move focus AND select (selection follows focus).
  const onKeyDown = useCallback((e: React.KeyboardEvent, i: number) => {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % MODES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + MODES.length) % MODES.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = MODES.length - 1;
    else return;
    e.preventDefault();
    if (disabled) return;
    btnRefs.current[next]?.focus();
    void select(MODES[next].id); // radio pattern — selection follows focus
  }, [disabled, select]);

  const noneActive = !MODES.some((x) => x.id === value);

  return (
    // Single-select widget → radiogroup/radio (NOT group + aria-pressed, which reads as
    // independent toggles to a screen reader).
    <div
      className="flex items-center gap-0.5 rounded-md p-0.5"
      style={{ backgroundColor: tok("panel-2"), border: `1px solid ${tok("border")}` }}
      role="radiogroup"
      aria-label="Agent mode"
    >
      {MODES.map((m, i) => {
        const active = value === m.id;
        const ac = m.danger && active ? red : m.id === "plan" && active ? amber : active ? cyan : tok("muted");
        const Icon = m.icon;
        return (
          <button
            key={m.id}
            ref={(el) => { btnRefs.current[i] = el; }}
            type="button"
            role="radio"
            onClick={() => { if (!disabled) void select(m.id); }}
            onKeyDown={(e) => onKeyDown(e, i)}
            // aria-disabled (not the `disabled` attr) keeps the control in the tab order
            // while streaming, so focus isn't lost when it re-enables. Click is gated above.
            aria-disabled={disabled || undefined}
            title={m.title}
            aria-checked={active}
            aria-description={m.title}
            tabIndex={active || (noneActive && i === 0) ? 0 : -1}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide outline-none transition-all duration-150 focus-visible:ring-2"
            style={{
              color: ac,
              backgroundColor: active ? `color-mix(in oklch, ${ac} 16%, transparent)` : "transparent",
              border: active ? `1px solid color-mix(in oklch, ${ac} 40%, transparent)` : "1px solid transparent",
              opacity: disabled ? 0.4 : 1,
              pointerEvents: disabled ? "none" : undefined,
            }}
          >
            <Icon size={11} aria-hidden />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

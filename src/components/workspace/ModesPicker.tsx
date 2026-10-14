import { useCallback, useRef } from "react";
import { ShieldCheck, Pencil, Zap, Map as MapIcon } from "lucide-react";
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

  // Phase G (ADR G-2): the mockup's `.seg`. Kept a radiogroup (one choice) rather than the
  // mockup's toggle buttons; index.css gives [aria-checked] the mockup's pressed look.
  return (
    <div className="seg" role="radiogroup" aria-label="Permission mode">
      {MODES.map((m, i) => {
        const active = value === m.id;
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
            tabIndex={active || (noneActive && i === 0) ? 0 : -1}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

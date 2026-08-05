import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck, Pencil, Zap } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import {
  isDangerMode,
  PERM_HINT,
  PERM_LABEL,
  PERM_MODES,
  putPermMode,
  type PermMode,
} from "../../lib/stationClient.ts";
import { ensurePerm, getPermDoc, setPermLocal, useStationPerm } from "./permStore";

// CC-Primitives P5 — the per-station INTERACTIVE permission mode (P1 backend).
// Governs the chat spawn only; the autonomous engine loop stays pinned to
// acceptEdits server-side, which is why the Guards card states that separately.
//
// SAFETY: `bypassPermissions` removes every tool prompt, so it takes TWO deliberate
// taps ("Sure?") and renders in the EXISTING danger/amber token — never a new colour.
// The write is optimistic and rolls back on failure: a UI that showed a safe mode
// while the station ran open would be a security-relevant desync, not a cosmetic one.
//
// Keys: roving tabindex, ←/→/Home/End move FOCUS only. Selection deliberately does
// NOT follow focus here (unlike the global ModesPicker) because arrowing across the
// group would otherwise arm an escalation the operator never asked for.

const ICON: Record<PermMode, typeof ShieldCheck> = {
  default: ShieldCheck,
  acceptEdits: Pencil,
  bypassPermissions: Zap,
};

const ARM_TIMEOUT_MS = 5000;

export function PermModeToggle({ agentId }: { agentId: string }) {
  const doc = useStationPerm(agentId);
  const [pending, setPending] = useState<PermMode | null>(null);
  const [armed, setArmed] = useState<PermMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = useCallback(() => {
    if (armTimer.current) { clearTimeout(armTimer.current); armTimer.current = null; }
    setArmed(null);
  }, []);
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);
  // Switching stations must never carry an armed escalation across.
  useEffect(() => { disarm(); setError(null); }, [agentId, disarm]);

  const effective = doc?.effective ?? null;
  const override = doc?.permMode ?? null;
  const inFlight = pending !== null;

  const commit = useCallback(
    async (m: PermMode) => {
      disarm();
      setError(null);
      const prev = override;
      setPending(m);
      setPermLocal(agentId, m); // optimistic; the SSE frame reconciles it authoritatively
      try {
        const r = await putPermMode(agentId, m);
        if (r?.error) throw new Error(r.error);
      } catch {
        // Roll back ONLY if our optimistic value is still what's showing — a concurrent
        // authoritative update (SSE from another seat) must not be stomped by a stale
        // snapshot (react-review MED-1). Then force an authoritative re-read.
        if (getPermDoc(agentId)?.permMode === m) setPermLocal(agentId, prev);
        void ensurePerm(agentId, true);
        setError("the runtime refused that change");
      } finally {
        setPending(null);
      }
    },
    [agentId, override, disarm],
  );

  const choose = useCallback(
    (m: PermMode) => {
      if (inFlight || m === effective) return;
      if (isDangerMode(m) && armed !== m) {
        setArmed(m);
        if (armTimer.current) clearTimeout(armTimer.current);
        armTimer.current = setTimeout(() => setArmed(null), ARM_TIMEOUT_MS);
        return;
      }
      void commit(m);
    },
    [inFlight, effective, armed, commit],
  );

  const onKeyDown = useCallback((e: React.KeyboardEvent, i: number) => {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % PERM_MODES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + PERM_MODES.length) % PERM_MODES.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = PERM_MODES.length - 1;
    else return;
    e.preventDefault();
    disarm();
    btnRefs.current[next]?.focus();
  }, [disarm]);

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Interactive permission mode"
        aria-busy={inFlight || undefined}
        className="flex items-center gap-0.5 rounded-md p-0.5"
        style={{ backgroundColor: tok("panel-2"), border: `1px solid ${tok("border")}` }}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) disarm(); }}
      >
        {PERM_MODES.map((m, i) => {
          const active = effective === m;
          const arming = armed === m;
          const danger = isDangerMode(m);
          // Selected danger and armed danger BOTH read amber — the existing token, never a new one.
          const ac = danger && (active || arming) ? tok("blocked-amber") : active ? tok("accent-cyan") : tok("muted");
          const Icon = ICON[m];
          return (
            <button
              key={m}
              ref={(el) => { btnRefs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={arming ? `Confirm ${PERM_LABEL[m]}` : PERM_LABEL[m]}
              aria-description={PERM_HINT[m]}
              title={PERM_HINT[m]}
              // aria-disabled (not `disabled`) keeps the control in the tab order while
              // the PUT is in flight, so focus is not lost when it re-enables.
              aria-disabled={inFlight || undefined}
              tabIndex={active || (!effective && i === 0) ? 0 : -1}
              onClick={() => choose(m)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={
                "inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium uppercase tracking-wide outline-none " +
                "transition-[background-color,color,opacity] duration-150 " +
                "hover:bg-panel/70 active:opacity-80 focus-visible:ring-2 focus-visible:ring-accent-cyan"
              }
              style={{
                color: ac,
                backgroundColor: active || arming ? `color-mix(in oklch, ${ac} 16%, transparent)` : "transparent",
                border: active || arming ? `1px solid color-mix(in oklch, ${ac} 42%, transparent)` : "1px solid transparent",
                opacity: inFlight ? 0.5 : 1,
                pointerEvents: inFlight ? "none" : undefined,
              }}
            >
              <Icon size={11} aria-hidden />
              {arming ? "Sure?" : PERM_LABEL[m]}
            </button>
          );
        })}
      </div>

      <p className="mt-1.5 font-mono text-[10px] text-muted">
        {!doc ? (
          "reading the station mode…"
        ) : override ? (
          <>
            override · <span style={{ color: tok(isDangerMode(override) ? "blocked-amber" : "accent-cyan") }}>{PERM_LABEL[override]}</span>
          </>
        ) : (
          <>inherits global · {doc.global ? PERM_LABEL[doc.global] : PERM_LABEL[doc.effective]}</>
        )}
        {inFlight && <span className="ml-1.5">saving…</span>}
      </p>

      {armed && (
        <p className="mt-1 text-[11px]" style={{ color: tok("blocked-amber") }} role="status">
          Tap again to confirm — bypass removes every tool prompt for this station.
        </p>
      )}
      {error && (
        <p className="mt-1 text-[11px]" style={{ color: tok("stale-red") }} role="alert">{error}</p>
      )}
    </div>
  );
}

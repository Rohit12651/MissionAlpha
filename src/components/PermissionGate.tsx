import { useCallback, useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, X } from "lucide-react";
import { tok } from "../lib/agentMeta";

// F3 — Permission gate. A reusable confirm modal for destructive / mass actions.
// "Ask before blindly doing the work." Surfaces WHAT will happen, to WHICH agents,
// and HOW MANY, then requires an explicit Confirm. ESC / backdrop / Cancel abort.
// Focus lands on Confirm on open; focus is trapped within the dialog. Reduced-motion
// safe. All color via OKLCH tokens — no inline hex.

export interface PermissionGateProps {
  open: boolean;
  title: string;
  /** One-line explanation of the action + consequence. */
  summary: string;
  /** Agent ids the action will hit — rendered as a capped list with overflow count. */
  affected: string[];
  /** Verb on the confirm button, e.g. "Respawn 15 agents". */
  confirmLabel: string;
  /** Token name for the action accent (e.g. "stale-red" for respawn). */
  accent?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const MAX_SHOWN = 12;

export function PermissionGate({
  open,
  title,
  summary,
  affected,
  confirmLabel,
  accent = "blocked-amber",
  onConfirm,
  onCancel,
}: PermissionGateProps) {
  const reduce = useReducedMotion();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Focus the confirm button when the dialog opens.
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  // ESC cancels; Tab is trapped inside the dialog.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onCancel],
  );

  const accentVar = tok(accent);
  const shown = affected.slice(0, MAX_SHOWN);
  const overflow = affected.length - shown.length;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.14, ease: "easeOut" }}
          onKeyDown={onKeyDown}
        >
          {/* backdrop */}
          <button
            type="button"
            aria-label="Cancel"
            onClick={onCancel}
            className="absolute inset-0 cursor-default bg-bg/70 backdrop-blur-sm outline-none"
          />
          {/* panel */}
          <motion.div
            ref={panelRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="pg-title"
            aria-describedby="pg-summary"
            className="relative w-full max-w-md overflow-hidden rounded-[14px] border border-border bg-panel/95 p-5 backdrop-blur-md"
            style={{ boxShadow: `0 0 32px -8px ${accentVar}` }}
            initial={{ opacity: 0, scale: reduce ? 1 : 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reduce ? 1 : 0.97 }}
            transition={{ duration: reduce ? 0 : 0.18, ease: "easeOut" }}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0" style={{ color: accentVar }}>
                <AlertTriangle size={18} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="pg-title" className="text-[15px] font-semibold text-text">
                  {title}
                </h2>
                <p id="pg-summary" className="mt-1.5 text-[12px] leading-snug text-muted">
                  {summary}
                </p>
              </div>
              <button
                type="button"
                onClick={onCancel}
                aria-label="Close"
                className="shrink-0 rounded-md p-1 text-muted outline-none transition-colors hover:text-text focus-visible:ring-2"
              >
                <X size={15} aria-hidden />
              </button>
            </div>

            {/* affected agents */}
            <div className="mt-3.5 rounded-md border border-border/60 bg-bg/50 px-3 py-2.5">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                {affected.length} agent{affected.length === 1 ? "" : "s"} affected
              </p>
              <div className="flex flex-wrap gap-1.5">
                {shown.map((id) => (
                  <span
                    key={id}
                    className="rounded font-mono text-[10px] text-text/85"
                    style={{
                      padding: "2px 6px",
                      backgroundColor: `color-mix(in oklch, ${accentVar} 10%, transparent)`,
                      border: `1px solid color-mix(in oklch, ${accentVar} 24%, transparent)`,
                    }}
                  >
                    {id}
                  </span>
                ))}
                {overflow > 0 && (
                  <span className="font-mono text-[10px] text-muted">+{overflow} more</span>
                )}
              </div>
            </div>

            {/* actions */}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-md border border-border/70 px-3 py-1.5 text-[12px] font-medium text-muted outline-none transition-colors hover:text-text focus-visible:ring-2"
              >
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                onClick={onConfirm}
                className="rounded-md px-3.5 py-1.5 text-[12px] font-semibold outline-none focus-visible:ring-2"
                style={{
                  color: accentVar,
                  backgroundColor: `color-mix(in oklch, ${accentVar} 14%, transparent)`,
                  border: `1px solid color-mix(in oklch, ${accentVar} 34%, transparent)`,
                }}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

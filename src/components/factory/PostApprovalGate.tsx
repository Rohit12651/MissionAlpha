import { useCallback, useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Send, X, ShieldCheck, FlaskConical } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import type { PostPreview } from "../../lib/factoryClient";

// Surface 4 — Per-post approval modal. A PermissionGate fork specialized for the
// irreversible outward action: shows the EXACT content that would post, the target
// account, char/limit state, and a dry-run/simulated marker. BOSS-gated; nothing
// posts until Confirm. Focus-trapped, ESC cancels, reduced-motion safe.

export function PostApprovalGate({
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: PostPreview | null;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const reduce = useReducedMotion();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const violet = tok("factory-violet");
  const gold = tok("ceo-gold");

  useEffect(() => {
    if (preview) confirmRef.current?.focus();
  }, [preview]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const f = panelRef.current.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])');
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
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

  const p = preview?.preview;
  const overLimit = p ? p.chars > p.maxChars : false;
  const nearLimit = p ? p.chars > p.maxChars * 0.9 : false;
  const countColor = overLimit ? tok("stale-red") : nearLimit ? tok("blocked-amber") : tok("muted");
  const simulated = p ? !p.composio : true;

  return (
    <AnimatePresence>
      {preview && p && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.14, ease: "easeOut" }}
          onKeyDown={onKeyDown}
        >
          <button type="button" aria-label="Cancel" onClick={onCancel} className="absolute inset-0 cursor-default bg-bg/70 backdrop-blur-sm outline-none" />
          <motion.div
            ref={panelRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="pa-title"
            className="relative w-full max-w-md overflow-hidden rounded-[14px] border bg-panel/95 p-5 backdrop-blur-md"
            style={{ borderColor: `color-mix(in oklch, ${violet} 40%, var(--c-border))`, boxShadow: `0 0 32px -8px ${violet}` }}
            initial={{ opacity: 0, scale: reduce ? 1 : 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reduce ? 1 : 0.97 }}
            transition={{ duration: reduce ? 0 : 0.18, ease: "easeOut" }}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0" style={{ color: violet }}>
                <Send size={18} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="pa-title" className="text-[15px] font-semibold text-text">
                  Approve external post
                </h2>
                <p className="mt-1.5 text-[12px] leading-snug text-muted">
                  This is a real outward action. Review the exact content before it posts. Nothing is sent until you confirm.
                </p>
              </div>
              <button type="button" onClick={onCancel} aria-label="Close" className="shrink-0 rounded-md p-1 text-muted outline-none transition-colors hover:text-text focus-visible:ring-2">
                <X size={15} aria-hidden />
              </button>
            </div>

            {/* target account */}
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Posting to</span>
              <span
                className="inline-flex items-center gap-1.5 rounded font-mono text-[11px] text-text/90"
                style={{ padding: "2px 8px", backgroundColor: `color-mix(in oklch, ${violet} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${violet} 30%, transparent)` }}
              >
                {p.platformLabel} · {p.handle}
              </span>
              <span className="font-mono text-[10px] text-muted">by {p.agentId}</span>
            </div>

            {/* content preview (rendered) */}
            <div className="mt-3 rounded-md border border-border/60 bg-bg/50 px-3 py-2.5">
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text/90">{p.content}</p>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[10px]">
              <span className="inline-flex items-center gap-1.5 font-mono" style={{ color: simulated ? tok("accent-cyan") : tok("done-green") }}>
                {simulated ? <FlaskConical size={11} aria-hidden /> : <ShieldCheck size={11} aria-hidden />}
                {simulated ? "DRY RUN · simulated (no composio key)" : "LIVE · composio connected"}
              </span>
              <span className="font-mono tabular-nums" style={{ color: countColor }}>
                {p.chars}/{p.maxChars} · {preview.rate.remaining} left today
              </span>
            </div>

            {/* actions */}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" onClick={onCancel} className="rounded-md border border-border/70 px-3 py-1.5 text-[12px] font-medium text-muted outline-none transition-colors hover:text-text focus-visible:ring-2">
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                disabled={busy || overLimit}
                onClick={onConfirm}
                className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12px] font-semibold outline-none focus-visible:ring-2 disabled:cursor-default disabled:opacity-40"
                style={{ color: gold, backgroundColor: `color-mix(in oklch, ${gold} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${gold} 34%, transparent)` }}
              >
                <Send size={13} aria-hidden /> {busy ? "Posting…" : simulated ? "Simulate post" : "Post to 1 account"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

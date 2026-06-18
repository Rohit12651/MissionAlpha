import { type ReactNode } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { X, Users } from "lucide-react";
import { tok } from "../../lib/agentMeta";

// TeamPanel — the demoted board, a secondary, collapsible "Team" view (ADR-023 /
// chat-first-ux §3). Desktop: static right column (420px) when open. Mobile
// (<lg): a full-screen overlay sheet. The board renders ONCE inside it.

export function TeamPanel({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          id="team-panel"
          role="complementary"
          aria-label="Team status"
          initial={reduce ? { opacity: 0 } : { x: 24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { x: 24, opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-0 z-40 flex w-full flex-col overflow-y-auto border-l lg:static lg:inset-auto lg:z-auto lg:w-[420px] xl:w-[460px]"
          style={{ backgroundColor: tok("bg"), borderColor: tok("border") }}
        >
          <div className="sticky top-0 z-10 flex items-center justify-between border-b px-4 py-3 backdrop-blur-md" style={{ borderColor: tok("border"), backgroundColor: `color-mix(in oklch, ${tok("bg")} 86%, transparent)` }}>
            <span className="inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-widest" style={{ color: tok("muted") }}>
              <Users size={13} aria-hidden /> Team status
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Team panel"
              className="rounded-md p-1 outline-none transition-colors focus-visible:ring-2"
              style={{ color: tok("muted") }}
            >
              <X size={16} aria-hidden />
            </button>
          </div>
          <div className="flex-1 px-4 py-4">{children}</div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

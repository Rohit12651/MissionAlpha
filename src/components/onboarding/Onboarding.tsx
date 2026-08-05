// First-run onboarding (gap #25). A focus-trapped, dismissible tour that explains
// the cockpit (chat · model picker · connectors · Team board) and drops the BOSS at
// a first goal. Shows once (localStorage ma.onboarded.v1) unless re-opened from the
// command palette. a11y: role=dialog, focus-trap, Esc, reduced-motion, responsive.

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { MessageSquare, Cpu, Plug, Users, Rocket, FolderGit2, X } from "lucide-react";
import { tok } from "../../lib/agentMeta";

export const ONBOARDED_KEY = "ma.onboarded.v1";

export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return true; // privacy mode → don't nag
  }
}
export function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    /* ignore */
  }
}

const STEPS: { icon: React.ReactNode; title: string; body: string }[] = [
  { icon: <MessageSquare size={20} aria-hidden />, title: "Chat is the cockpit", body: "Talk to the swarm in plain language. The center column is your primary surface — describe a goal and the Tech Lead routes it to the seats." },
  { icon: <FolderGit2 size={20} aria-hidden />, title: "Open a repo", body: "Point MissionAlpha at any local git repo in Settings → Workspace. Each task runs in its own git worktree, and approving a delivery commits to that branch — never straight into your working tree. With a remote and gh signed in, it opens a pull request instead." },
  { icon: <Cpu size={20} aria-hidden />, title: "Pick a model per chat", body: "Each chat can run Opus (smartest), Sonnet (balanced), or Haiku (fastest). Set a default in Settings; switch any time from the picker or ⌘K." },
  { icon: <Plug size={20} aria-hidden />, title: "Plug in connectors", body: "Add MCP connectors (GitHub, Notion, and more) in the Team panel, then grant them per-agent. Credentials are stored encrypted, never shown." },
  { icon: <Users size={20} aria-hidden />, title: "Watch the Team board", body: "Open the Team panel (right) to see the live board, tool-loop approvals, the audit trail, and the swarm globe. Everything observable." },
];

export function Onboarding({
  open,
  onClose,
  onTryGoal,
}: {
  open: boolean;
  onClose: () => void;
  onTryGoal: (goal: string) => void;
}) {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const last = step === STEPS.length - 1;

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => primaryRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish();
      }
      if (e.key === "Tab") {
        const f = ref.current?.querySelectorAll<HTMLElement>('button,[tabindex]:not([tabindex="-1"])');
        if (!f || f.length === 0) return;
        const first = f[0];
        const lastEl = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step]);

  const finish = () => {
    markOnboarded();
    onClose();
  };
  const tryGoal = () => {
    markOnboarded();
    onClose();
    onTryGoal("Create a small project: scaffold a minimal web app (index.html + a styled landing page).");
  };

  const cur = STEPS[step];

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="onb-title">
          <motion.div
            className="absolute inset-0"
            style={{ backgroundColor: `color-mix(in oklch, ${tok("bg")} 80%, transparent)` }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.2 }}
            aria-hidden
          />
          <motion.div
            ref={ref}
            className="relative w-full max-w-md overflow-hidden rounded-panel border border-border bg-panel p-6 shadow-2xl"
            initial={{ opacity: 0, scale: reduce ? 1 : 0.96, y: reduce ? 0 : 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: reduce ? 1 : 0.98 }}
            transition={{ duration: reduce ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <button
              type="button"
              onClick={finish}
              aria-label="Skip onboarding"
              className="absolute right-3 top-3 rounded-md p-1.5 text-muted outline-none transition-colors hover:text-text focus-visible:ring-2"
            >
              <X size={16} aria-hidden />
            </button>

            <p className="mb-1 font-mono text-[10px] uppercase tracking-widest" style={{ color: tok("ceo-gold") }}>
              Welcome to MissionAlpha
            </p>

            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl" style={{ color: tok("accent-cyan"), backgroundColor: `color-mix(in oklch, ${tok("accent-cyan")} 12%, transparent)` }}>
              {cur.icon}
            </div>

            <motion.div key={step} initial={reduce ? false : { opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduce ? 0 : 0.2 }}>
              <h2 id="onb-title" className="text-lg font-semibold tracking-tight">{cur.title}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{cur.body}</p>
            </motion.div>

            {/* progress dots */}
            <div className="mt-5 flex items-center gap-1.5" role="tablist" aria-label="Onboarding steps">
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  role="tab"
                  aria-selected={i === step}
                  className="h-1.5 rounded-full transition-all"
                  style={{ width: i === step ? 20 : 6, backgroundColor: i === step ? tok("accent-cyan") : tok("border") }}
                />
              ))}
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={finish}
                className="text-[12px] text-muted outline-none transition-colors hover:text-text focus-visible:ring-2"
              >
                Skip
              </button>
              <div className="flex items-center gap-2">
                {step > 0 && (
                  <button
                    type="button"
                    onClick={() => setStep((s) => s - 1)}
                    className="rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:text-text focus-visible:ring-2"
                  >
                    Back
                  </button>
                )}
                {!last ? (
                  <button
                    ref={primaryRef}
                    type="button"
                    onClick={() => setStep((s) => s + 1)}
                    className="rounded-md px-3.5 py-1.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2"
                    style={{ color: tok("bg"), backgroundColor: tok("accent-cyan") }}
                  >
                    Next
                  </button>
                ) : (
                  <button
                    ref={primaryRef}
                    type="button"
                    onClick={tryGoal}
                    className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2"
                    style={{ color: tok("bg"), backgroundColor: tok("accent-cyan") }}
                  >
                    <Rocket size={13} aria-hidden /> Try a first goal
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

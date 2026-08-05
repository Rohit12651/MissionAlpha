import { motion } from "framer-motion";

export type BoardView = "state" | "pipeline";

/** Top-level shell surface (P3). Only rendered when the VITE_INBOX flag is on. */
export type ShellView = "inbox" | "board";

/** Segmented control with a spring pill that slides under the active label. */
export function ViewToggle({
  view,
  onChange,
}: {
  view: BoardView;
  onChange: (v: BoardView) => void;
}) {
  const opts: { id: BoardView; label: string }[] = [
    { id: "state", label: "State" },
    { id: "pipeline", label: "Pipeline" },
  ];
  return (
    <div
      className="relative inline-flex rounded-full border border-border bg-panel p-1"
      role="group"
      aria-label="Board grouping"
    >
      {opts.map((o) => {
        const active = view === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className="relative z-10 rounded-full px-4 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-cyan"
            style={{ color: active ? "var(--c-bg)" : "var(--c-muted)" }}
            aria-pressed={active}
          >
            {active && (
              <motion.span
                layoutId="view-pill"
                className="absolute inset-0 -z-10 rounded-full"
                style={{ background: "var(--c-text)" }}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Shell surface switch — Inbox ⇄ Board (P3). Separate control from `ViewToggle`
 * above (which groups the kanban): different scope, different state, different
 * lifetime. The pending badge rides the Inbox segment so the count is visible
 * from the Board too, which is the whole point of a badge.
 *
 * Motion: one spring-driven `layoutId` pill (transform only). The count itself
 * does not animate — the badge changes tens of times a day, and emil's frequency
 * rule says a value that common should just update.
 */
export function ShellToggle({
  view,
  onChange,
  pending,
}: {
  view: ShellView;
  onChange: (v: ShellView) => void;
  pending: number;
}) {
  const opts: { id: ShellView; label: string }[] = [
    { id: "inbox", label: "Inbox" },
    { id: "board", label: "Board" },
  ];
  return (
    <div
      className="app-no-drag relative inline-flex rounded-full border border-border bg-panel p-1"
      role="group"
      aria-label="Shell surface"
    >
      {opts.map((o) => {
        const active = view === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className="relative z-10 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-cyan"
            style={{ color: active ? "var(--c-bg)" : "var(--c-muted)" }}
            aria-pressed={active}
          >
            {active && (
              <motion.span
                layoutId="shell-pill"
                className="absolute inset-0 -z-10 rounded-full"
                style={{ background: "var(--c-text)" }}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            {o.label}
            {o.id === "inbox" && pending > 0 && (
              <span className="helm-badge" aria-label={`${pending} awaiting your decision`}>
                {pending}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

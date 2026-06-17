import { motion } from "framer-motion";

export type BoardView = "state" | "pipeline";

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

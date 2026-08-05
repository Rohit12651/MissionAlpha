import { motion, useReducedMotion } from "framer-motion";
import { tok } from "../../lib/agentMeta";

// Send indicator — occupies the assistant bubble from the moment the POST leaves until
// the FIRST token lands. Enter is 180ms ease-out (well inside the 300ms budget) and
// animates opacity + transform ONLY, so it stays on the compositor. Under
// prefers-reduced-motion the enter is instant and the dots hold a steady dim state.
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export function PendingIndicator({ accent }: { accent: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.span
      role="status"
      aria-live="polite"
      aria-label="Waiting for a reply"
      className="inline-flex items-center gap-1.5"
      initial={reduce ? { opacity: 1 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.18, ease: EASE_OUT }}
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: accent, willChange: "opacity, transform" }}
          initial={false}
          animate={reduce ? { opacity: 0.55 } : { opacity: [0.25, 1, 0.25], scale: [0.85, 1, 0.85] }}
          transition={reduce ? { duration: 0 } : { duration: 1.05, repeat: Infinity, ease: "easeInOut", delay: i * 0.14 }}
        />
      ))}
      <span className="ml-1 font-mono text-[10px] uppercase tracking-wide" style={{ color: tok("muted") }}>
        thinking
      </span>
    </motion.span>
  );
}

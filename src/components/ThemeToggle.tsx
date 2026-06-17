import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "../theme/useTheme";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Sun/moon toggle for the header. Icon crossfades + rotates over 300ms (Emil:
 * ease-out enter, transform+opacity only). Reduced-motion → instant swap.
 */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const reduce = useReducedMotion();
  const isDark = theme === "dark";
  const Icon = isDark ? Moon : Sun;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      title={`Switch to ${isDark ? "light" : "dark"} theme`}
      className="relative flex h-8 w-8 items-center justify-center rounded-full border border-border bg-panel/70 text-muted outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-accent-cyan"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={theme}
          initial={reduce ? false : { opacity: 0, rotate: -90, scale: 0.6 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, rotate: 90, scale: 0.6 }}
          transition={{ duration: 0.3, ease: EASE }}
          className="absolute inline-flex"
          aria-hidden
        >
          <Icon size={15} strokeWidth={2} />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

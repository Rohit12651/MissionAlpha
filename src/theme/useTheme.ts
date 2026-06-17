import { createContext, useContext } from "react";

export type Theme = "dark" | "light";

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

export const STORAGE_KEY = "ma-theme";

export const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Reads the persisted/system-preferred theme. Order: localStorage → prefers-
 * color-scheme → dark (Tesla cinematic default). Pure + SSR-safe-guarded.
 */
export function resolveInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // localStorage may throw in privacy mode — fall through to media query.
  }
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

/** Subscribe to the active theme. Throws if used outside ThemeProvider. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}

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
 * Reads the persisted theme, else the mockup's cream default (Phase G, D-8).
 * Pure + SSR-safe-guarded.
 */
export function resolveInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // localStorage may throw in privacy mode — fall through to media query.
  }
  // Phase G (D-8): the approved mockup is cream until the BOSS toggles, whatever the OS
  // prefers — it has no prefers-color-scheme rule, so neither does the app.
  return "light";
}

/** Subscribe to the active theme. Throws if used outside ThemeProvider. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}

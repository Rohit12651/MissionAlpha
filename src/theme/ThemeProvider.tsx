import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ThemeContext,
  STORAGE_KEY,
  resolveInitialTheme,
  type Theme,
} from "./useTheme";

/**
 * Owns the active theme. Applies it to <html data-theme> (which flips the OKLCH
 * token set in index.css) and persists to localStorage. The 300ms crossfade on
 * the body bg/color lives in index.css and is reduced-motion-aware there.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme);

  // Apply to <html> + persist whenever it changes. Done in an effect so the
  // attribute is set before paint on mount too (initial value already correct).
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Persistence is best-effort; ignore privacy-mode write failures.
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggle = useCallback(
    () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  const value = useMemo(
    () => ({ theme, setTheme, toggle }),
    [theme, setTheme, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

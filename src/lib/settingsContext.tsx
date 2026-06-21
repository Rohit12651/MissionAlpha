// SettingsProvider / useSettings (ADR-040). Owns BOSS preferences, persists them,
// and reconciles theme + accent into the DOM. Theme is mirrored into the existing
// ThemeProvider via the shared <html data-theme> attribute + ma-theme key, so the
// two never drift (settings is the editing surface; ThemeProvider is the applier).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { MotionConfig } from "framer-motion";
import {
  loadSettings,
  saveSettings,
  mergeSettings,
  applyAccent,
  type Settings,
} from "./settings";
import { STORAGE_KEY as THEME_KEY } from "../theme/useTheme";

// reduceMotionOverride → framer-motion's MotionConfig contract.
// system → respect the OS media query; on → force reduced; off → force full motion.
const RM_MAP = { system: "user", on: "always", off: "never" } as const;

interface SettingsCtx {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  // Apply accent whenever it (or theme) changes.
  useEffect(() => {
    applyAccent(settings.accent, settings.theme);
  }, [settings.accent, settings.theme]);

  // Reflect a reduce-motion override onto <html data-reduce-motion> for CSS hooks.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    if (settings.reduceMotionOverride === "system") el.removeAttribute("data-reduce-motion");
    else el.setAttribute("data-reduce-motion", settings.reduceMotionOverride);
  }, [settings.reduceMotionOverride]);

  // Keep settings.theme in sync with the LIVE <html data-theme> — covers the header
  // ThemeToggle flipping it in-tab (the `storage` event does NOT fire same-document,
  // so a MutationObserver is the only correct same-tab sync). Syncing settings.theme
  // re-runs the applyAccent effect above, so the accent always uses the right-theme
  // variant and never drifts (fixes the accent-contrast-under-toggle bug).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    const syncFromDom = () => {
      const t = el.getAttribute("data-theme");
      if (t === "dark" || t === "light") {
        setSettings((s) => (s.theme === t ? s : mergeSettings(s, { theme: t })));
      }
    };
    syncFromDom(); // initial reconcile (ThemeProvider may have resolved a different theme)
    const obs = new MutationObserver(syncFromDom);
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    // also catch cross-tab theme changes
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY && (e.newValue === "dark" || e.newValue === "light")) syncFromDom();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      obs.disconnect();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = mergeSettings(prev, patch);
      saveSettings(next);
      // If theme changed here, mirror to ThemeProvider's key + DOM so it applies.
      if (next.theme !== prev.theme) {
        try {
          window.localStorage.setItem(THEME_KEY, next.theme);
        } catch {
          /* ignore */
        }
        document.documentElement.setAttribute("data-theme", next.theme);
        document.documentElement.style.colorScheme = next.theme;
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ settings, update }), [settings, update]);
  // MotionConfig makes framer-motion's useReducedMotion() honor the explicit override
  // (on/off) over the OS media query — the CSS net for non-framer animations lives in
  // index.css under [data-reduce-motion].
  return (
    <Ctx.Provider value={value}>
      <MotionConfig reducedMotion={RM_MAP[settings.reduceMotionOverride]}>{children}</MotionConfig>
    </Ctx.Provider>
  );
}

export function useSettings(): SettingsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSettings must be used within <SettingsProvider>");
  return ctx;
}

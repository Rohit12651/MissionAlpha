// Settings store (ADR-040) — pure, React-free, unit-tested with `node --test`.
// One versioned JSON blob in localStorage["ma.settings.v1"]. Every field is a
// closed enum / boolean validated on load: a tampered blob can NEVER inject CSS,
// argv, or a privileged tier — it just falls back to a safe default.
//
// Policy toggles here are CLIENT DEFAULTS that pre-fill existing gated flows; they
// do NOT weaken server-side enforcement (F2b broker / ADR-029 / 033 / 038 / 039).

import type { ModelTier } from "./modelTiers";

export type Theme = "dark" | "light";
export type AccentKey = "cyan" | "violet" | "gold" | "green";
export type ReduceMotionPref = "system" | "on" | "off";

export interface Settings {
  v: 1;
  theme: Theme;
  accent: AccentKey;
  defaultTier: ModelTier;
  connectorDefaults: { autoGrantNewAgents: boolean };
  toolLoop: { confirmEverySensitive: boolean };
  sandbox: { networkDefaultGranted: boolean };
  reduceMotionOverride: ReduceMotionPref;
}

export const SETTINGS_KEY = "ma.settings.v1";
// Mirror for modelTiers.loadTier() fallback (kept in sync by saveSettings).
export const DEFAULT_TIER_MIRROR_KEY = "ma.default.tier";

export const defaultSettings: Settings = {
  v: 1,
  theme: "dark",
  accent: "cyan",
  defaultTier: "sonnet",
  connectorDefaults: { autoGrantNewAgents: false }, // least privilege
  toolLoop: { confirmEverySensitive: true },
  sandbox: { networkDefaultGranted: false },
  reduceMotionOverride: "system",
};

/**
 * Accent → vetted OKLCH overrides for `--c-accent-cyan` (the primary accent the
 * cockpit reads). Values are contrast-checked (WCAG AA ≥ 4.5 on --c-panel) per
 * theme; `cyan` is the identity (today's look). `null` accent fields mean "leave
 * the index.css default in place".
 */
export const ACCENTS: Record<
  AccentKey,
  { label: string; dark: { base: string; bright: string }; light: { base: string; bright: string } }
> = {
  cyan: {
    label: "Cyan",
    dark: { base: "oklch(0.82 0.14 200)", bright: "oklch(0.82 0.14 200)" },
    light: { base: "oklch(0.52 0.13 220)", bright: "oklch(0.62 0.13 220)" },
  },
  violet: {
    label: "Violet",
    dark: { base: "oklch(0.78 0.13 300)", bright: "oklch(0.8 0.14 300)" },
    light: { base: "oklch(0.48 0.18 300)", bright: "oklch(0.56 0.16 300)" },
  },
  gold: {
    label: "Gold",
    dark: { base: "oklch(0.84 0.14 90)", bright: "oklch(0.86 0.13 90)" },
    light: { base: "oklch(0.55 0.13 80)", bright: "oklch(0.66 0.12 85)" },
  },
  green: {
    label: "Green",
    dark: { base: "oklch(0.78 0.16 150)", bright: "oklch(0.8 0.15 150)" },
    light: { base: "oklch(0.52 0.14 150)", bright: "oklch(0.6 0.13 150)" },
  },
};

const THEMES = new Set<Theme>(["dark", "light"]);
const ACCENT_KEYS = new Set<AccentKey>(["cyan", "violet", "gold", "green"]);
const TIERS = new Set<ModelTier>(["opus", "sonnet", "haiku"]);
const RM = new Set<ReduceMotionPref>(["system", "on", "off"]);

const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);

/** Validate an arbitrary parsed object into a complete Settings (never throws). */
export function coerceSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cd = (o.connectorDefaults || {}) as Record<string, unknown>;
  const tl = (o.toolLoop || {}) as Record<string, unknown>;
  const sb = (o.sandbox || {}) as Record<string, unknown>;
  return {
    v: 1,
    theme: THEMES.has(o.theme as Theme) ? (o.theme as Theme) : defaultSettings.theme,
    accent: ACCENT_KEYS.has(o.accent as AccentKey) ? (o.accent as AccentKey) : defaultSettings.accent,
    defaultTier: TIERS.has(o.defaultTier as ModelTier) ? (o.defaultTier as ModelTier) : defaultSettings.defaultTier,
    connectorDefaults: { autoGrantNewAgents: bool(cd.autoGrantNewAgents, false) },
    toolLoop: { confirmEverySensitive: bool(tl.confirmEverySensitive, true) },
    sandbox: { networkDefaultGranted: bool(sb.networkDefaultGranted, false) },
    reduceMotionOverride: RM.has(o.reduceMotionOverride as ReduceMotionPref)
      ? (o.reduceMotionOverride as ReduceMotionPref)
      : defaultSettings.reduceMotionOverride,
  };
}

export function mergeSettings(prev: Settings, patch: Partial<Settings>): Settings {
  // Re-coerce after shallow merge so a bad patch can't smuggle an invalid value.
  return coerceSettings({ ...prev, ...patch });
}

/** Load from localStorage (browser only). Falls back to defaults on any failure. */
export function loadSettings(): Settings {
  if (typeof window === "undefined") return { ...defaultSettings };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    return coerceSettings(JSON.parse(raw));
  } catch {
    return { ...defaultSettings };
  }
}

/** Persist (best-effort). Mirrors defaultTier for modelTiers.loadTier() fallback. */
export function saveSettings(s: Settings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    window.localStorage.setItem(DEFAULT_TIER_MIRROR_KEY, s.defaultTier);
  } catch {
    /* privacy mode — ignore */
  }
}

/**
 * Apply the chosen accent by overriding `--c-accent-cyan` (+ `-bright`) on <html>
 * for the active theme. `cyan` clears overrides (back to the index.css default).
 * Status colors (amber/red/green/gold) are untouched — only the PRIMARY accent moves.
 */
export function applyAccent(accent: AccentKey, theme: Theme): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  if (accent === "cyan") {
    el.style.removeProperty("--c-accent-cyan");
    el.style.removeProperty("--c-accent-cyan-bright");
    return;
  }
  const v = ACCENTS[accent][theme];
  el.style.setProperty("--c-accent-cyan", v.base);
  el.style.setProperty("--c-accent-cyan-bright", v.bright);
}

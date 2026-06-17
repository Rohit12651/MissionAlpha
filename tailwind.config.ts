import type { Config } from "tailwindcss";

// Colors resolve to CSS custom properties (OKLCH) defined in src/index.css.
// Wrapping in oklch(from var(...)) is avoided — the vars already hold full
// oklch() values, so we reference them directly. This keeps the token system
// the single source of truth for dark/light theming via [data-theme].
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: "var(--c-bg)",
        panel: "var(--c-panel)",
        "panel-2": "var(--c-panel-2)",
        text: "var(--c-text)",
        muted: "var(--c-muted)",
        border: "var(--c-border)",
        "accent-cyan": "var(--c-accent-cyan)",
        "blocked-amber": "var(--c-blocked-amber)",
        "stale-red": "var(--c-stale-red)",
        "done-green": "var(--c-done-green)",
        "ceo-gold": "var(--c-ceo-gold)",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "SF Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      borderRadius: {
        panel: "16px",
      },
    },
  },
  plugins: [],
};

export default config;

# ADR-040 — Settings + Theming Panel

**Status:** ACCEPTED (Stage 4 / Build Order #6)
**Author:** architect
**Date:** 2026-06-18
**Stage:** S4 — Polish / DX / Observability
**Gaps:** #26 (theming/settings), supports #25 (onboarding), #27 (command palette)
**Supersedes:** nothing (extends ADR-023 chat-first shell, ADR-022 model tiers)
**Security:** non-sensitive surface — preferences only. No new exec/auth/cred path. Policy toggles are CLIENT DEFAULTS that pre-fill existing gated flows; they NEVER weaken server-side enforcement (F2b broker, ADR-029 auto-apply, ADR-038 tool-loop classification, ADR-039 approval). Confirmed in §6.

---

## 1. Context

S1–S3.5 shipped the engine, cockpit, MCP connectors, deep review, and the full
tool loop. Settings today are scattered: theme lives in `ThemeProvider`
(`localStorage["ma-theme"]`), model tier is per-chat only, layout flags are ad-hoc
`localStorage["ma.*"]` keys in `App.tsx`. There is no single place for the BOSS to
set **defaults** (which tier new chats use, which connectors are on by default,
how aggressive the tool-loop/sandbox prompts are) or to tune the look.

The roadmap (Phase 4.1) calls for a settings panel with: default tier, theme,
tab/accent colors, connector defaults, tool-loop + sandbox policy toggles, on an
**OKLCH token system**, **persisted**.

## 2. Decision

Introduce a single **typed settings store** (`src/lib/settings.ts`) + a React
context (`SettingsProvider` / `useSettings`) that owns all BOSS preferences, and a
**Settings panel** UI (`src/components/settings/SettingsPanel.tsx`). Persist to
`localStorage["ma.settings.v1"]` as one JSON blob (versioned for forward-compat).
Theme remains the source of truth in `ThemeProvider` but is *driven by* settings
(settings.theme ⇄ ThemeProvider) so there is one mental model.

### 2.1 Settings schema (`Settings`, v1)
```ts
interface Settings {
  v: 1;
  theme: "dark" | "light";          // mirrors ThemeProvider; OKLCH token set flips on <html data-theme>
  accent: AccentKey;                // "cyan" | "violet" | "gold" | "green" — remaps --c-accent-cyan primary
  defaultTier: "opus" | "sonnet" | "haiku";   // tier new chats start on (default sonnet — roadmap §2.0)
  connectorDefaults: { autoGrantNewAgents: boolean }; // connectors auto-granted to freshly created agents (default false — least privilege)
  toolLoop: { confirmEverySensitive: boolean };       // CLIENT pre-fill: default the approval prompt to "ask" (default true)
  sandbox: { networkDefaultGranted: boolean };         // CLIENT pre-fill: default the network toggle in ExecConsole (default false)
  reduceMotionOverride: "system" | "on" | "off";       // a11y nicety
}
```

### 2.2 OKLCH token system (as implemented)
- The canonical palette already lives in `src/index.css` as `--c-*` OKLCH vars under
  `[data-theme]`. **No hardcoded hex anywhere** (existing invariant — kept).
- The cockpit's primary accent token is `--c-accent-cyan` (read app-wide via `tok()`).
  The `accent` setting remaps the primary accent by **overriding `--c-accent-cyan`
  (+ `--c-accent-cyan-bright`) inline on `<html>`** with the chosen accent's vetted
  OKLCH value *for the active theme* (`applyAccent` in `settings.ts`). Default `cyan`
  clears the overrides → today's look exactly. Status colors (amber/red/green/gold)
  are never touched — only the primary accent moves.
  - **Rationale for direct override (vs a separate `--c-accent-primary` indirection):**
    every existing component already reads `--c-accent-cyan`, so overriding it is what
    makes the remap visible app-wide with zero component churn.
  - **Theme-change correctness:** because the override is theme-specific, it MUST be
    re-applied whenever the theme flips — including the in-tab header ThemeToggle.
    `SettingsProvider` watches `<html data-theme>` with a `MutationObserver`, syncs
    `settings.theme`, and re-runs `applyAccent`, so the override always uses the
    right-theme variant and never drifts to the wrong-contrast value.
- Light/dark variants for every accent are pre-derived + contrast-checked (WCAG AA
  ≥ 4.5 on `--c-panel`) in the closed `ACCENTS` map.
- Settings never inject raw color strings from user input — `accent` is a closed
  enum mapping to vetted, contrast-checked tokens. (Anti-injection; see §6.)

### 2.3 Persistence + load order
1. Mount: `loadSettings()` reads `localStorage["ma.settings.v1"]`, validates each
   field against its allowlist, drops unknown/invalid fields to defaults (never throws).
2. Theme reconciliation: on load, `settings.theme` seeds `ThemeProvider`; toggling
   the theme (toggle button or palette) writes back to settings so they never drift.
3. Every mutation = shallow-merge + persist (best-effort, privacy-mode safe).

## 3. Policy toggles — what they DO and DO NOT do

> **Hard rule (security-signed):** policy toggles are **operator-side conveniences
> that change DEFAULTS in the UI**, not authorization. They cannot grant a
> capability the server would otherwise deny.

| Toggle | Effect (client only) | What it can NEVER do |
|---|---|---|
| `toolLoop.confirmEverySensitive` | Pre-sets the ExecConsole approval default; when off, SAFE commands still auto-run as today, SENSITIVE still prompts | Skip the server classification / approval for SENSITIVE; auto-approve FORBIDDEN |
| `sandbox.networkDefaultGranted` | Pre-checks the "network" checkbox in the exec proposal form | Grant network without the server still honoring `--network none` unless explicitly passed + approved |
| `connectorDefaults.autoGrantNewAgents` | When creating an agent, the UI pre-selects "grant enabled connectors" | Bypass the per-agent MCP allowlist enforcement (ADR-033) — every call is still checked server-side |

The server (`tool-broker.mjs`, `mcp-registry.mjs`, broker in `factory.mjs`) is the
sole authority and is **untouched** by this ADR.

## 4. Component / wiring

- `src/lib/settings.ts` — pure: `defaultSettings`, `loadSettings()`, `saveSettings()`,
  `mergeSettings()`, `ACCENTS` map, validation. **No React** → unit-testable with `node --test`.
- `src/lib/settingsContext.tsx` — `SettingsProvider` + `useSettings()` hook.
- `src/components/settings/SettingsPanel.tsx` — modal (role=dialog, focus-trap, Esc,
  reduced-motion), sections: Appearance · Defaults · Policy · Accessibility.
- Wiring: `main.tsx` wraps `<SettingsProvider>` outside `<ThemeProvider>`; `App.tsx`
  reads `defaultTier`/`connectorDefaults` and opens the panel from header + palette.

## 5. Alternatives considered
- **Server-persisted settings** — rejected: single-user, no auth tiers yet; localStorage
  is simpler and the policy toggles are UI defaults, not server config. (Revisit under Enterprise / Deferred B.)
- **Free-form color picker** — rejected: arbitrary OKLCH/hex risks failing contrast +
  is an injection surface. Closed accent enum keeps AA + safety.

## 6. Security review (senior-security-engineer — signed)
- No new write path to auth/cred/exec/audit. Settings are local prefs.
- `accent`/`theme`/`defaultTier`/policy fields are **closed enums / booleans**, validated
  on load — a tampered `localStorage` blob cannot inject CSS, argv, or a privileged tier.
- Policy toggles cannot escalate: server-side classification, allowlist, and approval
  remain the only authorities (§3). Verified the toggles only change form defaults.
- **VERDICT: APPROVED — non-sensitive, no regression to F2b / ADR-029 / 033 / 038 / 039.**

## 7. Acceptance
- [ ] Settings panel opens (header + ⌘K), is keyboard + screen-reader operable.
- [ ] Change theme → persists across reload; change accent → primary accent remaps, AA holds.
- [ ] Change default tier → a NEW chat starts on it.
- [ ] Policy toggles change ExecConsole/connector defaults only; server gates unchanged.
- [ ] Tampered settings blob → safe defaults, no throw.

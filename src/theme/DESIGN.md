# Design — MissionAlpha (locked, Phase G)

The renderer's design system. Source of truth: the approved mockup
`docs/mockups/missionalpha-sketchbook.html`. Every surface matches it exactly (ADR G-2);
this file names the system so a change is made here and in the mockup together, never in one
component.

## Genre and macrostructure
- Genre: editorial (studied-DNA, Pa'lais botanical sketchbook).
- Splash: Marquee Hero → recipe band → promises → statement footer (landing view).
- App: Workbench. Titlebar · BOS sidebar (BOS_NAV order) · page (eyebrow, H1, Caveat tagline,
  live clock) · status strip · draggable live-ops dock.

## Theme (exact mockup tokens)
| Token | Value | Role |
|---|---|---|
| `--paper` | #fbf9f6 | page |
| `--card` | #ffffff | cards, drawers |
| `--ink` / `--ink-2` / `--ink-3` | #000 / #3c3f48 / #5d6170 | text ladder |
| `--brand` | #234386 | the only filled CTA, headings |
| honey / orange / sky / sand / sage | #ffc400 / #ed7328 / #6aa8dc / #d2b68c / #a2d3a6 | status + blobs |
| `--hair` / `--hair-strong` | rgba(0,0,0,.14) / .6 | rules, inputs |

- Orange is never text (2.9:1 on cream). Text on orange is ink.
- Dark theme ("indigo night") is the mockup's `:root[data-theme="dark"]` block.

## Typography
- Display: Bebas Neue 400, uppercase, tracking .031–.06em.
- Labels: Jost 500, uppercase, tracking .12–.27em, 10–12px (ADR G-1: no 12px floor).
- Body: Inter 400/500/600, 16px/1.5.
- Script: Caveat 500, taglines only.
- Fonts are self-hosted woff2 in `src/fonts` (`font-src 'self'`).

## Shape and spacing
- Radii: button 32px, card 8px, input 8px, tag 16px.
- Shadows: card `-14px 10px 49px rgba(0,0,0,.16)`, soft `0 20px 27px rgba(0,0,0,.05)`.
- 4px spacing scale `--s-4 … --s-128`.

## Motion (emil-design-eng)
- Easings: `--ease-out` cubic-bezier(.23,1,.32,1), `--ease-in-out` (.77,0,.175,1),
  `--ease-drawer` (.32,.72,0,1).
- Press `scale(.97)` at 140ms; UI 220ms; FLIP moves 520ms.
- Animate transform/opacity only. Reduced motion collapses to an opacity crossfade of 150ms
  or less.

## Microinteractions
- Silent success plus a toast. Overlays close on Esc and trap focus.
- Focus ring: 2px indigo, 3px offset, never animated.

## What every surface shares
Wordmark MISSIONALPHA (Bebas), indigo CTA voice, eyebrow + H1 + Caveat tagline header, chips
with dots, botanical line-art at 1.2px stroke with no fill.

# UX Contract — Chat-First Workspace Shell

**Slug:** `chat-first-ux`
**Feature:** MissionAlpha unified workspace (Phase 2 of `workspace-plan.md`)
**Author:** principal-ux-design
**Status:** DESIGN_CONTRACT_PUBLISHED
**Date:** 2026-06-17
**Binding for:** senior-web-1 (shell reflow), senior-web-2 (model picker, thread switcher, Team panel)
**Tokens:** OKLCH only, via `src/index.css` vars; reach accents through `tok("<name>")` or `var(--c-*)`. No raw hex/oklch literals in components.

Reference register: **product** cockpit. Feel: Claude Code / Linear / Raycast — calm, dense, fast, keyboard-first. Anti-slop: no gradient-on-card, no nested cards, no center-everything, no decorative chrome.

## 1. Shell layout — three regions, center owns the conversation

- Root grid: `grid-template-columns: <rail> 1fr <team>; height: 100dvh; overflow:hidden`. Each region manages its own overflow; the page never scrolls as a whole. Bg `--c-bg`.

**LEFT — Thread rail** (`role="navigation"` `aria-label="Threads"`): width `264px` (min 224 / max 300), collapsible to `56px` icon rail (chevron bottom-left, persisted `ma.rail.collapsed`). Bg `--c-bg`, right edge `1px --c-border`. Own scroll on the list. Structure: pinned Boss/CEO group (◆ `--c-ceo-gold`) + divider + agents group (identity dot per `agentMeta`). Row: 40px, padding 8/12, radius 8, identity dot 8px + name (13px, truncate). **Active** = bg `--c-panel-2` + 3px left accent bar (identity color) + `aria-current="page"` + text `--c-muted`→`--c-text`. Hover = bg `--c-panel`. Background-streaming non-active thread shows a slow-pulsing identity dot (static under reduced-motion).

**CENTER — Primary chat** (`role="main"` `aria-label="Conversation"`): `min-width 480px`, flex `1fr`, bg `--c-panel`, internal `grid-template-rows: auto 1fr auto` (sticky header / scrolling thread / sticky input). **The thread is the sole scroll owner of the center** (`overflow-y:auto`, `overscroll-behavior:contain`). Evolve `BossConsole`+`AgentChat` thread/input markup into this column — same SSE parse, same role tags, same `▍` cursor. Boss keeps `parseDispatch`+dispatch bridge; agents keep the F2b changes bridge.
- Header (64px, grid `auto 1fr auto`, bottom `1px --c-border`): left = identity dot + title (15px semibold) + subtitle (10px mono uppercase `--c-muted`); right = model picker + mode badge + Team toggle.
- Thread: padding 24/20, message gap 16, max message column 760px centered; messages left-aligned prose rows (icon + role tag + text), no bubbles.
- Input bar (sticky bottom, bg `--c-panel`, top `1px --c-border`, padding 12/20): textarea (`--c-bg` fill, autosize 2→8 rows, Enter sends / Shift+Enter newline) + Send (thread-identity accent at `color-mix 14% / border 34%`).

**RIGHT — Team panel** (`role="complementary"` `aria-label="Team status"` `id="team-panel"`): width `420px` (min 360 / max 560), collapses fully to `0`. Bg `--c-bg`, left edge `1px --c-border`, own scroll. Holds the existing board unchanged (board's internal view-switcher stays inside).

## 2. Model picker — compact header dropdown, per-thread, persisted

Custom listbox (button + `role="listbox"`/`role="option"` popover — not native `<select>`), in the center header right of the title, left of the mode badge.

| Tier | Label | Hint | id |
|---|---|---|---|
| Opus | `Opus` | `smartest` | claude-opus-4-8 |
| Sonnet | `Sonnet` | `balanced` | claude-sonnet-4-6 |
| Haiku | `Haiku` | `fastest` | claude-haiku-4-5 |

**Default Sonnet.** Per-thread, persisted (`ma.model.<threadId>`). Trigger: 32px, bg `--c-panel-2`, border `1px --c-border`, dot `--c-accent-cyan` + label + chevron; `aria-haspopup="listbox"` `aria-expanded` `aria-label="Model tier, currently Sonnet"`. Menu: surface `--c-panel-2`, border, radius 10, `transform-origin: top right`, width 220, rows 44px; **selected** = cyan check + label `--c-text` + `aria-selected` (not color-alone — position+weight). Hover row bg `color-mix(cyan 10%, panel-2)`.
Keyboard: Enter/Space/↓ open; ↑/↓ roving via `aria-activedescendant`; Home/End; Enter selects+closes+returns focus; Esc closes; typeahead o/s/h. Never `outline:none` (global focus ring stands). Switch feedback: label crossfade + `aria-live=polite` "Model set to Opus"; history not cleared; next message uses new tier.

## 3. Team panel — secondary, toggle-able board

Toggle in center header far right: 32px icon button, `aria-pressed`, `aria-controls="team-panel"`, `aria-label="Toggle Team panel"`; rest `--c-muted`/transparent, active icon `--c-text`/bg `--c-panel-2`. Shortcut `⌘.`/`Ctrl+.`. Collapse → grid third col `0`, panel `display:none` after exit anim. Persisted `ma.team.open` (default open ≥1024px, closed below). Motion: `translateX` + grid track, ease-out ≤300ms, reduced-motion instant.

## 4. Responsive

| Range | Layout |
|---|---|
| `<768px` | Chat full-screen; rail + team leave flow |
| `768–1023px` | Rail → 56px icon rail; team closed (sheet on demand) |
| `≥1024px` | Full 3-column; team default-open |

Mobile (`<768px`): single column, top app bar (56px): left hamburger → rail as left sheet (`role="dialog"` `aria-modal` focus-trap, Esc/scrim close, focus returns); center title; right model picker + Team button → board as bottom sheet. Input pinned bottom, `env(safe-area-inset-bottom)`, `100dvh`. Touch targets ≥44px (sheet thread rows 48px).

## 5. Motion (emil — binding)

Only animate `transform`+`opacity`. Ease-out enter, ease-in-out moves, never ease-in. ≤300ms. Reuse `useReducedMotion()`; CSS net is the backstop.

| Interaction | Spec |
|---|---|
| Team slide/collapse | translateX + grid track; enter 240ms ease-out, exit 200ms; reduced→instant |
| Rail collapse | width/transform 200ms ease-out; label crossfade first 120ms |
| Mobile sheets | slide from edge 260ms enter / 200ms exit; scrim opacity same |
| Model-switch label | old `opacity1→0 + translateY(0→-3)` 120ms; new `opacity0→1 + translateY(3→0)` 140ms; no bounce |
| Model menu | origin top-right; open `scale(0.96→1)+opacity` 160ms; close `opacity1→0` 120ms; never scale(0) |
| Streaming cursor | existing `▍ animate-pulse`; static under reduced-motion |
| Thread switch | crossfade body: out `opacity1→0` 100ms, in `opacity0→1 + translateY(4→0)` 160ms; don't slide column; reduced→instant; scroll to bottom (smooth/auto per reduce) |
| Row hover/active | `transition: background-color` 120ms (NOT `transition:all`) |
| Press feedback | `scale(0.97)` on `:active` 100ms; pressables only, never keyboard-initiated |

## 6. A11y (WCAG 2.2 AA — binding)

- Landmarks: rail `nav`, center `main` (exactly one), team `aside`/`complementary`; mobile sheets `role=dialog aria-modal focus-trap`.
- Focus order = DOM order (no positive tabindex). Thread switch → focus composer of new thread (only on explicit activation, not background stream). Menu/sheet close → focus returns to invoker.
- Live regions: streaming assistant text `aria-live=polite aria-atomic=false`, `aria-busy` on thread region while streaming — **debounce/coalesce announcements** (sentence/whitespace boundary or ~250ms throttle, NOT per-token). Errors `role=alert`. Confirmations (`dispatched n/n`, `applied n/n`, model-switch) `role=status`. Rail background-stream pip → throttled `sr-only` "{agent} is replying".
- Contrast: body `--c-text` on `--c-panel`; metadata `--c-muted` (≥12px); accent TEXT uses AA-safe light vars (cyan 5.04 / gold 4.92 / green 5.17 / amber 5.02 / red 5.38 on panel); `-bright` variants decorative ONLY. Active thread by bg+bar+`aria-current` not color alone; selected tier by check+position+weight.
- Target sizes: web header icons ≥40px hit area; mobile ≥44px.

## 7. States

Empty (per thread): outlined `--c-border` block, `--c-muted` body, `--c-text` lead; agent = "Message {id}. They reply with their Claude brain; edits land in a sandbox you review before applying." Streaming: input disabled, Send spinner+…, `▍` cursor, `aria-busy`. Error: red line `role=alert` + retry-enabled input. Mode badge: live·claude (green) / live·subscription / mock (amber) — unchanged.

## 8. Self-critique

P/H/E/S/R/V: chat unambiguously hero (full-height panel, 760px measure, board demoted aside); 3 landmarks + one scroll owner; dense+calm, no nested cards/gradients; Linear/Raycast structure not centered-card slop; responsive 320–768 verified with sheets+safe-area; per-thread identity color = texture without noise. Open risk for frontend: debounce the `aria-live` streaming region (don't machine-gun SR users). Motion passes emil bar.

Gate: `DESIGN_CONTRACT_PUBLISHED`. No `index.css` change needed (existing AA-verified set sufficient — do not modify or inline token values).

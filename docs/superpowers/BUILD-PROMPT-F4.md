# BUILD PROMPT — F4: MissionAlpha Desktop App (Electron, Dark Cockpit)

> Paste this prompt into a new Claude Code session in the MissionAlpha repo.
> Design source of truth: `docs/mockups/missionalpha-cockpit.html` — study it FIRST.

---

## Context

MissionAlpha is an AI agent-swarm orchestrator. Stack:
- **Backend:** `agent-runtime/` — Node ESM HTTP server (`server.mjs`), spawns `claude -p` CLI + Docker jail, streams SSE
- **Frontend:** `src/` — React/Vite cockpit SPA, dev port 3004, proxied to runtime :3005 via `vite.config.ts`
- **Auth:** runtime token at `RUNTIME_TOKEN_DIR/.runtime-token`; client fetches via `/api/runtime-token` (vite dev-only middleware)

F4 wraps both in Electron: main process auto-spawns runtime child; renderer = built cockpit. No architectural rewrite — additive only.

---

## MANDATORY SKILL CHAIN — fire IN ORDER before touching any code

1. `sp-brainstorming` — scope + approach
2. `sp-writing-plans` — write executable sub-plan (RED→GREEN steps) before any code
3. **`hallmark study docs/mockups/missionalpha-cockpit.html`** — extract design DNA (do this BEFORE writing any CSS/components; if hallmark is unavailable, read the mockup HTML and extract tokens manually)
4. **`impeccable craft`** → **`impeccable colorize`** (OKLCH dark palette) → **`impeccable typeset`** → **`impeccable critique`** → **`impeccable polish`**
5. `frontend-design` — component structure
6. `emil-design-eng` — topbar/kanban-card/panel transitions + interactions
7. `kw-design-design-system` — lock tokens as CSS custom properties in `src/index.css`
8. `kw-design-accessibility-review` + `a11y-architect` — WCAG 2.2 dark contrast ≥ 4.5:1, focus rings, keyboard nav
9. `sp-test-driven-development` — RED→GREEN for every unit (supervisor, preflight, token bridge)
10. `webapp-testing` — visual verify in running app
11. `security-reviewer` — Electron hardening (contextIsolation, CSP, token bridge security)
12. `sp-verification-before-completion` — BEFORE claiming done
13. `sp-requesting-code-review` — final review

**Agents to use:**
- `principal-ux-design` — OWNS dark palette + OKLCH tokens + layout contract; all other frontend agents consume its output
- `electron-pro` — main/preload/supervisor/packaging
- `ui-designer` — component library
- `a11y-architect` — WCAG 2.2 audit
- `security-reviewer` — Electron hardening pass
- `ui-ux-tester` — interaction QA

---

## Design Direction — DARK COCKPIT (source of truth: `docs/mockups/missionalpha-cockpit.html`)

**Run `hallmark study docs/mockups/missionalpha-cockpit.html` first. Implement what the mockup shows, exactly.**

### Palette (OKLCH — set in `src/index.css`, NOT inline)
```css
:root {
  --bg-base:       oklch(0.16 0 0);
  --bg-panel:      oklch(0.20 0 0);
  --bg-surface:    oklch(0.24 0 0);
  --accent-cyan:   oklch(0.75 0.18 200);   /* primary / active */
  --accent-gold:   oklch(0.80 0.15  85);   /* warning / stale */
  --accent-violet: oklch(0.65 0.20 290);   /* in-progress */
  --accent-amber:  oklch(0.78 0.16  65);   /* blocked */
  --accent-green:  oklch(0.72 0.16 150);   /* done */
  --text-primary:  oklch(0.92 0 0);
  --text-muted:    oklch(0.60 0 0);
  --border:        oklch(0.28 0 0);
}
```

### Layout (from mockup)
- **Frameless window** — mac traffic-light inset; drag region on topbar
- **Topbar:** status dot (green=runtime up / red=down), agent-count pills (active/blocked/stale/offline), nav buttons (Audit · Tools · Replay · ⌘K · ⚙)
- **Left roster panel (200 px):** agent avatar list, model-tier tags (pro/opus/sonnet), active cyan ring
- **Centre kanban (5 cols):** idle · in-progress · blocked · review · done; card drag; globe backdrop (faint CSS ring animation behind the board)
- **Right panel (360 px):** Chat | Feed tabs; message bubbles colour-coded by sender (system/user/agent); quota chip + ctx chip + model selector + Send composer
- **Key screens:** "/" command menu overlay, agent drawer (model picker + overdue ring), settings modal, onboarding wizard

### Typography
No specific font required — system-ui or Inter is fine. Set `--font-sans` in `src/index.css`. Do NOT force Lato.

---

## Known Wiring Gaps — BOTH must be solved or chat dies in packaged build

### (a) Runtime base URL
- Dev: vite proxies `/runtime/*` → `:3005`; client calls relative `/runtime/...`
- Packaged: no proxy → 404
- **Fix:** inject `window.__RUNTIME_BASE__` via Electron preload (`contextBridge`) = `""` (dev, relative) or `"http://127.0.0.1:3005"` (packaged). Client reads it before every fetch.

### (b) Auth token (THE blocker — 401 = dead chat)
- Dev: `/api/runtime-token` served by vite dev-only middleware (`vite.config.ts:459-494`)
- Packaged: that route 404s → no `x-runtime-token` → every `/runtime/*` = 401 → chat dead
- **Fix:** Electron main reads `.runtime-token` file from `RUNTIME_TOKEN_DIR`; exposes it to renderer via `contextBridge` in `preload.js`; client token-fetch checks `window.__RUNTIME_TOKEN__` first (packaged), falls back to `/api/runtime-token` fetch (dev)

---

## Files to Create

| File | Purpose |
|------|---------|
| `electron/main.js` | BrowserWindow (frameless, contextIsolation:true, nodeIntegration:false), loads renderer, manages runtime supervisor |
| `electron/preload.js` | `contextBridge` exposes `window.__RUNTIME_BASE__` + `window.__RUNTIME_TOKEN__` |
| `electron/runtime-supervisor.js` | Spawns `node agent-runtime/server.mjs` with RUNTIME_* env, polls `/runtime/health`, restarts on crash, SIGTERM on quit |
| `electron/preflight.js` | Detects `claude` on PATH + `docker info` + auth → friendly setup screen (not crash) |
| `electron-builder.yml` | App id `com.missionalpha.app`, mac dmg + win nsis, icons, extraResources (runtime + .claude/agents) |

## Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add electron + electron-builder deps; add `electron:dev` + `electron:build` scripts |
| `src/index.css` | Dark OKLCH palette + `--font-sans`; replaces any light-mode defaults |
| `index.html` | Font preload if needed |
| `src/App.tsx` | Runtime-base URL switch (`window.__RUNTIME_BASE__` || `""`) |
| Client token-fetch file | Switch: packaged → `window.__RUNTIME_TOKEN__`, dev → fetch `/api/runtime-token` |

---

## Sub-Plan Structure (write with `sp-writing-plans` before coding)

```
F4.0  hallmark study docs/mockups/missionalpha-cockpit.html  → design DNA doc
F4.1  Electron scaffold  (main.js + preload.js + electron:dev)
F4.2  Runtime supervisor  (spawn + health-poll + restart)  RED→GREEN tests
F4.3  Preflight checks  (claude/Docker/auth)  RED→GREEN tests
F4.4  OKLCH dark palette + layout shell  (owned by principal-ux-design)
F4.5  Kanban board (5-col) + roster panel + topbar pills  (impeccable craft)
F4.6  Chat|Feed right panel + composer  (emil-design-eng motion)
F4.7  Globe backdrop (CSS animation)
F4.8  Key screens: command menu / agent drawer / settings / onboarding
F4.9  Packaged wiring: (a) runtime-base + (b) token bridge  ← CRITICAL
F4.10 a11y pass  (a11y-architect: dark contrast + focus rings + keyboard)
F4.11 electron-builder.yml + production build
F4.12 Security review  (security-reviewer)
F4.13 Visual verify + interaction QA  (webapp-testing + ui-ux-tester)
F4.14 sp-verification-before-completion → commit + push
```

---

## Hard Constraints

- **Never free-code a step** — `sp-writing-plans` sub-plan first, then RED→GREEN per task
- **Design = mockup** — `hallmark study` the mockup HTML before writing one line of CSS
- **`principal-ux-design` owns the design contract** — other agents consume its tokens
- **Packaged mode wiring is NON-NEGOTIABLE** — test the built `.dmg` / packed app, not just vite dev
- **Caveman chat, normal code** — no fluff in updates; code/commits written normally
- **Commit per GREEN** — one commit per passing test/phase
- **`security-reviewer` before merge** — contextIsolation, no remote module, CSP headers, token bridge can't leak

---

## Host Dependency Scope (document in app)

The app is **Tier-1: dev-machine only**. It requires on the host:
1. `claude` on PATH + logged-in subscription (or `ANTHROPIC_API_KEY`)
2. Docker daemon running (only for `/exec` jail; chat works without Docker — degrade gracefully with a warning, don't block)

Bundling `claude` or Docker into the app is OUT OF SCOPE. Preflight screen shows what to install when deps are missing.

---

## Exit Gate (all must be green before "done")

- [ ] `electron:dev` launches cockpit in Electron window with dark cockpit UI
- [ ] Design matches `docs/mockups/missionalpha-cockpit.html` — topbar / roster / 5-col kanban / chat-feed / globe backdrop
- [ ] Runtime auto-starts; `runtime-supervisor` restarts on crash
- [ ] Preflight detects missing `claude` / Docker with setup screen (not crash)
- [ ] **PACKAGED BUILD** (not just dev): chat works — token bridge live (no 401), runtime base resolved
- [ ] Docker-down degrades gracefully (warn in preflight, don't block launch)
- [ ] WCAG 2.2: dark contrast ≥ 4.5:1, focus visible, keyboard nav
- [ ] Electron security review clean (contextIsolation, CSP, no node in renderer)
- [ ] `electron:build` → `.dmg` (mac) or installer — launches cleanly
- [ ] Suite green; `sp-verification-before-completion` passed; commit + push

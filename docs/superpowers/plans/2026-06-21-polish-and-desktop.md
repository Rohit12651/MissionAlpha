# MissionAlpha — Polish + Desktop Plan (3 features)

> **STATUS: FEATURE SPEC + SEQUENCING — NOT directly line-executable.** Each feature (F1–F4)
> is a scoped spec whose FIRST task is to produce its own executable sub-plan (real
> RED→GREEN code + exact commands) via `sp-writing-plans`, then execute it with
> `sp-subagent-driven-development`. Do NOT hand a fresh subagent an `Fx.y` bullet and
> expect runnable code — expand it into a sub-plan first. (Validation 2026-06-21 corrected
> this header: the earlier version over-claimed execution-readiness.)

**Goal:** Raise swarm build throughput, give the CEO live web research, and ship MissionAlpha as
a Docker-Desktop-styled Electron app (Lato). (A headless full-loop e2e test was scoped as F3
and DROPPED — see "Dropped: F3" below.)

**Architecture:** agent-runtime (Node ESM, spawns `claude` CLI + Docker jail) stays the
backend; the React/Vite cockpit stays the UI. F1/F2 are surgical runtime edits. F4 wraps
both in Electron (main process spawns the runtime child; renderer = the built cockpit). F3
adds a Docker+cli-gated end-to-end test. No architectural rewrite — additive only.

**Tech stack:** Node ESM, React/Vite, Electron + electron-builder (new), Docker jail, `claude` CLI.

**Global rules:** per-feature sub-plan first; TDD (`sp-test-driven-development`);
`sp-verification-before-completion` before "done"; security-sensitive paths →
`security-reviewer`; commit per GREEN; caveman chat / normal code.

**Verified code anchors (2026-06-21):** `MAX_INFLIGHT` decl `server.mjs:166` (already
`RUNTIME_MAX_INFLIGHT` env-overridable); shared inflight counter `inflight++` at `:793/:1126/:1196`,
slot helper `tryAcquireSlot()` `:843`; `cliReply` tool-scoping `:477`, `allowedToolsForAgent` `:501`,
`--strict-mcp-config` `:540/:551`, TOOLS default-`none` branch `:524`; **boss is MOCKED**
`server.mjs:371 (mockCeoReply)`; tokens/font live in **`src/index.css`** (NOT `src/styles/tokens.css`,
which does not exist); resolve route `POST /runtime/factory/resolve :1066`; chat `/runtime/:id/chat`,
run `/runtime/:id/run :1324`.

---

## Skill + Agent map (CLAUDE.md — MANDATORY, fire per phase)

Every phase: **task-0 = `sp-writing-plans`** (write the executable sub-plan), then
**`sp-subagent-driven-development`** to execute it, **`sp-test-driven-development`** for each
code step (RED→GREEN), **`sp-verification-before-completion`** before claiming done. Per-phase
specialists on top:

| Phase | Skills (fire first) | Agents (build/verify) | Why |
|---|---|---|---|
| **F1** scale ceiling | `sp-writing-plans` → `sp-test-driven-development` → `sp-verification-before-completion` | `performance-engineer` (concurrency design), `node-specialist` (impl), `security-reviewer` (fork-bomb/quota) | tune `MAX_INFLIGHT` default + dynamic backoff without breaking the safety throttle |
| **F2** CEO web | `sp-writing-plans` → `sp-test-driven-development` → `sp-verification-before-completion` | `claude-code-guide` (confirm `claude -p` WebSearch/WebFetch flags), `node-specialist` (impl), `security-reviewer` (egress) | grant web tools to boss/CEO only, outside the TOOLS=none gate |
| **F4** desktop | `sp-writing-plans` → `impeccable` (+ `frontend-design`) for the Docker-Desktop/Lato shell → `sp-test-driven-development` (supervisor units) → `webapp-testing` (visual verify) → `sp-verification-before-completion` | `electron-pro` (main/preload/supervisor/packaging), `security-reviewer` (Electron hardening: contextIsolation/CSP/token bridge) | wrap cockpit+runtime in Electron; preflight + packaged token/base wiring |

Rule: **never free-code a phase** — fire `sp-writing-plans` first to expand it into RED/GREEN
steps, then the agents above. Commit per GREEN; security-sensitive paths gate on `security-reviewer`.

---

## F1 — Scale ceiling: better default + dynamic concurrency  (~½ day)

**Goal:** `MAX_INFLIGHT` defaults to a hardcoded **4** (`server.mjs:166`). The env override
`RUNTIME_MAX_INFLIGHT` ALREADY exists — so the change is the DEFAULT (CPU/quota-derived) +
optional dynamic backoff, NOT adding the env.

**Assigned skills/agents:** `sp-writing-plans` (sub-plan), `performance-engineer`, `sp-test-driven-development`, `security-reviewer` (fork-bomb/quota intact).

**Sub-plan must cover (files: `server.mjs:166` + the `tryAcquireSlot` path `:843` + new `test/concurrency.test.mjs`):**
- Replace the `|| 4` literal with `computeMaxInflight()` = `RUNTIME_MAX_INFLIGHT` if set, else `clamp(os.cpus().length - 1, 2, 12)`.
- KEEP unchanged: the single shared `inflight` counter (`:793/:843/:1126/:1196` et al. — also `:1235/:1371/:1510`; the sub-plan author must audit ALL inflight sites, not just these) and the quota-guard pre-gate (`:676`).
- Preserve the hard cap → busy returns 429 (fork-bomb guard).
- (Optional) dynamic: shrink effective cap when the quota window is near its limit; restore when idle.
- `security-reviewer` pass; suite green; commit.

**Exit Gate:** default cap CPU-derived, env override still wins, 429 still fires at cap, quota guard intact, tests green.

---

## F2 — CEO live web research  (~1–2 hr)

**Goal:** The CEO does LIVE web research. Grant `WebSearch`/`WebFetch` at spawn for the
boss/CEO thread ONLY.

**⚠️ Hard constraints (validation-flagged):**
- **Boss is MOCKED** (`server.mjs:371` → `mockCeoReply`). Web research only fires under
  `RUNTIME_BACKEND=cli` (real `claude`). F2 work + the live-check MUST set `RUNTIME_BACKEND=cli`;
  under mock, web tools are never exercised.
- **Tool-gate placement:** `cliReply` defaults `TOOLS="none"` → the `none` branch (`:524`) adds
  NO `--allowed-tools`. The boss web-tool append MUST sit **independent of / after** that mode
  branch (an unconditional "if agentId ∈ web-set, append WebSearch/WebFetch"), else the default
  config strips it.

**Assigned skills/agents:** `sp-writing-plans`, `claude-code-guide` (confirm `-p` supports the tools + exact names), `sp-test-driven-development`, `security-reviewer` (egress).

**Sub-plan must cover (files: `agent-runtime/agent-tools.mjs` or `cliReply` in `server.mjs`, + `test/web-tools.test.mjs`):**
- Confirm `claude -p --allowed-tools WebSearch WebFetch` works headless; record exact tool names.
- `WEB_RESEARCH_AGENTS = new Set(["boss","ceo"])`; append the web tools to `args` for those ids, placed AFTER the TOOLS-mode branch so `none` can't strip them; keep `--strict-mcp-config` + existing scoping.
- Test: boss args include WebSearch/WebFetch; a non-CEO agent's args do NOT (scope-leak guard).
- `security-reviewer`: egress now reachable from the CEO turn — env already secret-stripped, CEO chat mode has no repo write; confirm no exfil combo. Mark smoke-test finding #1 resolved.
- Live check under `RUNTIME_BACKEND=cli`: CEO reply cites a real source. Commit.

**Exit Gate:** boss/CEO turn has WebSearch/WebFetch (verified in spawn args + a live cli reply); no other agent does; security clean.

---

## F4 — Desktop app (Electron, Docker-Desktop look, Lato)  (~1–1.5 day)

**Goal:** One double-click app. Native window, no terminals. Bundles the Vite cockpit +
auto-spawns the agent-runtime child. Restyled to look like **Docker Desktop**, **Lato** font.

### 🔴 HOST-DEPENDENCY GAP (validation-flagged — design this FIRST)
The runtime spawns the **`claude` CLI** + a **Docker jail**. A double-click app therefore still
needs, on the host: (1) `claude` on PATH + a logged-in subscription (or `ANTHROPIC_API_KEY`),
(2) the **Docker daemon running** (for `/exec`). The app CANNOT silently assume these.
**Required in the sub-plan:**
- A **preflight check** on launch: detect `claude` on PATH, `docker info` ok, and auth presence
  → if any missing, show a friendly setup screen (not a crash), with what to install.
- **Scope statement:** Tier-1 desktop = **dev-machine only** (deps present). Bundling
  claude/Docker into the app is out of scope. Document this explicitly.
- Chat works without Docker (Docker only gates `/exec`); preflight should degrade gracefully
  (warn, not block) when Docker is down but `claude` is present.

### 🟡 PACKAGED-MODE WIRING — TWO breaks, not one (validation-flagged)
Dev relies on the vite server for two things that VANISH in a packaged app (loads
`dist/index.html`, no vite). Both must be handled or chat is dead in the built app:

**(a) Runtime base URL.** Dev: vite proxies `/runtime/*` → `:3005` (`vite.config.ts:519-526`);
client calls relative `/runtime/...` (`App.tsx:100`, `ChatPane.tsx`). Packaged: no proxy →
those 404. Fix: client reads a runtime base (dev → relative; packaged → `http://127.0.0.1:3005`)
from a build flag / injected global.

**(b) 🟠 Auth token (the blocker).** Client fetches the runtime token from `/api/runtime-token`
(`runtimeToken.ts` / `BossConsole.tsx:20`), served by a **vite DEV-ONLY middleware**
(`serve-runtime-token`, `vite.config.ts:459-494`). Packaged → that route 404s → no
`x-runtime-token` → **every `/runtime/*` returns 401 → chat dead.** Fix: Electron main/supervisor
reads the runtime token FILE (`RUNTIME_TOKEN_DIR/.runtime-token`) and exposes it to the renderer
via `contextBridge` (preload); the client's token-fetch switches from `/api/runtime-token` (dev)
to the bridge (packaged). Ties into F4.2 (supervisor knows the token dir) + `preload.js`.

### Design direction — "Docker Desktop" (skills: `impeccable` + `frontend-design`)
- **Font:** `Lato` (Google Fonts; bundle locally for offline), weights 400/700. Set
  `--font-sans: "Lato", system-ui, sans-serif` in **`src/index.css`** (the real tokens/font file —
  NOT `src/styles/tokens.css`). Add the Lato `@font-face`/preload in `index.html`.
- **Layout:** left **icon rail** (whale-blue) + section list; thin custom title bar (frameless,
  mac traffic-light inset); main content; bottom **status strip** (runtime up? Docker? quota — like
  Docker's bottom bar).
- **Palette:** Docker light — white/`#f8fafc` surfaces, `#1d63ed` (Docker blue) primary, slate
  text, flat 0.5px borders, minimal shadow. Keep a dark variant.

**Assigned skills/agents:** `sp-writing-plans`, `electron-pro` (main process, supervisor, packaging), `impeccable`/`frontend-design` (Docker look + Lato), `sp-test-driven-development` (supervisor units), `security-reviewer` (Electron hardening).

**Sub-plan files (to CREATE unless noted):** `electron/main.js`, `electron/preload.js`,
`electron/runtime-supervisor.js`, `electron/preflight.js`, `electron-builder.yml`; MODIFY
`package.json` (deps + `electron:dev`/`electron:build`), **`src/index.css`** (Lato + Docker palette),
`index.html` (Lato), shell components (`src/App.tsx` + rail/statusbar) + the client runtime-base switch.

**Sub-plan must cover:**
- `electron/main.js` + `preload.js`: frameless `BrowserWindow`, `contextIsolation:true`,
  `nodeIntegration:false`, dev→`http://localhost:3004`, prod→`dist/index.html`.
- `runtime-supervisor.js`: spawn `node agent-runtime/server.mjs` with `RUNTIME_*` env, wait
  `/runtime/health`, restart on crash, SIGTERM on quit. Unit-test spawn/health/kill (mock spawn).
- `preflight.js`: the 🔴 dep checks above → setup screen.
- 🟡 Packaged wiring (BOTH): (a) renderer runtime-base switch (relative dev / `127.0.0.1:3005`
  packaged); (b) token bridge — preload exposes the `.runtime-token` (read by main from
  `RUNTIME_TOKEN_DIR`) via `contextBridge`; client token-fetch switches off `/api/runtime-token`
  in packaged mode. WITHOUT (b) the built app 401s on every call.
- Lato + Docker shell (`src/index.css` + components) — visual-verify.
- `electron-builder.yml`: app id `com.missionalpha.app`, mac `dmg` + win `nsis`, icon,
  `extraResources` shipping the runtime + `.claude/agents`.
- `security-reviewer`: contextIsolation on, no remote module, CSP, renderer can't hijack the child.
- `electron:build` → `.dmg`; launch; preflight + cockpit + runtime auto-start + a chat; screenshot.

**Exit Gate:** double-click app opens MissionAlpha (Docker look, Lato); preflight detects
missing `claude`/Docker with a friendly screen; runtime auto-starts; **chat works in the PACKAGED
build — token bridge live (no 401) + runtime base resolved** (not just in dev); Docker-down
degrades gracefully; Electron security review clean; scope documented as dev-machine Tier-1.

---

## Dropped: F3 — Full-loop headless end-to-end test  (DECISION 2026-06-21)

A headless test driving CEO→approve→architect→lead→agents→QA→review unattended was scoped,
then **dropped**. Rationale (decision record, not a TODO):

1. **Can't run in CI** — needs the real `claude` subscription + Docker + minutes + real tokens;
   CI has none. So it would be a *manual-only* test → its main value (automated regression) is gone.
2. **Flaky / low-signal** — real `claude` output is non-deterministic; asserts can only be loose
   ("≥1 agent wrote a file"), catching little while breaking often = maintenance tax.
3. **Expensive per run** — burns subscription + minutes each time → won't be run often → rots.
4. **Already covered where it counts** — 259 unit tests on the deterministic logic (guards, router,
   gap-detector, exec gate) + both ends proven live (Phase 0 smoke + Phase 3 demo). The untested
   "middle" is mostly **prose orchestration** (agents following `.md` rules) — hard to assert
   meaningfully and the least likely thing a unit test wouldn't already catch.

**Substitute (lightweight, 0 maintenance):** after any change to the orchestration layer
(CEO/architect/lead/dispatch `.md` or the dispatch wiring), run the **bill-splitter goal through
the UI once** and watch it (≈2 min) — the Phase-0 smoke, done by hand. ~90% of the value, no flaky
CI, no token burn.

**Revisit F3 only if:** the project gains multiple contributors, OR the dispatch layer starts
getting heavily refactored (then an automated net earns its keep).

---

## SEQUENCE
```
F1 (cap) → F2 (CEO web) → F4 (desktop)
```
F1/F2 quick wins; F4 the visible one. (F3 dropped — see above.)

## Self-review (post-validation)
- Scope: **3 features (F1, F2, F4)**. F3 dropped with a recorded rationale + a manual-smoke substitute.
- Header honest: SPEC + per-feature sub-plans (each Fx task-0 = write its executable sub-plan). Not falsely claiming line-executable.
- Code anchors verified + corrected (index.css, MAX_INFLIGHT:166 already-env, /runtime/factory/resolve, boss-mock).
- Design gaps promoted to explicit tasks: F4 host preflight + dev-only scope + renderer URL; F2 cli-backend + tool-gate placement.
- `Architecture:` label added. Security gates on F1 (fork-bomb), F2 (egress), F4 (Electron).

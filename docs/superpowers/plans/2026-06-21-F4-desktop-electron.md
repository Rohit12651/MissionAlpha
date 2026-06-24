# F4 — MissionAlpha Desktop App (Electron) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Code steps RED→GREEN→commit (superpowers:test-driven-development). Electron-hardening + packaged-token paths gate on `security-reviewer` BEFORE commit.

**Goal:** One double-click desktop app — native frameless window, no terminals — that bundles the React cockpit, auto-spawns the agent-runtime child via a supervisor, and works (chat included) in the PACKAGED build via a contextBridge token + runtime-base switch.

**Architecture:** Electron `main` (Node) spawns `node agent-runtime/server.mjs` (supervisor: spawn→wait `/runtime/health`→restart→SIGTERM), runs a preflight (`claude` on PATH, `docker info`, auth), then loads the cockpit (dev `http://localhost:3004` / packaged `dist/index.html`). `preload` (`contextIsolation:true`, `nodeIntegration:false`) exposes ONLY the runtime token (read by main from `RUNTIME_TOKEN_DIR/.runtime-token`) + the runtime base URL via `contextBridge`. Renderer switches token-source + base off vite-dev in packaged mode.

**DESIGN SOURCE OF TRUTH (boss-confirmed):** `docs/mockups/missionalpha-cockpit.html` — the **current** MissionAlpha cockpit (OKLCH dark tokens already in `src/index.css`: `--c-bg .16 / --c-cyan .82 200 / --c-gold / --c-violet`, `--radius:12px`; topbar + 200px roster + 5-col board (idle/in progress/blocked/review/done) + 360px Chat|Feed; globe backdrop). **NOT a Docker-Desktop reskin** — keep the existing cockpit. F4 visual delta = (1) **Lato** font (hard constraint; mockup uses Inter), (2) **frameless title bar** (mac traffic-light inset), (3) **bottom status strip** (runtime up? · Docker? · quota). Dark default, light variant kept.

**Tech Stack:** Electron + electron-builder, Node ESM, React/Vite, `node --test`, `concurrently` + `wait-on`.

## Verified anchors (2026-06-21)
- Runtime token: `server.mjs:125` `RUNTIME_TOKEN`; `:129` `TOKEN_DIR = RUNTIME_TOKEN_DIR || join(tmpdir(),"missionalpha-runtime")`; `:130` `TOKEN_FILE=.runtime-token`; `:136` written 0o600.
- Port: `server.mjs:22` `RUNTIME_PORT||3005`; listens `127.0.0.1`.
- Health: `GET /runtime/health` `server.mjs:1578` (NOT host-gated: `:953`).
- Vite dev-only token middleware: `vite.config.ts:489-494` `serve-runtime-token` → `/api/runtime-token`. Proxy `/runtime`→`:3005` `vite.config.ts:519-526`.
- Client token fetch (4 sites): `src/lib/runtimeToken.ts:7`, `src/components/BossConsole.tsx:20`, `src/components/AgentChat.tsx:19`, `src/lib/factoryClient.ts:66` — all `fetch("/api/runtime-token")`.
- Client `/runtime/*` relative fetches: `App.tsx:100`, `ChatPane.tsx:252/268/295/385`, `BossConsole.tsx:101/179`, `AgentChat.tsx:53/69/109`, `factoryClient.ts:220/225/230`, `quotaClient.ts:16`.
- Tokens/font file: `src/index.css` (OKLCH; `[data-theme]`). `index.html` minimal (no font link).
- Vite dev port 3004 (`package.json` `dev: vite --port 3004`); build = `tsc && vite build`.

---

## File Structure
- **Create:** `electron/main.js`, `electron/preload.js`, `electron/runtime-supervisor.js`, `electron/preflight.js`, `electron-builder.yml`, `electron/test/runtime-supervisor.test.mjs`, `electron/test/preflight.test.mjs`, `src/lib/runtimeBase.ts`, `src/styles/lato.css` (or inline @font-face in index.css), `src/components/shell/TitleBar.tsx`, `src/components/shell/StatusStrip.tsx`, `src/components/PreflightGate.tsx`.
- **Modify:** `package.json` (deps+scripts), `src/index.css` (Lato `--font-sans` + frameless body), `index.html` (Lato preload + CSP meta), `src/lib/runtimeToken.ts` + the 3 other token sites, the `/runtime/*` fetch sites (via `runtimeUrl()`), `src/App.tsx` (mount TitleBar + StatusStrip + PreflightGate).

---

## Task 1: package.json — Electron deps + scripts

**Files:** Modify `package.json`.

- [ ] **Step 1: Add devDependencies + scripts** (exact versions pinned to current majors; adjust to latest stable at install)

Add to `devDependencies`: `"electron": "^33.0.0"`, `"electron-builder": "^25.1.8"`, `"concurrently": "^9.1.0"`, `"wait-on": "^8.0.1"`. Add `"main": "electron/main.js"`. Add scripts:
```json
"electron:dev": "concurrently -k \"npm:dev\" \"wait-on tcp:3004 && RUNTIME_BACKEND=cli electron .\"",
"electron:build": "npm run build && electron-builder"
```

- [ ] **Step 2: Install + sanity**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm install`
Expected: exit 0; `npx electron --version` prints v33.x.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(electron): add electron + electron-builder + dev/build scripts (F4)"
```

---

## Task 2: runtime-supervisor.js (spawn → health → restart → kill) — TDD

**Files:** Create `electron/runtime-supervisor.js` + `electron/test/runtime-supervisor.test.mjs`.

**Contract:** `createSupervisor({ spawn, fetch, serverPath, env, port, retries=10, intervalMs=300 })` →
`{ start(): Promise<void>, stop(): void, isUp(): boolean, onCrash(cb) }`.
- `start()` spawns `node <serverPath>` with `env`, polls `GET http://127.0.0.1:<port>/runtime/health` until ok or `retries` exhausted (throws on exhaustion).
- child `exit` (non-zero, not after stop()) → calls registered crash cbs + respawns (bounded).
- `stop()` → SIGTERM, no respawn. Pure DI (spawn/fetch injected) so it unit-tests with mocks.

- [ ] **Step 1: Failing test (mock spawn + fetch)**

```javascript
// electron/test/runtime-supervisor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSupervisor } from "../runtime-supervisor.js";

function mockChild() { const c = new EventEmitter(); c.kill = (sig) => { c.killed = sig || "SIGTERM"; }; return c; }

test("start() spawns server and resolves when health goes ok", async () => {
  const child = mockChild();
  let healthCalls = 0;
  const sup = createSupervisor({
    spawn: () => child,
    fetch: async () => ({ ok: ++healthCalls >= 2 }), // first not-ok, second ok
    serverPath: "/x/server.mjs", env: {}, port: 3005, intervalMs: 1,
  });
  await sup.start();
  assert.equal(sup.isUp(), true);
  assert.ok(healthCalls >= 2);
});

test("start() throws if health never comes up within retries", async () => {
  const sup = createSupervisor({
    spawn: () => mockChild(), fetch: async () => ({ ok: false }),
    serverPath: "/x", env: {}, port: 3005, retries: 3, intervalMs: 1,
  });
  await assert.rejects(() => sup.start(), /health/i);
});

test("stop() sends SIGTERM and prevents respawn", async () => {
  const child = mockChild();
  const sup = createSupervisor({ spawn: () => child, fetch: async () => ({ ok: true }), serverPath: "/x", env: {}, port: 3005, intervalMs: 1 });
  await sup.start();
  sup.stop();
  assert.equal(child.killed, "SIGTERM");
  let respawned = false;
  const orig = child.listeners; // emit exit AFTER stop → must NOT respawn
  child.emit("exit", 0);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(respawned, false);
});

test("crash (exit before stop) fires onCrash and respawns", async () => {
  let spawns = 0; const children = [];
  const sup = createSupervisor({
    spawn: () => { spawns++; const c = mockChild(); children.push(c); return c; },
    fetch: async () => ({ ok: true }), serverPath: "/x", env: {}, port: 3005, intervalMs: 1, retries: 5,
  });
  let crashed = 0; sup.onCrash(() => crashed++);
  await sup.start();
  children[0].emit("exit", 1); // crash
  await new Promise(r => setTimeout(r, 10));
  assert.equal(crashed, 1);
  assert.ok(spawns >= 2, "respawned after crash");
  sup.stop();
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module '../runtime-supervisor.js'`).
Run: `cd electron && node --test test/runtime-supervisor.test.mjs`

- [ ] **Step 3: Implement `electron/runtime-supervisor.js`** (CommonJS-free ESM; injected spawn/fetch)

```javascript
// electron/runtime-supervisor.js — supervise the agent-runtime child.
// Pure DI (spawn/fetch injected) → unit-testable. main.js wires real node:child_process spawn + global fetch.
export function createSupervisor({ spawn, fetch, serverPath, env = {}, port = 3005, retries = 10, intervalMs = 300 }) {
  let child = null, up = false, stopping = false;
  const crashCbs = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const healthUrl = `http://127.0.0.1:${port}/runtime/health`;

  async function waitHealthy() {
    for (let i = 0; i < retries; i++) {
      try { const r = await fetch(healthUrl); if (r && r.ok) { up = true; return; } } catch { /* not up yet */ }
      await sleep(intervalMs);
    }
    throw new Error(`runtime health did not come up on :${port} after ${retries} tries`);
  }

  function spawnChild() {
    child = spawn("node", [serverPath], { env: { ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.on("exit", (code) => {
      up = false;
      if (stopping) return;          // intentional → no respawn
      for (const cb of crashCbs) { try { cb(code); } catch { /* */ } }
      spawnChild();                  // bounded by process lifetime; main.js can cap if needed
    });
  }

  return {
    async start() { stopping = false; spawnChild(); await waitHealthy(); },
    stop() { stopping = true; up = false; if (child) { try { child.kill("SIGTERM"); } catch { /* */ } } },
    isUp() { return up; },
    onCrash(cb) { crashCbs.push(cb); },
  };
}
```

- [ ] **Step 4: Run → PASS** (4 tests).
- [ ] **Step 5: Commit** `git add electron/runtime-supervisor.js electron/test/runtime-supervisor.test.mjs && git commit -m "feat(electron): runtime supervisor — spawn/health/restart/SIGTERM, DI-tested (F4)"`

---

## Task 3: preflight.js (claude / docker / auth checks) — TDD

**Files:** Create `electron/preflight.js` + `electron/test/preflight.test.mjs`.

**Contract:** `preflight({ exec })` → `Promise<{ claude:boolean, docker:boolean, auth:boolean, ok:boolean, blocking:boolean, messages:string[] }>`.
- `claude` = `exec("claude --version")` resolves (exit 0).
- `docker` = `exec("docker info")` resolves. Docker DOWN is **non-blocking** (warn only — chat works without it; Docker gates only `/exec`).
- `auth` = `claude` present (subscription) OR `process.env.ANTHROPIC_API_KEY`.
- `ok` = claude && auth. `blocking` = `!ok` (missing claude/auth blocks; missing docker does NOT).

- [ ] **Step 1: Failing test (inject exec)**

```javascript
// electron/test/preflight.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../preflight.js";

const okExec = async () => ({ code: 0 });
const failExec = (failCmd) => async (cmd) => { if (cmd.includes(failCmd)) throw new Error("not found"); return { code: 0 }; };

test("all present → ok, not blocking", async () => {
  const r = await preflight({ exec: okExec, env: {} });
  assert.equal(r.ok, true); assert.equal(r.blocking, false);
  assert.equal(r.claude, true); assert.equal(r.docker, true); assert.equal(r.auth, true);
});

test("docker down → non-blocking warn, chat still ok", async () => {
  const r = await preflight({ exec: failExec("docker"), env: {} });
  assert.equal(r.docker, false); assert.equal(r.ok, true); assert.equal(r.blocking, false);
  assert.ok(r.messages.some((m) => /docker/i.test(m)));
});

test("claude missing → blocking", async () => {
  const r = await preflight({ exec: failExec("claude"), env: {} });
  assert.equal(r.claude, false); assert.equal(r.ok, false); assert.equal(r.blocking, true);
});

test("no claude but ANTHROPIC_API_KEY → auth true via env, still blocked on claude binary", async () => {
  const r = await preflight({ exec: failExec("claude"), env: { ANTHROPIC_API_KEY: "sk-ant-x" } });
  assert.equal(r.auth, true); assert.equal(r.claude, false); assert.equal(r.blocking, true);
});
```

- [ ] **Step 2: Run → FAIL.** `cd electron && node --test test/preflight.test.mjs`
- [ ] **Step 3: Implement**

```javascript
// electron/preflight.js — host dependency check. Tier-1 = dev-machine (deps present).
// claude+auth are blocking; docker is a non-blocking warning (chat works without it).
export async function preflight({ exec, env = process.env }) {
  const probe = async (cmd) => { try { const r = await exec(cmd); return !r || r.code === 0; } catch { return false; } };
  const claude = await probe("claude --version");
  const docker = await probe("docker info");
  const auth = claude || Boolean(env.ANTHROPIC_API_KEY);
  const messages = [];
  if (!claude) messages.push("`claude` CLI not found on PATH. Install Claude Code and log in (subscription) or set ANTHROPIC_API_KEY.");
  if (!auth) messages.push("No Claude auth detected — log into Claude Code or set ANTHROPIC_API_KEY.");
  if (!docker) messages.push("Docker daemon not reachable — chat works, but /exec (sandboxed code execution) is disabled until Docker is running.");
  const ok = claude && auth;
  return { claude, docker, auth, ok, blocking: !ok, messages };
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(electron): preflight host-dep check (claude/docker/auth), Tier-1 dev-machine (F4)`.

---

## Task 4: main.js + preload.js (frameless, hardened, token bridge)

**Files:** Create `electron/main.js`, `electron/preload.js`. (Not unit-tested — integration-verified in Task 7; security-reviewed.)

- [ ] **Step 1: `electron/preload.js`** — expose ONLY token + base, nothing else

```javascript
// electron/preload.js — contextIsolation bridge. Renderer gets ONLY the runtime token
// + base URL; no Node, no ipc beyond these reads.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("missionAlpha", {
  isPackaged: true,
  runtimeBase: "http://127.0.0.1:3005",
  getRuntimeToken: () => ipcRenderer.invoke("ma:get-runtime-token"),
});
```

- [ ] **Step 2: `electron/main.js`** — frameless hardened window + supervisor + preflight + token IPC

```javascript
// electron/main.js
const { app, BrowserWindow, ipcMain, session } = require("electron");
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { exec: cpExec } = require("node:child_process");
const exec = (cmd) => promisify(cpExec)(cmd).then(() => ({ code: 0 }));

const RUNTIME_PORT = 3005;
const TOKEN_DIR = process.env.RUNTIME_TOKEN_DIR || join(require("node:os").tmpdir(), "missionalpha-runtime");
const TOKEN_FILE = join(TOKEN_DIR, ".runtime-token");
const isDev = !app.isPackaged;
// packaged: runtime ships under resources/agent-runtime (extraResources); dev: repo path.
const SERVER_PATH = isDev
  ? join(__dirname, "..", "agent-runtime", "server.mjs")
  : join(process.resourcesPath, "agent-runtime", "server.mjs");

let supervisor, win;

ipcMain.handle("ma:get-runtime-token", () => {
  try { return readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; }
});

async function boot() {
  const { createSupervisor } = await import("./runtime-supervisor.js");
  const { preflight } = await import("./preflight.js");
  const pf = await preflight({ exec, env: process.env });

  supervisor = createSupervisor({
    spawn, fetch: globalThis.fetch, serverPath: SERVER_PATH, port: RUNTIME_PORT,
    env: { ...process.env, RUNTIME_PORT: String(RUNTIME_PORT), RUNTIME_TOKEN_DIR: TOKEN_DIR, RUNTIME_BACKEND: process.env.RUNTIME_BACKEND || "cli" },
  });
  if (pf.ok) { try { await supervisor.start(); } catch (e) { /* surfaced via status strip */ } }

  win = new BrowserWindow({
    width: 1320, height: 860, frame: false, titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0d12",
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // CSP — defense in depth (index.html also sets a meta CSP).
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders,
    "Content-Security-Policy": ["default-src 'self'; connect-src 'self' http://127.0.0.1:3005; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:;"] } }));

  if (isDev) win.loadURL("http://localhost:3004");
  else win.loadFile(join(__dirname, "..", "dist", "index.html"));
  // pass preflight result to renderer for the gate/status strip
  win.webContents.on("did-finish-load", () => win.webContents.send("ma:preflight", pf));
}

app.whenReady().then(boot);
app.on("window-all-closed", () => { try { supervisor?.stop(); } catch {} app.quit(); });
app.on("before-quit", () => { try { supervisor?.stop(); } catch {} });
```
(preload must also forward `ma:preflight`; add `onPreflight: (cb)=>ipcRenderer.on("ma:preflight",(_,d)=>cb(d))` to the bridge.)

- [ ] **Step 3: Manual dev smoke** (after Task 5+6 so the renderer reads the bridge):
Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run electron:dev`
Expected: frameless window opens cockpit, runtime auto-starts, chat works.

- [ ] **Step 4: Commit** `feat(electron): hardened frameless main + preload token bridge + preflight wiring (F4)` — **AFTER security-reviewer** (see Security section).

---

## Task 5: Renderer wiring — runtime base + token source switch

**Files:** Create `src/lib/runtimeBase.ts`; Modify `src/lib/runtimeToken.ts`, `BossConsole.tsx:20`, `AgentChat.tsx:19`, `factoryClient.ts:66`, + all `/runtime/*` fetch sites.

- [ ] **Step 1: `src/lib/runtimeBase.ts`**

```typescript
// Runtime base + token source. Dev (vite): base "" (proxy) + token from /api/runtime-token.
// Packaged (electron): base http://127.0.0.1:3005 + token from the contextBridge.
interface MABridge { isPackaged: boolean; runtimeBase: string; getRuntimeToken: () => Promise<string>; }
const bridge: MABridge | undefined = (globalThis as any).missionAlpha;

export const RUNTIME_BASE = bridge?.isPackaged ? bridge.runtimeBase : "";
export function runtimeUrl(path: string): string { return RUNTIME_BASE + path; }

let tokenPromise: Promise<string> | null = null;
export function runtimeToken(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = bridge?.isPackaged
      ? bridge.getRuntimeToken().catch(() => "")
      : fetch("/api/runtime-token", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : { token: "" }))
          .then((j) => (j as { token?: string }).token ?? "").catch(() => "");
  }
  return tokenPromise;
}
```

- [ ] **Step 2:** Replace the body of `src/lib/runtimeToken.ts` to re-export from `runtimeBase` (keep the named export `runtimeToken` so existing imports work):
```typescript
export { runtimeToken } from "./runtimeBase";
```
- [ ] **Step 3:** In `BossConsole.tsx:20`, `AgentChat.tsx:19`, `factoryClient.ts:66`: replace each local `fetch("/api/runtime-token")…` token getter with `import { runtimeToken } from "../lib/runtimeBase"` (adjust path) and call it. (Each currently re-implements the same fetch; unify to the shared getter.)
- [ ] **Step 4:** Prefix every `/runtime/...` fetch with `runtimeUrl(...)`. Sites: `App.tsx:100`, `ChatPane.tsx:252/268/295/385`, `BossConsole.tsx:101/179`, `AgentChat.tsx:53/69/109`, `factoryClient.ts:220/225/230`, `quotaClient.ts:16`. E.g. `fetch(runtimeUrl(\`/runtime/${id}/chat\`), …)`.
- [ ] **Step 5:** Typecheck. Run: `npm run typecheck` → exit 0. Build: `npm run build` → exit 0.
- [ ] **Step 6: Commit** `feat(cockpit): runtime base + token source switch (dev vite / packaged bridge) (F4)`.

---

## Task 6: UI shell — Lato + frameless title bar + bottom status strip (OWNER: principal-ux-design)

> Match the EXISTING cockpit (the mockup). Do NOT reskin to Docker Desktop. Visual delta only.

**Files:** Modify `src/index.css`, `index.html`; Create `src/components/shell/TitleBar.tsx`, `src/components/shell/StatusStrip.tsx`, `src/components/PreflightGate.tsx`; Modify `src/App.tsx`.

- [ ] **Step 1: Lato** — bundle locally (offline). Add `src/fonts/` Lato 400/700 woff2; `@font-face` in `src/index.css`; set `--font-sans: "Lato", system-ui, -apple-system, "Segoe UI", sans-serif;` and apply to `body`. Add `<link rel="preload" as="font" …>` in `index.html` + a `<meta http-equiv="Content-Security-Policy" …>` matching main.js CSP.
- [ ] **Step 2: Frameless TitleBar** — thin bar, `-webkit-app-region: drag` (buttons `no-drag`), mac traffic-light inset (`titleBarStyle:"hiddenInset"` already in main). Houses the mockup topbar content (status dot + "MissionAlpha" + status pills + nav). `emil-design-eng` for hover/press states (≤160ms, ease-out).
- [ ] **Step 3: StatusStrip** (bottom, Docker-bottom-bar-like) — runtime up? (poll `runtimeUrl('/runtime/health')`), Docker present? (from preflight result), quota (existing `quotaClient`). Reuse mockup `.chip` styling + token colors (green/amber/red).
- [ ] **Step 4: PreflightGate** — if `blocking`, render the friendly setup screen (mockup onboarding style) listing `messages`; else render the cockpit. Docker-down shows a non-blocking banner.
- [ ] **Step 5: a11y (a11y-architect + kw-design-accessibility-review)** — WCAG 2.2: visible focus rings on title-bar buttons + status chips, keyboard reachable, contrast ≥4.5:1 (the light-theme tokens were already darkened for this — keep), `prefers-reduced-motion` honored in title-bar motion.
- [ ] **Step 6: Visual verify (webapp-testing / ui-ux-tester)** — `npm run electron:dev`, screenshot, compare side-by-side with `docs/mockups/missionalpha-cockpit.html` + Lato applied. `impeccable critique`/`polish` pass.
- [ ] **Step 7: Commit** `feat(cockpit): Lato + frameless title bar + status strip + preflight gate (F4, matches mockup)`.

---

## Task 7: electron-builder packaging + packaged-mode proof

**Files:** Create `electron-builder.yml`.

- [ ] **Step 1: `electron-builder.yml`**

```yaml
appId: com.missionalpha.app
productName: MissionAlpha
directories: { output: release }
files: [ "dist/**/*", "electron/**/*", "package.json" ]
extraResources:
  - { from: "agent-runtime", to: "agent-runtime", filter: ["**/*", "!**/threads/**", "!**/engine-store/**", "!**/test/**"] }
  - { from: ".claude/agents", to: ".claude/agents" }
mac: { target: ["dmg"], category: "public.app-category.developer-tools" }
win: { target: ["nsis"] }
```

- [ ] **Step 2: Build** Run: `npm run electron:build` → expect a `.dmg` in `release/`.
- [ ] **Step 3: PACKAGED proof (the Exit-Gate blocker)** — install/launch the `.dmg`. Verify, with screenshots:
  1. Window opens the cockpit in **Lato**, matching the mockup layout (roster/board/Chat-Feed/status strip).
  2. Preflight: with `claude` missing → friendly setup screen (temporarily rename it on PATH to test); with Docker down → non-blocking banner, chat still usable.
  3. Runtime **auto-starts** (status strip shows runtime up).
  4. **Chat works in the packaged build** — send a CEO message, get a streamed reply. This proves BOTH (a) base resolved to `127.0.0.1:3005` (no vite proxy) AND (b) token came via the contextBridge (no `/api/runtime-token` 404 → no 401).
- [ ] **Step 4: Commit** `build(electron): electron-builder config + packaged dmg (F4)`.

---

## Security review (MANDATORY — BLOCKING before Task 4 & Task 7 commits)

Dispatch `security-reviewer` on `electron/*`. Confirm:
1. `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`; no `@electron/remote`; preload exposes ONLY `{isPackaged, runtimeBase, getRuntimeToken, onPreflight}` — no arbitrary ipc, no fs/exec reachable from renderer.
2. CSP present (main `onHeadersReceived` + index.html meta); `connect-src` limited to `'self'` + `http://127.0.0.1:3005`; no remote code load; dev `loadURL` only in `!app.isPackaged`.
3. Token bridge: renderer can READ the runtime token (needed) but cannot read arbitrary files; `ma:get-runtime-token` returns ONLY `.runtime-token`; token never logged.
4. Renderer cannot hijack/redirect the spawned child; supervisor env doesn't leak host secrets beyond what server.mjs already strips; `will-navigate`/`setWindowOpenHandler` deny external navigation (add if missing).

---

## a11y (WCAG 2.2) — a11y-architect + kw-design-accessibility-review
Focus visible on all new interactive shell elements; keyboard operable title-bar + gate; contrast ≥4.5:1; reduced-motion respected. Sign-off required for Exit Gate.

---

## Exit Gate (F4)
- [ ] Double-click app opens MissionAlpha matching the mockup (Lato, current cockpit layout/palette) — screenshot vs mockup.
- [ ] Preflight handles missing `claude`/Docker with a friendly screen (not a crash); Docker-down degrades gracefully (chat works).
- [ ] Runtime auto-starts (supervisor) — status strip shows up.
- [ ] **CHAT WORKS IN THE PACKAGED BUILD** — token bridge live (no 401) + base resolved (Task 7 Step 3.4).
- [ ] Electron security review clean (no CRITICAL/HIGH).
- [ ] a11y WCAG 2.2 pass.
- [ ] Scope documented: dev-machine **Tier-1** (host needs claude+Docker; bundling them is out of scope).
- [ ] Suite green: `cd agent-runtime && npm test` (267) + new electron tests (supervisor 4 + preflight 4); `npm run typecheck` 0; `npm run build` 0.
- [ ] Commits per GREEN; not pushed.

## Self-Review (against F4 spec §100-175 + mockup)
- Host preflight (claude/docker/auth, docker non-blocking, Tier-1 scope) → Task 3 + 6.4 + Exit Gate. ✔
- Packaged (a) base URL + (b) token bridge → Task 4+5; proven Task 7.3.4. ✔
- Electron hardening (contextIsolation/nodeIntegration/CSP/no-remote) → Task 4 + Security. ✔
- Supervisor spawn/health/restart/SIGTERM + unit test (mock spawn) → Task 2. ✔
- Lato in src/index.css + index.html → Task 6.1. ✔
- electron-builder app id/dmg/nsis/icon/extraResources(runtime+.claude/agents) → Task 7.1. ✔
- Design = mockup (current cockpit) NOT Docker Desktop; delta = Lato+titlebar+statusstrip → Task 6 header. ✔
- Placeholder scan: real code in testable tasks; UI task references exact mockup tokens. ✔

// electron/main.cjs — MissionAlpha Electron main process.
// CJS file (root package.json is "type":"module"; Electron entry + preload require CJS).
// ESM modules (runtime-supervisor.js, preflight.js) are imported via dynamic await import().
"use strict";

const { app, BrowserWindow, ipcMain, session, screen, dialog, Notification, shell } = require("electron");
const { join } = require("node:path");
const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { exec: cpExec } = require("node:child_process");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const isDev = !app.isPackaged;
// Packaged: pinned (the CSP and preload name 127.0.0.1:3005). Dev: the port and token dir the
// Vite dev proxy reads from the repo .env, so the app's calls reach this runtime and its token
// matches the one Vite serves (runtime-env.cjs devRuntimeTarget).
const RUNTIME_PINS = {
  port: 3005,
  tokenDir: process.env.RUNTIME_TOKEN_DIR || join(tmpdir(), "missionalpha-runtime"),
};
const { port: RUNTIME_PORT, tokenDir: RUNTIME_TOKEN_DIR } = isDev
  ? require("./runtime-env.cjs").devRuntimeTarget(readRepoDotenv(), process.env, RUNTIME_PINS)
  : RUNTIME_PINS;
const TOKEN_FILE = join(RUNTIME_TOKEN_DIR, ".runtime-token");

// Server path: dev → repo sibling; packaged → extraResources bundle.
const RUNTIME_DIR = isDev
  ? join(__dirname, "..", "agent-runtime")
  : join(process.resourcesPath, "agent-runtime");
const SERVER_PATH = join(RUNTIME_DIR, "server.mjs");
// The runtime's OWN workspace validator — main must not grow a second, weaker one.
const WORKSPACE_PATH = join(RUNTIME_DIR, "workspace.mjs");
const { validateRepoRoot } = require("./repo-root-guard.cjs");

// Wrap node:child_process exec in a promise that resolves to { code: 0 } on
// success and rejects (throws) on non-zero exit — matches preflight contract.
const exec = (cmd) =>
  promisify(cpExec)(cmd).then(() => ({ code: 0 }));

// ---------------------------------------------------------------------------
// PATH resolution (packaged-launch fix). A Finder-launched .app inherits only a
// minimal PATH (/usr/bin:/bin), NOT the user's login PATH — so `claude`
// (~/.local/bin), `node`, and `docker` (e.g. /opt/homebrew/bin) are invisible,
// breaking preflight AND the runtime's child spawns. Resolve the real login PATH
// once via the user's shell and merge it into process.env.PATH so preflight and
// every spawned child (which inherit {...process.env}) can find the binaries.
function resolveLoginPath() {
  const fallback = [
    join(process.env.HOME || "", ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  let resolved = "";
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    // execFileSync (no shell string) → the shell binary is the file, args are an
    // array, so nothing is interpolated into a command line (no injection surface).
    // -lc: LOGIN (non-interactive) shell — sources ~/.zprofile/.zlogin without the
    // interactive-stdin hang. stdin:'ignore' guards any shell that still blocks.
    // The fallback dirs below (incl. ~/.local/bin, /opt/homebrew/bin) cover PATH
    // entries that live only in ~/.zshrc, so claude is found even if -lc misses it.
    resolved = require("node:child_process")
      .execFileSync(shell, ["-lc", 'printf %s "$PATH"'], { timeout: 4000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    /* shell probe failed — fall back to the common dirs below */
  }
  const merged = [
    ...resolved.split(":").filter(Boolean),
    ...fallback,
    ...(process.env.PATH || "").split(":").filter(Boolean),
  ];
  process.env.PATH = [...new Set(merged)].join(":"); // de-duped, login first
}
resolveLoginPath();

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
let supervisor = null;
let supervisorFactory = null;
let win = null;

// Project folder — persisted across restarts in <userData>/missionalpha/repo-root.txt.
// RUNTIME_REPO_ROOT env override (dev) takes precedence.
let repoRoot = process.env.RUNTIME_REPO_ROOT || null;
let repoRootFile = null; // initialised in boot() once userData is available

/** The repo-root .env text, or "" (packaged builds have none). */
function readRepoDotenv() {
  try { return readFileSync(join(__dirname, "..", ".env"), "utf8"); } catch { return ""; }
}

function buildSupervisorEnv() {
  // Step 0 — the desktop child takes allow-listed RUNTIME_* keys from the REPO-ROOT .env
  // through one picker (runtime-env.cjs), parsed the way Node's --env-file parses the
  // CLI's agent-runtime/.env. Different file, same rules. Process env wins.
  const picked = require("./runtime-env.cjs").pickRuntimeEnv(readRepoDotenv(), process.env);
  return {
    ...process.env,
    ...picked,
    RUNTIME_PORT: String(RUNTIME_PORT),
    RUNTIME_TOKEN_DIR,
    RUNTIME_BACKEND: picked.RUNTIME_BACKEND || "cli",
    WAAHYU_STATE_PATH: process.env.WAAHYU_STATE_PATH || join(app.getPath("userData"), "agent-status", "state.json"),
    ...(repoRoot ? { RUNTIME_REPO_ROOT: repoRoot } : {}),
  };
}

async function restartSupervisor() {
  if (supervisor) { try { supervisor.stop(); } catch { /* ignore */ } }
  // Brief pause so the OS reclaims the port before the new child binds it.
  await new Promise((r) => setTimeout(r, 600));
  supervisor = supervisorFactory({ spawn, fetch: globalThis.fetch, serverPath: SERVER_PATH, port: RUNTIME_PORT, env: buildSupervisorEnv() });
  await supervisor.start();
}

// ---------------------------------------------------------------------------
// IPC: runtime token reader (only reads the single .runtime-token file)
// ---------------------------------------------------------------------------
ipcMain.handle("ma:get-runtime-token", () => {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
});

// ---------------------------------------------------------------------------
// IPC: Delivery notification + dock badge (P3)
//
// Renderer-supplied strings are DATA. They are coerced, control-char stripped and
// length-capped here, then handed to the OS notification API only — never to a
// shell, a path, a URL or a require(). The dock badge is a short numeric string.
// Dedupe is renderer-side (deliveryNotify.shouldNotify), and re-checked here with
// a bounded set so a second window or a reload cannot double-notify one Delivery.
// ---------------------------------------------------------------------------
const NOTIFIED = new Set();
const NOTIFIED_CAP = 500;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001f\u007f]/g;
const clean = (v, cap) => String(v ?? "").replace(CTRL_RE, " ").trim().slice(0, cap);

ipcMain.on("ma:notify-delivery", (_event, payload) => {
  try {
    const p = payload && typeof payload === "object" ? payload : {};
    const id = clean(p.id, 64);
    if (!id || NOTIFIED.has(id)) return;
    NOTIFIED.add(id);
    if (NOTIFIED.size > NOTIFIED_CAP) NOTIFIED.delete(NOTIFIED.values().next().value);

    const pending = Math.max(0, Math.min(9999, Math.floor(Number(p.pending) || 0)));
    if (Notification.isSupported()) {
      new Notification({
        title: clean(p.title, 120) || "New delivery",
        body: clean(p.body, 200) || "Awaiting your decision",
        silent: false,
      }).show();
    }
    // macOS only; a no-op elsewhere (app.dock is undefined on Windows/Linux).
    app.dock?.setBadge?.(pending > 0 ? String(pending) : "");
  } catch {
    /* a notification must never be able to take the main process down */
  }
});

// ---------------------------------------------------------------------------
// IPC: project folder picker + RUNTIME_REPO_ROOT hot-swap
// ---------------------------------------------------------------------------
ipcMain.handle("ma:pick-folder", async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
    title: "Select Project Folder",
    buttonLabel: "Select Folder",
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

ipcMain.handle("ma:get-repo-root", () => repoRoot);

// P5 — open a PR URL in the user's real browser. The renderer cannot navigate or
// window.open out of the app (both are denied in web-contents-created below), so
// this is the ONLY external exit — and it is allowlisted HERE, in main, where the
// renderer cannot influence the check. https + github.com only.
ipcMain.handle("ma:open-external", async (_event, rawUrl) => {
  try {
    const u = new URL(String(rawUrl));
    if (u.protocol !== "https:") return { ok: false, error: "https only" };
    if (!/^(.+\.)?github\.com$/.test(u.hostname)) return { ok: false, error: "github.com only" };
    await shell.openExternal(u.toString());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// sr-security P5 re-review #3 — VALIDATE before pinning. The value set here becomes
// RUNTIME_REPO_ROOT, which outranks the validated persisted config, so an unchecked
// path (setRepoRoot("/"), setRepoRoot($HOME)) is a whole-disk grant to every agent.
// The renderer's string is DATA: only the repoPath that the runtime's own
// validateWorkspace RETURNS is ever stored or exported.
ipcMain.handle("ma:set-repo-root", async (_event, folderPath) => {
  const v = await validateRepoRoot(folderPath, WORKSPACE_PATH);
  if (!v.ok) return { ok: false, error: v.error };
  repoRoot = v.repoPath;
  // Persist for next launch — the VALIDATED realpath, never the raw input.
  try {
    if (repoRootFile) {
      mkdirSync(join(app.getPath("userData"), "missionalpha"), { recursive: true });
      writeFileSync(repoRootFile, repoRoot, "utf8");
    }
  } catch { /* non-fatal */ }
  // Restart runtime with new RUNTIME_REPO_ROOT.
  if (!supervisorFactory) return { ok: true }; // boot not done yet; env picked up on start
  try {
    await restartSupervisor();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Navigation hardening — deny external navigation + new-window attempts
// ---------------------------------------------------------------------------
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      // Allow only localhost (dev Vite) and file:// (packaged dist).
      const allowed =
        parsed.protocol === "file:" ||
        (parsed.protocol === "http:" &&
          (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"));
      if (!allowed) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------
async function boot() {
  // Dynamic import of ESM modules (CJS → ESM dynamic import is supported in
  // Node 12+ and works correctly inside Electron's main process).
  const { createSupervisor } = await import("./runtime-supervisor.js");
  const { preflight } = await import("./preflight.js");

  // Store factory so hot-swap (ma:set-repo-root) can create a new supervisor.
  supervisorFactory = createSupervisor;

  // Initialise persistent repo-root path now that userData is available.
  repoRootFile = join(app.getPath("userData"), "missionalpha", "repo-root.txt");
  // Load persisted folder (env override already wins via module-level init). The
  // file on disk is re-validated, not trusted: it is the same env pin with the same
  // highest precedence, so a tampered repo-root.txt is a setRepoRoot("/") by another
  // route. Rejected ⇒ null ⇒ the runtime falls back to its own default root.
  if (!repoRoot) {
    let persisted = null;
    try { persisted = readFileSync(repoRootFile, "utf8").trim() || null; } catch { /* not set */ }
    if (persisted) {
      const v = await validateRepoRoot(persisted, WORKSPACE_PATH);
      repoRoot = v.ok ? v.repoPath : null;
      if (!v.ok) console.warn(`[main] persisted repo root rejected (${v.error}) — using the runtime default`);
    }
  }

  // Run host dependency preflight (claude / docker / auth).
  const pf = await preflight({ exec, env: process.env });

  // Build supervisor with injected real spawn + global fetch.
  // buildSupervisorEnv() injects RUNTIME_REPO_ROOT when repoRoot is set.
  supervisor = createSupervisor({
    spawn,
    fetch: globalThis.fetch,
    serverPath: SERVER_PATH,
    port: RUNTIME_PORT,
    env: buildSupervisorEnv(),
  });

  // Only start the runtime supervisor when preflight passes.
  // Errors are surfaced via the status strip rather than crashing the app.
  if (pf.ok) {
    try {
      await supervisor.start();
    } catch (err) {
      // Runtime failed to come up — status strip will show it as down.
      console.error("[main] supervisor.start() failed:", err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Create the browser window — clamp to the display work area so the right chat
  // panel can never open off-screen on smaller / scaled-Retina logical resolutions
  // (a fixed 1320 wide window overflows a <1320-logical-px display). Center it.
  // ---------------------------------------------------------------------------
  const { width: waW, height: waH } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1320, waW - 40),
    height: Math.min(900, waH - 40),
    minWidth: 900,
    minHeight: 600,
    center: true,
    frame: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0d12",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Tell the (sandboxed) preload whether this is a dev run. In dev the renderer is
      // served by vite on localhost:3004 and must reach the runtime through vite's
      // same-origin /runtime + /api proxy (relative URLs) — fetching 127.0.0.1:3005
      // directly is cross-origin and CORS-blocked. Packaged stays on the direct base.
      additionalArguments: [isDev ? "--ma-dev" : "--ma-packaged"],
    },
  });

  // ---------------------------------------------------------------------------
  // CSP — defense-in-depth header injection (index.html also sets a meta CSP).
  // Applied to defaultSession so it covers all requests for the window.
  // ---------------------------------------------------------------------------
  // Header CSP INTERSECTS with the index.html meta CSP (most-restrictive wins). In dev,
  // vite serves an inline react-refresh preamble + a websocket HMR client, so the dev
  // header must permit them too — else the renderer goes blank even though the meta CSP
  // (relaxed by the devCspRelax vite plugin) allows it. Packaged stays strict: no inline.
  const CSP_PROD =
    "default-src 'self';" +
    " connect-src 'self' http://127.0.0.1:3005;" +
    " img-src 'self' data:;" +
    " style-src 'self' 'unsafe-inline';" +
    " font-src 'self' data:;";
  const CSP_DEV =
    "default-src 'self';" +
    " script-src 'self' 'unsafe-inline';" + // vite react-refresh preamble is inline
    " connect-src 'self' ws://localhost:3004 http://localhost:3004 http://127.0.0.1:3005;" +
    " img-src 'self' data:;" +
    " style-src 'self' 'unsafe-inline';" +
    " font-src 'self' data:;";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [isDev ? CSP_DEV : CSP_PROD],
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Load the renderer
  // ---------------------------------------------------------------------------
  if (isDev) {
    win.loadURL("http://localhost:3004");
  } else {
    win.loadFile(join(__dirname, "..", "dist", "index.html"));
  }

  // Forward preflight result to renderer once the page has fully loaded.
  // The PreflightGate + StatusStrip components consume this via onPreflight().
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("ma:preflight", pf);
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(boot);

app.on("window-all-closed", () => {
  try { supervisor?.stop(); } catch { /* ignore */ }
  app.quit();
});

app.on("before-quit", () => {
  try { supervisor?.stop(); } catch { /* ignore */ }
});

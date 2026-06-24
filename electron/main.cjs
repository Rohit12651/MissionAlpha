// electron/main.cjs — MissionAlpha Electron main process.
// CJS file (root package.json is "type":"module"; Electron entry + preload require CJS).
// ESM modules (runtime-supervisor.js, preflight.js) are imported via dynamic await import().
"use strict";

const { app, BrowserWindow, ipcMain, session, screen, dialog } = require("electron");
const { join } = require("node:path");
const { readFileSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { exec: cpExec } = require("node:child_process");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const RUNTIME_PORT = 3005;
const RUNTIME_TOKEN_DIR =
  process.env.RUNTIME_TOKEN_DIR || join(tmpdir(), "missionalpha-runtime");
const TOKEN_FILE = join(RUNTIME_TOKEN_DIR, ".runtime-token");
const isDev = !app.isPackaged;

// Server path: dev → repo sibling; packaged → extraResources bundle.
const SERVER_PATH = isDev
  ? join(__dirname, "..", "agent-runtime", "server.mjs")
  : join(process.resourcesPath, "agent-runtime", "server.mjs");

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

function buildSupervisorEnv() {
  return {
    ...process.env,
    RUNTIME_PORT: String(RUNTIME_PORT),
    RUNTIME_TOKEN_DIR,
    RUNTIME_BACKEND: process.env.RUNTIME_BACKEND || "cli",
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

ipcMain.handle("ma:set-repo-root", async (_event, folderPath) => {
  if (!folderPath || !existsSync(folderPath)) {
    return { ok: false, error: "Path does not exist" };
  }
  repoRoot = folderPath;
  // Persist for next launch.
  try {
    if (repoRootFile) {
      mkdirSync(join(app.getPath("userData"), "missionalpha"), { recursive: true });
      writeFileSync(repoRootFile, folderPath, "utf8");
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
  // Load persisted folder (env override already wins via module-level init).
  if (!repoRoot) {
    try { repoRoot = readFileSync(repoRootFile, "utf8").trim() || null; } catch { /* not set */ }
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
    },
  });

  // ---------------------------------------------------------------------------
  // CSP — defense-in-depth header injection (index.html also sets a meta CSP).
  // Applied to defaultSession so it covers all requests for the window.
  // ---------------------------------------------------------------------------
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self';" +
            " connect-src 'self' http://127.0.0.1:3005;" +
            " img-src 'self' data:;" +
            " style-src 'self' 'unsafe-inline';" +
            " font-src 'self' data:;",
        ],
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

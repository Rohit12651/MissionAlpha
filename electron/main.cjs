// electron/main.cjs — MissionAlpha Electron main process.
// CJS file (root package.json is "type":"module"; Electron entry + preload require CJS).
// ESM modules (runtime-supervisor.js, preflight.js) are imported via dynamic await import().
"use strict";

const { app, BrowserWindow, ipcMain, session } = require("electron");
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
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
// Module-level state
// ---------------------------------------------------------------------------
let supervisor = null;
let win = null;

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

  // Run host dependency preflight (claude / docker / auth).
  const pf = await preflight({ exec, env: process.env });

  // Build supervisor with injected real spawn + global fetch.
  supervisor = createSupervisor({
    spawn,
    fetch: globalThis.fetch,
    serverPath: SERVER_PATH,
    port: RUNTIME_PORT,
    env: {
      ...process.env,
      RUNTIME_PORT: String(RUNTIME_PORT),
      RUNTIME_TOKEN_DIR,
      RUNTIME_BACKEND: process.env.RUNTIME_BACKEND || "cli",
    },
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
  // Create the browser window
  // ---------------------------------------------------------------------------
  win = new BrowserWindow({
    width: 1320,
    height: 860,
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

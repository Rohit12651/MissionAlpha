// electron/preload.cjs — contextIsolation bridge.
// Renderer gets ONLY: isPackaged flag, runtimeBase, getRuntimeToken (IPC), onPreflight (IPC).
// Nothing else is exposed — no Node, no arbitrary IPC, no fs/exec reachable from the renderer.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// main.cjs passes --ma-dev (vite dev server) or --ma-packaged via additionalArguments.
// Dev → relative runtimeBase ("") so the renderer hits vite's same-origin /runtime + /api
// proxy (no CORS). Packaged → the direct loopback runtime base.
const IS_DEV = process.argv.includes("--ma-dev");

contextBridge.exposeInMainWorld("missionAlpha", {
  isPackaged: !IS_DEV,
  runtimeBase: IS_DEV ? "" : "http://127.0.0.1:3005",
  getRuntimeToken: () => ipcRenderer.invoke("ma:get-runtime-token"),
  // Replace any prior listener so React StrictMode's double-mount can't accumulate
  // duplicate "ma:preflight" handlers. Returns a cleanup fn for explicit teardown.
  onPreflight: (cb) => {
    ipcRenderer.removeAllListeners("ma:preflight");
    const handler = (_e, d) => cb(d);
    ipcRenderer.on("ma:preflight", handler);
    return () => ipcRenderer.removeListener("ma:preflight", handler);
  },
  // Project folder — lets the renderer open a native folder-picker dialog and
  // hot-swap RUNTIME_REPO_ROOT without restarting the whole Electron process.
  pickFolder: () => ipcRenderer.invoke("ma:pick-folder"),
  getRepoRoot: () => ipcRenderer.invoke("ma:get-repo-root"),
  setRepoRoot: (path) => ipcRenderer.invoke("ma:set-repo-root", path),
  // P5 — open a PR link in the real browser. main.cjs re-validates the URL
  // (https + github.com only); the renderer cannot widen that allowlist.
  openExternal: (url) => ipcRenderer.invoke("ma:open-external", String(url)),
  // P3 — a Delivery arrived: raise the OS notification + set the dock badge.
  // Fire-and-forget (no reply channel), so the SSE callback never awaits the UI
  // thread. Only the four named primitives cross the bridge — main.cjs re-coerces
  // and caps all of them, and never treats any of them as a path or a command.
  notifyDelivery: (p) =>
    ipcRenderer.send("ma:notify-delivery", {
      id: String(p && p.id ? p.id : ""),
      title: String(p && p.title ? p.title : ""),
      body: String(p && p.body ? p.body : ""),
      pending: Number(p && p.pending) || 0,
    }),
});

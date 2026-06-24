// electron/preload.cjs — contextIsolation bridge.
// Renderer gets ONLY: isPackaged flag, runtimeBase, getRuntimeToken (IPC), onPreflight (IPC).
// Nothing else is exposed — no Node, no arbitrary IPC, no fs/exec reachable from the renderer.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("missionAlpha", {
  isPackaged: true,
  runtimeBase: "http://127.0.0.1:3005",
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
});

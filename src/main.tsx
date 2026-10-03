import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./theme/ThemeProvider";
import { SettingsProvider } from "./lib/settingsContext";
import { TickProvider } from "./lib/ticker";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

// Phase G — the framed Electron window needs the title bar to clear the macOS traffic
// lights; a browser render does not (and must match the mockup). The preload ALWAYS sets
// `isPackaged` (electron/preload.cjs), so its presence — not the bridge object alone — is the
// signal that we are inside the window.
if (typeof (globalThis as { missionAlpha?: { isPackaged?: unknown } }).missionAlpha?.isPackaged === "boolean") {
  document.documentElement.dataset.shell = "electron";
}

createRoot(rootEl).render(
  <StrictMode>
    <SettingsProvider>
      <ThemeProvider>
        <TickProvider>
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </TickProvider>
      </ThemeProvider>
    </SettingsProvider>
  </StrictMode>,
);

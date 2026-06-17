import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./theme/ThemeProvider";
import { TickProvider } from "./lib/ticker";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <TickProvider>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </TickProvider>
    </ThemeProvider>
  </StrictMode>,
);

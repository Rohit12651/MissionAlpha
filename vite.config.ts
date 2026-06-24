import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import type { Plugin } from "vite";
// F4.1 — import the shared handler module so dev and the packaged runtime
// use IDENTICAL logic. Helpers (readJsonBody, knownAgentIds, readDirJson,
// ALLOWED_TYPES, TARGET_RE, summarizeLines…) now live in cockpit-feeds.mjs.
import { stateHandler, commandHandler, auditHandler, commandStatusHandler, sessionsHandler } from "./agent-runtime/cockpit-feeds.mjs";

// ── Data seam ──────────────────────────────────────────────────────────────
// MissionAlpha is a STANDALONE watcher. It does NOT live inside the swarm it
// watches. It reads ONE file — the swarm's exported state.json — via a
// configurable path. Default points at the Waahyu swarm (sibling repo), but
// any swarm that emits the same schema can be pointed at by changing
// WAAHYU_STATE_PATH in .env. This is the seam that makes it global-ready.
function resolveStatePath(env: Record<string, string>): string {
  const p = env.WAAHYU_STATE_PATH;
  if (p && p.trim()) return resolve(p.trim());
  // default: sibling Waahyu repo's exported state
  return resolve(__dirname, "../WaahyuPython/agent-status/state.json");
}

// READ side — reuses the shared handler from cockpit-feeds.mjs (DRY with runtime).
function serveAgentState(statePath: string): Plugin {
  const handler = stateHandler(statePath);
  return {
    name: "serve-agent-state",
    configureServer(server) {
      server.middlewares.use("/api/state.json", handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/state.json", handler);
    },
  };
}

// ── Command channel (write-back) — the reverse arrow ─────────────────────────
// POST /api/command writes ONE validated command file into the swarm's
// agent-status/commands/ dir (sibling of state.json). The swarm drains it via
// consume_commands.py. Handler logic (validation, atomic write, audit) lives in
// cockpit-feeds.mjs and is shared with the packaged agent-runtime.
function serveCommandChannel(statePath: string): Plugin {
  const handler = commandHandler(statePath);
  return {
    name: "serve-command-channel",
    configureServer(server) {
      server.middlewares.use("/api/command", handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/command", handler);
    },
  };
}

// ── Read-only control-plane endpoints (Cycle 1: F5 audit + F7 command status) ──
// F5 — GET /api/audit?limit=N → parsed tail of commands/AUDIT.log (newest first).
function serveAuditLog(statePath: string): Plugin {
  const handler = auditHandler(statePath);
  return {
    name: "serve-audit-log",
    configureServer(s) {
      s.middlewares.use("/api/audit", handler);
    },
    configurePreviewServer(s) {
      s.middlewares.use("/api/audit", handler);
    },
  };
}

// F7 — GET /api/commands/status → lifecycle of recent commands from the 3 dirs.
function serveCommandStatus(statePath: string): Plugin {
  const handler = commandStatusHandler(statePath);
  return {
    name: "serve-command-status",
    configureServer(s) {
      s.middlewares.use("/api/commands/status", handler);
    },
    configurePreviewServer(s) {
      s.middlewares.use("/api/commands/status", handler);
    },
  };
}

// ── Session history endpoints (Cycle 2: F4) ──────────────────────────────────
function serveSessions(statePath: string): Plugin {
  const handler = sessionsHandler(statePath);
  return {
    name: "serve-sessions",
    configureServer(s) {
      s.middlewares.use("/api/sessions", handler);
    },
    configurePreviewServer(s) {
      s.middlewares.use("/api/sessions", handler);
    },
  };
}

// Serve the agent-runtime auth token to the SAME-ORIGIN dashboard only. The
// browser fetches this once and sends it as x-runtime-token on /apply + /changes.
// Cross-origin pages can issue the request but CORS blocks them reading the token.
function serveRuntimeToken(env: Record<string, string>): Plugin {
  // Read from the runtime's token file OUTSIDE the repo (sr-security #5).
  const tokenDir = env.RUNTIME_TOKEN_DIR || join(tmpdir(), "missionalpha-runtime");
  const tokenFile = join(tokenDir, ".runtime-token");
  const loopbackHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
  const handler = async (req: any, res: any) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // anti-rebinding: drop non-loopback Host, and any cross-origin Origin.
    const host = String(req.headers.host || "");
    const origin = req.headers.origin;
    if (!loopbackHost.test(host) || (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    try {
      const token = (await readFile(tokenFile, "utf-8")).trim();
      res.end(JSON.stringify({ token }));
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "runtime token not available — is agent-runtime started?" }));
    }
  };
  return {
    name: "serve-runtime-token",
    configureServer(s) {
      s.middlewares.use("/api/runtime-token", handler);
    },
    configurePreviewServer(s) {
      s.middlewares.use("/api/runtime-token", handler);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const statePath = resolveStatePath(env);
  return {
    // Relative asset paths in the production build so the packaged Electron app
    // (loaded via file://) resolves /assets/* against index.html, not the FS root.
    // Dev keeps "/" for the vite server + proxy.
    base: mode === "production" ? "./" : "/",
    plugins: [
      react(),
      serveAgentState(statePath),
      serveCommandChannel(statePath),
      serveAuditLog(statePath),
      serveCommandStatus(statePath),
      serveSessions(statePath),
      serveRuntimeToken(env),
    ],
    server: {
      port: 3004,
      strictPort: false,
      // anti-DNS-rebinding: reject requests whose Host isn't loopback (sr-security #4).
      allowedHosts: ["localhost", "127.0.0.1"],
      // Track B chat fork — proxy chat to the SEPARATE agent-runtime service so the
      // browser stays same-origin. The watcher process never hosts the LLM runtime.
      proxy: {
        "/runtime": {
          target: `http://localhost:${env.RUNTIME_PORT || "3005"}`,
          changeOrigin: true,
        },
        // Agent Factory endpoints live on the same separate runtime service.
        "/factory": {
          target: `http://localhost:${env.RUNTIME_PORT || "3005"}`,
          changeOrigin: true,
        },
      },
    },
    // Keep a single three.js instance across r3f / drei so refs/types line up.
    resolve: { dedupe: ["three", "@react-three/fiber"] },
  };
});

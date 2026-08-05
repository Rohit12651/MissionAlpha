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

// DEV-ONLY CSP relax. The packaged app keeps the strict index.html meta CSP (no inline
// script). But vite's dev server injects an inline @vitejs/plugin-react refresh preamble
// + a websocket HMR client — both blocked by `default-src 'self'`, which leaves the
// renderer blank ("plugin-react can't detect preamble"). `apply: "serve"` scopes this to
// the dev server only; `vite build` never runs it, so production CSP is unchanged.
function devCspRelax(): Plugin {
  const DEV_CSP =
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " + // vite react-refresh preamble is inline
    "connect-src 'self' ws://localhost:3004 http://localhost:3004 http://127.0.0.1:3005; " + // HMR ws + runtime
    "img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:;";
  return {
    name: "dev-csp-relax",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace(
        /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
        `<meta http-equiv="Content-Security-Policy" content="${DEV_CSP}" />`,
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  return {
    // Relative asset paths in the production build so the packaged Electron app
    // (loaded via file://) resolves /assets/* against index.html, not the FS root.
    // Dev keeps "/" for the vite server + proxy.
    base: mode === "production" ? "./" : "/",
    // Dev serves ONLY the runtime token from vite (it reads the token file, the runtime
    // can't). Every OTHER /api/* feed is PROXIED to the runtime (below) so dev shows the
    // SAME LIVE state as packaged — buildLiveState (real heartbeats + inflight + engine
    // tasks), not the frozen on-disk snapshot the old static plugins read.
    plugins: [
      react(),
      devCspRelax(),
      serveRuntimeToken(env),
    ],
    server: {
      port: 3004,
      strictPort: false,
      // anti-DNS-rebinding: reject requests whose Host isn't loopback (sr-security #4).
      allowedHosts: ["localhost", "127.0.0.1"],
      // Proxy chat + live feeds to the SEPARATE agent-runtime service so the browser stays
      // same-origin. The watcher process never hosts the LLM runtime. /api/runtime-token is
      // NOT proxied — the vite plugin above owns it (runtime has no such route).
      proxy: {
        "/runtime": { target: `http://127.0.0.1:${env.RUNTIME_PORT || "3005"}`, changeOrigin: true },
        "/factory": { target: `http://127.0.0.1:${env.RUNTIME_PORT || "3005"}`, changeOrigin: true },
        // P3 Inbox (ADR-051) — Delivery list/detail/decide. Same runtime target as
        // /runtime + /factory; without this every Inbox call would hit vite and 404.
        "/inbox": { target: `http://127.0.0.1:${env.RUNTIME_PORT || "3005"}`, changeOrigin: true },
        // LIVE cockpit feeds — runtime builds these from real activity, not the static file.
        "/api/state.json": { target: `http://127.0.0.1:${env.RUNTIME_PORT || "3005"}`, changeOrigin: true },
        "/api/command": { target: `http://127.0.0.1:${env.RUNTIME_PORT || "3005"}`, changeOrigin: true },
        "/api/audit": { target: `http://127.0.0.1:${env.RUNTIME_PORT || "3005"}`, changeOrigin: true },
        "/api/commands": { target: `http://127.0.0.1:${env.RUNTIME_PORT || "3005"}`, changeOrigin: true },
        "/api/sessions": { target: `http://127.0.0.1:${env.RUNTIME_PORT || "3005"}`, changeOrigin: true },
      },
    },
    // Keep a single three.js instance across r3f / drei so refs/types line up.
    resolve: { dedupe: ["three", "@react-three/fiber"] },
  };
});

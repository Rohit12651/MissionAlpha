// Step 0 — ONE picker for the RUNTIME_* keys the desktop supervisor may take from the repo
// .env. Closed allow-list: a key not named here never reaches the child, so .env cannot
// redirect the token dir, the port, or the repo root (those are main.cjs's to set).
"use strict";

const RUNTIME_ENV_ALLOW = Object.freeze([
  "RUNTIME_MANAGER_DISPATCH",
  "RUNTIME_ENGINE_SPAWNER",
  "RUNTIME_SANDBOX_IMAGE",
  "RUNTIME_STORY_MAX_CONCURRENT",
  "RUNTIME_BACKEND",
]);

// Mirrors what Node's --env-file accepts (the CLI's parser), so the two entry points agree:
// an optional `export ` prefix, a matching pair of surrounding quotes, and an inline
// ` # comment` on an unquoted value. G7 (2026-09-17) found the quote case live-reachable.
function parseDotenv(text) {
  const out = {};
  for (const raw of String(text || "").split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
    else { const hash = value.indexOf(" #"); if (hash >= 0) value = value.slice(0, hash).trim(); }
    out[key] = value;
  }
  return out;
}

/** Allow-listed RUNTIME_* from `.env` text, with `processEnv` winning on conflict. */
function pickRuntimeEnv(dotenvText, processEnv) {
  const fromFile = parseDotenv(dotenvText);
  const out = {};
  for (const key of RUNTIME_ENV_ALLOW) {
    const v = processEnv?.[key] ?? fromFile[key];
    if (v !== undefined && v !== "") out[key] = String(v);
  }
  return out;
}

/**
 * DEV ONLY: where the runtime must listen, and where its token lives, so that the Vite dev
 * proxy the app calls through reaches it. vite.config.ts reads RUNTIME_PORT and
 * RUNTIME_TOKEN_DIR from this same repo .env (process env winning), so the supervisor follows
 * the same rule; otherwise the proxy targets one port while the runtime listens on another,
 * and the token Vite serves is not the runtime's. This does NOT widen RUNTIME_ENV_ALLOW: it
 * grants the supervisor nothing the dev proxy did not already read. Packaged builds never
 * call it and keep main.cjs's pins (the CSP and preload name 127.0.0.1:3005).
 */
function devRuntimeTarget(dotenvText, processEnv, pins) {
  const fromFile = parseDotenv(dotenvText);
  const pick = (key) => { const v = processEnv?.[key] || fromFile[key]; return v ? String(v) : ""; };
  const port = Number(pick("RUNTIME_PORT"));
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : pins.port,
    tokenDir: pick("RUNTIME_TOKEN_DIR") || pins.tokenDir,
  };
}

module.exports = { pickRuntimeEnv, RUNTIME_ENV_ALLOW, parseDotenv, devRuntimeTarget };

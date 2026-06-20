// ADR-032/033 — MCP Connector Registry + per-agent grants + per-session scoped-config
// composition. Reuses the proven `claude -p --mcp-config <file> --strict-mcp-config`
// mechanism (spike-verified). Cred VALUES live in the AES broker (factory.mjs) and are
// resolved ONLY here at the spawn frame; the registry stores cred REFERENCES only.
//
// SECURITY (ADR-033, HARD gate):
//  - stdio command MUST be in LAUNCHER_ALLOWLIST (no arbitrary exec via a crafted connector).
//  - http url MUST be https + parseable.
//  - cred refs MUST resolve to an existing broker cred; header/env names safe identifiers.
//  - grants are DEFAULT-DENY; an ungranted agent's composeConfig is null → with
//    --strict-mcp-config it loads NO MCP at all (host/global ignored).
//  - composeConfig fails closed: a granted connector with a missing cred is OMITTED.
//  - listConnectors NEVER exposes a cred value.

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// v1 launcher allowlist (OQ-033.2 — docker dropped: arbitrary-image escape surface).
export const LAUNCHER_ALLOWLIST = new Set(["npx", "node", "uvx", "python", "python3", "bunx"]);
const NAME_RE = /^[a-z0-9_-]{2,48}$/i;
const IDENT_RE = /^[A-Za-z0-9_]{1,64}$/; // header / env var names
const ctrl = (s) => /[\x00-\x1f\x7f]/.test(s); // eslint-disable-line no-control-regex

function validateSpec(spec, credExists) {
  if (!spec || typeof spec !== "object") return "spec required";
  const name = String(spec.name || "");
  if (!NAME_RE.test(name) || /^mcp__/i.test(name)) return "invalid name (use [a-z0-9_-]{2,48}, not mcp__*)";
  const refs = { ...(spec.envRefs || {}), ...(spec.headersRef || {}) };
  for (const [k, credId] of Object.entries(refs)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return `unsafe ref name: ${k}`;
    if (!IDENT_RE.test(k)) return `invalid ref name: ${k}`;
    if (typeof credId !== "string" || !credExists(credId)) return `unknown credId for ${k}`;
  }
  if (spec.transport === "stdio") {
    if (typeof spec.command !== "string") return "command must be a string"; // no array/obj type-confusion
    if (!LAUNCHER_ALLOWLIST.has(spec.command)) return `command not in launcher allowlist: ${spec.command}`;
    const args = spec.args ?? [];
    if (!Array.isArray(args) || args.length > 64) return "args must be an array (≤64)";
    for (const a of args) {
      if (typeof a !== "string" || a.length > 512 || ctrl(a)) return "invalid arg (string, ≤512, no control chars)";
    }
    return null;
  }
  if (spec.transport === "http") {
    let u;
    try { u = new URL(String(spec.url)); } catch { return "invalid url"; }
    if (u.protocol !== "https:") return "http connector url must be https";
    if (!u.host) return "url host required";
    return null;
  }
  return "transport must be 'stdio' or 'http'";
}

export function createMcpRegistry(opts = {}) {
  const dir = opts.dir;
  const now = opts.now || (() => Date.now());
  const getCredValue = opts.getCredValue || (() => null);
  const credExists = opts.credExists || (() => false);
  const connFile = join(dir, "mcp-connectors.json");
  const grantFile = join(dir, "mcp-grants.json");
  mkdirSync(dir, { recursive: true });

  const atomicWrite = (file, obj) => {
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify(obj)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  };
  const loadConns = () => { try { return JSON.parse(readFileSync(connFile, "utf-8")); } catch { return []; } };
  const saveConns = (l) => atomicWrite(connFile, l);
  const loadGrants = () => { try { return JSON.parse(readFileSync(grantFile, "utf-8")); } catch { return {}; } };
  const saveGrants = (g) => atomicWrite(grantFile, g);

  // public view — refs (names) only, NEVER cred values.
  const pub = (c) => ({
    connectorId: c.connectorId, name: c.name, transport: c.transport,
    command: c.command, args: c.args, url: c.url,
    envRefNames: Object.keys(c.envRefs || {}), headerRefNames: Object.keys(c.headersRef || {}),
    scopes: c.scopes || [], enabled: c.enabled, createdAt: c.createdAt, updatedAt: c.updatedAt,
  });

  function addConnector(spec) {
    const err = validateSpec(spec, credExists);
    if (err) return { error: err };
    const ts = new Date(now()).toISOString();
    const connector = {
      connectorId: `mcp_${randomBytes(6).toString("hex")}`,
      name: spec.name, transport: spec.transport,
      command: spec.transport === "stdio" ? spec.command : undefined,
      args: spec.transport === "stdio" ? (spec.args || []) : undefined,
      url: spec.transport === "http" ? spec.url : undefined,
      envRefs: spec.envRefs || undefined,
      headersRef: spec.headersRef || undefined,
      scopes: Array.isArray(spec.scopes) ? spec.scopes.slice(0, 32) : [],
      enabled: spec.enabled !== false,
      createdAt: ts, updatedAt: ts,
    };
    const list = loadConns();
    list.push(connector);
    saveConns(list);
    return { connector: pub(connector) };
  }

  function listConnectors() { return loadConns().map(pub); }
  function getConnector(id) { const c = loadConns().find((c) => c.connectorId === id); return c ? pub(c) : null; }
  function rawConnector(id) { return loadConns().find((c) => c.connectorId === id) || null; }

  function patchConnector(id, patch) {
    const list = loadConns();
    const i = list.findIndex((c) => c.connectorId === id);
    if (i < 0) return { error: "not found" };
    const merged = { ...list[i], ...patch, connectorId: id, createdAt: list[i].createdAt };
    const err = validateSpec(merged, credExists);
    if (err) return { error: err };
    merged.updatedAt = new Date(now()).toISOString();
    list[i] = merged;
    saveConns(list);
    return { connector: pub(merged) };
  }

  function setEnabled(id, enabled) {
    const list = loadConns();
    const c = list.find((c) => c.connectorId === id);
    if (!c) return { error: "not found" };
    c.enabled = !!enabled;
    c.updatedAt = new Date(now()).toISOString();
    saveConns(list);
    return { ok: true, enabled: c.enabled };
  }

  function removeConnector(id) {
    const list = loadConns();
    const next = list.filter((c) => c.connectorId !== id);
    if (next.length === list.length) return { error: "not found" };
    saveConns(next);
    // cascade — strip this connector from every agent's grants
    const g = loadGrants();
    for (const a of Object.keys(g)) g[a] = (g[a] || []).filter((cid) => cid !== id);
    saveGrants(g);
    return { ok: true };
  }

  // ── grants (default-deny) ──────────────────────────────────────────────────
  function grant(agentId, connectorId) {
    if (!rawConnector(connectorId)) return { error: "unknown connector" };
    const g = loadGrants();
    const cur = new Set(g[agentId] || []);
    cur.add(connectorId);
    g[agentId] = [...cur];
    saveGrants(g);
    return { ok: true };
  }
  function revoke(agentId, connectorId) {
    const g = loadGrants();
    g[agentId] = (g[agentId] || []).filter((c) => c !== connectorId);
    saveGrants(g);
    return { ok: true };
  }
  function grantsFor(agentId) { return loadGrants()[agentId] || []; }
  function allGrants() { return loadGrants(); }

  // Granted + enabled connectors for an agent (raw records).
  function activeFor(agentId) {
    const ids = new Set(grantsFor(agentId));
    return loadConns().filter((c) => ids.has(c.connectorId) && c.enabled);
  }

  // ── per-session scoped config (the spawn-frame composition) ─────────────────
  // Returns { mcpServers, allowedTools } or null if the agent has no usable connector.
  // Resolves cred VALUES here (decrypt). Fails closed: a connector whose cred is
  // missing is OMITTED. The caller writes this to a 0o600 file OUTSIDE the worktree.
  function composeConfig(agentId) {
    const active = activeFor(agentId);
    const mcpServers = {};
    const allowedTools = [];
    for (const c of active) {
      if (c.transport === "stdio") {
        const env = {};
        let bad = false;
        for (const [name, credId] of Object.entries(c.envRefs || {})) {
          const v = getCredValue(credId);
          if (v == null) { bad = true; break; }
          env[name] = v;
        }
        if (bad) continue; // fail closed — omit connector with a missing cred
        const entry = { command: c.command, args: c.args || [] };
        if (Object.keys(env).length) entry.env = env;
        mcpServers[c.name] = entry;
      } else if (c.transport === "http") {
        const headers = {};
        let bad = false;
        for (const [name, credId] of Object.entries(c.headersRef || {})) {
          const v = getCredValue(credId);
          if (v == null) { bad = true; break; }
          headers[name] = v;
        }
        if (bad) continue;
        const entry = { type: "http", url: c.url };
        if (Object.keys(headers).length) entry.headers = headers;
        mcpServers[c.name] = entry;
      }
      allowedTools.push(`mcp__${c.name}`); // whole-server grant
    }
    if (Object.keys(mcpServers).length === 0) return null;
    return { mcpServers, allowedTools };
  }

  // Plaintext secret values for an agent's granted connectors — for the spawn-frame
  // egress scrub set (so a tool echo can't leak a cred). NEVER persisted/logged.
  function collectSecretValues(agentId) {
    const out = [];
    for (const c of activeFor(agentId)) {
      const refs = { ...(c.envRefs || {}), ...(c.headersRef || {}) };
      for (const credId of Object.values(refs)) {
        const v = getCredValue(credId);
        if (v) out.push(v);
      }
    }
    return out;
  }

  // Names of an agent's granted + enabled connectors (for the system-prompt MCP note).
  function grantedNames(agentId) { return activeFor(agentId).map((c) => c.name); }

  // Seed a default Playwright MCP connector (idempotent) so browser automation is
  // available to grant out of the box. `npx` is in LAUNCHER_ALLOWLIST; no creds needed.
  // DEFAULT-DENY still applies — an agent only gets it after an explicit grant.
  if (opts.seedDefaults) {
    try {
      if (!loadConns().some((c) => c.name === "playwright")) {
        addConnector({ name: "playwright", transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], scopes: ["browser"], enabled: true });
      }
    } catch { /* non-fatal — seeding never blocks startup */ }
  }

  return {
    addConnector, listConnectors, getConnector, patchConnector, setEnabled, removeConnector,
    grant, revoke, grantsFor, allGrants, composeConfig, collectSecretValues, grantedNames,
  };
}

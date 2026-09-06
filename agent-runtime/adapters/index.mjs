// P7 / ADR-054 — adapter lifecycle + config. Owns the per-adapter enable flags and
// config (bot-name patterns, poll interval, workspace slug), reads/writes the
// BOSS-editable factory/adapters.json (plain JSON, schema-validated), and aggregates
// adapter STATUS so a poll failure surfaces as a visible banner rather than a silent
// vanish or a crash.
//
// SECURITY (ADR-054): fail-closed. A missing or corrupt config file → ALL adapters
// disabled (the safest state — no polling, no ingestion), logged. `save()` validates
// strictly before it ever touches disk, so the on-disk config can only move between
// valid states, and enabling an adapter without its required config is rejected.

import { readFileSync, existsSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { createGithubAdapter } from "./github.mjs";
import { createClaudeSessionsAdapter } from "./claude-sessions.mjs";

const MIN_POLL_MS = 10_000;
const DEFAULT_POLL_MS = 60_000;

function defaults() {
  return {
    github: { enabled: false, botAuthors: [], repo: null, pollIntervalMs: DEFAULT_POLL_MS, mergeOnApprove: false },
    claudeCode: { enabled: false, workspaceSlug: "", debounceMs: 800 },
    // MUNDER-ADOPTION A7 — Slack ingress. Fail-closed: disabled, empty allowlist. The
    // signing secret NEVER lives in this file — it stays in the environment
    // (SLACK_SIGNING_SECRET), same posture as every other credential.
    slack: { enabled: false, channelAllowlist: [] },
  };
}

/**
 * Coerce + validate a raw config object. `strict` (the save path) THROWS on anything
 * invalid — including enabling an adapter without its required fields. The load path
 * calls it non-strict and, on throw, the caller falls back to all-disabled.
 */
export function normalizeAdapterConfig(raw, { strict = false } = {}) {
  const fail = (m) => { if (strict) throw new Error(`adapters: ${m}`); return null; };
  const out = defaults();
  const r = raw && typeof raw === "object" ? raw : {};

  const g = r.github && typeof r.github === "object" ? r.github : {};
  if (g.enabled !== undefined && typeof g.enabled !== "boolean") { if (fail("github.enabled must be boolean") === null && strict) return null; }
  out.github.enabled = !!g.enabled;
  if (g.botAuthors !== undefined) {
    if (!(Array.isArray(g.botAuthors) && g.botAuthors.every((s) => typeof s === "string"))) { const v = fail("github.botAuthors must be a string array"); if (v === null && strict) return null; }
    else out.github.botAuthors = g.botAuthors.filter((s) => s.trim()).slice(0, 50);
  }
  if (g.repo !== undefined && g.repo !== null) { if (typeof g.repo !== "string") { const v = fail("github.repo must be a string or null"); if (v === null && strict) return null; } else out.github.repo = g.repo || null; }
  if (g.pollIntervalMs !== undefined) {
    const n = Number(g.pollIntervalMs);
    if (!(Number.isFinite(n) && n >= MIN_POLL_MS)) { const v = fail(`github.pollIntervalMs must be a number >= ${MIN_POLL_MS}`); if (v === null && strict) return null; }
    else out.github.pollIntervalMs = Math.floor(n);
  }
  out.github.mergeOnApprove = !!g.mergeOnApprove;
  if (strict && out.github.enabled && out.github.botAuthors.length === 0) throw new Error("adapters: enable github requires at least one botAuthor");

  const c = r.claudeCode && typeof r.claudeCode === "object" ? r.claudeCode : {};
  out.claudeCode.enabled = !!c.enabled;
  if (c.workspaceSlug !== undefined && c.workspaceSlug !== null) { if (typeof c.workspaceSlug !== "string") { const v = fail("claudeCode.workspaceSlug must be a string"); if (v === null && strict) return null; } else out.claudeCode.workspaceSlug = c.workspaceSlug.slice(0, 200); }
  if (c.debounceMs !== undefined) { const n = Number(c.debounceMs); if (Number.isFinite(n) && n >= 100) out.claudeCode.debounceMs = Math.floor(n); }
  if (strict && out.claudeCode.enabled && !out.claudeCode.workspaceSlug) throw new Error("adapters: enable claudeCode requires a workspaceSlug");

  // MUNDER-ADOPTION A7 — Slack ingress config. Channel ids are Slack's own shape
  // (C + upper-alnum); anything else is dropped (load) or refused (save). Enabling
  // with an empty allowlist is refused on save — an ingress that accepts every
  // channel is not a configuration, it is an accident.
  const s = r.slack && typeof r.slack === "object" ? r.slack : {};
  if (s.enabled !== undefined && typeof s.enabled !== "boolean") { if (fail("slack.enabled must be boolean") === null && strict) return null; }
  out.slack.enabled = !!s.enabled;
  if (s.channelAllowlist !== undefined) {
    if (!(Array.isArray(s.channelAllowlist) && s.channelAllowlist.every((x) => typeof x === "string"))) {
      const v = fail("slack.channelAllowlist must be a string array"); if (v === null && strict) return null;
    } else {
      out.slack.channelAllowlist = s.channelAllowlist.map((x) => x.trim()).filter((x) => /^[A-Z0-9]{5,20}$/.test(x)).slice(0, 50);
    }
  }
  if (strict && out.slack.enabled && out.slack.channelAllowlist.length === 0) throw new Error("adapters: enable slack requires at least one allowlisted channel id");

  return out;
}

export function createAdapters(deps = {}) {
  const deliveries = deps.deliveries;
  if (!deliveries) throw new Error("createAdapters: deliveries required");
  const file = deps.file || null;
  const runner = deps.runner; // injected gh runner (tests); undefined ⇒ github uses defaultRunner
  const log = deps.log || (() => {});
  const now = deps.now || (() => Date.now());
  // Phase 3 / R10 — OPTIONAL trust recorder. Absent = byte-identical pre-R10 behaviour.
  const trust = deps.trust || null;
  const makeGithub = deps.makeGithub || createGithubAdapter;
  const makeClaude = deps.makeClaude || createClaudeSessionsAdapter;

  let config = defaults();
  let valid = true;
  let github = null;
  let claude = null;

  function rebuild() {
    try { github?.stop(); } catch { /* */ }
    try { claude?.stop(); } catch { /* */ }
    github = makeGithub({ deliveries, runner, log, now, trust, enabled: config.github.enabled, config: config.github });
    claude = makeClaude({ deliveries, log, now, trust, enabled: config.claudeCode.enabled, config: config.claudeCode });
  }

  function load() {
    config = defaults();
    valid = true;
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf-8"));
        config = normalizeAdapterConfig(raw); // lenient — coerce, don't throw
      } catch (e) {
        valid = false;
        config = defaults();
        log(`[adapters] ${file} unreadable → all adapters disabled: ${e?.message}`);
      }
    }
    rebuild();
  }

  function startAll() {
    if (config.github.enabled) { try { github.start(); } catch (e) { log(`[adapters] github start: ${e?.message}`); } }
    if (config.claudeCode.enabled) { try { claude.start(); } catch (e) { log(`[adapters] claudeCode start: ${e?.message}`); } }
  }
  function stopAll() {
    try { github?.stop(); } catch { /* */ }
    try { claude?.stop(); } catch { /* */ }
  }

  function status() {
    return { valid, github: github?.status() || null, claudeCode: claude?.status() || null };
  }

  // deliveries.externalDecideFn — a github-pr decision routes here (only github decides).
  async function decideExternal(args) {
    return github ? github.decideExternal(args) : { ok: false, error: "github adapter not initialised" };
  }

  function raw() { return { github: { ...config.github }, claudeCode: { ...config.claudeCode }, slack: { ...config.slack, channelAllowlist: [...(config.slack?.channelAllowlist || [])] }, valid }; }

  // MUNDER-ADOPTION A7 — the slack adapter reads its config LIVE through this getter
  // (a BOSS save() takes effect on the next request, no restart, fail-closed on invalid).
  function slackConfig() { return valid && config.slack ? { ...config.slack, channelAllowlist: [...config.slack.channelAllowlist] } : { enabled: false, channelAllowlist: [] }; }

  // Validate FIRST (throws on invalid) — a rejected save never touches disk, then hot-
  // reload: stop the old adapters, rebuild from the new config, start the enabled ones.
  function save(next) {
    const norm = normalizeAdapterConfig(next, { strict: true });
    if (file) {
      const rec = { ...norm, updatedAt: new Date(now()).toISOString() };
      const tmp = `${file}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try { writeFileSync(fd, JSON.stringify(rec, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, file);
    }
    config = norm;
    valid = true;
    stopAll();
    rebuild();
    startAll();
    return raw();
  }

  load();
  return { load, startAll, stopAll, status, decideExternal, save, raw, slackConfig, valid: () => valid, adapters: () => ({ github, claude }) };
}

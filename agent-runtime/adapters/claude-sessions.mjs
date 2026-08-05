// P7 / ADR-054 — Claude Code sessions adapter (visibility first).
//
// Watches ~/.claude/projects/<workspace-slug>/ for session transcript files (*.jsonl)
// and surfaces FINISHED sessions as source='claude-code' READ-ONLY Deliveries — the
// operator sees their own local Claude Code work in the SAME Inbox as the swarm and the
// external PRs, without any decide action (v1 is visibility only; control comes later).
//
// SECURITY (ADR-054): transcript content is UNTRUSTED. Title/summary/paths are handed to
// deliveries.mintExternal, which scrubs (SECRET_RE + extended shapes + control chars) at
// rest and on egress. Nothing here is executed and nothing is fed into an agent prompt.
// Read-only: the decide buttons are hidden client-side and deliveries.decide refuses a
// claude-code row server-side. Idempotent per session id.
//
// macOS fs.watch fires MANY events per write — the watcher is DEBOUNCED (a trailing
// timer), and a transcript is only ingested once its mtime has been STABLE past the
// window (i.e. the session has stopped writing).

import { readdirSync, statSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DEBOUNCE_MS = 800;
const DEFAULT_STABLE_MS = 1500;
const MAX_FILES = 200;
const MAX_LINES = 5000;
const MAX_PATHS = 100;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update", "create_file", "str_replace"]);

/** Pull display text + touched file paths from a Claude Code JSONL transcript. Pure. */
export function parseTranscript(text) {
  let firstUser = "";
  let lastAssistant = "";
  const paths = [];
  const seen = new Set();
  const addPath = (p) => { const s = String(p || "").slice(0, 400); if (s && !seen.has(s)) { seen.add(s); if (paths.length < MAX_PATHS) paths.push(s); } };

  const textOf = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ").trim();
  };
  const scanToolUse = (content) => {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || b.type !== "tool_use" || !EDIT_TOOLS.has(b.name)) continue;
      const inp = b.input || {};
      if (inp.file_path) addPath(inp.file_path);
      if (inp.notebook_path) addPath(inp.notebook_path);
      if (inp.path) addPath(inp.path);
    }
  };

  const lines = String(text || "").split("\n");
  for (const line of lines.slice(0, MAX_LINES)) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    const msg = o?.message || o;
    const role = msg?.role || o?.type;
    const content = msg?.content;
    if (role === "user") { const t = textOf(content); if (t && !firstUser) firstUser = t; }
    else if (role === "assistant") { const t = textOf(content); if (t) lastAssistant = t; scanToolUse(content); }
  }
  return { firstUser: firstUser.slice(0, 400), lastAssistant: lastAssistant.slice(0, 4000), paths };
}

export function createClaudeSessionsAdapter(opts = {}) {
  const deliveries = opts.deliveries;
  if (!deliveries) throw new Error("createClaudeSessionsAdapter: deliveries required");
  const now = opts.now || (() => Date.now());
  const cfg = opts.config || {};
  const config = {
    workspaceSlug: typeof cfg.workspaceSlug === "string" ? cfg.workspaceSlug.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 200) : "",
    projectsDir: cfg.projectsDir || join(homedir(), ".claude", "projects"),
    debounceMs: Math.max(100, Number(cfg.debounceMs) || DEFAULT_DEBOUNCE_MS),
    stableMs: Math.max(100, Number(cfg.stableMs) || DEFAULT_STABLE_MS),
  };
  const dir = config.workspaceSlug ? join(config.projectsDir, config.workspaceSlug) : config.projectsDir;
  const state = { active: false, lastScanAt: null, lastError: null, minted: 0, seen: 0, scans: 0 };
  const mintedIds = new Set();
  let watcher = null;
  let debounceTimer = null;

  // ── one scan of the transcript dir ──────────────────────────────────────────
  // Idempotent: a session already minted (in-memory OR already in the DB) is skipped.
  // A file whose mtime is still fresh (< stableMs old) is left until it settles — that
  // is how a still-writing session is not ingested mid-run.
  function scan() {
    state.scans++;
    let files;
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).slice(0, MAX_FILES); }
    catch (e) { state.lastError = `cannot read ${dir}: ${String(e?.message || e).slice(0, 160)}`; return { minted: 0, error: state.lastError }; }

    const t = now();
    let minted = 0;
    state.seen = files.length;
    for (const f of files) {
      const sessionId = f.replace(/\.jsonl$/i, "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 120);
      if (!sessionId) continue;
      const externalKey = `ccsession:${sessionId}`;
      if (mintedIds.has(externalKey)) continue;
      const full = join(dir, f);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (t - st.mtimeMs < config.stableMs) continue; // still being written — wait for it to settle
      if (deliveries.findByExternalKey(externalKey)) { mintedIds.add(externalKey); continue; } // already ingested

      let raw = "";
      try { raw = readFileSync(full, "utf-8"); } catch { continue; }
      const parsed = parseTranscript(raw);
      try {
        const out = deliveries.mintExternal({
          source: "claude-code",
          agentId: `claude-code:${sessionId}`.slice(0, 64),
          externalKey,
          kind: "code",
          title: parsed.firstUser || `Claude Code session ${sessionId.slice(0, 12)}`,
          summary: parsed.lastAssistant || "Local Claude Code session (read-only).",
          changes: parsed.paths.map((p) => ({ path: p })), // no patch bodies — read-only visibility
          externalMeta: { sessionId, readOnly: true, workspaceSlug: config.workspaceSlug, files: parsed.paths.length },
        });
        mintedIds.add(externalKey);
        if (out && !out.deduped) minted++;
      } catch (e) {
        state.lastError = `mint session ${sessionId}: ${String(e?.message || e).slice(0, 160)}`;
      }
    }
    state.minted += minted;
    state.lastScanAt = new Date(t).toISOString();
    if (minted || files.length) state.lastError = state.lastError && !minted ? state.lastError : null;
    return { minted };
  }

  // Debounced watch handler — coalesce the burst of fs events a single write produces.
  function onFsEvent() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; try { scan(); } catch (e) { state.lastError = String(e?.message || e).slice(0, 160); } }, config.debounceMs);
    if (typeof debounceTimer.unref === "function") debounceTimer.unref();
  }

  function start() {
    if (state.active) return;
    if (!config.workspaceSlug) { state.lastError = "no workspace slug configured"; return; }
    state.active = true;
    scan(); // ingest whatever finished sessions already exist
    try {
      watcher = watch(dir, { persistent: false }, () => onFsEvent());
      watcher.on?.("error", (e) => { state.lastError = `watch error: ${String(e?.message || e).slice(0, 160)}`; });
    } catch (e) {
      state.lastError = `cannot watch ${dir}: ${String(e?.message || e).slice(0, 160)}`;
    }
  }
  function stop() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (watcher) { try { watcher.close(); } catch { /* */ } watcher = null; }
    state.active = false;
  }

  function status() {
    const enabled = !!opts.enabled;
    let s;
    if (!enabled) s = "disabled";
    else if (!config.workspaceSlug) s = "error";
    else if (state.lastError) s = "error";
    else s = state.active ? "running" : "idle";
    return {
      adapter: "claude-code",
      enabled,
      running: state.active,
      state: s,
      readOnly: true,
      workspaceSlug: config.workspaceSlug,
      dir,
      lastScanAt: state.lastScanAt,
      lastError: state.lastError,
      counts: { minted: state.minted, seen: state.seen, scans: state.scans },
    };
  }

  // `onFsEvent` is exported so the debounce (many macOS fs events per write → ONE scan)
  // can be exercised deterministically without racing real fs.watch timing.
  return { name: "claude-code", scan, onFsEvent, status, start, stop };
}

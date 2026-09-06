// MUNDER-ADOPTION A3 — GROUND-TRUTH token usage from Claude Code's own transcripts.
//
// WHY: on the `cli` backend the runtime's usage numbers come from parsing its OWN child's
// stream. Claude Code writes an authoritative per-turn record to
// ~/.claude/projects/<projectKey(cwd)>/*.jsonl — including sessions this runtime never
// spawned (a human running `claude` in the same repo). This module reads that ledger.
// TOKENS + CONTEXT ONLY. The transcript's `total_cost_usd` field is NEVER read — the
// usage.mjs header explains why, and spend.mjs owns the single dollar exception.
//
// THE projectKey LESSON (ported bug, pinned by test): Claude Code's directory key is the
// absolute cwd with EVERY non-alphanumeric character dashed — leading slash included
// (/Users/me/App.v2 → -Users-me-App-v2). The PRE-2026 POSIX rule dropped the leading
// slash and dashed only '/' (Users-me-App.v2). The source harness emitted the legacy key
// unconditionally long after the format changed, and NOTHING errored — every caller reads
// an absent directory as "no transcripts yet" — so the miss silently cost months of dead
// telemetry. Therefore: BOTH keys are probed, existing dirs win, and "which dir answered"
// is part of the snapshot so drift is visible instead of silent.
//
// INCREMENTAL BY CONSTRUCTION: a file is re-parsed only when (size, mtimeMs) moved.
// Malformed lines are skipped (a transcript is an append-log; a torn tail line is
// normal). Bounded: at most MAX_FILES newest files, MAX_BYTES per file read.

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const MAX_FILES = 200;
export const MAX_BYTES = 8 * 1024 * 1024; // per transcript file

/** Claude Code's CURRENT project key: every non-alphanumeric → '-'. */
export function projectKey(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

/** The pre-2026 POSIX key, kept ONLY so old directories stay readable. */
export function legacyProjectKey(cwd) {
  return String(cwd || "").replace(/^\//, "").replaceAll("/", "-");
}

/** Candidate transcript dirs for a cwd, existing-first (current key wins a tie). */
export function transcriptDirs(cwd, { home = homedir() } = {}) {
  const base = join(home, ".claude", "projects");
  const current = join(base, projectKey(cwd));
  const legacy = join(base, legacyProjectKey(cwd));
  const out = [];
  if (existsSync(current)) out.push({ dir: current, key: "current" });
  if (legacy !== current && existsSync(legacy)) out.push({ dir: legacy, key: "legacy" });
  return out;
}

/**
 * Sum a Claude Code JSONL transcript's assistant usage rows. Pure.
 * Returns { turns, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
 *           contextTokens (last turn's input+caches), lastTs }.
 */
export function parseTranscriptUsage(text) {
  const out = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, lastTs: 0 };
  for (const line of String(text || "").split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // torn tail / non-JSON line — normal
    const u = o?.message?.usage;
    if (o?.type !== "assistant" || !u || typeof u !== "object") continue;
    const input = num(u.input_tokens);
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheCreate = num(u.cache_creation_input_tokens);
    out.turns += 1;
    out.inputTokens += input;
    out.outputTokens += num(u.output_tokens);
    out.cacheReadTokens += cacheRead;
    out.cacheCreationTokens += cacheCreate;
    out.contextTokens = input + cacheRead + cacheCreate; // last assistant row wins
    const ts = Date.parse(o?.timestamp || "");
    if (Number.isFinite(ts)) out.lastTs = Math.max(out.lastTs, ts);
  }
  return out;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function createTranscriptUsage(deps = {}) {
  const cwd = String(deps.cwd || process.cwd());
  const home = deps.home || homedir();
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  // Injected fs seams so tests never need a real ~/.claude.
  const fsx = { readdirSync, statSync, readFileSync, existsSync, ...(deps.fs || {}) };

  // file → { size, mtimeMs, usage } — the incremental cursor.
  const files = new Map();
  let lastEmitted = "";

  function dirs() {
    const base = join(home, ".claude", "projects");
    const current = join(base, projectKey(cwd));
    const legacy = join(base, legacyProjectKey(cwd));
    const out = [];
    if (fsx.existsSync(current)) out.push({ dir: current, key: "current" });
    if (legacy !== current && fsx.existsSync(legacy)) out.push({ dir: legacy, key: "legacy" });
    return out;
  }

  /** One sweep: stat every *.jsonl in both candidate dirs, re-parse only what moved. */
  function scan() {
    const found = dirs();
    const seen = new Set();
    for (const { dir } of found) {
      let names = [];
      try { names = fsx.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).slice(0, MAX_FILES); }
      catch { continue; }
      for (const name of names) {
        const path = join(dir, name);
        seen.add(path);
        let st;
        try { st = fsx.statSync(path); } catch { continue; }
        const prev = files.get(path);
        if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue; // unchanged
        if (st.size > MAX_BYTES) { log(`[transcript] ${name} exceeds ${MAX_BYTES}B — skipped`); continue; }
        let text;
        try { text = fsx.readFileSync(path, "utf8"); } catch { continue; }
        files.set(path, { size: st.size, mtimeMs: st.mtimeMs, usage: parseTranscriptUsage(text) });
      }
    }
    for (const path of files.keys()) if (!seen.has(path)) files.delete(path); // rotated away
    maybeEmit(found);
    return snapshot(found);
  }

  function totals() {
    const t = { sessions: files.size, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, lastTs: 0 };
    for (const { usage } of files.values()) {
      t.turns += usage.turns;
      t.inputTokens += usage.inputTokens;
      t.outputTokens += usage.outputTokens;
      t.cacheReadTokens += usage.cacheReadTokens;
      t.cacheCreationTokens += usage.cacheCreationTokens;
      t.lastTs = Math.max(t.lastTs, usage.lastTs);
    }
    return t;
  }

  // Change-only emission, same law as breaker.state: a frame per sweep for a static
  // ledger is noise. Identity/aggregate only — per-session detail stays behind the GET.
  function maybeEmit(found) {
    const t = totals();
    const sig = `${t.sessions}:${t.inputTokens}:${t.outputTokens}:${t.turns}`;
    if (sig === lastEmitted) return;
    lastEmitted = sig;
    try { emit("usage.transcript", { sessions: t.sessions, inputTokens: t.inputTokens, outputTokens: t.outputTokens, source: found.length ? found[0].key : "none" }); }
    catch { /* bus is observational */ }
  }

  /** Read model for the gated GET. Sessions newest-first, capped. */
  function snapshot(found = dirs()) {
    const sessions = [...files.entries()]
      .map(([path, f]) => ({ session: path.split("/").pop().replace(/\.jsonl$/, ""), ...f.usage }))
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, 50);
    return { cwd, dirs: found, totals: totals(), sessions };
  }

  return { scan, snapshot, totals, projectKey: () => projectKey(cwd), legacyProjectKey: () => legacyProjectKey(cwd) };
}

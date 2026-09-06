// MUNDER-ADOPTION A1-FINISH — the ENGINE EXECUTION SEAM: which CLI the autonomous
// engine spawns, with what argv, and how its stream is read back.
//
// SCOPE, stated exactly. Two engines are SPAWNABLE today: claude (the proven path) and
// codex (adapter below, proven against a stub binary — the real `codex` is not installed
// on this machine, and that fact is disclosed, not papered over). The other presets in
// cli-engines.mjs stay DETECTION-ONLY until each earns its own parser; an unknown or
// unsupported RUNTIME_CLI_ENGINE falls back to claude WITH A LOUD WARN — the autonomous
// engine must keep running on a misconfig, never wedge on one.
//
// THE CLAUDE CONTRACT IS BYTE-PINNED. buildEngineArgs('claude', …) must reproduce the
// exact argv engineDispatch has always built — a test compares it against the literal —
// so this refactor cannot drift the load-bearing path while adding a second one.
//
// CODEX CONTRACT (verified against the current docs, 2026-08):
//   invocation  codex exec --json [--model m] --cd <workdir> --sandbox workspace-write
//               --skip-git-repo-check -          ← '-' = prompt on stdin, same flow
//               as claude's stdin write; workspace-write scopes edits to the worktree.
//   stream      JSONL on stdout:
//               {type:'item.completed', item:{type:'agent_message', text}}
//               {type:'turn.completed', usage:{input_tokens, cached_input_tokens, output_tokens}}
//               {type:'turn.failed', error:{message}} · {type:'error', message}
//   usage map   codex `input_tokens` INCLUDES the cached share, claude's does not —
//               so input = input_tokens − cached_input_tokens and cached maps to
//               cache_read_input_tokens. Without that subtraction usageFromResult()
//               would double-count context (its contextTokens = input + cacheRead + …).
//
// WHAT CODEX RUNS DO NOT GET (v1, disclosed): per-line loop-steps — stepsFromLine()
// speaks Claude's stream shapes. The run inspector (A6) taps raw bytes for BOTH
// engines, so visibility is not lost; structured steps for codex are a follow-up.

import { cliEnginePreset } from "./cli-engines.mjs";

/** Engines the dispatch may actually SPAWN (a parser exists). Detection ≠ spawnable. */
export const SUPPORTED_SPAWN_ENGINES = Object.freeze(["claude", "codex"]);

/** Resolve RUNTIME_CLI_ENGINE → a spawnable engine, fail-safe to claude. */
export function resolveSpawnEngine(env = process.env, { log = () => {} } = {}) {
  const raw = String(env.RUNTIME_CLI_ENGINE || "").trim().toLowerCase();
  if (!raw || raw === "claude") return { id: "claude", preset: cliEnginePreset("claude"), forced: false };
  if (!SUPPORTED_SPAWN_ENGINES.includes(raw)) {
    log(`[engine] RUNTIME_CLI_ENGINE='${raw}' is not spawnable (supported: ${SUPPORTED_SPAWN_ENGINES.join(", ")}) — falling back to claude`);
    return { id: "claude", preset: cliEnginePreset("claude"), forced: true };
  }
  const preset = cliEnginePreset(raw);
  if (!preset) {
    log(`[engine] RUNTIME_CLI_ENGINE='${raw}' has no preset — falling back to claude`);
    return { id: "claude", preset: cliEnginePreset("claude"), forced: true };
  }
  return { id: raw, preset, forced: false };
}

/**
 * Build the spawn argv for an engine.
 *   claude → BYTE-IDENTICAL to the historical engineDispatch block (test-pinned).
 *   codex  → the documented exec contract above. `allowedTools` has no codex
 *            equivalent — the workspace-write sandbox is its containment model.
 */
export function buildEngineArgs({ engineId, modelId, allowedTools, strictMcp = false, workdir, permissionMode = "acceptEdits" }) {
  if (engineId === "codex") {
    const args = ["exec", "--json"];
    if (modelId) args.push("--model", modelId);
    args.push("--cd", workdir, "--sandbox", "workspace-write", "--skip-git-repo-check", "-");
    return args;
  }
  // claude — the pinned shape.
  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--no-session-persistence"];
  if (modelId) args.push("--model", modelId);
  for (const t of allowedTools || []) args.push("--allowed-tools", t);
  if (strictMcp) args.push("--strict-mcp-config");
  args.push("--add-dir", workdir, "--permission-mode", permissionMode);
  return args;
}

const RATE_RE = /rate.?limit|too many requests|429|usage limit/i;

/**
 * Parse ONE already-JSON.parsed codex stream object into normalized events:
 *   {kind:'delta', text}                            — agent message text to accumulate
 *   {kind:'result', isError, rateLimited, text?, usage?}
 * Unknown/irrelevant objects → []. `usage` comes back in CLAUDE key shape so the
 * existing usageFromResult()/recordUsage() path consumes it unchanged.
 */
export function parseCodexLine(o) {
  if (!o || typeof o !== "object") return [];
  if (o.type === "item.completed" && o.item && o.item.type === "agent_message" && typeof o.item.text === "string") {
    return [{ kind: "delta", text: o.item.text }];
  }
  if (o.type === "turn.completed") {
    const u = o.usage && typeof o.usage === "object" ? o.usage : {};
    const input = num(u.input_tokens);
    const cached = Math.min(num(u.cached_input_tokens), input); // never negative input
    return [{
      kind: "result", isError: false, rateLimited: false,
      usage: {
        input_tokens: input - cached,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
        output_tokens: num(u.output_tokens),
      },
    }];
  }
  if (o.type === "turn.failed" || o.type === "error") {
    const msg = String(o.type === "turn.failed" ? o.error?.message ?? "" : o.message ?? "").slice(0, 500);
    return [{ kind: "result", isError: true, rateLimited: RATE_RE.test(msg), text: msg }];
  }
  return [];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

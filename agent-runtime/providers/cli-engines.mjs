// MUNDER-ADOPTION A1 — the CLI-ENGINE PRESET TABLE (ported SHAPE, not policy).
//
// WHAT THIS IS: one frozen row per terminal coding agent the ecosystem ships — how it is
// invoked, how a model is selected, how a session resumes, how the tool installs when
// missing. It is a CATALOG plus a PATH-detector. It is NOT an account list (that is
// providers/registry.mjs) and it carries NO capability column — Principle 0 stands:
// capability is PROVED BY PROBE per account (capability-probe.mjs), never asserted by a
// table. The source repo hardcoded per-engine capability booleans; that is exactly the
// row this port deletes.
//
// WHAT IT IS NOT (yet, disclosed): the engine SPAWN path still runs Claude CLI only —
// the proven `engineDispatch` in server.mjs. These presets power detection, the roster
// route, the Accounts-page readout and the doctor's context; switching the spawn is a
// separate, deliberate change gated on a machine that actually has a second CLI.
//
// SECURITY: `installCommand` values are TRUSTED, HARDCODED constants (same law as the
// source repo stated: never user/manifest input) and nothing in this module RUNS them —
// they are surfaced as copy-paste guidance only. Detection uses execFile("which"), no
// shell, argument fixed from the frozen table.

import { execFile } from "node:child_process";

/** promptDelivery: how the FIRST prompt reaches the CLI.
 *  'flag'          — a named flag (claude --append-system-prompt, agy -i)
 *  'positional'    — trailing positional arg (codex "<prompt>")
 *  'type-into-tui' — bare TUI that rejects argv prompts; text must be typed in
 *                    after boot (crush — its first positional parses as a subcommand). */
export const CLI_ENGINE_PRESETS = Object.freeze([
  Object.freeze({ id: "claude",   label: "Claude Code",          bin: "claude",   modelFlag: "--model", autoFlag: "--dangerously-skip-permissions", resumeFlag: "--resume",       promptDelivery: "flag",          installCommand: "npm install -g @anthropic-ai/claude-code", docsUrl: "https://claude.com/claude-code" }),
  Object.freeze({ id: "codex",    label: "Codex · GPT",          bin: "codex",    modelFlag: "--model", autoFlag: "--full-auto",                    resumeSubcommand: "resume",   promptDelivery: "positional",    installCommand: "npm install -g @openai/codex",              docsUrl: "https://github.com/openai/codex" }),
  Object.freeze({ id: "grok",     label: "Grok · xAI",           bin: "grok",     modelFlag: "--model", autoFlag: "--yolo",                         resumeFlag: "--resume",       promptDelivery: "positional",    installCommand: "npm install -g @xai/grok-cli",              docsUrl: "https://x.ai" }),
  Object.freeze({ id: "kimi",     label: "Kimi Code",            bin: "kimi",     modelFlag: "--model", autoFlag: "--auto",                         promptDelivery: "flag",       installCommand: "npm install -g @moonshot/kimi-code" }),
  Object.freeze({ id: "agy",      label: "Antigravity · Gemini", bin: "agy",      modelFlag: "--model", autoFlag: "--auto",                         resumeFlag: "--conversation", promptDelivery: "flag",          installCommand: "npm install -g @google/antigravity" }),
  Object.freeze({ id: "qwen",     label: "Qwen",                 bin: "qwen",     modelFlag: "--model", autoFlag: "--yolo",                         promptDelivery: "positional",  installCommand: "npm install -g @qwen-code/qwen-code" }),
  Object.freeze({ id: "opencode", label: "OpenCode",             bin: "opencode", modelFlag: "--model", autoFlag: "--auto",                         promptDelivery: "positional",  installCommand: "npm install -g opencode-ai" }),
  Object.freeze({ id: "crush",    label: "Crush · Charm",        bin: "crush",    modelFlag: "--model", autoFlag: "--yolo",                         promptDelivery: "type-into-tui", installCommand: "brew install charmbracelet/tap/crush" }),
  Object.freeze({ id: "pi",       label: "Pi",                   bin: "pi",       modelFlag: "--model", autoFlag: "--auto",                         promptDelivery: "positional",  installCommand: "npm install -g @pi-dev/cli" }),
  Object.freeze({ id: "copilot",  label: "Copilot CLI",          bin: "copilot",  modelFlag: "--model", autoFlag: "--allow-all",                    promptDelivery: "positional",  installCommand: "npm install -g @github/copilot-cli" }),
]);

const BY_ID = Object.freeze(Object.fromEntries(CLI_ENGINE_PRESETS.map((p) => [p.id, p])));

/** hasOwnProperty (not `in`) so prototype keys can never resolve — registry.mjs law. */
export function cliEnginePreset(id) {
  return Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : null;
}

/** PATH-detect one binary. execFile, no shell; the bin string comes from the frozen
 *  table, never from a caller. Resolves { found, path }. */
function whichOne(bin, whichFn) {
  return new Promise((resolveP) => {
    whichFn("which", [bin], (err, stdout) => {
      const p = String(stdout || "").trim().split("\n")[0] || "";
      resolveP(err || !p ? { found: false, path: null } : { found: true, path: p });
    });
  });
}

/**
 * Detect every preset engine on PATH. Injectable `which` for tests. Returns rows in
 * table order: [{ id, label, bin, found, path, promptDelivery, installCommand }].
 */
export async function detectEngines({ which = execFile } = {}) {
  const rows = [];
  for (const p of CLI_ENGINE_PRESETS) {
    const d = await whichOne(p.bin, which);
    rows.push({ id: p.id, label: p.label, bin: p.bin, found: d.found, path: d.path, promptDelivery: p.promptDelivery, installCommand: p.installCommand || null, docsUrl: p.docsUrl || null });
  }
  return rows;
}

/**
 * A cached detector: detection shells out N times, so callers get a snapshot that
 * refreshes at most once per ttlMs (route reads) plus an explicit refresh(). Emits
 * `engine.roster` (identity: detected/total) ONLY when the detected set changes.
 */
export function createEngineDetector(deps = {}) {
  const which = deps.which || execFile;
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const ttlMs = Number.isFinite(Number(deps.ttlMs)) && Number(deps.ttlMs) > 0 ? Number(deps.ttlMs) : 60_000;

  let rows = null;
  let at = 0;
  let lastSig = "";
  let inflight = null;

  async function refresh() {
    if (inflight) return inflight; // coalesce concurrent refreshes
    inflight = (async () => {
      const next = await detectEngines({ which });
      rows = next; at = now();
      const sig = next.filter((r) => r.found).map((r) => r.id).sort().join(",");
      if (sig !== lastSig) {
        lastSig = sig;
        try { emit("engine.roster", { detected: next.filter((r) => r.found).length, total: next.length }); }
        catch { /* bus is observational */ }
      }
      inflight = null;
      return next;
    })();
    return inflight;
  }

  async function snapshot() {
    if (!rows || now() - at > ttlMs) await refresh();
    return { at, engines: rows };
  }

  return { refresh, snapshot, presets: CLI_ENGINE_PRESETS };
}

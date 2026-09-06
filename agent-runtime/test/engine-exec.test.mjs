// MUNDER-ADOPTION A1-FINISH — engine-exec invariants, pinned. The load-bearing one is
// the BYTE-PIN: claude argv must equal the historical literal exactly, or the refactor
// moved the proven path while claiming not to. Plus a REAL-PROCESS proof: the codex
// adapter drives an executable stub binary end-to-end (spawn → stdin prompt → JSONL
// stream → normalized result), which is the actual integration risk — the real codex
// CLI is NOT installed on this machine, and that is disclosed, not simulated away.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SUPPORTED_SPAWN_ENGINES, resolveSpawnEngine, buildEngineArgs, parseCodexLine,
} from "../providers/engine-exec.mjs";

// ── resolveSpawnEngine ───────────────────────────────────────────────────────

test("default and 'claude' resolve to claude, unforced", () => {
  assert.deepEqual(SUPPORTED_SPAWN_ENGINES, ["claude", "codex"]);
  for (const env of [{}, { RUNTIME_CLI_ENGINE: "" }, { RUNTIME_CLI_ENGINE: "claude" }, { RUNTIME_CLI_ENGINE: " CLAUDE " }]) {
    const r = resolveSpawnEngine(env);
    assert.equal(r.id, "claude");
    assert.equal(r.forced, false);
  }
});

test("'codex' resolves to codex; unsupported preset ids fail SAFE to claude with a warn", () => {
  assert.equal(resolveSpawnEngine({ RUNTIME_CLI_ENGINE: "codex" }).id, "codex");
  const warns = [];
  const r = resolveSpawnEngine({ RUNTIME_CLI_ENGINE: "grok" }, { log: (m) => warns.push(m) });
  assert.equal(r.id, "claude");
  assert.equal(r.forced, true);
  assert.match(warns[0], /not spawnable/);
  assert.equal(resolveSpawnEngine({ RUNTIME_CLI_ENGINE: "no-such" }, { log: () => {} }).id, "claude");
});

// ── argv ─────────────────────────────────────────────────────────────────────

test("BYTE-PIN: claude argv is exactly the historical engineDispatch shape", () => {
  const args = buildEngineArgs({
    engineId: "claude", modelId: "claude-sonnet-4", allowedTools: ["Write", "Edit"],
    strictMcp: true, workdir: "/tmp/wt", permissionMode: "acceptEdits",
  });
  assert.deepEqual(args, [
    "-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--no-session-persistence",
    "--model", "claude-sonnet-4",
    "--allowed-tools", "Write", "--allowed-tools", "Edit",
    "--strict-mcp-config",
    "--add-dir", "/tmp/wt", "--permission-mode", "acceptEdits",
  ]);
  // no model, no strict, no tools — flags simply absent, order preserved
  assert.deepEqual(buildEngineArgs({ engineId: "claude", workdir: "/w" }), [
    "-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--no-session-persistence",
    "--add-dir", "/w", "--permission-mode", "acceptEdits",
  ]);
});

test("codex argv follows the documented exec contract; prompt rides stdin via '-'", () => {
  assert.deepEqual(buildEngineArgs({ engineId: "codex", modelId: "gpt-5-codex", workdir: "/tmp/wt" }), [
    "exec", "--json", "--model", "gpt-5-codex", "--cd", "/tmp/wt", "--sandbox", "workspace-write", "--skip-git-repo-check", "-",
  ]);
  const noModel = buildEngineArgs({ engineId: "codex", workdir: "/w" });
  assert.ok(!noModel.includes("--model"));
  assert.equal(noModel[noModel.length - 1], "-");
});

// ── codex stream parsing ─────────────────────────────────────────────────────

test("agent_message → delta; other items ignored", () => {
  assert.deepEqual(parseCodexLine({ type: "item.completed", item: { type: "agent_message", text: "Done." } }),
    [{ kind: "delta", text: "Done." }]);
  assert.deepEqual(parseCodexLine({ type: "item.completed", item: { type: "command_execution", text: "ls" } }), []);
  assert.deepEqual(parseCodexLine({ type: "thread.started", thread_id: "t1" }), []);
  assert.deepEqual(parseCodexLine(null), []);
});

test("turn.completed maps usage into CLAUDE key shape, cached share SUBTRACTED from input", () => {
  const [r] = parseCodexLine({ type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } });
  assert.equal(r.kind, "result");
  assert.equal(r.isError, false);
  assert.deepEqual(r.usage, {
    input_tokens: 315, cache_read_input_tokens: 24448, cache_creation_input_tokens: 0, output_tokens: 122,
  });
  // cached > input can never yield negative input
  const [g] = parseCodexLine({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 9, output_tokens: 1 } });
  assert.equal(g.usage.input_tokens, 0);
});

test("turn.failed / error → isError result; rate-limit strings flagged for the 429 backoff", () => {
  const [f] = parseCodexLine({ type: "turn.failed", error: { message: "model response stream ended unexpectedly" } });
  assert.equal(f.isError, true);
  assert.equal(f.rateLimited, false);
  const [rl] = parseCodexLine({ type: "error", message: "Too Many Requests (429): usage limit reached" });
  assert.equal(rl.isError, true);
  assert.equal(rl.rateLimited, true);
});

// ── REAL-PROCESS proof: stub codex binary end-to-end ─────────────────────────

test("stub `codex` binary: spawn with built argv, prompt on stdin, stream parsed to text+usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-codex-stub-"));
  try {
    const bin = join(dir, "codex");
    // The stub asserts its OWN contract: first arg must be `exec`, last must be `-`;
    // it echoes a marker proving the prompt actually arrived on stdin.
    writeFileSync(bin, `#!/bin/sh
[ "$1" = "exec" ] || { echo '{"type":"error","message":"argv broke: no exec subcommand"}'; exit 2; }
prompt=$(cat)
printf '%s\\n' '{"type":"thread.started","thread_id":"t-stub"}'
printf '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"stub saw: '"$(printf %s "$prompt" | head -c 20)"'"}}\\n'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":900,"output_tokens":42}}'
`, { mode: 0o755 });
    chmodSync(bin, 0o755);

    const args = buildEngineArgs({ engineId: "codex", modelId: "gpt-5-codex", workdir: dir });
    const out = await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      let acc = "", buf = "", usage = null, err = null;
      child.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          const s = line.trim(); if (!s) continue;
          let o; try { o = JSON.parse(s); } catch { continue; }
          for (const ev of parseCodexLine(o)) {
            if (ev.kind === "delta") acc += ev.text;
            else if (ev.kind === "result") { usage = ev.usage ?? usage; if (ev.isError) err = ev.text; }
          }
        }
      });
      child.on("error", reject);
      child.on("close", () => resolve({ acc, usage, err }));
      child.stdin.write("TASK from BOSS: prove the pipe\n");
      child.stdin.end();
    });

    assert.equal(out.err, null);
    assert.match(out.acc, /^stub saw: TASK from BOSS/);
    assert.deepEqual(out.usage, { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 42 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

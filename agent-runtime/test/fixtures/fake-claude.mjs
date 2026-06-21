#!/usr/bin/env node
// Test fixture: a fake `claude` binary. Records the argv it was spawned with + the
// contents of any --mcp-config file, then emits one stream-json `result` line so the
// runtime's cliReply completes. Lets tests assert MCP injection deterministically
// without the real CLI / network.
import { writeFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
let mcpConfig = null;
const i = args.indexOf("--mcp-config");
if (i >= 0 && args[i + 1]) {
  try { mcpConfig = JSON.parse(readFileSync(args[i + 1], "utf-8")); } catch { /* */ }
}
const out = process.env.FAKE_CLAUDE_OUT;
if (out) {
  try { writeFileSync(out, JSON.stringify({ args, mcpConfig, mcpConfigPath: i >= 0 ? args[i + 1] : null })); } catch { /* */ }
}
// Optionally echo the injected cred values back as assistant text — to test that the
// runtime egress-scrubs them before they reach the SSE client (ADR-033).
function injectedSecrets() {
  const out = [];
  for (const srv of Object.values(mcpConfig?.mcpServers || {})) {
    for (const v of Object.values(srv.env || {})) out.push(v);
    for (const v of Object.values(srv.headers || {})) out.push(v);
  }
  return out;
}
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_ECHO) {
    for (const s of injectedSecrets()) {
      // stream_event content_block_delta → cliReply forwards via stream.token (scrubbed)
      process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: `the secret is ${s}` } } }) + "\n");
    }
  }
  process.stdout.write(JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }) + "\n");
  process.exit(0);
});

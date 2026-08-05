// electron/test/runtime-supervisor-drain.test.mjs
// P10 — proves the supervisor DRAINS the runtime child's stdio pipes.
//
// The prod bug: runtime-supervisor.js spawns with stdio:['ignore','pipe','pipe']
// and nothing reads stdout/stderr. Once the ~64KB OS pipe buffer fills, the packaged
// runtime BLOCKS on console.* forever. Health rides HTTP (waitHealthy → fetch), not
// stdout, so draining is safe.
//
// This test uses a REAL spawn of a throwaway script (NOT the real app) that floods
// stdout past the pipe buffer, then — only once the write actually FLUSHES — drops a
// marker file. If the parent does not drain, the write callback never fires, the
// marker never appears, and the assertion fails. That is exactly the hang.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSupervisor } from "../runtime-supervisor.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("drains child stdout so a >128KB logger does not hang the parent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-sup-drain-"));
  const script = join(dir, "flood.mjs");
  const marker = join(dir, "flushed.marker");
  // 200KB >> the ~64KB macOS/Linux pipe buffer, so the write callback only fires
  // if SOMETHING on the parent side is reading the pipe.
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
const big = "x".repeat(200 * 1024);
process.stdout.write(big, () => { writeFileSync(${JSON.stringify(marker)}, "ok"); });
setInterval(() => {}, 1000);
`,
  );

  const sup = createSupervisor({
    spawn,
    fetch: async () => ({ ok: true }), // no health server in a throwaway spawn
    serverPath: script,
    env: { PATH: process.env.PATH }, // child needs PATH to resolve "node"
    port: 3999,
    intervalMs: 1,
  });

  try {
    await sup.start();
    const deadline = Date.now() + 6000;
    let flushed = false;
    while (Date.now() < deadline) {
      if (existsSync(marker)) { flushed = true; break; }
      await sleep(50);
    }
    assert.ok(
      flushed,
      "child's >128KB stdout write never flushed — the parent is not draining the pipe (the prod hang)",
    );
  } finally {
    sup.stop();
    await sleep(50);
    rmSync(dir, { recursive: true, force: true });
  }
});

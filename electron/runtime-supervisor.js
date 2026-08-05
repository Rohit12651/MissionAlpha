// electron/runtime-supervisor.js — supervise the agent-runtime child.
// Pure DI (spawn/fetch injected) → unit-testable. main.js wires real node:child_process spawn + global fetch.
export function createSupervisor({ spawn, fetch, serverPath, env = {}, port = 3005, retries = 10, intervalMs = 300, logCap = 64 * 1024 }) {
  let child = null, up = false, stopping = false;
  const crashCbs = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const healthUrl = `http://127.0.0.1:${port}/runtime/health`;

  // The runtime child is spawned with piped stdout/stderr. If NOTHING reads those
  // pipes, the OS buffer (~64KB) fills and the child BLOCKS on its next console.*
  // FOREVER — the packaged-app hang. Health rides HTTP (waitHealthy), never stdout,
  // so we discard the stream while keeping a capped tail for crash diagnostics.
  let logTail = "";
  const appendTail = (chunk) => {
    logTail += chunk;
    if (logTail.length > logCap) logTail = logTail.slice(logTail.length - logCap);
  };
  const drain = (stream) => {
    if (!stream || typeof stream.on !== "function") return; // DI mock has no streams
    try { stream.setEncoding?.("utf8"); } catch { /* */ }
    stream.on("data", appendTail);
    stream.on("error", () => { /* pipe torn down on child exit — never throw */ });
  };

  async function waitHealthy() {
    for (let i = 0; i < retries; i++) {
      try { const r = await fetch(healthUrl); if (r && r.ok) { up = true; return; } } catch { /* not up yet */ }
      await sleep(intervalMs);
    }
    throw new Error(`runtime health did not come up on :${port} after ${retries} tries`);
  }

  function spawnChild() {
    logTail = "";                    // fresh tail per child so crash diagnostics are this run's
    child = spawn("node", [serverPath], { env: { ...env }, stdio: ["ignore", "pipe", "pipe"] });
    drain(child.stdout);             // MUST read the pipes or the child blocks once they fill
    drain(child.stderr);
    child.on("exit", (code) => {
      up = false;
      if (stopping) return;          // intentional → no respawn
      const tail = logTail;
      for (const cb of crashCbs) { try { cb(code, tail); } catch { /* */ } }
      spawnChild();                  // bounded by process lifetime; main.js can cap if needed
    });
  }

  return {
    async start() { stopping = false; spawnChild(); await waitHealthy(); },
    stop() { stopping = true; up = false; if (child) { try { child.kill("SIGTERM"); } catch { /* */ } } },
    isUp() { return up; },
    onCrash(cb) { crashCbs.push(cb); },
    tail() { return logTail; },      // capped diagnostics tail (last ~logCap bytes)
  };
}

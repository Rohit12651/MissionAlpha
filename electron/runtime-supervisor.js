// electron/runtime-supervisor.js — supervise the agent-runtime child.
// Pure DI (spawn/fetch injected) → unit-testable. main.js wires real node:child_process spawn + global fetch.
export function createSupervisor({ spawn, fetch, serverPath, env = {}, port = 3005, retries = 10, intervalMs = 300 }) {
  let child = null, up = false, stopping = false;
  const crashCbs = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const healthUrl = `http://127.0.0.1:${port}/runtime/health`;

  async function waitHealthy() {
    for (let i = 0; i < retries; i++) {
      try { const r = await fetch(healthUrl); if (r && r.ok) { up = true; return; } } catch { /* not up yet */ }
      await sleep(intervalMs);
    }
    throw new Error(`runtime health did not come up on :${port} after ${retries} tries`);
  }

  function spawnChild() {
    child = spawn("node", [serverPath], { env: { ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.on("exit", (code) => {
      up = false;
      if (stopping) return;          // intentional → no respawn
      for (const cb of crashCbs) { try { cb(code); } catch { /* */ } }
      spawnChild();                  // bounded by process lifetime; main.js can cap if needed
    });
  }

  return {
    async start() { stopping = false; spawnChild(); await waitHealthy(); },
    stop() { stopping = true; up = false; if (child) { try { child.kill("SIGTERM"); } catch { /* */ } } },
    isUp() { return up; },
    onCrash(cb) { crashCbs.push(cb); },
  };
}

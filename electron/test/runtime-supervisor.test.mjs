// electron/test/runtime-supervisor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSupervisor } from "../runtime-supervisor.js";

function mockChild() { const c = new EventEmitter(); c.kill = (sig) => { c.killed = sig || "SIGTERM"; }; return c; }

test("start() spawns server and resolves when health goes ok", async () => {
  const child = mockChild();
  let healthCalls = 0;
  const sup = createSupervisor({
    spawn: () => child,
    fetch: async () => ({ ok: ++healthCalls >= 2 }), // first not-ok, second ok
    serverPath: "/x/server.mjs", env: {}, port: 3005, intervalMs: 1,
  });
  await sup.start();
  assert.equal(sup.isUp(), true);
  assert.ok(healthCalls >= 2);
});

test("start() throws if health never comes up within retries", async () => {
  const sup = createSupervisor({
    spawn: () => mockChild(), fetch: async () => ({ ok: false }),
    serverPath: "/x", env: {}, port: 3005, retries: 3, intervalMs: 1,
  });
  await assert.rejects(() => sup.start(), /health/i);
});

test("stop() sends SIGTERM and prevents respawn", async () => {
  let spawnCount = 0;
  const children = [];
  const sup = createSupervisor({
    spawn: () => { spawnCount++; const c = mockChild(); children.push(c); return c; },
    fetch: async () => ({ ok: true }),
    serverPath: "/x", env: {}, port: 3005, intervalMs: 1,
  });
  await sup.start();
  const child = children[0];
  sup.stop();
  assert.equal(child.killed, "SIGTERM");
  // emit exit AFTER stop() → must NOT trigger a second spawn
  child.emit("exit", 0);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(spawnCount, 1, "no respawn after stop()");
});

test("crash (exit before stop) fires onCrash and respawns", async () => {
  let spawns = 0; const children = [];
  const sup = createSupervisor({
    spawn: () => { spawns++; const c = mockChild(); children.push(c); return c; },
    fetch: async () => ({ ok: true }), serverPath: "/x", env: {}, port: 3005, intervalMs: 1, retries: 5,
  });
  let crashed = 0; sup.onCrash(() => crashed++);
  await sup.start();
  children[0].emit("exit", 1); // crash
  await new Promise(r => setTimeout(r, 10));
  assert.equal(crashed, 1);
  assert.ok(spawns >= 2, "respawned after crash");
  sup.stop();
});

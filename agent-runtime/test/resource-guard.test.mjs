// Phase 1 / R2a — resource-guard tests.
//
// The load-bearing assertion in this file is REGRESSION-1: on a real macOS vm_stat
// sample, the guard's availability number must be dramatically higher than what
// os.freemem() reports. That is the ruflo bug reproduced as a test — if someone ever
// "simplifies" this module back to os.freemem(), this test fails.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseVmStat,
  parseMemInfo,
  readLoadPerCore,
  createResourceGuard,
  DEFAULT_MIN_AVAIL_PCT,
} from "../resource-guard.mjs";

// A real `vm_stat` sample shape (16GB box, heavily used, tiny free pool — the exact
// condition that makes os.freemem() report ~0.4%).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                5454.
Pages active:                            192074.
Pages inactive:                          187213.
Pages speculative:                         3804.
Pages throttled:                              0.
Pages wired down:                        140000.
Pages purgeable:                          40000.
"Translation faults":                 123456789.
Pages copy-on-write:                    1234567.
Pages zero filled:                     12345678.
Pages reactivated:                       123456.
Pages purged:                             12345.
File-backed pages:                       150000.
Anonymous pages:                         233091.
Pages stored in compressor:              500000.
Pages occupied by compressor:            120000.
`;

test("parseVmStat counts reclaimable classes, not just free pages", () => {
  const r = parseVmStat(VM_STAT);
  assert.ok(r, "should parse");
  // free+inactive+speculative+purgeable = 5454+187213+3804+40000 = 236471
  // total = 236471 + active(192074) + wired(140000) + compressor(120000) = 688545
  assert.equal(Math.round(r.availPct), 34);
});

test("REGRESSION-1: guard availability >> the os.freemem()-style ratio (the ruflo bug)", () => {
  const r = parseVmStat(VM_STAT);
  // What ruflo computes: free pages only, over total.
  const freeOnlyPct = (5454 / 688545) * 100;
  assert.ok(freeOnlyPct < 1, `sanity: free-only is ${freeOnlyPct.toFixed(2)}%`);
  assert.ok(
    r.availPct > 30,
    `guard must see real availability (${r.availPct.toFixed(2)}%), not the free-only ${freeOnlyPct.toFixed(2)}%`,
  );
  // And the floor that permanently blocked ruflo must be clearable here.
  assert.ok(r.availPct > DEFAULT_MIN_AVAIL_PCT);
});

test("parseVmStat returns null on garbage rather than guessing", () => {
  assert.equal(parseVmStat("not vm_stat output"), null);
  assert.equal(parseVmStat(""), null);
  assert.equal(parseVmStat(null), null);
});

test("parseMemInfo reads MemAvailable, not MemFree", () => {
  const r = parseMemInfo(`MemTotal:       16000000 kB
MemFree:          200000 kB
MemAvailable:    8000000 kB
Buffers:          100000 kB
`);
  assert.equal(Math.round(r.availPct), 50);
  assert.equal(parseMemInfo("garbage"), null);
});

test("readLoadPerCore divides by core count", () => {
  const v = readLoadPerCore({ loadavg: () => [4, 3, 2], cpuCount: 8 });
  assert.equal(v, 0.5);
  assert.equal(readLoadPerCore({ loadavg: () => [], cpuCount: 8 }), null);
});

test("canRun defers when measured availability is under the floor", async () => {
  const guard = createResourceGuard({
    platform: "darwin",
    exec: (_b, _a, _o, cb) => cb(null, `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                1000.
Pages active:                            500000.
Pages inactive:                            2000.
Pages speculative:                            0.
Pages purgeable:                              0.
Pages wired down:                        100000.
Pages occupied by compressor:             50000.
`),
    loadavg: () => [1, 1, 1],
    cpuCount: 8,
  });
  const r = await guard.canRun();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "memory");
  assert.ok(r.detail.availPct < DEFAULT_MIN_AVAIL_PCT);
});

test("canRun clears on a healthy machine", async () => {
  const guard = createResourceGuard({
    platform: "darwin",
    exec: (_b, _a, _o, cb) => cb(null, VM_STAT),
    loadavg: () => [2, 2, 2],
    cpuCount: 8,
  });
  const r = await guard.canRun();
  assert.equal(r.ok, true);
  assert.equal(r.reason, "clear");
});

test("canRun defers on sustained load even when memory is fine", async () => {
  const guard = createResourceGuard({
    platform: "darwin",
    exec: (_b, _a, _o, cb) => cb(null, VM_STAT),
    loadavg: () => [32, 30, 28],
    cpuCount: 8,
  });
  const r = await guard.canRun();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "load");
});

test("FAIL-OPEN: a missing probe proceeds instead of wedging the loop forever", async () => {
  const guard = createResourceGuard({
    platform: "darwin",
    exec: (_b, _a, _o, cb) => cb(new Error("vm_stat: not found")),
    loadavg: () => [1, 1, 1],
    cpuCount: 8,
  });
  const r = await guard.canRun();
  assert.equal(r.ok, true, "an unavailable probe must NOT block autonomy (ruflo's failure mode)");
  assert.equal(r.reason, "degraded");
});

test("FAIL-OPEN: an unknown platform proceeds", async () => {
  const guard = createResourceGuard({ platform: "sunos", loadavg: () => [1, 1, 1], cpuCount: 4 });
  const r = await guard.canRun();
  assert.equal(r.ok, true);
  assert.equal(r.reason, "degraded");
});

test("a throwing probe never escapes status()", async () => {
  const guard = createResourceGuard({
    platform: "darwin",
    exec: () => { throw new Error("boom"); },
    loadavg: () => [1, 1, 1],
    cpuCount: 8,
  });
  const s = await guard.status();
  assert.equal(s.ok, true);
  assert.equal(s.reason, "degraded");
});

test("thresholds are configurable and reported", async () => {
  const guard = createResourceGuard({
    platform: "darwin",
    exec: (_b, _a, _o, cb) => cb(null, VM_STAT),
    loadavg: () => [1, 1, 1],
    cpuCount: 8,
    minAvailPct: 90,
  });
  const r = await guard.canRun();
  assert.equal(r.ok, false, "34% available must fail a 90% floor");
  const s = await guard.status();
  assert.equal(s.minAvailPct, 90);
});

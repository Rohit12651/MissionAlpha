// Phase 1 / R2a — the RESOURCE GUARD. Answers one question before an autonomous tick
// spends anything: "does this machine have room to run a background worker right now?"
//
// WHY THIS MODULE EXISTS AT ALL (the measured bug it is a direct answer to):
//   ruflo's daemon ships the same guard and it is DEAD ON ARRIVAL on macOS. Measured on
//   this machine 2026-08-18: its 5 enabled workers deferred 5/5 on first tick, forever,
//   reporting "Memory too low: 0.4% free" while the OS reported 40% available. Root
//   cause, verified in its source and reproduced directly: it computes
//   `os.freemem() / os.totalmem()`. On macOS `os.freemem()` counts ONLY vm_stat "Pages
//   free" — it excludes inactive, purgeable and compressed pages, which the kernel
//   reclaims on demand and which macOS deliberately keeps near zero because free RAM is
//   wasted RAM. So on any Mac that has been up more than a few minutes that ratio is
//   ~0.4%, and a 5% floor can never be cleared. The daemon runs and accomplishes nothing.
//
// THE RULE THIS MODULE ENFORCES: **never os.freemem()**. Availability is read from the
// platform's own availability metric — vm_stat's reclaimable classes on darwin,
// MemAvailable on linux — and only those numbers are compared against a floor.
//
// FAIL-OPEN, NOT FAIL-CLOSED. If the probe is missing, unparseable, or slow, this returns
// ok:true with a `degraded` reason and lets the tick proceed. That is the OPPOSITE of
// ruflo's posture and it is deliberate: a guard whose own failure silently wedges the
// autonomy loop forever is a worse outcome than a tick that runs on a busy machine. The
// queue, the engine and the per-agent serialization are the real backpressure; this is a
// courtesy check, so it degrades toward doing the work.
//
// SECURITY: probes run through execFile with an ARGV ARRAY and shell:false (the
// quality.mjs law) against a CLOSED set of absolute-name binaries. No shell exists to
// interpret a metacharacter, and no operator input reaches this module at all — the
// thresholds are numbers, never commands.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";

/** Floor for available memory, percent of total. Below this a tick defers. */
export const DEFAULT_MIN_AVAIL_PCT = 10;
/** Ceiling for 1-minute load average expressed PER CORE. Above this a tick defers. */
export const DEFAULT_MAX_LOAD_PER_CORE = 1.5;
/** A probe that has not answered by now is treated as absent (fail-open). */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * Parse `vm_stat` output into an availability ratio.
 *
 * macOS page classes and why each is counted:
 *   free        — unallocated, immediately usable.
 *   inactive    — clean pages backing files/anon that the kernel evicts on demand.
 *   speculative — read-ahead, dropped under any pressure.
 *   purgeable   — explicitly volatile; the kernel may discard at will.
 * NOT counted: active, wired down (in use), compressed (already-compressed occupancy).
 *
 * Returns null on anything unparseable so the caller can fail open rather than guess.
 */
export function parseVmStat(text) {
  if (typeof text !== "string" || !text) return null;
  const pageSize = /page size of (\d+) bytes/.exec(text);
  if (!pageSize) return null;
  const bytesPerPage = Number(pageSize[1]);
  if (!Number.isFinite(bytesPerPage) || bytesPerPage <= 0) return null;

  const pagesFor = (label) => {
    const m = new RegExp(`${label}:\\s+(\\d+)`).exec(text);
    return m ? Number(m[1]) : 0;
  };
  const free = pagesFor("Pages free");
  const inactive = pagesFor("Pages inactive");
  const speculative = pagesFor("Pages speculative");
  const purgeable = pagesFor("Pages purgeable");
  const active = pagesFor("Pages active");
  const wired = pagesFor("Pages wired down");
  const compressed = pagesFor("Pages occupied by compressor");

  const availablePages = free + inactive + speculative + purgeable;
  const totalPages = availablePages + active + wired + compressed;
  if (totalPages <= 0) return null;

  return {
    availableBytes: availablePages * bytesPerPage,
    totalBytes: totalPages * bytesPerPage,
    availPct: (availablePages / totalPages) * 100,
  };
}

/** Parse /proc/meminfo. MemAvailable is the kernel's own reclaimable estimate. */
export function parseMemInfo(text) {
  if (typeof text !== "string" || !text) return null;
  const kb = (label) => {
    const m = new RegExp(`^${label}:\\s+(\\d+) kB`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  const avail = kb("MemAvailable");
  const total = kb("MemTotal");
  if (!Number.isFinite(avail) || !Number.isFinite(total) || total <= 0) return null;
  return {
    availableBytes: avail * 1024,
    totalBytes: total * 1024,
    availPct: (avail / total) * 100,
  };
}

function run(bin, args, { exec = execFile, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      // argv array + shell:false — no shell, no metacharacter interpretation (quality.mjs law).
      exec(bin, args, { timeout: timeoutMs, shell: false, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : String(stdout || ""));
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Read memory availability for the current platform.
 * Returns null when unavailable — the caller MUST treat null as "unknown", never as zero.
 */
export async function readMemory(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === "darwin") {
    const out = await run("vm_stat", [], deps);
    return parseVmStat(out);
  }
  if (platform === "linux") {
    const read = deps.readFile || readFile;
    try {
      return parseMemInfo(String(await read("/proc/meminfo", "utf8")));
    } catch {
      return null;
    }
  }
  return null; // unknown platform → unknown, and unknown fails open
}

/** 1-minute load average per core. Null when the platform does not report one. */
export function readLoadPerCore(deps = {}) {
  const loadavg = deps.loadavg || os.loadavg;
  const cpus = deps.cpuCount ?? (deps.cpus || os.cpus)().length;
  const one = Array.isArray(loadavg()) ? loadavg()[0] : null;
  if (!Number.isFinite(one) || !Number.isFinite(cpus) || cpus <= 0) return null;
  return one / cpus;
}

/**
 * Create the guard.
 *
 * canRun() → { ok, reason, detail } where:
 *   ok:true  + reason:'clear'     — both probes read and both are within bounds.
 *   ok:true  + reason:'degraded'  — a probe was unavailable; failing OPEN on purpose.
 *   ok:false + reason:'memory'    — measured availability under the floor.
 *   ok:false + reason:'load'      — measured load per core over the ceiling.
 */
export function createResourceGuard(deps = {}) {
  const minAvailPct = Number(deps.minAvailPct ?? process.env.RUNTIME_GUARD_MIN_AVAIL_PCT ?? DEFAULT_MIN_AVAIL_PCT);
  const maxLoadPerCore = Number(deps.maxLoadPerCore ?? process.env.RUNTIME_GUARD_MAX_LOAD_PER_CORE ?? DEFAULT_MAX_LOAD_PER_CORE);
  const log = typeof deps.log === "function" ? deps.log : () => {};

  async function snapshot() {
    const [mem, loadPerCore] = await Promise.all([
      readMemory(deps).catch(() => null),
      Promise.resolve().then(() => { try { return readLoadPerCore(deps); } catch { return null; } }),
    ]);
    return { mem, loadPerCore };
  }

  async function canRun() {
    const { mem, loadPerCore } = await snapshot();

    // Unknown memory is UNKNOWN, never zero. This is the precise line ruflo gets wrong.
    if (!mem) {
      log("[guard] memory probe unavailable — proceeding (fail-open)");
      return { ok: true, reason: "degraded", detail: { probe: "memory", availPct: null, loadPerCore } };
    }
    if (mem.availPct < minAvailPct) {
      return {
        ok: false,
        reason: "memory",
        detail: { availPct: Number(mem.availPct.toFixed(2)), minAvailPct, loadPerCore },
      };
    }
    if (Number.isFinite(loadPerCore) && loadPerCore > maxLoadPerCore) {
      return {
        ok: false,
        reason: "load",
        detail: { loadPerCore: Number(loadPerCore.toFixed(2)), maxLoadPerCore, availPct: Number(mem.availPct.toFixed(2)) },
      };
    }
    return {
      ok: true,
      reason: "clear",
      detail: { availPct: Number(mem.availPct.toFixed(2)), loadPerCore: Number.isFinite(loadPerCore) ? Number(loadPerCore.toFixed(2)) : null },
    };
  }

  /** Shape the doctor check consumes. Never throws. */
  async function status() {
    try {
      const r = await canRun();
      return { ok: r.ok, reason: r.reason, ...r.detail, minAvailPct, maxLoadPerCore };
    } catch (e) {
      return { ok: true, reason: "degraded", error: e?.message || "probe failed", minAvailPct, maxLoadPerCore };
    }
  }

  return { canRun, status, minAvailPct, maxLoadPerCore };
}

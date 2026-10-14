// Every claude / engine CLI child the runtime starts, and what happens to them when it stops.
//
// Observed 2026-09-27: `kill <server pid>` exited the runtime and left the seat it had just
// dispatched running as an orphan (PPID 1), still spending. The server had no signal handler, and
// its children shared its process group, so nothing told them.
//
// spawnSeat starts each child DETACHED — the leader of its own process group — so one signal to
// `-pid` reaches the CLI and everything it started (MCP servers, Bash tool commands). On SIGTERM /
// SIGINT the handler signals every live group (SIGTERM, a short grace, SIGKILL for survivors) and
// exits SYNCHRONOUSLY: no child `exit`/`close` handler gets an event-loop turn, so an in-flight task
// row stays claimed/EDITING — the state the P4 boot reconcile re-queues — instead of being recorded
// as a failed attempt. Per-task kills (kill-switch, timeouts, STOP) use killGroup for the same reason:
// signalling only the leader would orphan the seat's subprocesses. Pinned by SHUT-1…6.
import { spawn } from "node:child_process";

const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 };
const DEFAULT_GRACE_MS = 500;

export function createSeatChildren({ spawnFn = spawn } = {}) {
  const live = new Set();
  function spawnSeat(bin, args, opts = {}) {
    const child = spawnFn(bin, args, { ...opts, detached: true });
    live.add(child);
    child.once("exit", () => live.delete(child));
    child.once("error", () => live.delete(child));
    return child;
  }
  /** Signal every live group; returns how many groups still had a member. */
  function signalAll(signal) {
    let reached = 0;
    for (const c of live) {
      if (!c.pid) continue;
      try { process.kill(-c.pid, signal); reached++; } catch { /* group already gone */ }
    }
    return reached;
  }
  /** Signal a seat's whole group (the CLI and every subprocess it started). A dead group is a no-op. */
  function killGroup(child, signal) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
  }
  return { spawnSeat, signalAll, killGroup, get size() { return live.size; } };
}

// ponytail: a blocking sleep on the main thread — acceptable only because the process is exiting
// and must not yield to child handlers first.
const sleepSync = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Register SIGTERM/SIGINT: kill every live seat group, then exit with 128 + signal. Once only. */
export function installShutdown(children, { proc = process, exit = (code) => process.exit(code), graceMs = DEFAULT_GRACE_MS } = {}) {
  let done = false;
  const onSignal = (signal) => {
    if (done) return;
    done = true;
    if (children.signalAll("SIGTERM") > 0) {
      sleepSync(graceMs);
      children.signalAll("SIGKILL");
    }
    exit(SIGNAL_EXIT[signal]);
  };
  for (const signal of Object.keys(SIGNAL_EXIT)) proc.on(signal, () => onSignal(signal));
}

/** The one registry the server and the factory share. */
export const seatChildren = createSeatChildren();

// Phase E · Task 17 — the ONE place the runtime runs a script out of the target repo.
//
// `scripts/agent-heartbeat.sh` and `scripts/agent-sync.sh` are MissionAlpha's swarm bus. They
// live in the TARGET repo's tree, so on a repo someone else wrote they are that author's code,
// run with bash on the host on every apply, escalation and hire. Trusted only when the target
// IS this runtime's own repo, or when the operator sets RUNTIME_ALLOW_REPO_SCRIPTS=1 (the
// literal 1; anything else stays closed). Otherwise the event goes to the in-process bus.
//
// CORE_GUARD: an agent able to edit this file could open the gate for every later target.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function createRepoScripts({
  repoRoot,
  selfRoot = SELF_ROOT,
  allow = process.env.RUNTIME_ALLOW_REPO_SCRIPTS === "1",
  spawnFn = spawn,
  exists = existsSync,
  emit = () => {},
} = {}) {
  const trusted = allow || resolve(repoRoot) === resolve(selfRoot);
  return {
    trusted,
    run(script, args = []) {
      const argv = args.map(String);
      if (!trusted) { emit("bus.script-skipped", { script, args: argv }); return false; }
      const file = join(repoRoot, "scripts", script);
      if (!exists(file)) return false; // F5 — a trusted repo without the bus scripts
      const failed = (e) => emit("bus.script-failed", { script, error: String(e?.message || e).slice(0, 200) });
      try {
        // spawn reports ENOENT as a LATER 'error' event; with no listener it would crash the server.
        spawnFn("bash", [file, ...argv], { stdio: "ignore", cwd: repoRoot }).on("error", failed);
        return true;
      } catch (e) {
        failed(e);
        return false;
      }
    },
  };
}

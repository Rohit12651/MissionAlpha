// 6.7 — SEAT SETTINGS GUARD (security review, HIGH).
//
// Engine seats run `claude -p` on the HOST with `--setting-sources project`, so the CLI reads
// `<workdir>/.claude/settings.json` (permissions.allow, hooks) from the worktree it is given.
// The snapshot never carries `.claude/` (SNAPSHOT_DENY), but a seat holds Write and can CREATE
// it; the 429-retry re-spawns into the SAME workdir, and would then load agent-authored
// settings — a host-side privilege escalation that no jail sees.
//
// Rule: a worktree may never contain `.claude/` at spawn time. This runs before EVERY spawn,
// retries included. Anything found is removed and reported; the caller treats a tampered
// worktree as a refusal, not a retry. Fail-closed: an unreadable workdir is reported too.
import { existsSync, rmSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const SEAT_SETTINGS_DIR = ".claude";

// ── 2026-09-05 — WHAT MAKES A `.claude/` HOSTILE ────────────────────────────
// The original rule was "any `.claude/` is tampering". `claude -p` creates `.claude/` in its
// own cwd as ordinary session state, so the retry sweep found the CLI's OWN directory and
// vetoed the spawn: EVERY engine task ended `empty-diff`, having authored nothing. Proven
// live and A/B'd across a roster seat and a non-roster agent, so it was not Phase 7's doing.
// A control with a 100% false-positive rate is an outage, not a control (addendum #21).
//
// The escalation 6.7 exists to stop is the CLI HONOURING agent-authored permissions or
// hooks. That needs one of these files. A session cache cannot escalate anything, so it is
// removed silently. The directory is ALWAYS removed either way — that part never changed.
const PERMISSION_BEARING = [
  /^settings(\.[a-z0-9-]+)?\.json$/i, // settings.json, settings.local.json
  /^hooks(\.json)?$/i,                 // hooks/ or hooks.json
];

/** True if a `.claude/` entry could change what the CLI is permitted to do. */
function isPermissionBearing(name) {
  return PERMISSION_BEARING.some((re) => re.test(name));
}

/** @returns {{ ok: true, tampered: false } | { ok: true, tampered: true, removed: string } | { ok: false, error: string }} */
export function sweepSeatSettings(workdir) {
  if (!workdir || typeof workdir !== "string") return { ok: false, error: "workdir required" };
  const target = join(workdir, SEAT_SETTINGS_DIR);
  try {
    const linked = isSymlink(target);
    if (!existsSync(target) && !linked) return { ok: true, tampered: false };

    // Decide BEFORE removing. A symlink is always hostile: the CLI's own cache is a real
    // directory it created in place, never a link pointing out of the worktree.
    let hostile = linked;
    let offender = linked ? `${SEAT_SETTINGS_DIR} (symlink)` : null;
    if (!hostile) {
      for (const name of readdirSync(target)) {
        if (isPermissionBearing(name)) { hostile = true; offender = name; break; }
      }
    }

    // ALWAYS removed, hostile or not — the CLI must never load anything out of the worktree.
    rmSync(target, { recursive: true, force: true });
    return hostile
      ? { ok: true, tampered: true, removed: target, offender }
      : { ok: true, tampered: false, removed: target };
  } catch (e) {
    return { ok: false, error: `could not sweep ${target}: ${e?.message || e}` };
  }
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

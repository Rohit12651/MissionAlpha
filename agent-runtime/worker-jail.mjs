// Phase E · Task 18 (Option 2, BOSS-approved 2026-09-24) — the worker jail.
//
// Workers run `claude -p` on the host. This puts their Bash (and every child it starts) inside
// the Claude CLI's own OS sandbox — Seatbelt on macOS, bubblewrap on Linux — passed per spawn with
// `--settings`. Writes: the worktree, `--add-dir` dirs and the session temp dir only. The model's
// `dangerouslyDisableSandbox` retry is ignored, and a sandbox that cannot start is a hard failure
// rather than a silent unsandboxed run. (code.claude.com/docs/en/sandboxing, checked 2026-09-24.)
//
// NOT covered, by the CLI's design: the Read/Edit/Write tools. Those stay bounded by `--add-dir`
// and the permission mode.
//
// Mode: RUNTIME_WORKER_JAIL=off ⇒ off. Unset ⇒ on exactly when the target is not trusted (Task 17's
// decision: a repo that is not MissionAlpha). Any other value ⇒ on — a typo fails closed.
//
// CORE_GUARD: an agent able to edit this file could unlock its own jail.
const DENY_READ = Object.freeze(["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh", "~/.claude/.credentials.json"]);

const SETTINGS = JSON.stringify({
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    filesystem: { denyRead: DENY_READ },
  },
});

export function workerJail({ env = process.env.RUNTIME_WORKER_JAIL, trusted } = {}) {
  const on = env === undefined ? !trusted : env !== "off";
  return {
    on,
    settings: on ? SETTINGS : null,
    warning: on ? null : "workers run on the host — their shell commands are not sandboxed (set RUNTIME_WORKER_JAIL=cli)",
  };
}

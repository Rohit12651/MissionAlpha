# Worker jail — design for the BOSS (Task 18)

**Status:** BOSS chose Option 2 on 2026-09-24; built in `agent-runtime/worker-jail.mjs`. Q2 (default on for foreign repos) implemented as recommended. JAIL-1 proven live — see the plan record.
Written 2026-09-24.

## The hole, stated plainly

Every worker seat runs `claude -p` **on the host**, with cwd = its git worktree. `applyAllowed`,
CORE_GUARD, writeScope and (Task 16) strict ship all guard what gets **landed**. None of them
guard what the child process **does while it runs**. A worker's Bash tool can
`echo x > ~/.zshrc`, `rm -rf ~/other-repo`, or read `~/.ssh/id_ed25519` and put it in a file it
then lands. The broker never sees those writes because they are outside the worktree.

`--add-dir <worktree>` + `--permission-mode` scope the Read/Edit/Write **tools**. They do not
bind a shell command.

## What the Claude CLI provides (docs checked 2026-09-24, code.claude.com/docs/en/sandboxing)

- A built-in **Bash sandbox**, OS-enforced: **Seatbelt** on macOS (nothing to install),
  **bubblewrap** (+ socat) on Linux/WSL2. Native Windows unsupported.
- Enabled per invocation with `--settings '{"sandbox": {...}}'` — no settings file needed.
- Default write set: cwd + subdirs, `--add-dir` dirs, the session temp dir. For a **linked git
  worktree** it also allows the main repo's shared `.git` (refs/index), still denying `.git/hooks`
  and `.git/config`.
- `allowUnsandboxedCommands: false` disables the model's `dangerouslyDisableSandbox` retry.
- `failIfUnavailable: true` makes a missing sandbox a hard failure instead of a silent unsandboxed run.
- `filesystem.denyRead` blocks reads (not blocked by default).
- Network allowlist via `network.allowedDomains` / `strictAllowlist`.
- **Scope:** Bash, PowerShell, Monitor **and their child processes** only. Read/Edit/Write tools
  are governed by permission rules, not the sandbox.
- `excludedCommands` run OUTSIDE the sandbox and array settings **merge across scopes** — so
  which setting sources the child loads matters.
- `docker` is incompatible with it (irrelevant: workers do not run docker).

## Options

| | 1. Docker jail (`sandbox.mjs`) | 2. CLI sandbox (`--settings`) | 3. Both, flag-selected |
|---|---|---|---|
| Boundary | Container: reads **and** writes, whole process | OS (Seatbelt/bwrap): Bash + children | Either |
| Covers Write/Edit tools | Yes | No — still permission rules (`--add-dir` scope) | Per choice |
| Cost to build | High: claude CLI + auth **inside** the image (mount credentials into the jail), worktree `.git` pointer needs the main repo mounted, image to maintain | Low: one JSON arg on the existing spawn | Sum of both |
| Runtime cost | Container start per turn on the macOS Docker VM (already the top CPU consumer on this host) | ~none | — |
| Failure mode | Docker down ⇒ no workers | Sandbox unavailable ⇒ refuse (with `failIfUnavailable`) | — |
| Credential exposure | Worse: account token must enter the container | Unchanged | — |

## Recommendation: Option 2 now, behind `RUNTIME_WORKER_JAIL=cli`

It closes the actual observed-risk path (a shell command writing or deleting outside the
worktree) with one argument, no new moving parts, and fails closed. Option 1's extra coverage
(reads, the edit tools) is real but costs a credential-in-container design and per-turn
container starts on a host that is already CPU-bound — and the edit tools are already scoped
by `--add-dir`.

Settings passed to every worker spawn when the flag is `cli`:

```json
{ "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "failIfUnavailable": true,
    "filesystem": { "denyRead": ["~/.ssh", "~/.aws", "~/.config/gh", "~/.claude/.credentials.json"] }
} }
```

And the spawn keeps `--setting-sources project` (the worktree's `.claude/` is already stripped by
`seat-settings-guard.mjs`), so the operator's user-level `excludedCommands` cannot widen a worker.

## Tests (red first)

- **JAIL-1** (plan wording adapted to option 2): with `RUNTIME_WORKER_JAIL=cli`, a Bash write to an
  absolute path outside the worktree fails and the file does not exist. Deterministic, no model:
  drive the same sandbox runtime the CLI uses against a fixture worktree. If that runtime is not
  callable without a model turn, JAIL-1 becomes a phase-exit live check and the unit test pins the
  argv (settings JSON present, escape hatch off, failIfUnavailable on).
- **JAIL-2**: flag off ⇒ readiness reports "workers run on the host" as a WARNING.
- **JAIL-3**: flag on + sandbox unavailable ⇒ the spawn is refused by name, never run unsandboxed.

## Open questions for the BOSS

1. Option 2 (recommended), 1, or 3?
2. Default the flag ON for foreign repos (RUNTIME_REPO_ROOT ≠ MissionAlpha) and OFF for
   MissionAlpha itself? (Recommended: yes — mirrors Task 17's trust rule.)
3. The `denyRead` list above: add anything?

## Known gaps even after Option 2

- Read/Edit/Write tools are NOT OS-sandboxed; they rely on `--add-dir` + permission mode.
- Network is unrestricted unless an allowlist is also set (not proposed here: npm installs need it).
- Linux hosts need `bubblewrap` + `socat` installed; `failIfUnavailable` turns their absence into a refusal.

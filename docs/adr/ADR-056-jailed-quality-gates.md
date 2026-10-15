# ADR-056 — Story quality gates run inside the Docker jail

- **Status:** ACCEPTED
- **Date:** 2026-08-04
- **Slug:** `jailed-quality-gates`
- **Plan:** Story-Pipeline S4 — quality-gate command execution (remediation)
- **Deciders:** senior-security-engineer (**BLOCKING gate — cleared by this ADR**), architect, senior-backend
- **Related:** ADR-037 (execution sandbox — the jail reused here), ADR-038 (tool-loop broker — same jail, same posture), ADR-026 (git worktree — the `/work` bind), quality.mjs / test-gate.mjs / story-reviewqa.mjs / sandbox.mjs

## Context — the finding

The S4 quality gates execute **agent-authored test code**: a build agent writes a diff into the worktree, and the gate then runs the repo's configured test command (`node --test`, `npm test`, `playwright test`, …) over that worktree. A malicious or prompt-injected build agent can plant a `*.test.js` that, when the gate runs it, reads `~/.aws` / `~/.ssh` and exfiltrates over the network.

The BLOCKING senior-security-engineer review found the gate runner (`createExecFileRunner` in `quality.mjs`, wired via `test-gate.mjs` and the QA/e2e path in `story-reviewqa.mjs`) ran that code **un-jailed** — a plain `execFile` on the host, with `HOME` present and the network open. This is the naive shape ADR-037's SECURITY LAW rejects: *a git worktree is not a security boundary; approval prompts stop accidents, not malice.* The program's OTHER execution path (the tool loop, ADR-038) was already Docker-jailed; the gate runner did not match it.

## Decision

Route BOTH story quality gates through the existing Docker jail (`sandbox.mjs`, `createSandbox().runInSandbox`) — the exact jail the tool-loop broker uses — instead of a host `execFile`:

- **`test-gate.mjs`** (unit-test gate) and **`story-reviewqa.mjs`** (QA/e2e gate) now call `sandbox.runInSandbox(mountDir, testCmd.join(" "), { network: false, timeoutMs })`.
- The container gives: `--network none` (no exfil), `--read-only` rootfs, non-root (`nobody`, uid 65534), `--cap-drop ALL`, `--security-opt no-new-privileges`, the realpath'd worktree as the ONLY writable/visible host path (no `~/.aws`, no `~/.ssh`, no `HOME`, no `process.env` / secrets), a disk cap, and `docker kill` on timeout.
- **`docker kill` nukes the whole container tree** on timeout, which also MOOTS the earlier process-group-orphan finding — there is no host child process group to leak.
- **Fail-closed when Docker is unavailable:** if `dockerAvailable()`/preflight is false, the gate FAILS (reason `sandbox-unavailable`) and the story blocks with a clear alert. There is **no** silent pass and **no** un-jailed host fallback. This matches the tool-loop posture.
- **Sandbox is dependency-injected**, so deterministic unit tests stay hermetic (a spy sandbox) without requiring a live daemon; the real (non-mock) path uses the same `sandbox` instance as the tool loop.

### Defense-in-depth kept BEFORE the sandbox

The validated-argv discipline in `quality.mjs` is retained as belt-and-suspenders (the container already contains any escape, but cheap layered checks stay):

- **allow-listed binary + `SAFE_ARG` per element** — so `testCmd.join(" ")` is a clean single string for the container's `sh -c` (no shell metachars to interpret).
- **cwd realpath guard (fix #3):** a `quality.json` `workdir` subdir is realpath-resolved and asserted to stay INSIDE the worktree root before it becomes the mount source, so a planted symlink cannot widen the mount scope pre-sandbox.
- **node-flag denylist (defense-in-depth):** the `node` binary rejects `-e`/`--eval`, `-r`/`--require`, `--import`, `--input-type`, and every `--experimental-*` flag, so an allow-listed `node` cannot be walked into arbitrary inline code or arbitrary module-file preload from the worktree.

`createExecFileRunner`/`minimalEnv` are retained in `quality.mjs` ONLY as a validated reference for hardened host exec (covered by `quality.test.mjs`) and for any future NON-agent, trusted-command path; they are OFF the story-gate path and must not be reintroduced as a fallback.

## Accepted residual & caveats

- **Target = single-operator / CI.** The jail is designed for the reference machine and CI, not a hostile multi-tenant host.
- **macOS Docker bind-permission caveat (already noted in `sandbox.mjs`):** the mount dir is `chmod 0o777`'d so the non-root container uid can write `/work`. On Linux/CI this is required; on macOS Docker it is cosmetic. The residual host-side exposure of that one dir is accepted for the single-operator/CI target. For the QA/e2e gate the mount is the repo root, so that single directory's mode is changed — acceptable on the operator's own machine.
- **Per-destination egress filtering is deferred** — `network:false` is a hard off, which is all the gates need (tests must not reach the network).
- **Exec image** is `node:24-alpine` (has node/npm/git and native TypeScript type stripping); a config that names a runner absent from the image (e.g. `playwright`) fails the gate honestly — an operator/config concern, not a containment gap.

## Consequences

- The gate now needs a reachable Docker daemon; without one, stories block (loud, not silent). This is the intended fail-closed behavior.
- Every gate run pays a `docker info` preflight + container start. Acceptable for the autonomy-critical safety it buys.
- The security review's BLOCK is cleared: agent test code can no longer read host secrets or exfiltrate — it runs with no host fs, no network, and no secrets.

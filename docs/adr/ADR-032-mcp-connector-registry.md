# ADR-032 — MCP Connector Registry & Per-Session Composition

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `mcp-connector-registry`
- **Plan:** STAGE 2.5 — MCP Connector Layer (gap #29)
- **Deciders:** architect, **owner (BOSS)**, senior-security-engineer (HARD gate on ADR-033), principal-db-engineer (store owner, consulted), senior-backend-1 (consulted)
- **Plugs into:** ADR-021 (credential broker reuse), ADR-022 (model-tier allowlist / argv-array spawn discipline), ADR-027 (file-based store conventions), ADR-033 (creds + allowlist — the security gate this ADR depends on)
- **Depends on:** ADR-033 sign-off is BLOCKING — this layer does not ship until 033 passes.

## Context

The runtime drives Claude via the **subscription `cli` path only** (`claude -p`, ADR-022 S2 ratification — the `api`/`mock` branches are dead-but-present, NOT a product surface). Today an agent spawned by `cliReply` (`agent-runtime/server.mjs` ~L477) gets a fixed tool set (`READ_TOOLS`/`WRITE_TOOLS` L92-93) and zero external connectors. There is no way for the BOSS to grant a specific agent an MCP server — a filesystem server scoped to a data dir, a hosted HTTP tool — without it leaking to every agent or pulling from the host's global `.mcp.json`.

GAP #29: a **per-agent MCP connector layer** — the BOSS registers connectors once, grants them to named agents, and at spawn the runtime composes a scoped `.mcp.json` containing **exactly** that agent's granted connectors, injected into the `claude -p` argv. Nothing global, nothing cross-agent.

**SPIKE RESULT (proven end-to-end, `claude` v2.1.140 — document this, not an assumption):** a scoped config `{ "mcpServers": { "fsspike": { "command":"npx", "args":["-y","@modelcontextprotocol/server-filesystem","/tmp/mcp-spike/data"] } } }` passed via `--mcp-config <path> --strict-mcp-config --allowedTools "mcp__fsspike__read_file ..."` produced an init event `"mcp_servers":[{"name":"fsspike","status":"pending"}]`, the agent emitted a `tool_use` named `mcp__fsspike__read_file`, and read back real file content. stdio transport confirmed. **`--strict-mcp-config` makes claude load ONLY the injected servers, ignoring all global/user `.mcp.json` + settings** — it is the per-agent allowlist enforcer at the claude layer. HTTP transport works via a config entry carrying `url` + `headers` (proven shape from `claude mcp add --transport http <url> --header "Authorization: Bearer ..."`). Unlisted MCP tools are auto-denied in `-p`.

The credential broker already exists (`agent-runtime/factory.mjs` — AES-256-GCM, ADR-021). Connector secrets **reuse it** (BOSS decision: no new secret store). The store conventions already exist (ADR-027 — gitignored dir, atomic write+rename, `0o600`, `safeId` keys). This ADR adds a connector registry + grant gate + a spawn-time composition step; the **security crux** (cred lifetime, command validation, double allowlist, egress scrub) is ADR-033 and is a HARD blocking gate.

## Decision

### 0. Scope — REUSED vs ADDED

```
REUSED  : cliReply argv-array spawn (server.mjs L515, no shell:true)         — MCP flags appended here
REUSED  : AES-256-GCM broker (factory.mjs encrypt/decrypt L416-428)          — connector secret storage (ADR-033)
REUSED  : RUNTIME_DIR = $TMPDIR/missionalpha-runtime (factory.mjs L57)        — scoped .mcp.json written here, OUTSIDE worktree
REUSED  : atomic write+rename + 0o600 (ADR-027; saveConnections L432-435)     — registry file crash-safety
REUSED  : server-minted id + charset sanitize (ID_RE L91; safeId L460)        — connectorId / name
REUSED  : originOk/tokenOk/hostOk auth gate (server.mjs L124/131; L1006)      — new routes use the SAME gate as /apply + /factory/*
REUSED  : scrub() egress filter (server.mjs L333) + factory.scrubExt (L46)    — extended to connector secret values (ADR-033)
ADDED   : agent-runtime/mcp-registry.mjs    — connector records + grant map (no secret values)
ADDED   : agent-runtime/mcp-compose.mjs     — per-spawn scoped .mcp.json builder (decrypt-at-spawn, ADR-033)
ADDED   : RUNTIME_DIR/mcp-registry.json     — connector records (gitignored, 0o600, references only)
ADDED   : RUNTIME_DIR/mcp-grants.json       — agentId → [connectorId] grant map (gitignored, 0o600)
ADDED   : /factory/connectors* routes       — CRUD + grant + health (auth-gated, same family as /apply)
ADDED   : MCP flags in cliReply argv        — --mcp-config / --strict-mcp-config / --allowedTools (only when grants exist)
```

`api`/`mock` backends get **no** MCP injection — the connector layer is `cli`-only, matching the product posture (ADR-022 S2).

### 1. Connector record schema (= future DB row; file-based per ADR-027)

The record holds **configuration + references only — never a secret value.** A secret lives encrypted in the AES broker (ADR-033) and is named here by `credId` (an opaque broker handle, e.g. the existing `conn_<hex>` connId shape, reused). `headersRef` / `envRefs` map a header/env name → a `credId`, so the registry record is safe to read, list, and (gitignored) persist.

```jsonc
{
  "connectorId": "mcp_<12hex>",          // server-minted primary key; sanitized
  "name":        "fsdata",               // [a-z0-9_-]{2,48}; becomes mcp__<name>__* tool prefix
  "transport":   "stdio",                // "stdio" | "http"
  "command":     "npx",                  // stdio ONLY — MUST pass the command allowlist (ADR-033 §3)
  "args":        ["-y","@modelcontextprotocol/server-filesystem","/data"],  // stdio ONLY; validated shape
  "url":         null,                   // http ONLY — MUST be https + (optional) host allowlist (ADR-033 §3)
  "headersRef":  {},                     // http ONLY — { "Authorization": "<credId>" } name→credId; NEVER a value
  "envRefs":     {},                     // stdio ONLY — { "FOO_TOKEN": "<credId>" } name→credId; injected via .mcp.json env, NOT child env
  "scopes":      [],                     // informational labels for the panel (e.g. ["read-file"]); not enforced
  "enabled":     true,                   // disabled connectors are never composed into any agent
  "createdAt":   "2026-06-18T...Z",
  "updatedAt":   "2026-06-18T...Z"
}
```

**INVARIANT (carried into ADR-033 §1):** secret VALUES never appear in this record. Only `credId` references. The public list view (`pubConnector`, analogous to `pubConn` factory.mjs L437) additionally strips `command`/`args`/`url`/`headersRef`/`envRefs` to a presence summary so the panel never re-displays operator-supplied config that could carry a path/host worth hiding. Mutually-exclusive fields by transport: a `stdio` record has `command`+`args`(+`envRefs`), `url`/`headersRef` null; an `http` record has `url`+`headersRef`, `command`/`args`/`envRefs` null. The store rejects a record that mixes them.

### 2. Registry store module — `agent-runtime/mcp-registry.mjs`

A narrow, migration-ready interface mirroring `factory.mjs`'s connection store (and ADR-027 §1 — JSON record IS the future table schema):

```js
addConnector(rec)            // validate (transport shape + ADR-033 §3 command/url guards) → mint mcp_<hex> → atomic write 0o600
updateConnector(id, patch)   // allowed fields: name, command, args, url, headersRef, envRefs, scopes, enabled; re-validated; updatedAt bumped
setEnabled(id, bool)         // enable/disable toggle (disabled = never composed)
removeConnector(id)          // drop record + cascade-drop from every grant in mcp-grants.json
listConnectors()             // public view (pubConnector — config summarized, NO refs/values)
getConnector(id)             // internal full record (for compose); never returned over the wire raw
```

- **id minting:** server-minted `mcp_<randomUUID-12hex>` (like `connId` factory.mjs L448); never client-supplied. `name` sanitized to `[a-z0-9_-]{2,48}` (reuse `ID_RE` discipline L91) because it becomes the `mcp__<name>__*` tool namespace — a bad name would mis-scope `--allowedTools`.
- **persistence:** `mcp-registry.json` under `RUNTIME_DIR` (= `$TMPDIR/missionalpha-runtime`, factory.mjs L57), gitignored, written with the atomic tmp→rename + `0o600` pattern (ADR-027; `saveConnections` L432-435). Crash-safe, migration-ready (file→SQLite/Mongo is a schema port).
- **validation choke point:** `addConnector`/`updateConnector` run the ADR-033 §3 command/url/header validators BEFORE write. An invalid command (not on the launcher allowlist, or containing shell metachars) is rejected at the route with HTTP 400 — it never reaches a record, never reaches a spawn.

### 3. Per-agent GRANT model — separate grant map (chosen)

**Decision: a separate `mcp-grants.json` map, NOT a `grantedAgents:[]` field on the connector record.** Justification:

- **Default-deny is the natural state.** An agent with no grant entry simply isn't in the map → gets nothing. No per-record default to misread.
- **Two axes change independently.** Connectors are edited by the operator (config drift); grants change per agent (org changes). Co-locating them couples a config edit to a grant audit. A separate map keeps the grant decision a first-class, separately-audited record — the same reasoning ADR-021 uses for keeping creds out of the agent spec.
- **Cascade is explicit.** `removeConnector` cascades into the grant map (drop the id from every agent's list); a stale grant can never point at a deleted connector.

```jsonc
// RUNTIME_DIR/mcp-grants.json
{ "growth-marketer": ["mcp_ab12...", "mcp_cd34..."], "research-bot": ["mcp_ab12..."] }
```

```js
grant(agentId, connectorId)    // add (agentId must exist in factory registry OR be a built-in; connectorId must exist)
revoke(agentId, connectorId)   // remove
grantsFor(agentId)             // → [connectorId]  (the compose step's input)
listGrants()                   // → full map (panel view)
```

**Default = NO grants.** An agent receives a connector ONLY via an explicit `grant()` call from the auth-gated route. This is the first half of the double allowlist (ADR-033 §2): the grant gate decides WHICH connectors are eligible for an agent's scoped config; `--strict-mcp-config` enforces it at the claude layer.

### 4. Per-session composition (the PROVEN mechanism) — `agent-runtime/mcp-compose.mjs`

At spawn, for the dispatching `agentId`, `cliReply` calls `composeMcp(agentId)`:

1. `connectorIds = grantsFor(agentId)` → for each, `getConnector(id)` and keep only `enabled` ones. **If the result is empty → return null → inject NOTHING (current behavior preserved; no MCP flags added).**
2. Build the scoped config object — `stdio`: `{ command, args, env }` where `env` is `{ NAME: <decrypted secret> }` resolved from `envRefs` via the broker decrypt (ADR-033 §1, decrypt-at-spawn ONLY); `http`: `{ url, headers }` where `headers` is `{ NAME: <decrypted secret> }` resolved from `headersRef`.

   ```jsonc
   { "mcpServers": {
       "fsdata":  { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","/data"] },
       "hostedX": { "url": "https://tools.example.com/mcp", "headers": { "Authorization": "Bearer <decrypted>" } }
   } }
   ```
3. Write that JSON to an absolute path **OUTSIDE the worktree** — `RUNTIME_DIR/mcp/<agentId>-<spawnNonce>.json`, mode `0o600` (ADR-033 §1: the agent's Read tool is scoped to its worktree via `--add-dir`, so a config under `$TMPDIR/missionalpha-runtime` is unreadable by the agent — same reasoning as the runtime token L99-107 and broker creds factory.mjs L55-58).
4. Append to the `cliReply` argv (after the existing `--allowed-tools` loop L496/499, before `spawn` L515):

   ```js
   args.push("--mcp-config", scopedPath);   // absolute path to the composed config
   args.push("--strict-mcp-config");        // claude loads ONLY these servers — the allowlist enforcer
   for (const name of composedNames) args.push("--allowedTools", `mcp__${name}__*`);  // one per granted server
   ```
   `--strict-mcp-config` is the PROVEN per-agent enforcer: the agent loads exactly the servers in `scopedPath`, nothing from the host's global/user `.mcp.json` or settings. An ungranted agent gets no `--mcp-config` at all → no MCP servers, and (because no `--strict-mcp-config`) it also matches today's behavior of inheriting nothing relevant (it has no MCP tools allowlisted either way).
5. After spawn, the scoped file is deleted (ADR-033 §1 — short-lived; `child.on("close")` unlink, or unlink immediately after claude has read it on init). The decrypted secret exists only in the file's brief lifetime + the argv compose frame, never in the child env (envRefs go into the `.mcp.json` `env` map per the spike, NOT `childEnv` L510-514 which strips secret-shaped vars).

This adds MCP injection to the **same single call site** (`cliReply`) that ADR-022 hardened — argv-array spawn, no `shell:true`, server-resolved values only. The engine dispatch path (`engineDispatch` ~L661) is **out of scope for STAGE 2.5** (engine agents run autonomously; granting them connectors is a future ADR with its own gate). Only the interactive `cliReply` path composes MCP in this stage.

### 5. Health probe (best-effort, panel-surfaced)

Per-connector `status`: a lightweight check, surfaced to the panel, never blocking.

- **Default:** a short-timeout spawn check — compose a single-connector scoped config and run `claude mcp get <name> --mcp-config <path> --strict-mcp-config` (or parse the init `mcp_servers[].status` from a throwaway `-p` probe), reading the `pending`/`connected`/`failed` status the spike observed. Timeboxed (e.g. 5s), result cached.
- Marked **best-effort**: a `failed`/`timeout` status is informational (surfaces "connector unreachable" in the panel) and does NOT disable the connector or block a spawn — an operator decides. Health never decrypts a secret it doesn't need; an HTTP connector probe MAY skip the auth header (a 401 still proves reachability).

### 6. New auth-gated routes (same token + origin + host family as `/apply` and `/factory/*`)

All under the existing `/factory/` auth block (server.mjs L1005-1006: `originOk(req) && tokenOk(req)`, host already enforced globally L732). Loopback-only, runtime-token-gated — identical posture to `/apply` and `/factory/connect`.

```
GET    /factory/connectors                      → listConnectors()              (public view; NO refs/values)
POST   /factory/connectors        {name, transport, command?, args?, url?, headersRef?, envRefs?, scopes?}
                                                → addConnector()  → 201 | 400    (validated; refs only — secret VALUES arrive via /factory/connect-style cred add, ADR-033 §1)
PATCH  /factory/connectors/:connectorId  {patch}→ updateConnector()→ 200 | 400/404
DELETE /factory/connectors/:connectorId         → removeConnector()→ 200 | 404   (cascades into grants)
POST   /factory/connectors/:connectorId/enable  {enabled:bool} → setEnabled() → 200
POST   /factory/connectors/grant   {agentId, connectorId, action:"grant"|"revoke"} → grant/revoke → 200 | 400
GET    /factory/connectors/grants               → listGrants()                  (panel view)
GET    /factory/connectors/:connectorId/health  → probe() → {status, at}        (best-effort)
```

Route id regex follows the existing pattern (`/^\/factory\/connectors\/(mcp_[a-z0-9]+)/i`, like the `conn_` match L1112). Bodies bounded via `readBody(16_000)` like `/factory/connect` L1094. **Secret VALUES are submitted through the broker's cred-add route (ADR-033 §1), not embedded in a connector record** — the connector record carries only the resulting `credId` references.

## Security invariant (full treatment in ADR-033 — HARD gate)

This ADR's structural invariants (enforced here; security crux + attack table in ADR-033):

| Invariant | Where enforced (this ADR) |
|---|---|
| Connector record holds references, never secret values | §1 schema + `pubConnector` view |
| Disabled/ungranted connector never composed into an agent config | §3 default-deny grant map + §4 step 1 |
| Scoped `.mcp.json` written OUTSIDE the worktree, `0o600`, deleted post-spawn | §4 steps 3+5 (reuses RUNTIME_DIR placement L57) |
| `--strict-mcp-config` = claude loads ONLY composed servers (no global/user MCP) | §4 step 4 (PROVEN) |
| Operator-supplied `command`/`url`/`args` validated before write | §2 validation choke point → ADR-033 §3 |
| MCP flags appended at the single argv-array spawn site (no shell) | §4 step 4 (reuses ADR-022 discipline) |

**ADR-033 sign-off is BLOCKING.** No connector composes into a real spawn until senior-security-engineer signs off on ADR-033 (cred lifetime, command validation, double allowlist, egress scrub).

## Consequences

**Positive** — per-agent MCP grants without leaking to the swarm; reuses the proven loop/broker/argv discipline untouched (ADR-021/022/027); `--strict-mcp-config` gives a hard claude-layer allowlist on top of our grant gate; file store is migration-ready (principal-db-engineer owns the port); zero impact on agents with no grants (inject-nothing path = today's behavior).

**Negative / accepted** — composition decrypts a secret at the spawn frame and writes a `0o600` file briefly (mitigated: outside worktree, deleted post-spawn, scrubbed on egress — ADR-033); operator can register a connector whose command launches a child process (the core risk — gated by the command allowlist, ADR-033 §3, the reason 033 is a HARD gate); health is best-effort (a connector can be granted-but-unreachable; surfaced, not blocked); engine-path MCP deferred to a later ADR.

**Observability** — `meta` SSE event gains `mcpServers:[names]` per turn so the chat header shows which connectors served the turn (names only, never config/values); registry + grant changes write to the existing `factory-audit.log` (factory.mjs L607, `audit("connector.add"/"connector.grant"/...)` — config metadata only, NEVER refs/values); startup logs connector + grant counts.

## Alternatives rejected

1. **`grantedAgents:[]` on the connector record** — couples a config edit to a grant audit; muddies the default-deny default. Separate grant map keeps grant a first-class, separately-audited decision (§3).
2. **Global `.mcp.json` shared by all agents** — exactly the leak this ADR prevents; every agent would see every connector. `--strict-mcp-config` per-agent scoping is the whole point.
3. **A new secret store for connector creds** — violates the BOSS decision (reuse the AES broker). The factory.mjs broker (ADR-021) already does AES-256-GCM, tmp-dir, never-logged — ADR-033 reuses it verbatim.
4. **Inject MCP via child env (`childEnv`)** — `childEnv` (L510-514) deliberately STRIPS secret-shaped vars; the spike proved stdio servers get their env via the `.mcp.json` `env` map, not the child env. Env injection would both fight the existing strip and broaden the child's secret surface.
5. **MCP for the engine path in this stage** — autonomous engine agents granted external tools is a larger blast radius needing its own gate; deferred. STAGE 2.5 is the interactive `cliReply` path only.

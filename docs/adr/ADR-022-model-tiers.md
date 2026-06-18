# ADR-022 — Model-Tier Allowlist (Claude Opus / Sonnet / Haiku, per-chat)

- **Status:** ACCEPTED
- **Date:** 2026-06-17
- **Slug:** `model-tiers`
- **Plan:** `docs/ceo/workspace-plan.md` (Phase 1 / Phase 3)
- **Deciders:** architect, senior-backend-1, senior-security-engineer (HARD gate), ceo
- **Supersedes:** the single fixed `RUNTIME_MODEL` const in `agent-runtime/server.mjs`

## Context

The runtime drives Claude two ways (see `agent-runtime/server.mjs`):

- **cli backend** (default, no key) — spawns `claude -p ...` via `spawn(CLAUDE_BIN, args, {…})`. The model is whatever the subscription session resolves; today there is NO `--model` flag, so every turn uses the CLI default.
- **api backend** (key present) — `client.messages.stream({ model: MODEL, … })` where `MODEL = process.env.RUNTIME_MODEL || "claude-sonnet-4-6"` — a single process-wide const.

GAP (workspace-plan §"What already exists", GAP 1): there is exactly one model for the whole app. BOSS wants a **per-chat tier picker** — pick Opus for the hard strategic turn, Haiku for a cheap/fast status ping — without leaving the chat.

BOSS decision (workspace-plan §"BOSS decisions (locked)" #1, NO NEGOTIATION):
> Models = Claude tiers only: Opus (claude-opus-4-8) / Sonnet (claude-sonnet-4-6) / Haiku (claude-haiku-4-5). Subscription (cli `--model`). No GPT/Gemini.

So the feature is small plumbing — but the *input* is now user-controlled, and it flows into a `spawn` argv. That is the whole reason this ADR exists: get the data path right so a model field can never become a flag-injection vector.

## Decision

Introduce a **STRICT, closed tier allowlist**. User code never names a model id; it names a *tier key*. The runtime owns the key→id map.

### 1. Registry (single source of truth, server-side const)

```js
const MODEL_TIERS = Object.freeze({
  opus:   "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku:  "claude-haiku-4-5",
});
const DEFAULT_TIER = "sonnet";          // balanced — plan default
const TIER_KEYS = Object.keys(MODEL_TIERS);
```

Model ids are **non-dated aliases** (per global CLAUDE.md rule). The map is the ONLY place an id literal appears.

### 2. API surface

`POST /runtime/:id/chat`, `POST /runtime/:id/run`, and `POST /factory/author` accept an OPTIONAL field:

```jsonc
{ "message": "...", "model": "opus" }   // model ∈ {"opus","sonnet","haiku"}, optional
```

- `model` absent / empty → `DEFAULT_TIER` (`sonnet`).
- `model` present and ∈ `TIER_KEYS` → resolve via `MODEL_TIERS[tier]`.
- `model` present and NOT in `TIER_KEYS` → **HTTP 400** `{ "error": "unknown model tier" }`. No fallback-to-default on a bad value — fail loud.

A single resolver gates every entry point:

```js
function resolveTier(raw) {
  const tier = (raw == null || raw === "") ? DEFAULT_TIER : String(raw);
  if (!Object.prototype.hasOwnProperty.call(MODEL_TIERS, tier)) {
    return { error: "unknown model tier", valid: TIER_KEYS };
  }
  return { tier, modelId: MODEL_TIERS[tier] };
}
```

`hasOwnProperty` (not `in`) avoids prototype-chain keys (`toString`, `constructor`) resolving as "valid".

### 3. Runtime mapping

- **cli backend** — `cliReply()` appends `args.push("--model", modelId)`. `modelId` is ALWAYS a value pulled FROM `MODEL_TIERS` — never the raw request field. `spawn` with an argv array and no `shell:true` means even a hostile string could not break out of an argv slot — but we never let a hostile string reach the array at all (defense in depth).
- **api backend** — `client.messages.stream({ model: modelId, … })`, replacing the `MODEL` const at the call site.
- **mock backend** — ignores the tier; echoes the requested tier in the `meta` event for UX parity.

The `meta` SSE event gains `tier` + `modelId` so the chat header chip can show which tier served the turn.

### 4. Health

`GET /runtime/health` reports `tiers` + `defaultTier` so the UI builds the picker from the server, not a hardcoded client list.

## Security invariant (sr-security HARD gate — Phase 3 + Phase 6)

**INVARIANT: only an allowlisted tier key ever influences the model; raw user input is NEVER interpolated into the `claude` argv (or the SDK `model` field).**

Three layers, in order:

1. **Allowlist-only (primary).** The request carries a *tier key*, not a model string. The id that reaches `spawn`/SDK is read out of the frozen `MODEL_TIERS` map by key. Unknown key → 400 before any spawn. `model: "--dangerously-skip-permissions"` or `model: "sonnet --add-dir /"` is not a key → 400. It never becomes argv.
2. **Argv-array spawn (existing, structural).** `spawn(CLAUDE_BIN, args, {…})` with no `shell:true` — each array element is one literal argv token. No shell to interpret metacharacters, no word-splitting. Prevents *shell* injection; the allowlist prevents *flag* injection.
3. **Frozen registry.** `Object.freeze(MODEL_TIERS)` + `hasOwnProperty` key check prevents prototype-pollution / runtime mutation from widening the allowlist.

| Attack | Vector | Mitigation |
|---|---|---|
| Flag injection | `model:"--dangerously-skip-permissions"` | not a tier key → 400 |
| Arg-splice | `model:"haiku --add-dir /etc"` | not a tier key → 400; argv array = one token anyway |
| Prototype key | `model:"constructor"` / `"toString"` | `hasOwnProperty` guard → 400 |
| Provider smuggling | `model:"gpt-4o"` | not a tier key → 400 (enforces "Claude only") |
| Registry widening | runtime mutation of the map | `Object.freeze` |

sr-security sign-off condition (Phase 1 exit + Phase 6): confirm (a) no code path passes the raw `model` field to `spawn`/SDK, (b) unknown tier → 400 with no spawn, (c) the map is frozen. BLOCKING gate.

## Consequences

**Positive** — per-chat tier selection; cost/speed control (Haiku cheap pings, Opus hard reasoning, Sonnet default); tiny blast radius (one resolver + two argv elements + one meta field + health); "Claude only" enforced structurally at the data layer.

**Negative / accepted** — cli relies on `claude -p --model <id>` honoring the flag (LOW; single call site); a 4th tier = one deliberate line; a stale client sending a removed tier → 400 (UI surfaces gracefully).

**Observability** — `meta.tier` per turn → UI chip + retro "which tier used most"; startup log includes `tiers=[opus,sonnet,haiku] default=sonnet`.

## Alternatives rejected

1. **Raw `--model` passthrough** — turns a user field into argv/SDK value; the exact flag-injection surface this ADR closes. Also lets non-Claude ids through. No.
2. **Env-only model (status quo)** — one model per process (GAP 1); can't pick per-chat without restart.
3. **Open registry from file/db** — adds a config-tamper surface for zero current benefit; 3 frozen tiers.
4. **Per-agent fixed tier** — less flexible than per-chat; BOSS wants per-thread selection (persisted, see ADR-023).

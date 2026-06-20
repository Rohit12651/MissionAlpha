# ADR-030 — Usage Meter (token + context-window %, modeled on Claude Code `/context` — NEVER a cost meter)

- **Status:** PROPOSED
- **Date:** 2026-06-18
- **Slug:** `usage-tracking`
- **Plan:** S2 chat-first cockpit — gap #8 (the meter). `docs/ceo/workspace-plan.md`
- **Deciders:** architect, senior-backend (cli stream parse), senior-web (header readout), senior-security-engineer (HARD gate: no `$` egress), ceo
- **Related:** ADR-022 (tiers / cli backend), ADR-023 (chat-first shell, header), ADR-031 (thread endpoints surface usage)
- **Renamed from:** "cost-tracking" — the prior name was wrong. Subscription is flat-rate; there is no per-call cost. This is a **USAGE** meter.

## Context

BOSS is on the **subscription `cli` backend ONLY** (`claude -p` — flat-rate, like Claude Code; ADR-022 S2 ratification). There is NO Anthropic API backend in the product. Therefore:

> **NO DOLLARS, EVER, anywhere in the UI.** Nothing is billed per call; a `$` figure would be FALSE. The meter is a USAGE meter — tokens + context-window % — modeled on Claude Code's `/context`. (BOSS-locked, NO NEGOTIATION.)

Today the cockpit shows **no usage at all**. The chat header (`src/components/workspace/ChatPane.tsx` ~L264) shows a mode chip + `ModelTierPicker` and nothing else. The operator cannot see how much of the context window a long thread has consumed, nor how many tokens a turn cost in attention terms — the single most useful signal Claude Code surfaces via `/context`.

**Spike result (already run, do NOT re-probe):** `claude -p --output-format stream-json` returns a final `{"type":"result",…}` event carrying a real `usage` object:

```jsonc
{
  "type": "result",
  "result": "…assistant text…",
  "num_turns": 1,
  "usage": {
    "input_tokens": 1234,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 5678,
    "output_tokens": 256,
    "output_tokens_details": { "thinking_tokens": 0 }
  },
  "total_cost_usd": 0.0123    // ← IGNORED. Never read, never surfaced. Subscription = flat rate.
}
```

These are **real token counts** — no estimate needed. The current `cliReply` parser (`server.mjs` ~L480) reads only `obj.result` text from this event; it **discards `usage` entirely**. That is the gap.

GROUND TRUTH (cite):
- `cliReply` (~L411) spawns `claude -p`, line-parses stdout stream-json, forwards `content_block_delta` text + the `result.result` fallback text via `stream.token`. It does NOT capture `result.usage`. It calls `onDone(acc)`.
- `handleChat` (~L496) builds the SSE via `sse(res)` (~L283) which today emits `meta`/`token`/`done`/`error`. `save(acc)` (~L500) pushes the assistant turn into `hist`, trims to `THREAD_KEEP`, then `persistThread(agentId, trimmed, tier)`.
- `persistThread` (~L170) writes `{ id, tier, messages, updatedAt }` to `agent-runtime/threads/<id>.json` (gitignored), capped at `THREAD_MAX_BYTES`.
- `scrub` (~L268) runs on every `stream.token`.
- ChatPane SSE client (~L190) parses `event: <name>` + `data: <json>` frames; branches on `meta`/`token`/`error`. The parser accepts ANY event name — a new `usage` event is one added `else if`.

## Decision

Capture the **real `usage` object** from the cli `result` event, emit it as a NEW `usage` SSE event before `done`, roll it up into the persisted thread record, and render it in the ChatPane header as a `/context`-style readout. **No `$` ever crosses the wire or reaches the UI.**

### 1. Backend capture — `cliReply` parses `result.usage` + `num_turns`

In the stdout line loop (`server.mjs` ~L480), the `obj.type === "result"` branch additionally captures the `usage` object and `num_turns` into closure vars (parallel to `acc`). It NEVER reads `total_cost_usd`.

```js
// inside cliReply's stdout 'data' handler, result branch (ADDED — usage capture):
} else if (obj.type === "result") {
  if (typeof obj.result === "string" && !streamed) { acc = obj.result; stream.token(obj.result); }
  if (obj.usage && typeof obj.usage === "object") {
    capturedUsage = obj.usage;            // raw token counts ONLY
    capturedTurns = Number(obj.num_turns) || capturedTurns;
  }
  // NB: obj.total_cost_usd is deliberately NOT read. (sr-security HARD gate.)
}
```

`cliReply`'s `onDone` callback signature widens to carry the normalized usage (or `null` if absent): `onDone(acc, usageOrNull)`. A single normalizer builds the wire shape from the raw cli object + the resolved tier:

```js
// ADDED — normalize cli usage → wire shape. tier from resolveTier (ADR-022).
function normalizeUsage(raw, tier) {
  if (!raw) return null;
  const inputTokens          = Number(raw.input_tokens) || 0;
  const outputTokens         = Number(raw.output_tokens) || 0;
  const cacheCreationTokens  = Number(raw.cache_creation_input_tokens) || 0;
  const cacheReadTokens      = Number(raw.cache_read_input_tokens) || 0;
  const thinkingTokens       = Number(raw.output_tokens_details?.thinking_tokens) || 0;
  // current context footprint = everything that occupied the window this turn.
  const contextTokens        = inputTokens + cacheReadTokens + cacheCreationTokens;
  const contextWindow        = CONTEXT_WINDOW;            // const, §"context-window constant" below
  const contextPct           = contextWindow ? Math.min(1, contextTokens / contextWindow) : 0;
  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
           thinkingTokens, contextTokens, contextWindow, contextPct, tier };
}
```

### 2. New SSE event — `usage` (emitted before `done`)

`sse(res)` (~L283) gains one emitter, sibling to `token`/`meta`:

```js
usage: (u) => res.write(`event: usage\ndata: ${JSON.stringify(u)}\n\n`),
```

`handleChat`'s cli `onDone` emits it after `save`, before `done`:

```js
cliReply(agentId, systemFor(agentId), hist, stream, (acc, usage) => {
  const norm = normalizeUsage(usage, tier);   // null if cli returned no usage
  save(acc || "(no output)", norm);           // save() gains the rollup arg (§3)
  if (norm) stream.usage(norm);               // ONLY token/context fields — never $
  stream.done();
}, modelId);
```

**Wire shape (the `usage` SSE event payload) — token/context ONLY, no cost field:**

```jsonc
{
  "inputTokens":          1234,    // result.usage.input_tokens
  "outputTokens":         256,     // result.usage.output_tokens
  "cacheCreationTokens":  0,       // result.usage.cache_creation_input_tokens
  "cacheReadTokens":      5678,    // result.usage.cache_read_input_tokens
  "thinkingTokens":       0,       // result.usage.output_tokens_details.thinking_tokens
  "contextTokens":        6912,    // input + cacheRead + cacheCreation (current footprint)
  "contextWindow":        200000,  // CONTEXT_WINDOW const (see §"context-window constant")
  "contextPct":           0.0346,  // contextTokens / contextWindow, clamped [0,1]
  "tier":                 "sonnet" // resolved tier that served the turn (ADR-022)
}
```

There is deliberately **no `cost`, no `usd`, no `price` key**. `total_cost_usd` is never read in §1, so it cannot appear here.

### 3. Persistence — cumulative usage rollup on the thread record

`persistThread` (~L170) extends the record with a `usage` rollup so the meter survives restart. `save()` in `handleChat` (~L500) gains the per-turn normalized usage and accumulates:

```js
// thread record (ADDED `usage` block — additive; old records without it load fine):
{
  id, tier, messages, updatedAt,
  usage: {
    turns:               12,        // += 1 per turn that returned usage (or += num_turns)
    totalInputTokens:    14820,     // running sum
    totalOutputTokens:   3072,      // running sum
    totalCacheReadTokens: 51200,    // running sum (optional display)
    lastContextTokens:   6912,      // most recent turn's footprint
    lastContextPct:      0.0346,    // most recent turn's window %
    lastTier:            "sonnet"
  }
}
```

- `loadThreads` (~L151) currently hydrates only `obj.messages` into the in-memory Map. To survive restart the rollup must also be hydrated — keep a parallel in-memory `Map<id, usageRollup>` (or hydrate the rollup alongside messages). On a turn with no usage (mock/dead-api), the rollup is left unchanged (no turn increment, no NaN).
- Old thread files lacking `usage` load unchanged → rollup starts empty. **Backward-compatible, additive** (mirrors ADR-023 §3B).
- Byte cap: the rollup is ~8 small ints — negligible against `THREAD_MAX_BYTES` (256 KiB). No new cap needed; the existing trim path already re-serializes the record (carry the rollup through the trim branch at ~L174).

### 4. Context-window constant

```js
const CONTEXT_WINDOW = Number(process.env.RUNTIME_CONTEXT_WINDOW || 200000); // tokens
```

- **Decision:** a single env-overridable const, default **200000**, applied to ALL current tiers (opus/sonnet/haiku). This is the documented standard window for the current Claude generation; modeling it per-tier buys nothing today (all three share it) and adds a map to keep in sync with ADR-022.
- **Flagged as a constant to confirm (see Open Questions):** the cli `usage` object does NOT report the model's window, only consumed tokens. 200000 is the documented window, not a CLI-reported value. If a future tier ships a 1M window, this becomes a per-tier map keyed off `MODEL_TIERS`. Until then: one const. The `%` is therefore a UI affordance against a documented denominator, not a billed quantity.

### 5. UI — `/context`-style readout in the ChatPane header

In the sticky header (`ChatPane.tsx` ~L264), beside `ModelTierPicker` (~L283) / in the `headerExtra` slot — a compact, non-reflowing readout:

- **Tokens:** `↑ 1.2k in · ↓ 256 out` (optionally `· 5.7k cached`). Real counts from the `usage` event.
- **Context bar:** a thin `contextPct` progress bar + label `3% of window` (or `6.9k / 200k`), exactly the Claude Code `/context` mental model.
- **Tier:** which tier ran (already in the meta chip; the `usage.tier` confirms the served tier).
- **NEVER a `$` figure.** No currency, no "spend", no "cost". (sr-security gate.)
- **No-usage fallback:** if a turn returns no `usage` event (the dead `mock`/`api` branches — not a product path, but defensive), label the readout `~est` using `chars/4` on the streamed text, OR hide the bar entirely. Never render a fake exact count. The persisted rollup (§3) seeds the readout on resume before the first turn of a restored thread.

The ChatPane SSE loop (~L200) gains one branch:

```ts
else if (ev === "usage") setUsage(data as UsageReadout); // new state; renders the header readout
```

### 6. Health / observability

- Optional: the thread endpoints in ADR-031 (`GET /runtime/threads`, `GET /runtime/:id/thread`) surface the persisted `usage` rollup (scrubbed) so the rail can show a per-thread usage badge and resume hydrates the meter without waiting for a turn. This is the read-only consumer of §3.
- Startup log already prints `tiers=… default=…` (ADR-022); add `contextWindow=200000` so the denominator is auditable.

## Security invariant (sr-security HARD gate)

**INVARIANT: no monetary value EVER crosses the wire to the client. The `usage` SSE event carries ONLY token + context fields. `total_cost_usd` is never read by the parser, never persisted, never emitted.**

- The cli `result` event DOES contain `total_cost_usd`. The §1 parser reads `obj.result`, `obj.usage`, `obj.num_turns` — and explicitly NOT `total_cost_usd`. `normalizeUsage` (§1) builds the wire object from an allowlisted set of token keys; it cannot pass through an unknown cost field because it constructs a fresh object key-by-key (never spreads `raw`).
- `persistThread` stores the rollup built from the same allowlisted keys — no cost field can land on disk.
- The existing egress `scrub` (~L268) still runs on every `stream.token` (streamed assistant text) — unchanged. The `usage` event payload is server-constructed numerics (not model text), so it needs no scrub, but it also contains no secret-shaped or monetary content by construction.
- No new auth surface from the `usage` event itself (it rides the existing authenticated `/chat` SSE). The thread endpoints that ALSO surface usage are gated in ADR-031.

| Attack / failure | Vector | Mitigation |
|---|---|---|
| Cost leakage to UI | `total_cost_usd` in the cli `result` event | parser never reads it; `normalizeUsage` builds a fresh object from an allowlisted token-key set (no spread) → field cannot transit |
| Forged usage inflates window % to alarm operator | malicious local process posts a crafted SSE? | usage is SERVER-emitted from the cli child's own stdout; client never supplies usage; SSE is server→client only |
| `NaN`/`Infinity` in `contextPct` | `contextWindow = 0` or non-numeric cli field | `Number(x) || 0` coercion on every field; `contextWindow ? … : 0` guard; `Math.min(1, …)` clamp |
| Disk bloat via rollup | unbounded accumulation | rollup is fixed ~8 ints; record still bounded by `THREAD_MAX_BYTES`; trim path carries the rollup |
| Secret in usage payload | secret-shaped token count? | payload is pure numerics + tier enum; no free text; `scrub` still covers the text `token` channel |

sr-security S2 sign-off condition (BLOCKING): confirm (a) `total_cost_usd` is read nowhere; (b) the `usage` event and the persisted rollup contain only the documented token/context numeric keys; (c) no UI string contains a currency symbol or "cost"/"spend"; (d) `scrub` still runs on the text channel.

## Consequences

**Positive** — operator sees real attention budget (`/context` parity), the single highest-value usage signal; truthful (real counts, no fabricated estimate on the live cli path); flat-rate honesty preserved (no false `$`); tiny blast radius (one parser branch + one SSE emitter + one normalizer + one rollup field + one header readout); rollup survives restart so resume shows usage immediately.

**Negative / accepted** — `contextWindow` is a documented const, not CLI-reported (Open Question 1); the dead mock/api branches return no usage → `~est`/hidden (acceptable, not a product path); a turn that crashes before the `result` event emits no usage (the meter simply doesn't update — acceptable); cumulative rollup is approximate across `THREAD_KEEP` trims (messages trim, the rollup totals do not — this is intended; totals are lifetime-of-thread, not lifetime-of-retained-messages — confirm with BOSS, Open Question 2).

## Alternatives rejected

1. **Cost meter (the original "cost-tracking" framing)** — shows `$`. FALSE on a flat-rate subscription; BOSS-locked NO. Renamed this ADR to `usage-tracking` to bury the framing.
2. **Estimate-only (`chars/4`) meter** — we have REAL counts from the cli `usage` object; an estimate would be strictly worse and could disagree with reality. Estimate is the fallback ONLY when usage is absent (dead branches).
3. **Per-tier context-window map now** — all three current tiers share 200000; a map is premature config to keep in sync with ADR-022 for zero current benefit. One const, env-overridable, becomes a map only when a tier's window actually diverges.
4. **Surfacing `total_cost_usd` "internally, hidden from UI"** — still crosses the wire / lands on disk → a leak waiting to happen, and violates the flat-rate truth. Never read it at all.
5. **Separate `/usage` polling endpoint instead of an SSE event** — the count is known exactly at turn end inside the same stream; an extra round-trip and a second auth surface for data we already hold is wasteful. The rollup IS surfaced read-only via ADR-031's thread endpoints for resume/badge — no separate usage endpoint.

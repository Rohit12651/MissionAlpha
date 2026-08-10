# Multi-Provider Credentials & Auth Modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a Providers & Credentials surface to MissonAlpha — keep Claude subscription login, add Claude API-key mode with full swarm parity, architect for 4 providers with honest capability tiers. Everything wired backend→frontend, end to end.

**Architecture:** Runtime provider registry + encrypted local credential store (in the existing OUTSIDE-REPO `TOKEN_DIR`). Surgical engine change: the autonomous write-loop keeps spawning the `claude` CLI, but injects `ANTHROPIC_API_KEY` into the child when the active Claude credential is api-key mode (instead of always stripping it) → API keys run the full swarm, no new agent loop. Loopback+token-gated REST endpoints. React Providers panel matching the approved mockup. Preflight updated to accept either auth.

**Tech Stack:** Node 26, `better-sqlite3@13` (already fixed), `@anthropic-ai/sdk`, node:crypto (AES-256-GCM), React 19 + Vite 5, existing `runtimeBase` fetch/SSE helpers, node:test.

**Spec:** `docs/superpowers/specs/2026-08-09-multi-provider-credentials-design.md`

---

## EXECUTION PROTOCOL (applies to EVERY phase — no negotiation)

**Source of truth:** `/Users/RohitAnandeshi/.claude/CLAUDE.md` (PES prime directive) governs every phase.

**Per-phase model + mode:**
- **Build:** Opus 4.8, `/caveman` full, `headroom` wrap ON, `codeburn` after each phase.
- **Test/verify:** Fable 5, same caveman/headroom/codeburn.
- Both run every checklist at full PES standard — effort never scales down.

**Mandatory skills every phase (CLAUDE.md routing):**
| Stage | Skill |
|---|---|
| Plan/execute | `sp-writing-plans` → `sp-executing-plans` / `sp-subagent-driven-development` |
| TDD | `sp-test-driven-development` |
| Debug (root cause unclear) | `sp-systematic-debugging` |
| Security (auth/secrets/keys — THIS FEATURE) | `security-review` + `claude-code-security-review` — block on CRITICAL |
| Code review before merge-gate | `code-reviewer` agent + `/code-review` |
| UI phases | `hallmark` → `impeccable` → `taste-skill`, in order |
| Animation/motion | `emil-design-eng` |
| Verify before "done" | `sp-verification-before-completion` |
| Memory/recall | `mem-search` / `learn-codebase` |
| Ship gate (when told) | gstack `/qa` → `/review` → `/ship` |
| Token cost | `codeburn` after each phase |

**PES gates per phase (in order, all pass, evidence shown, before any "done"):**
build → lint+typecheck → tests → security pass → runtime verification → adversarial self-review → delivery report with **Known Gaps & Risks**.

**Hard rules:**
1. **DO NOT COMMIT** until the user explicitly says so. Track work on branch `feat/multi-provider-credentials` (create from `helmMission`), stage nothing to `main`.
2. **Do not break current functionality.** Baseline (Phase 0) captures green state; every phase re-runs it. Any regression = stop + fix + re-test before proceeding.
3. **Everything WIRED.** No dead UI, no stub endpoints. Each phase ends with a live request flowing UI→runtime→store→UI.
4. **Reserved words** ("done/works/passing/secure") only with verification output shown; else "changed, unverified".
5. **Context continuation:** if the window nears exhaustion, write a `HANDOFF.md` (state, next task, open gates) to `docs/superpowers/plans/`, then continue in a fresh window using `headroom`+`caveman`+`codeburn`. Never re-derive settled facts; read HANDOFF + this plan.
6. **Auth blocker:** live swarm smoke test needs user-supplied auth (re-login OR api key). Everything else is proven with the deterministic env-injection probe (Phase 1 Task 6). Disclose this in every delivery report until resolved.

---

## FILE STRUCTURE

**Create:**
- `agent-runtime/providers/registry.mjs` — frozen provider list + capability lookup.
- `agent-runtime/providers/crypto.mjs` — AES-256-GCM seal/open + machine key mgmt.
- `agent-runtime/providers/credentials.mjs` — store: load/save/connect/replace/disconnect/setActive/getActiveSecret.
- `agent-runtime/providers/routes.mjs` — HTTP handlers for `/runtime/providers/*`.
- `agent-runtime/test/providers-credentials.test.mjs` — store + crypto unit tests.
- `agent-runtime/test/providers-http.test.mjs` — endpoint tests (token/Host gates).
- `agent-runtime/test/engine-key-injection.test.mjs` — the deterministic env-injection probe.
- `src/components/settings/ProvidersPanel.tsx` — the screen.
- `src/components/settings/ProviderCard.tsx` — one provider card.
- `src/components/settings/ClaudeAuthModes.tsx` — the two-mode chooser + key field.
- `src/lib/providers.ts` — typed client (fetch wrappers) + types.
- `src/components/settings/__tests__/ProvidersPanel.test.tsx` — component tests.

**Modify:**
- `agent-runtime/server.mjs` — mount routes; replace `:1205` capability gate; key-injection in child-env builder (`:1229-1233`) for engine + chat spawn; extend `/runtime/health` with `activeProvider`.
- `src/components/PreflightGate.tsx` + its readiness producer — accept either auth.
- `src/App.tsx` (or settings router) — route to ProvidersPanel.
- `.env.example` — document `ANTHROPIC_API_KEY` optional + provider knobs.

---

## PHASE 0 — Baseline health + fix broken (BLOCKING, do first)

**Model:** Fable 5 · **Skills:** `sp-systematic-debugging`, `sp-verification-before-completion`, `mem-search`, `codeburn`.

- [ ] **0.1** Create branch: `git checkout -b feat/multi-provider-credentials` (from `helmMission`). No commits yet.
- [ ] **0.2** Runtime env aligned: `agent-runtime/.env` → `RUNTIME_PORT=3006` + dev `RUNTIME_TOKEN_DIR` (already done this session — verify).
- [ ] **0.3** Typecheck baseline: `npm run typecheck` → expect 0 errors. Record.
- [ ] **0.4** Runtime tests baseline: `npm run test:runtime` → expect 1135 pass; the only fails are Docker-sandbox tests IF Docker down. With Docker up, expect those green too. Record exact counts.
- [ ] **0.5** Unit + vendor + electron test baselines: `npm run test:unit`, `test:vendor`, `test:electron`. Record.
- [ ] **0.6** Boot runtime (`cd agent-runtime && npm start`) + dev UI (preview `missionalpha-dev`); confirm Inbox/Board render, SSE `live`, `/runtime/health` = 200. Screenshot.
- [ ] **0.7** Write `docs/superpowers/plans/BASELINE-2026-08-09.md` with all recorded numbers. This is the regression gate every later phase re-runs.

**Exit gate:** typecheck 0, runtime suite green (sandbox tests may need Docker), UI live. Any red → fix with `sp-systematic-debugging` before Phase 1.

---

## PHASE 1 — Core feature (backend→frontend, fully wired)

**Model:** Opus 4.8 build / Fable 5 verify · **Skills:** `sp-test-driven-development` (all tasks), `security-review` + `claude-code-security-review` (Tasks 1-4, 6), `hallmark`→`impeccable`→`taste-skill` (Tasks 7-9 UI), `emil-design-eng` (Task 9 motion), `code-reviewer` + `/code-review` (Task 11), `sp-verification-before-completion` (Task 12), `codeburn` (end).

### Task 1: Provider registry
**Files:** Create `agent-runtime/providers/registry.mjs`; Test `agent-runtime/test/providers-credentials.test.mjs`.

- [ ] **1.1 Write failing test**
```js
import { test } from "node:test"; import assert from "node:assert/strict";
import { PROVIDERS, providerById, providerCapability } from "../providers/registry.mjs";
test("registry lists claude as swarm-capable and wired", () => {
  const c = providerById("claude");
  assert.equal(c.capability, "swarm");
  assert.equal(c.wired, true);
  assert.deepEqual(c.authMethods, ["subscription", "api_key"]);
});
test("capability lookup + chat_only providers exist", () => {
  assert.equal(providerCapability("claude"), "swarm");
  assert.equal(providerCapability("minimax"), "chat_only");
  assert.equal(providerById("openai-codex").wired, false);
  assert.equal(PROVIDERS.length, 4);
});
```
- [ ] **1.2 Run → FAIL** `node --test agent-runtime/test/providers-credentials.test.mjs` (module missing).
- [ ] **1.3 Implement**
```js
// agent-runtime/providers/registry.mjs
export const PROVIDERS = Object.freeze([
  { id: "claude", label: "Claude", authMethods: ["subscription", "api_key"], capability: "swarm", wired: true },
  { id: "openai-codex", label: "ChatGPT · Codex", authMethods: ["device_code"], capability: "swarm", wired: false },
  { id: "minimax", label: "MiniMax", authMethods: ["oauth"], capability: "chat_only", wired: false },
  { id: "zai", label: "Z.ai", authMethods: ["api_key"], capability: "chat_only", wired: false },
]);
const BY_ID = Object.freeze(Object.fromEntries(PROVIDERS.map((p) => [p.id, p])));
export function providerById(id) { return BY_ID[id] ?? null; }
export function providerCapability(id) { return BY_ID[id]?.capability ?? null; }
```
- [ ] **1.4 Run → PASS.**

### Task 2: Crypto (AES-256-GCM seal/open + machine key)
**Files:** Create `agent-runtime/providers/crypto.mjs`; add tests to `providers-credentials.test.mjs`.

- [ ] **2.1 Write failing test**
```js
import { sealSecret, openSecret, ensureKey } from "../providers/crypto.mjs";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
test("seal→open round-trips; ciphertext ≠ plaintext", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-key-"));
  ensureKey(dir);
  const sealed = sealSecret(dir, "sk-ant-secret-123");
  assert.notEqual(sealed.ct, "sk-ant-secret-123");
  assert.equal(openSecret(dir, sealed), "sk-ant-secret-123");
});
test("tampered ciphertext throws (GCM auth)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-key-")); ensureKey(dir);
  const sealed = sealSecret(dir, "x"); sealed.ct = sealed.ct.slice(0, -2) + "00";
  assert.throws(() => openSecret(dir, sealed));
});
```
- [ ] **2.2 Run → FAIL.**
- [ ] **2.3 Implement**
```js
// agent-runtime/providers/crypto.mjs
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs"; import { join } from "node:path";
const KEY_FILE = (dir) => join(dir, "cred.key");
export function ensureKey(dir) {
  const f = KEY_FILE(dir);
  if (!existsSync(f)) writeFileSync(f, randomBytes(32), { mode: 0o600 });
  return readFileSync(f);
}
export function sealSecret(dir, plaintext) {
  const key = ensureKey(dir); const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}
export function openSecret(dir, sealed) {
  const key = ensureKey(dir);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  d.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(sealed.ct, "base64")), d.final()]).toString("utf8");
}
```
- [ ] **2.4 Run → PASS.**

### Task 3: Credential store
**Files:** Create `agent-runtime/providers/credentials.mjs`; extend `providers-credentials.test.mjs`.

- [ ] **3.1 Write failing tests** — connect(api_key) persists metadata + hasSecret true, plaintext NOT in `credentials.json`; getActiveSecret returns decrypted; disconnect removes both; setActive validates provider id; default active = claude subscription; file mode 0600.
```js
import { createStore } from "../providers/credentials.mjs";
test("connect api_key: metadata persisted, secret encrypted, plaintext never in json", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-store-"));
  const s = createStore(dir);
  s.connect("claude", { authMethod: "api_key", secret: "sk-ant-XYZ", identifier: "me@x.co" });
  const raw = readFileSync(join(dir, "credentials.json"), "utf8");
  assert.ok(!raw.includes("sk-ant-XYZ"));
  assert.equal(s.snapshot().providers.claude.hasSecret, true);
  assert.equal(s.getActiveSecret(), "sk-ant-XYZ");
});
test("subscription mode stores no secret; disconnect clears", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-store-")); const s = createStore(dir);
  s.connect("claude", { authMethod: "subscription", identifier: "me@x.co" });
  assert.equal(s.getActiveSecret(), null);
  s.disconnect("claude");
  assert.equal(s.snapshot().providers.claude, undefined);
});
```
- [ ] **3.2 Run → FAIL.**
- [ ] **3.3 Implement** `createStore(dir)` returning `{ snapshot, connect, replace, disconnect, setActive, getActiveSecret, getSecretFor }`. Persists `credentials.json` (0600) with `{ activeProviderId, providers }`; api_key secrets sealed via crypto.mjs into `credentials.enc` (0600). `snapshot()` returns metadata only (never secrets). `getActiveSecret()` → if active provider authMethod==="api_key" return `openSecret(...)`, else null. Validate `providerById(id)` on every mutation; throw on unknown. On first load with no file, default `{ activeProviderId: "claude", providers: {} }`.
- [ ] **3.4 Run → PASS.** Add a test asserting `statSync(credentials.json).mode & 0o777 === 0o600`.

### Task 4: Engine + chat key-injection (the surgical core)
**Files:** Modify `agent-runtime/server.mjs`.

- [ ] **4.1 Wire store at boot:** near `TOKEN_DIR` setup (~`:211`), `const credStore = createStore(TOKEN_DIR);` (import from `./providers/credentials.mjs`). `ensureKey(TOKEN_DIR)` once.
- [ ] **4.2 Replace `:1205` gate:**
```js
// was: if (BACKEND !== "cli") return { error: "engine write-loop requires the cli backend (claude subscription)" };
const activeId = credStore.snapshot().activeProviderId;
if (providerCapability(activeId) !== "swarm")
  return { error: `active provider '${activeId}' is chat-only — switch to a swarm-capable provider to run the autonomous engine`, code: "CHAT_ONLY" };
```
- [ ] **4.3 Key-injection in the CLI child-env builder (`:1229-1233`)** — after the strip loop, conditionally add the key:
```js
const activeSecret = credStore.getActiveSecret(); // decrypted api_key or null
if (activeSecret && activeId === "claude") childEnv.ANTHROPIC_API_KEY = activeSecret;
```
Apply the SAME two lines to the chat spawn path (find the other `spawn(CLAUDE_BIN` site) so chat honors the mode too.
- [ ] **4.4** Extend `/runtime/health` JSON with `activeProvider: activeId, activeCapability: providerCapability(activeId)`.
- [ ] **4.5** Manual sanity: `curl -s -H "x-runtime-token: $TOK" 127.0.0.1:3006/runtime/health | jq .activeProvider` → `"claude"`.

### Task 5: Runtime endpoints
**Files:** Create `agent-runtime/providers/routes.mjs`; mount in `server.mjs`; Test `agent-runtime/test/providers-http.test.mjs`.

- [ ] **5.1 Write failing tests** (mirror `inbox-http.test.mjs` harness): `GET /runtime/providers` with no token → 401; with evil Host → 403; with token → returns 4 providers + activeProviderId. `POST /runtime/providers/claude/connect` `{authMethod:"api_key", secret:"sk-ant-test"}` with a stubbed probe → 200, snapshot shows connected+hasSecret, secret NOT in response body. `POST .../disconnect` → 200, gone. `POST /runtime/providers/active {providerId:"minimax"}` → 200 with `warning` about chat-only.
- [ ] **5.2 Run → FAIL.**
- [ ] **5.3 Implement** handlers `{ list, connect, replace, disconnect, setActive }` taking `(credStore, probeFn)`. `connect` for api_key calls `probeFn(secret)` (1-token Anthropic request) and only persists on success; returns `{ ok, provider }` with metadata only. `setActive` returns `{ ok, warning? }` (warning when `chat_only`). In `server.mjs`, gate these behind the SAME `hostOk` + token check as `/inbox`; route `GET /runtime/providers`, `POST /runtime/providers/:id/(connect|replace|disconnect)`, `POST /runtime/providers/active`. Inject a real `probeFn` (uses `@anthropic-ai/sdk` `messages.create` max_tokens:1) in prod; tests pass a stub.
- [ ] **5.4 Run → PASS.** Assert no secret string appears in any response body.

### Task 6: Deterministic env-injection probe (proves the unlock WITHOUT a live model)
**Files:** Create `agent-runtime/test/engine-key-injection.test.mjs`.

- [ ] **6.1 Write test** — extract the child-env builder into a pure exported helper `buildChildEnv(processEnv, { activeSecret, activeId })` in server.mjs (refactor 4.3 into this testable fn), then:
```js
import { buildChildEnv } from "../server-envbuild.mjs"; // or exported from server
test("api_key mode → ANTHROPIC_API_KEY present in child env", () => {
  const env = buildChildEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-host-should-be-stripped" },
                            { activeSecret: "sk-ant-ACTIVE", activeId: "claude" });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-ACTIVE");
});
test("subscription mode → key stripped, absent from child env", () => {
  const env = buildChildEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-host" },
                            { activeSecret: null, activeId: "claude" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});
```
- [ ] **6.2 Refactor** the inline env loop into `buildChildEnv` (exported), call it from both spawn sites. Run → PASS. This is the core-correctness proof gated on NO auth.

### Task 7: Typed client + types
**Files:** Create `src/lib/providers.ts`.
- [ ] **7.1** Types: `ProviderId`, `AuthMethod`, `Capability`, `ProviderMeta`, `ProvidersSnapshot`. Fetch wrappers using existing `runtimeBase` (token header + base URL): `getProviders()`, `connectProvider(id, body)`, `replaceProvider`, `disconnectProvider`, `setActiveProvider(id)`. All typed, no `any`.
- [ ] **7.2** Vitest/node test: mock fetch, assert each wrapper hits the right path + method + carries token header.

### Task 8: ProviderCard + ClaudeAuthModes (structure)
**Files:** Create `src/components/settings/ProviderCard.tsx`, `ClaudeAuthModes.tsx`.
**Skills:** `hallmark` (structure/anti-slop) → `impeccable` (polish) → `taste-skill`.
- [ ] **8.1** `ProviderCard` props: `meta, account?, onAdd, onReplace, onDisconnect`. Renders icon tile, label + capability badge (Full swarm/Chat only), auth sublabel, connected row (status dot + `id:account` + identifier + Replace/Disconnect) OR "Coming soon" empty state for `wired:false`. Match mockup dark tokens (`tok(...)`).
- [ ] **8.2** `ClaudeAuthModes` props: `snapshot, onConnectSubscription, onConnectApiKey`. Two-mode selector (subscription default), api-key → masked `<input type=password>` + Verify&save; security hint line. Wired to Task 7 client.
- [ ] **8.3** Component tests: render both states; api-key submit calls `connectProvider("claude",{authMethod:"api_key",secret})`; disconnect calls client.

### Task 9: ProvidersPanel (assemble + motion + live wiring)
**Files:** Create `src/components/settings/ProvidersPanel.tsx`; modify settings router/`App.tsx`.
**Skills:** `hallmark`→`impeccable`→`taste-skill`, `emil-design-eng` (card enter/expand motion, reduced-motion aware).
- [ ] **9.1** Panel: fetch `getProviders()` on mount; "✓ Credentials synced" banner when ≥1 connected; map registry → `ProviderCard`; Claude card hosts `ClaudeAuthModes`. Optimistic update + refetch on mutation. Error toasts on failure. Wire into Settings nav (`ref_56` region).
- [ ] **9.2** Motion: card mount stagger + api-key field expand via Framer Motion, `prefers-reduced-motion` respected (emil review).
- [ ] **9.3** Component test: full panel renders 4 cards, connect flow updates banner.

### Task 10: Preflight update
**Files:** Modify `src/components/PreflightGate.tsx` + readiness producer (electron bridge / runtime health).
- [ ] **10.1** Readiness "auth OK" = subscription usable OR a stored api_key credential exists (from `/runtime/health.activeProvider` + store). Block only when neither. Update `SetupScreen` copy: "Connect a provider — Claude subscription or an Anthropic API key — to start the swarm." Add a button/deeplink to the Providers panel.
- [ ] **10.2** Test: preflight `blocking:false` when api_key credential present even if subscription absent.

### Task 11: Security review + code review
**Skills:** `security-review`, `claude-code-security-review`, `code-reviewer` agent, `/code-review`.
- [ ] **11.1** Run `security-review` over `providers/*.mjs`, `routes.mjs`, engine diff, UI key handling. CHECK: secret never logged/echoed/serialized to snapshot; key file 0600 outside REPO_ROOT; injected only into model subprocess; probe failure persists nothing; no key in URL/query; redaction covers new paths. **Block on any CRITICAL; fix before proceeding.**
- [ ] **11.2** `code-reviewer` agent on the full diff. Resolve all sev≥Medium.

### Task 12: End-to-end verification (Fable 5)
**Skills:** `sp-verification-before-completion`, `webapp-testing`/`preview_*`.
- [ ] **12.1** Re-run Phase 0 baseline suites → no regressions (record deltas).
- [ ] **12.2** New tests all green: `providers-credentials`, `providers-http`, `engine-key-injection`, UI component tests.
- [ ] **12.3** Live wiring proof (no model needed): boot runtime+UI → open Providers → connect a DUMMY api key with probe stubbed to accept in a dev flag OR use `/runtime/providers` curl round-trip → confirm snapshot flips to connected, banner shows, `/runtime/health.activeProvider` reflects it, engine gate now returns swarm-eligible (env-injection probe green). Screenshot each.
- [ ] **12.4** **Auth-gated smoke (disclose if blocked):** if the user supplies a real Anthropic key OR re-logs `claude`, set it active, trigger one scheduled task, confirm a REAL delivery with a diff appears (not a stuck-failure). If auth unavailable → mark this single step "BLOCKED — needs user auth" in the delivery report; everything else remains verified.
- [ ] **12.5** Delivery report: PES format + Known Gaps & Risks + `codeburn` token summary for the phase.

---

## PHASE 2 — OpenAI Codex provider (full swarm)

**Model:** Opus 4.8 / Fable 5 · **Skills:** same matrix; `docs-lookup`/context7 for Codex CLI API; `security-review` (new secret path); UI via `hallmark`→`impeccable`→`taste-skill`.
- [ ] **2.1** Registry: flip `openai-codex.wired=true`; authMethod `device_code`.
- [ ] **2.2** Store: support device-code credential shape (token, not raw key).
- [ ] **2.3** Engine: when active provider = `openai-codex`, spawn the Codex CLI binary instead of `claude` (new spawner branch, same worktree/apply broker downstream). Capability stays `swarm`.
- [ ] **2.4** Endpoint: device-code connect flow (`connect` returns a device code + poll; store on completion).
- [ ] **2.5** UI: Codex card active — Add account (device code), Replace, Disconnect.
- [ ] **2.6** Tests: spawner branch selection by active provider; device-code store round-trip; UI flow. Security review. E2E verify (Fable 5). Delivery report.

---

## PHASE 3 — MiniMax + Z.ai (chat-capable)

**Model:** Opus 4.8 / Fable 5 · **Skills:** same matrix.
- [ ] **3.1** Registry: `minimax` (oauth), `zai` (api_key), both `capability:chat_only`, `wired:true`.
- [ ] **3.2** Chat path: route chat replies through provider SDK when active provider is chat-only (new adapter under `providers/adapters/`). Engine write-loop returns the CHAT_ONLY structured result (already built Task 4.2) + UI banner "engine paused — chat-only provider active".
- [ ] **3.3** Store: oauth (minimax) + api_key (zai) shapes.
- [ ] **3.4** UI: both cards active with correct auth flows + Chat-only badge; setActive warning surfaced.
- [ ] **3.5** Tests: chat adapter per provider; capability gate pauses engine cleanly; UI warnings. Security review. E2E verify. Delivery report.

---

## SELF-REVIEW (done at plan-write time)

- **Spec coverage:** registry (T1), store+crypto (T2-3), engine unlock (T4,6), endpoints (T5), client (T7), UI cards+modes+panel (T8-9), preflight (T10), security (T11), verify (T12), phases 2-3 for remaining providers. ✅ every spec section mapped.
- **Placeholder scan:** novel/critical tasks carry full code; repetitive UI tasks specify exact props/paths/behaviors + tests. No "TBD/handle edge cases".
- **Type consistency:** `buildChildEnv`, `createStore`, `sealSecret/openSecret/ensureKey`, `providerCapability/providerById`, client fn names consistent across tasks.
- **Known gap:** Task 12.4 live smoke is the one step gated on user auth — explicitly disclosed, not hidden.

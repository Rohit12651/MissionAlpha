# Helm Excellence Program — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `sp-subagent-driven-development`
> (recommended) or `sp-executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take MissionAlpha/Helm from a working agent-ops console to a production-grade,
fully-wired product — every feature end-to-end (runtime → REST/SSE → client → UI), every
claim verified, nothing decorative.

**Architecture:** Additive only. New runtime modules under `agent-runtime/`, new client
libs under `src/lib/`, new UI under `src/components/`. No re-platform: SSE + REST stay
(ADR-052), CLI-spawn engine stays. Every new surface is a consumer of events the bus
already emits or a new gated REST route following the existing `needsAuth` + Host + token
pattern.

**Tech Stack:** React 19 · Vite 5 · TypeScript · Node 26 · better-sqlite3 13 · Electron ·
node:test · Playwright (new, Phase 0)

**Source spec:** `docs/superpowers/specs/2026-08-10-excellence-manifesto-review.md` (rev 3)

**Branch:** `feat/multi-provider-credentials` @ `05e8dbd`. **NO COMMITS until the user says so.**

---

## 0. Operating protocol — applies to EVERY phase, no exceptions

### 0.1 Skill chain, per phase

| When | Skill | Non-negotiable |
|---|---|---|
| Phase start | `sp-executing-plans` (or `sp-subagent-driven-development`) | Yes |
| Before any code | `sp-test-driven-development` — RED before GREEN | Yes |
| Root cause unclear | `sp-systematic-debugging` | On trigger |
| Any UI/frontend work | `hallmark` → `impeccable` → `taste-skill`, **in that order** | Yes, phases 1-9 |
| Any animation/motion | `emil-design-eng` | On trigger |
| Auth / API keys / user input / SQL / secrets | `security-review` + `claude-code-security-review` | Yes, blocks on CRITICAL |
| After code written | `code-reviewer` agent | Yes |
| Before claiming done | `sp-verification-before-completion` | Yes |
| Browser verification | `preview_*` tools (in-session) or `agent-browser` | Yes, phases with UI |
| Planning / QA / ship gates | gstack `/qa`, `/review`, `/cso` | Yes |
| After debugging session | `headroom learn` | On trigger |
| Session end | `codeburn` | Yes |

**Always on, every phase:** `headroom` (context compression), `caveman` (output
compression), `claude-mem` (cross-session memory). These are already wired via hooks.

### 0.2 The gate — every phase ends here

No phase is "done" until **all seven** pass, with output pasted into the phase log:

```bash
npm run typecheck      # expect: 0 errors
npm run lint           # expect: 0 (--max-warnings 0)
npm run test:unit      # expect: 372+ pass, 0 fail
npm run test:runtime   # expect: 1208+ pass, 0 fail
npm run test:vendor    # expect: 28 pass, 0 fail
npm run test:electron  # expect: 9 pass, 0 fail
npm run build          # expect: tsc + vite build clean
```

**Baseline to never regress:** typecheck 0 · lint 0 · unit 372 · runtime 1208 · vendor 28
· electron 9 = **1,617 tests green**. Any phase that reduces a count without deleting the
corresponding feature has broken something. Stop and fix.

Plus, per phase:
- **Runtime restart** after ANY `agent-runtime/*.mjs` edit. A stale process serves old
  code — this has bitten this project before.
- **Live browser proof** for any UI change: screenshot at 320 / 768 / 1440, both themes.
- **Fable 5 independent verification** (§0.3).

### 0.3 Fable 5 verification protocol

Opus builds. **Fable verifies.** After each phase's gate passes, dispatch:

```
Agent tool → subagent_type: "general-purpose", model: "fable"
```

Fable's prompt must include: (a) the phase goal, (b) the files changed, (c) the claim
being made, (d) instruction to **independently re-run the gates and re-derive any number
in the delivery report**, (e) instruction to be adversarial and hunt for the failure the
builder missed. Fable operates under the same caveman/headroom/codeburn discipline —
terse output, no filler.

**Fable's verdict is binding.** If Fable finds a defect, the phase is NOT done. Fix,
re-gate, re-verify. Max 3 iterations; if it does not converge, escalate to the user with
`STATUS / REASON / ATTEMPTED / RECOMMENDATION`.

Precedent from this session: three rounds of adversarial review found real defects in the
builder's own work **every single round**, including a fabricated code quotation. Assume
the builder is wrong until an independent model says otherwise.

### 0.4 Context exhaustion protocol

**Honest limit:** an agent cannot self-invoke a new context window. When context runs
out, the session ends. What CAN be done:

1. **Prevention:** `headroom` is on. Keep phases small. Dispatch heavy exploration to
   subagents so their token cost stays out of the main thread.
2. **State survives in files, not context.** Before each phase ends, append to
   `docs/superpowers/plans/EXCELLENCE-HANDOFF.md`: phase status, gates run + output,
   files touched, open threads, next action. **This file is the resume point.**
3. **Resume:** the user opens a new session and says "continue the excellence program."
   The new session reads `EXCELLENCE-HANDOFF.md` + this plan and picks up at the first
   unchecked box. No re-derivation.
4. **Unattended continuation:** if genuinely autonomous overnight running is wanted, it
   requires the `/loop` skill (ScheduleWakeup) or a cron routine — a separate setup the
   user must authorize. Not assumed here.

### 0.5 Rules that do not bend

- **No commits until the user says so.** Work accumulates in the working tree.
- **Everything wired.** No feature ships with a dead button, an unrouted endpoint, or a
  client function nothing calls. Each phase has an explicit "wiring proof" step.
- **No fabricated data.** No confidence percentages, no invented telemetry. If a number
  cannot be computed from real state, it does not render.
- **Don't break current functionality.** Re-run the full baseline every phase.
- **Production-grade only.** No stubs, no mock data, no TODO-as-done. Anything stubbed is
  labeled STUB in the delivery report.
- **Delivery report per phase**, with a mandatory **Known Gaps & Risks** section.

---

## File structure — what gets created, and why

| Path | Responsibility | Phase |
|---|---|---|
| `test/visual/harness.mjs` | Playwright launch, deterministic freeze, screenshot capture | 0 |
| `test/visual/pages.mjs` | The page × viewport × theme matrix | 0 |
| `agent-runtime/providers/routes.mjs` *(modify)* | `PATCH /runtime/accounts/:id` | 1 |
| `src/lib/accounts.ts` *(modify)* | `updateAccount()` client | 1 |
| `src/components/bos/AccountsPage.tsx` *(modify)* | Edit row action + edit form | 1 |
| `agent-runtime/failure-signature.mjs` | Pure: delivery → cluster signature | 2 |
| `agent-runtime/deliveries.mjs` *(modify)* | Cluster query + bulk-decide | 2, 3 |
| `src/lib/clusterModel.ts` | Pure: group deliveries by signature | 2 |
| `src/components/inbox/ClusterCard.tsx` | Collapsed cluster UI | 2 |
| `src/components/inbox/InboxPanel.tsx` *(modify)* | Render clusters + selection | 2, 3 |
| `src/components/inbox/DeliveryBulkBar.tsx` | Bulk action bar for deliveries | 3 |
| `agent-runtime/patch-edit.mjs` | Validate + apply a human-edited patch | 4 |
| `src/components/inbox/DiffEditor.tsx` | Inline diff edit (TEXT NODES ONLY) | 4 |
| `src/lib/activityStream.ts` | SSE → activity feed model (pure) | 5 |
| `src/components/bos/ActivityStream.tsx` | The feed UI | 5 |
| `agent-runtime/agent-ledger.mjs` | Per-agent approval stats from SQLite | 6 |
| `src/components/bos/AgentLedger.tsx` | Ledger UI | 6 |
| `agent-runtime/spend.mjs` | Metered spend, API-key accounts only | 7 |
| `src/theme/tokens.css` | The single token source (scale, ladder, accent) | 8 |

---

# PHASE 0 — Baseline lock + visual-regression harness

**Why first:** there are **zero component/DOM tests** across 100 components. Phases 8-9
touch 57 component files with no automated safety net. The harness is a hard prerequisite,
not a mitigation. **It is also unproven** — screenshots must be deterministic against
`HeartbeatRibbon`, `PulseGlobe`, `TtlRing` and live SSE. This phase proves or disproves it.

**Skills:** `sp-executing-plans` · `sp-test-driven-development` · `webapp-testing` ·
`preview_*` tools · `sp-verification-before-completion`

### Task 0.1 — Lock the baseline

- [ ] **Step 1: Run all seven gates, capture output verbatim**

```bash
cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha
npm run typecheck && npm run lint && npm run test:unit && \
npm run test:runtime && npm run test:vendor && npm run test:electron && npm run build
```

Expected: typecheck 0 · lint 0 · unit 372 · runtime 1208 · vendor 28 · electron 9 · build clean.

- [ ] **Step 2: Write the baseline into the handoff file**

Create `docs/superpowers/plans/EXCELLENCE-HANDOFF.md` with a `## Baseline` section
containing the exact counts above and the date. Every later phase diffs against this.

### Task 0.2 — Determinism spike (THE GO/NO-GO)

- [ ] **Step 1: Install Playwright**

```bash
npm i -D @playwright/test && npx playwright install chromium
```

- [ ] **Step 2: Identify every non-deterministic source**

```bash
grep -rn "animation\|@keyframes\|transition\|requestAnimationFrame\|setInterval" \
  src/theme/*.css src/index.css src/components/HeartbeatRibbon.tsx \
  src/components/TtlRing.tsx src/components/PulseGlobe.tsx | head -40
```

Record every hit. Each is a determinism risk.

- [ ] **Step 3: Write the freeze harness**

Create `test/visual/harness.mjs`:

```javascript
// Deterministic screenshot harness. Freezes every source of visual nondeterminism
// BEFORE first paint, so a screenshot of unchanged code is byte-identical run to run.
export const FREEZE_CSS = `
  *, *::before, *::after {
    animation-play-state: paused !important;
    animation-delay: -1ms !important;
    animation-duration: 1ms !important;
    transition-duration: 0ms !important;
    transition-delay: 0ms !important;
    caret-color: transparent !important;
  }
`;

/** Pin clock + RNG so relative timestamps and any jitter render identically. */
export const FREEZE_JS = `
  (() => {
    const FIXED = 1786500000000; // 2026-08-10T12:40:00Z, arbitrary but fixed
    const RealDate = Date;
    // @ts-ignore
    globalThis.Date = class extends RealDate {
      constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(FIXED); }
      static now() { return FIXED; }
    };
    Math.random = () => 0.42;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(FIXED), 0);
  })();
`;

export async function freeze(page) {
  await page.addInitScript(FREEZE_JS);
  await page.addStyleTag({ content: FREEZE_CSS });
}
```

- [ ] **Step 4: Write the determinism test (this is the spike)**

Create `test/visual/determinism.spec.mjs`:

```javascript
import { test, expect } from "@playwright/test";
import { freeze } from "./harness.mjs";

// THE GO/NO-GO: screenshot the most animation-heavy surface twice in one run.
// If these two buffers differ, the harness cannot gate Phase 9 and the plan changes.
test("two consecutive captures of the live board are byte-identical", async ({ page }) => {
  await page.goto("http://localhost:3004");
  await freeze(page);
  await page.waitForSelector('[data-testid="bos-side"], nav', { timeout: 15000 });
  const a = await page.screenshot({ fullPage: false });
  await page.waitForTimeout(1200); // let any un-frozen timer fire
  const b = await page.screenshot({ fullPage: false });
  expect(Buffer.compare(a, b)).toBe(0);
});
```

- [ ] **Step 5: Run it**

```bash
npm run dev &   # vite on :3004
npx playwright test test/visual/determinism.spec.mjs
```

Expected: **PASS**.

- [ ] **Step 6: GATE — decide**

- **PASS** → harness is viable. Continue to Task 0.3.
- **FAIL** → do NOT proceed to 0.3. Diagnose with `sp-systematic-debugging`. If the
  globe (WebGL) is the cause, add a `VITE_GLOBE=0` capture flag and re-run. If it still
  fails, **stop and escalate to the user**: Phase 9 (A2, 57 files) has no safety net and
  must be re-scoped to manual review or deferred. Record the decision in the handoff file.

### Task 0.3 — Baseline screenshot matrix

- [ ] **Step 1: Define the matrix**

Create `test/visual/pages.mjs`:

```javascript
// Every BOS surface × 3 viewports × 2 themes. This is the regression net for phases 8-9.
export const PAGES = [
  "center", "stories", "missions", "brief", "deck", "workflows",
  "schedule", "outputs", "vault", "accounts", "roadmap",
];
export const VIEWPORTS = [
  { name: "mobile",  width: 320,  height: 800 },
  { name: "tablet",  width: 768,  height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];
export const THEMES = ["dark", "light"];
```

- [ ] **Step 2: Write the capture spec, run it, commit baselines to disk (not git)**

Capture to `test/visual/__baseline__/<page>-<viewport>-<theme>.png`. 11 × 3 × 2 = **66
baseline images**. Add `test/visual/__baseline__/` and `test/visual/__diff__/` to
`.gitignore` — binaries do not belong in this repo's history.

- [ ] **Step 3: Add npm scripts**

```json
"test:visual": "playwright test test/visual",
"test:visual:update": "playwright test test/visual --update-snapshots"
```

### Phase 0 exit

- [ ] All seven gates green, output pasted into handoff
- [ ] Determinism spike PASSED (or escalation recorded)
- [ ] 66 baselines captured
- [ ] **Fable 5 verification** — prompt: *"Independently re-run the determinism spike 3×.
      Confirm byte-identity. Then attempt to BREAK it: resize, navigate, let SSE deliver an
      event mid-capture. Report any nondeterminism the builder missed."*
- [ ] Delivery report + Known Gaps appended to handoff

---

# PHASE 1 — edit-account (the live defect)

**Why:** `agent-runtime/server.mjs:1007` streams *"This account has no model set — edit
the account and add a model id"*. `AccountsPage.tsx` `AccountRow` renders only **Set
active** and **Remove**. The runtime instructs users to do something the UI cannot do.
Only recovery is delete + re-add, which destroys the sealed secret. **Shipping today.**

**Skills:** `sp-test-driven-development` · **`security-review` + `claude-code-security-review`
(MANDATORY — handles API keys)** · `hallmark` → `impeccable` → `taste-skill` (UI) ·
`code-reviewer` · `sp-verification-before-completion`

**Scope decision (was undefined in the spec — deciding it here):** PATCH accepts
`label`, `model`, `baseUrl`, and optionally a **replacement secret**. It does NOT accept
`providerType` (changing type would invalidate the capability tier and the sealed secret's
meaning — delete and re-add is correct for that). Omitted fields are left unchanged. The
sealed secret survives any edit that does not explicitly replace it.

### Task 1.1 — Backend: PATCH endpoint (TDD)

**Files:** Modify `agent-runtime/providers/credentials.mjs`, `agent-runtime/providers/routes.mjs`
Test: `agent-runtime/test/providers-credentials.test.mjs`, `agent-runtime/test/providers-http.test.mjs`

- [ ] **Step 1: Write the failing store test**

Add to `agent-runtime/test/providers-credentials.test.mjs`:

```javascript
test("updateAccount changes model without touching the sealed secret", async (t) => {
  const dir = await mkTempStoreDir(t);
  const store = createStore(dir);
  const acct = store.addAccount({
    providerType: "custom", label: "or", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "sk-test-123",
  });
  assert.equal(acct.hasSecret, true);

  const updated = store.updateAccount(acct.id, { model: "nvidia/nemotron-nano-9b-v2:free" });

  assert.equal(updated.model, "nvidia/nemotron-nano-9b-v2:free");
  assert.equal(updated.hasSecret, true, "secret must survive a metadata-only edit");
  assert.equal(store.getSecret(acct.id), "sk-test-123", "secret value unchanged");
});

test("updateAccount can replace the secret", async (t) => {
  const dir = await mkTempStoreDir(t);
  const store = createStore(dir);
  const acct = store.addAccount({
    providerType: "custom", label: "or", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "old-key",
  });
  store.updateAccount(acct.id, { secret: "new-key" });
  assert.equal(store.getSecret(acct.id), "new-key");
});

test("updateAccount rejects providerType changes", async (t) => {
  const dir = await mkTempStoreDir(t);
  const store = createStore(dir);
  const acct = store.addAccount({ providerType: "claude", label: "c", authMethod: "subscription" });
  assert.throws(() => store.updateAccount(acct.id, { providerType: "openai" }),
    /providerType cannot be changed/);
});

test("updateAccount throws on unknown id", async (t) => {
  const dir = await mkTempStoreDir(t);
  const store = createStore(dir);
  assert.throws(() => store.updateAccount("nope", { model: "x" }), /unknown account/);
});
```

- [ ] **Step 2: Run — verify RED**

```bash
node --test agent-runtime/test/providers-credentials.test.mjs
```

Expected: FAIL — `store.updateAccount is not a function`.

- [ ] **Step 3: Implement `updateAccount` in `credentials.mjs`**

Add to the returned object, directly after `addAccount`:

```javascript
    // Edit an existing account. Metadata-only by default; `secret` (when present and
    // non-empty) re-seals a NEW secret over the old one. providerType is immutable —
    // changing it would invalidate the capability tier the sealed secret was stored under,
    // so callers must delete + re-add instead.
    updateAccount(id, patch = {}) {
      const account = requireAccount(id);
      if ("providerType" in patch && patch.providerType !== account.providerType) {
        throw new Error("providerType cannot be changed; delete and re-add the account");
      }
      const next = { ...account };
      if (typeof patch.label === "string" && patch.label.trim()) {
        next.label = patch.label.trim().slice(0, 128);
      }
      if ("model" in patch) {
        if (patch.model !== null && typeof patch.model !== "string") throw new Error("model must be a string or null");
        if (typeof patch.model === "string" && patch.model.length > 128) throw new Error("model too long");
        next.model = patch.model === null || patch.model === "" ? null : patch.model;
      }
      if (typeof patch.baseUrl === "string" && patch.baseUrl) {
        if (!/^https?:\/\//i.test(patch.baseUrl)) throw new Error("baseUrl must be http(s)");
        next.baseUrl = patch.baseUrl;
      }
      if (typeof patch.secret === "string" && patch.secret.length > 0) {
        if (next.authMethod !== "api_key") throw new Error("only api_key accounts hold a secret");
        enc[next.id] = sealSecret(dir, patch.secret);
        next.hasSecret = true;
        persistEnc();
      }
      const i = meta.accounts.findIndex((a) => a.id === id);
      meta.accounts[i] = next;
      persistMeta();
      return { ...next };
    },
```

- [ ] **Step 4: Run — verify GREEN**

```bash
node --test agent-runtime/test/providers-credentials.test.mjs
```

Expected: PASS, all four new tests.

- [ ] **Step 5: Write the failing HTTP test**

Add to `agent-runtime/test/providers-http.test.mjs`:

```javascript
test("PATCH /runtime/accounts/:id updates model and never returns the secret", async (t) => {
  const { base, token } = await bootRuntime(t);
  const created = await postJson(`${base}/runtime/accounts`, token, {
    providerType: "custom", label: "or", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "sk-secret-abc",
  });
  const res = await fetch(`${base}/runtime/accounts/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, host: "127.0.0.1" },
    body: JSON.stringify({ model: "nvidia/nemotron-nano-9b-v2:free" }),
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!body.includes("sk-secret-abc"), "SECURITY: secret must never appear in a response");
  assert.equal(JSON.parse(body).model, "nvidia/nemotron-nano-9b-v2:free");
});

test("PATCH without a token is rejected", async (t) => {
  const { base } = await bootRuntime(t);
  const res = await fetch(`${base}/runtime/accounts/anything`, {
    method: "PATCH", headers: { "content-type": "application/json", host: "127.0.0.1" },
    body: JSON.stringify({ model: "x" }),
  });
  assert.equal(res.status, 401);
});

test("PATCH with an SSRF baseUrl is rejected", async (t) => {
  const { base, token } = await bootRuntime(t);
  const created = await postJson(`${base}/runtime/accounts`, token, {
    providerType: "custom", label: "or", authMethod: "api_key",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions", secret: "k",
  });
  const res = await fetch(`${base}/runtime/accounts/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, host: "127.0.0.1" },
    body: JSON.stringify({ baseUrl: "http://169.254.169.254/latest/meta-data/" }),
  });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 6: Run — verify RED, then implement the route**

In `agent-runtime/providers/routes.mjs`, add a PATCH handler alongside the existing
`POST :id/secret`. It MUST: (a) sit inside the same `needsAuth` + Host gate, (b) run
`assertSafeUrl()` from `url-guard.mjs` on any incoming `baseUrl`, (c) return the metadata
snapshot only — never the secret.

- [ ] **Step 7: Run — verify GREEN, then restart the runtime**

```bash
node --test agent-runtime/test/providers-http.test.mjs
# MANDATORY after any agent-runtime edit:
pkill -f "agent-runtime/server.mjs"; node agent-runtime/server.mjs &
```

### Task 1.2 — Client + UI

**Files:** Modify `src/lib/accounts.ts`, `src/components/bos/AccountsPage.tsx`
Test: `src/lib/__tests__/accounts.test.ts`

- [ ] **Step 1: Failing client test, then implement `updateAccount()`**

```typescript
export async function updateAccount(
  id: string,
  patch: { label?: string; model?: string | null; baseUrl?: string; secret?: string },
): Promise<Account> {
  return authedJson<Account>(`/runtime/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
```

- [ ] **Step 2: UI — Edit action per row**

Run `hallmark` → `impeccable` → `taste-skill` before writing markup. Add an **Edit**
button to `AccountRow` (between *Set active* and the trash icon) that opens an inline
edit form pre-filled with label / model / baseUrl, plus an optional "replace token"
password field with placeholder `leave blank to keep the current token`.

- [ ] **Step 3: Fix the message that started this**

`agent-runtime/server.mjs:1007` — the message now describes a real path. Verify the
wording matches the affordance that exists ("edit the account" → an Edit button exists).

- [ ] **Step 4: WIRING PROOF (live, not asserted)**

```bash
# runtime + UI up, then in the browser:
# 1. Accounts → Edit on the MiniMax row → set model → Save
# 2. Row re-renders with the model, "no model set" text is gone
# 3. Set active → Chat → confirm the adapter uses the new model
curl -s -X PATCH "http://127.0.0.1:3006/runtime/accounts/<id>" \
  -H "authorization: Bearer $(cat $RUNTIME_TOKEN_DIR/.runtime-token)" \
  -H 'content-type: application/json' -d '{"model":"nvidia/nemotron-nano-9b-v2:free"}' | jq
```

Screenshot each step. **A button that does not change server state is a failed phase.**

### Phase 1 exit

- [ ] Seven gates green (runtime count now 1208 + new tests)
- [ ] `security-review` run — **CRITICAL 0 required**; confirm secret never in any response, never logged, file mode still 0600
- [ ] `code-reviewer` agent run, findings ≥ Medium resolved
- [ ] Visual regression: `npm run test:visual` — accounts page diff expected and reviewed
- [ ] **Fable 5 verification** — prompt: *"Re-run every gate. Then attempt to exfiltrate the sealed secret through the new PATCH route: response body, error messages, logs, timing. Attempt SSRF via baseUrl. Attempt providerType escalation. Report anything the builder missed."*
- [ ] Delivery report + Known Gaps

---

# PHASE 2 — Failure clustering

**Why:** live measurement of the running app — queue strip reads `tech-lead · 27 fail`,
`sr-backend · 23 fail`, `sr-frontend · 19 fail`, `coo-station · 15 fail`, `cmo-station · 7
fail`, `sales-station · 6 fail` = **97 failures**, surfaced as ~20 near-identical Inbox
cards (*"tech-lead is stuck — spawn"* ×2, *"— timeout"* ×2, *"— empty-diff"* ×3, plus
dozens of rejected `coo-station is stuck — spawn`). **One problem rendered as twenty
decisions.** Confirmed absent: no cluster/dedupe/groupBy in `queueModel.ts` or the inbox
components.

**Skills:** `sp-test-driven-development` · `hallmark` → `impeccable` → `taste-skill` ·
`code-reviewer` · `sp-verification-before-completion`

### Task 2.1 — Pure signature function (backend)

**Files:** Create `agent-runtime/failure-signature.mjs`, Test: `agent-runtime/test/failure-signature.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { failureSignature } from "../failure-signature.mjs";

test("identical stuck-reasons for the same agent share a signature", () => {
  const a = { agentId: "tech-lead", title: "tech-lead is stuck — spawn", kind: "failure" };
  const b = { agentId: "tech-lead", title: "tech-lead is stuck — spawn", kind: "failure" };
  assert.equal(failureSignature(a), failureSignature(b));
});

test("different stuck-reasons do NOT collapse", () => {
  const a = { agentId: "tech-lead", title: "tech-lead is stuck — spawn", kind: "failure" };
  const b = { agentId: "tech-lead", title: "tech-lead is stuck — timeout", kind: "failure" };
  assert.notEqual(failureSignature(a), failureSignature(b));
});

test("same reason, different agent does NOT collapse", () => {
  const a = { agentId: "tech-lead", title: "tech-lead is stuck — spawn", kind: "failure" };
  const b = { agentId: "sr-backend", title: "sr-backend is stuck — spawn", kind: "failure" };
  assert.notEqual(failureSignature(a), failureSignature(b));
});

test("non-failure deliveries are NEVER clustered", () => {
  assert.equal(failureSignature({ agentId: "x", title: "Add feature", kind: "code" }), null);
});
```

- [ ] **Step 2: RED, then implement**

```javascript
// Failure clustering — collapses N identical agent-stuck deliveries into ONE decision.
// SAFETY: only `kind: "failure"` deliveries cluster. Real code deliveries are never
// merged — every code change keeps its own individual human decision.
const STUCK_RE = /^(?<agent>[\w-]+) is stuck — (?<reason>[\w-]+)/;

export function failureSignature(delivery) {
  if (!delivery || delivery.kind !== "failure") return null;
  const m = STUCK_RE.exec(String(delivery.title ?? ""));
  if (!m) return null;
  return `${delivery.agentId}::${m.groups.reason}`;
}
```

- [ ] **Step 3: GREEN**

### Task 2.2 — Client cluster model + UI

**Files:** Create `src/lib/clusterModel.ts`, `src/components/inbox/ClusterCard.tsx`;
Modify `src/components/inbox/InboxPanel.tsx`; Test: `src/lib/__tests__/clusterModel.test.ts`

- [ ] **Step 1: Failing test for `groupDeliveries`** — asserts N failures with one
      signature produce 1 cluster of size N, code deliveries pass through ungrouped, and
      **order is stable** (clusters sort by newest member).
- [ ] **Step 2: RED → implement → GREEN**
- [ ] **Step 3: `ClusterCard`** — run `hallmark`/`impeccable`/`taste-skill` first. Shows
      agent, reason, **×N** count, newest timestamp, and expands to the individual members.
      Actions: **Dispatch fix** (one task for the root cause) and **Dismiss all**.
- [ ] **Step 4: Wire into `InboxPanel`** behind a filter pill (`All` / `Clustered`).

### Task 2.3 — Bulk dismiss endpoint

- [ ] Failing HTTP test → `POST /inbox/bulk-decide` accepting `{ ids[], decision, feedback }`,
      gated identically to the single-decision route, **capped at 200 ids per call**,
      returning per-id results. Then implement, restart runtime, verify GREEN.

### Phase 2 exit

- [ ] Seven gates green
- [ ] **WIRING PROOF:** live Inbox shows ~20 cards collapse to ~6 clusters; **Dismiss all**
      on one cluster removes every member server-side; SSE pushes the update without refresh
- [ ] Visual regression reviewed
- [ ] **Fable 5** — prompt: *"Verify no CODE delivery was ever clustered. Attempt to make two semantically different failures collapse. Verify bulk-decide is auth-gated and capped. Confirm the Inbox count matches the DB after a bulk dismiss."*
- [ ] Delivery report + Known Gaps

---

# PHASE 3 — Bulk decisions on deliveries

**Why:** `BulkActionBar.tsx` exists but serves only the agent board ("ack all stale",
"respawn all offline"). Deliveries have no multi-select. The F3 confirm-gate pattern is
already written — this wires an existing primitive to a second surface.

**Skills:** `sp-test-driven-development` · `hallmark` → `impeccable` · `code-reviewer` ·
`security-review` (bulk state mutation) · `sp-verification-before-completion`

- [ ] **Task 3.1** — Selection state in `InboxPanel`: click-to-select, `Shift`-click range,
      `x` to toggle, `Esc` to clear. Unit-tested as a pure reducer in `src/lib/selectionModel.ts`.
- [ ] **Task 3.2** — `DeliveryBulkBar.tsx`: "N selected · Approve all low-risk · Reject all · Clear".
      **Hard gate:** approving any `high` band in bulk requires the typed confirm phrase —
      the existing single-decision friction must NOT be bypassable via bulk.
- [ ] **Task 3.3** — Wire to `POST /inbox/bulk-decide` (built in 2.3).
- [ ] **WIRING PROOF:** select 5, approve, confirm 5 rows leave the DB and 5 branches/PRs
      are attempted through the unchanged broker path.

**Phase 3 exit:** seven gates · security-review (**bulk approve must not bypass the
high-risk gate — CRITICAL if it does**) · visual regression · **Fable 5**: *"Attempt to
approve a high-risk delivery in bulk without typing the confirm phrase. Attempt to bulk-
decide someone else's ids. Attempt a 10,000-id payload."* · delivery report

---

# PHASE 4 — Approve-with-edit

**Why:** decisions are binary today. A one-line problem forces a full agent round-trip.
Editing inline before approving collapses the loop — the highest-leverage change to the
core decision surface.

**⚠ SECURITY-CRITICAL PHASE.** `ReviewPane.tsx:41-45` is a live security control:

> the diff is rendered as TEXT NODES ONLY. Every line goes through React's normal child
> escaping. There is no innerHTML and no dangerouslySetInnerHTML anywhere in this file or
> its siblings — the mockup's innerHTML pattern deliberately does not ship. Diff content
> originates in a sandboxed agent's output, so it is untrusted by definition.

**Skills:** `sp-test-driven-development` · **`security-review` + `claude-code-security-review`
(BLOCKING)** · `hallmark` → `impeccable` → `taste-skill` · `code-reviewer`

- [ ] **Task 4.0 — Restate the control as a test FIRST (before any edit-UI code).**
      Add `src/lib/__tests__/no-innerhtml.test.ts` asserting `grep` over `src/` returns
      **zero** non-comment `innerHTML` / `dangerouslySetInnerHTML` occurrences. This test
      must exist and pass before Task 4.1 starts, and must still pass at phase exit.
- [ ] **Task 4.1** — `agent-runtime/patch-edit.mjs`: validate a human-edited unified diff
      (well-formed hunks, line counts match headers, no path traversal in `+++`/`---`,
      size cap). TDD with malformed-patch cases.
- [ ] **Task 4.2** — `DiffEditor.tsx`: editable per-line, **text nodes only**, `<textarea>`
      backed. No syntax highlighting in this phase (deferred — see Known Gaps).
- [ ] **Task 4.3** — `POST /inbox/:id/approve` accepts an optional `editedPatch`; applies
      it through the **unchanged broker path**. A repo write must still happen only via
      `applyChanges`.
- [ ] **WIRING PROOF:** edit one line in a real delivery → approve → confirm the *edited*
      content (not the original) lands in the branch. `git show` the result.

**Phase 4 exit:** seven gates · no-innerHTML test green · `security-review` **CRITICAL 0
required** · visual regression · **Fable 5**: *"Attempt XSS through the edited patch.
Attempt path traversal via patch headers. Confirm the P3 text-node control still holds.
Confirm an edited approve cannot bypass the broker."* · delivery report

---

# PHASE 5 — Activity stream

**Why:** the manifesto's best idea and the cheapest — ADR-052 already fans out `task.*`,
`agent.state`, `usage.tick`, `delivery.created`, `delivery.decided`. Pure consumer; no new
infrastructure.

**Skills:** `sp-test-driven-development` · `hallmark` → `impeccable` → `taste-skill` ·
`emil-design-eng` (the feed animates — reduced-motion required) · `code-reviewer`

- [ ] **Task 5.1** — `src/lib/activityStream.ts`: pure reducer, SSE event → activity row.
      Unit-tested. **Bounded ring buffer (500 rows)** so a long session cannot leak memory.
- [ ] **Task 5.2** — `ActivityStream.tsx`: reverse-chronological feed, agent avatar, verb,
      target, relative time. Auto-scroll with **pause-on-hover** and a "N new" jump pill.
      Per-agent filter. Empty state: *"Quiet watch — nothing logged yet."*
- [ ] **Task 5.3** — Mount as a collapsible right rail on the Command Center; persist
      open/closed in settings.
- [ ] **`emil-design-eng` pass** on the row-enter animation; **must** respect
      `prefers-reduced-motion`.
- [ ] **WIRING PROOF:** queue a real task → the feed shows queued → started → done → the
      Delivery appearing in the Inbox, **live, with no refresh**, in under 2s.

**Phase 5 exit:** seven gates · visual regression (incl. reduced-motion capture) ·
**Fable 5**: *"Verify no event type renders as `undefined`. Force 1,000 events and confirm the buffer cap holds and the UI stays responsive. Kill the SSE connection mid-stream and confirm reconnect + no duplicate rows."* · delivery report

---

# PHASE 6 — Agent performance ledger

**Why:** `getScoreboard` exists but measures dogfood throughput (approved ÷ human-minutes),
not per-agent quality. Every decision is already in SQLite. "sr-backend: 60% approved, 23
failures this week" tells you which agents to trust, retune, or retire — and for an
agent-ops product that is close to the whole point.

**Skills:** `sp-test-driven-development` · `hallmark` → `impeccable` → `taste-skill` ·
`dataviz` (the skill, for any chart) · `code-reviewer`

- [ ] **Task 6.1** — `agent-runtime/agent-ledger.mjs`: per-agent, per-window aggregate —
      delivered / approved / changes-requested / rejected / failed, approval rate, median
      time-to-decision. **Pure SQL over existing rows.** No new writes, no schema change.
- [ ] **Task 6.2** — `GET /runtime/agent-ledger?window=7d`, gated like `/runtime/scoreboard`.
- [ ] **Task 6.3** — `AgentLedger.tsx` on the Agents deck. Sortable table + sparkline per
      agent. **Honesty rule:** an agent with < 5 decisions shows `insufficient data`, never
      a percentage. Use the `RiskChip`/ADR-053 `unrated` precedent.
- [ ] **WIRING PROOF:** approve a delivery → the agent's approved count increments on next
      fetch. Verify the number against a hand-run SQL query.

**Phase 6 exit:** seven gates · visual regression · **Fable 5**: *"Re-derive every ledger number with independent SQL. Confirm the <5-decision honesty rule holds. Confirm no division-by-zero renders as NaN."* · delivery report

---

# PHASE 7 — Metered spend (multi-provider)

**Why:** `agent-runtime/usage.mjs:2` states the `result` event carries `total_cost_usd`
but *"it is NEVER read here"*, and line 110: *"NO cost/USD/$ field, ever."* That was
**correct** under subscription-only. The multi-provider work changed the premise: API-key
accounts (OpenRouter, custom) bill per token. Cost is now real for those and fake for
subscription.

**Skills:** `sp-test-driven-development` · `security-review` (touches account state) ·
`hallmark` → `impeccable` · `code-reviewer`

- [ ] **Task 7.1** — `agent-runtime/spend.mjs`: record spend **only** when the active
      account's `authMethod === "api_key"`. Subscription runs record `null`, never 0.
- [ ] **Task 7.2** — Surface per-delivery and per-agent spend. **Honesty rule:**
      subscription accounts render `included`, never a dollar figure. A blended
      subscription+API number must be impossible — assert this in a test.
- [ ] **Task 7.3** — Update the `usage.mjs` header comment to record why the rule changed.
      A stale comment contradicting the code is how this session's worst error happened.
- [ ] **WIRING PROOF:** run one chat on an API-key account → spend appears; run one on a
      subscription account → `included` appears, no number.

**Phase 7 exit:** seven gates · security-review · **Fable 5**: *"Confirm no fabricated cost renders for subscription accounts under any path. Confirm spend is never inferred from token counts we did not receive."* · delivery report

---

# PHASE 8 — A1: CSS token layer

**Targets (from spec §3.1, all measured):**

| Defect | Now | Target |
|---|---|---|
| Surface ladder | 1.09 / 1.09 / 1.11 : 1 | **≥1.25:1** adjacent |
| Accent | 168 sites (106 CSS + 62 tsx) | **3 roles** — active-nav, primary CTA, focus/selection |
| Type scale | 21 CSS sizes + 16 tsx sizes | **9-step scale, ~1.2 ratio** |
| Sub-12px | 94 CSS + 368 tsx = 462 sites | **12px absolute floor** |
| Cockpit split | dark sidebar vs light cockpit | cockpit adopts dark tokens |

**Skills:** **`hallmark` (FIRST — structure + slop gates) → `impeccable` (polish) →
`taste-skill` (anti-slop)** · `emil-design-eng` (motion) · `code-reviewer`

- [ ] **Task 8.0 — DECIDE the 16→9 mapping** (the spec explicitly does not make this call).
      Produce `docs/superpowers/specs/type-scale.md` mapping every existing size to a scale
      step. **This blocks Phase 9 — do it here, in writing, before touching code.**
- [ ] **Task 8.1** — `src/theme/tokens.css`: single source for ladder, scale, accent roles.
- [ ] **Task 8.2** — Rewrite the ladder to hit ≥1.25:1. **Re-measure and paste the ratios.**
- [ ] **Task 8.3** — Reduce accent to 3 roles in the 106 CSS sites; everything else
      monochrome or semantic.
- [ ] **Task 8.4** — Unify the cockpit to dark tokens.
- [ ] **Task 8.5** — Re-verify **all text still passes WCAG AA** (baseline 5.30–13.82:1).
      Paste the recomputed table. A regression below 4.5:1 fails the phase.
- [ ] Visual regression: expect large diffs. **Review all 66 by eye.** Accept intentional,
      investigate unexpected.

**Phase 8 exit:** seven gates · `hallmark audit` + `impeccable audit` clean · contrast
table pasted · **Fable 5**: *"Independently recompute every contrast ratio and the accent-site count. Confirm the ≥1.25:1 and 12px targets are actually met in the CSS layer. Find any token that regressed below AA."* · delivery report

---

# PHASE 9 — A2: component sweep

**Surface:** **57 files, 368 sub-12px occurrences** (543 total `text-[Npx]` across 61
files) + 62 accent sites in `.tsx`. **~80% of defects 3 and 4 live here** — this is the
phase rev 1 of the spec under-sized by ~4x.

**Blocked on:** Phase 0 determinism PASS + Phase 8 Task 8.0 mapping. Do not start otherwise.

**Skills:** `impeccable` (`/impeccable polish`, `/impeccable typeset`, `/impeccable layout`)
· `taste-skill` · `code-reviewer` · `sp-verification-before-completion`

- [ ] **Task 9.1** — Mechanical pass in **batches of ~10 files**. After each batch: run
      `npm run test:visual`, review diffs, gate, continue. **Never sweep all 57 at once** —
      with zero component tests, the screenshot diff is the only safety net.
- [ ] **Task 9.2** — Replace every `text-[Npx]` with a scale class per the 8.0 mapping.
- [ ] **Task 9.3** — Reduce the 62 `.tsx` accent sites to the 3 roles.
- [ ] **Task 9.4** — Verify the floor holds:

```bash
grep -rhoE 'text-\[([0-9]|1[01])(\.[0-9]+)?px\]' src --include='*.tsx' | wc -l   # expect 0
```

**Phase 9 exit:** seven gates · sub-12px count **0** · all 66 screenshots reviewed ·
`impeccable audit` clean · **Fable 5**: *"Re-run the sub-12px grep. Confirm 0. Spot-check 10 random components at 320px for layout breakage the screenshots missed. Confirm no functional regression."* · delivery report

---

# PHASE 10 — Final gauntlet

**Skills:** gstack `/qa` · `/review` · `/cso` · `comprehensive-review` ·
`claude-code-security-review` · `a11y-architect` · `sp-finishing-a-development-branch` ·
`codeburn`

- [ ] **10.1** — Full seven-gate run from clean: `rm -rf node_modules && npm ci` then all gates.
- [ ] **10.2** — `/qa` full pass.
- [ ] **10.3** — `/cso` + `security-review` over the entire diff. **CRITICAL 0 required.**
- [ ] **10.4** — Accessibility: `a11y-architect` — keyboard path through every new surface,
      focus visible, contrast AA, reduced-motion honored.
- [ ] **10.5** — Performance: bundle size vs baseline; flag any chunk that grew >10%.
- [ ] **10.6** — **Dead-wiring sweep** — the "everything wired" gate:

```bash
# every exported client fn must have a caller; every route must have a client
npx knip 2>/dev/null || npx ts-prune | grep -v "used in module"
```

Any unused export in the new code is either wired or deleted. **No orphans.**

- [ ] **10.7** — 30-minute unattended soak: runtime + UI up, queue real tasks, confirm the
      swarm runs, self-heals, and mints Deliveries with **no human intervention**. Record
      crash count (expect 0) and confirm the activity stream stayed live throughout.
- [ ] **10.8** — Final delivery report: every phase, every gate, every number, full
      **Known Gaps & Risks**.
- [ ] **10.9** — `codeburn` for session cost.
- [ ] **10.10** — **STOP. Report to the user. Do not commit.**

---

## Rollback

Nothing is committed, so rollback is `git checkout -- <path>` per file or
`git stash` wholesale. **Before any destructive git command, run `git status` and stash
untracked work with `-u`.** The last good commit is `05e8dbd` (pushed to origin).

## Known gaps & risks — carried into execution

| Risk | Sev | Mitigation |
|---|---|---|
| **A0 determinism unproven** | **High** | Phase 0 Task 0.2 is an explicit go/no-go. If it fails, Phase 9 loses its only safety net and must be re-scoped — escalate, don't proceed. |
| 57 files, zero component tests | **High** | Batches of 10 + screenshot gate each |
| Approve-with-edit reintroduces XSS | **High** | Task 4.0 writes the guard test BEFORE the feature |
| Bulk approve bypasses high-risk friction | **High** | Explicit test; CRITICAL if found |
| Clustering hides a real code delivery | Med | Only `kind: "failure"` clusters; asserted in tests |
| Cost shown for subscription accounts | Med | Test asserts `included`, never a number |
| Context exhaustion mid-phase | Med | `EXCELLENCE-HANDOFF.md` updated at every phase boundary |
| Effort estimates are judgment | Low | Disclosed; no phase is time-boxed into a failure |

**Deferred, explicitly not in this plan:** diff syntax highlighting (design known —
Shiki token array → React elements, never `innerHTML` — but not scoped here);
SSE→WebSocket (ADR-057-A, open, no evidence of need); LangGraph; Docker-per-agent;
sidebar collapse; font-family change; LLM self-reported confidence; ghost cursors.

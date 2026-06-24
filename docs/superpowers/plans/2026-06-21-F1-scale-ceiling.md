# F1 — Scale Ceiling: CPU-derived default + optional dynamic backoff (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every code step is RED→GREEN→commit (superpowers:test-driven-development).

**Goal:** Replace the hardcoded `MAX_INFLIGHT = … || 4` default with a CPU/quota-derived value (env override still wins), via a pure testable module, without disturbing the shared inflight counter, the quota pre-gate, or the 429 fork-bomb cap.

**Architecture:** Extract concurrency math into a new pure ESM module `agent-runtime/concurrency.mjs` (no I/O, no `os` dependency in the function body — caller injects cpu count). `server.mjs:166` consumes it at module load. The single `let inflight` counter (`:167`) and all 11 `inflight >= MAX_INFLIGHT` gate/increment sites are UNTOUCHED — only the const's value source changes. Dynamic backoff is an OPTIONAL pure helper (Task 3), wired at most at one soft pre-gate, gated on performance-engineer + security-reviewer sign-off.

**Tech Stack:** Node ESM, `node --test` (built-in), `node:os`.

**Verified anchors (2026-06-21):**
- `const MAX_INFLIGHT = Number(process.env.RUNTIME_MAX_INFLIGHT || 4)` — `server.mjs:166`
- `let inflight = 0` — `:167`
- Gate/incr/decr sites (ALL audited, keep reading the const): `:792-798`, `:843-844` (`tryAcquireSlot`/`releaseSlot`), `:1089-1090`, `:1126-1128`, `:1195-1204`, `:1233-1242`, `:1333-1334`, `:1371-1373`, `:1496`, `:1510-1511`, `:1544`; health readouts `:981`, `:1577`
- Quota pre-gate: `quotaCount(agentId, MA_QUOTA_WINDOW_MS) >= MA_QUOTA_MAX` — `:676`
- `node:os` already imported (only `tmpdir`, `:64`) — Task 2 adds `cpus`
- Test runner: `node --test --test-concurrency=1 test/*.test.mjs`

---

## File Structure

- **Create:** `agent-runtime/concurrency.mjs` — pure: `computeMaxInflight()`, `effectiveMaxInflight()` (optional).
- **Create:** `agent-runtime/test/concurrency.test.mjs` — unit tests for the pure module.
- **Modify:** `agent-runtime/server.mjs:64` (add `cpus` import), `:164-166` (consume `computeMaxInflight`). Nothing else.

---

## Task 1: Pure `computeMaxInflight` module (RED→GREEN)

**Files:**
- Create: `agent-runtime/concurrency.mjs`
- Test: `agent-runtime/test/concurrency.test.mjs`

**Contract:** `computeMaxInflight({ env, cpuCount })` → number.
- If `env.RUNTIME_MAX_INFLIGHT` is set AND parses to a finite int ≥ 1 → that value (override always wins, unclamped — operator intent is explicit).
- Else → `clamp(cpuCount - 1, 2, 12)`.
- Garbage/empty/≤0 env → ignored, fall through to cpu-derived.

- [ ] **Step 1: Write the failing test**

```javascript
// agent-runtime/test/concurrency.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMaxInflight } from "../concurrency.mjs";

test("env override wins, unclamped", () => {
  assert.equal(computeMaxInflight({ env: { RUNTIME_MAX_INFLIGHT: "20" }, cpuCount: 4 }), 20);
  assert.equal(computeMaxInflight({ env: { RUNTIME_MAX_INFLIGHT: "1" }, cpuCount: 64 }), 1);
});

test("cpu-derived = clamp(cpuCount-1, 2, 12) when no env", () => {
  assert.equal(computeMaxInflight({ env: {}, cpuCount: 1 }), 2);  // floor
  assert.equal(computeMaxInflight({ env: {}, cpuCount: 2 }), 2);  // floor
  assert.equal(computeMaxInflight({ env: {}, cpuCount: 8 }), 7);  // mid
  assert.equal(computeMaxInflight({ env: {}, cpuCount: 14 }), 12); // ceil
});

test("garbage env ignored → falls through to cpu-derived", () => {
  for (const bad of ["", "abc", "0", "-5", "  ", "3.5x"]) {
    assert.equal(computeMaxInflight({ env: { RUNTIME_MAX_INFLIGHT: bad }, cpuCount: 8 }), 7);
  }
});

test("missing/zero cpuCount still yields the floor", () => {
  assert.equal(computeMaxInflight({ env: {}, cpuCount: 0 }), 2);
  assert.equal(computeMaxInflight({ env: {} }), 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-runtime && node --test test/concurrency.test.mjs`
Expected: FAIL — `Cannot find module '../concurrency.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// agent-runtime/concurrency.mjs
// Pure concurrency math (no I/O, no os import — caller injects cpuCount) so it is
// unit-testable without booting server.mjs. F1: CPU-derived MAX_INFLIGHT default.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Resolve the concurrency cap for spawned `claude` children.
 * Env override (RUNTIME_MAX_INFLIGHT) always wins when it parses to an int >= 1.
 * Otherwise CPU-derived: clamp(cpuCount - 1, 2, 12).
 * @param {{ env?: Record<string,string|undefined>, cpuCount?: number }} opts
 * @returns {number}
 */
export function computeMaxInflight({ env = {}, cpuCount = 0 } = {}) {
  const raw = env.RUNTIME_MAX_INFLIGHT;
  if (raw != null && /^\d+$/.test(String(raw).trim())) {
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return clamp((Number(cpuCount) || 0) - 1, 2, 12);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-runtime && node --test test/concurrency.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha
git add agent-runtime/concurrency.mjs agent-runtime/test/concurrency.test.mjs
git commit -m "feat(runtime): pure computeMaxInflight — CPU-derived cap, env override wins"
```

---

## Task 2: Wire `computeMaxInflight` into server.mjs (default change only)

**Files:**
- Modify: `agent-runtime/server.mjs:64` (import), `:164-166` (consume)

- [ ] **Step 1: Add `cpus` to the existing `node:os` import**

Change `server.mjs:64` from:
```javascript
import { tmpdir } from "node:os";
```
to:
```javascript
import { tmpdir, cpus } from "node:os";
```

- [ ] **Step 2: Import the pure module (near the other local imports, e.g. after line 91)**

```javascript
import { computeMaxInflight } from "./concurrency.mjs";
```

- [ ] **Step 3: Replace the const at `:166`**

From:
```javascript
const MAX_INFLIGHT = Number(process.env.RUNTIME_MAX_INFLIGHT || 4);
```
to:
```javascript
// CPU-derived default; RUNTIME_MAX_INFLIGHT still overrides (F1). All inflight gate
// sites below read this single const — only its value source changed.
const MAX_INFLIGHT = computeMaxInflight({ env: process.env, cpuCount: cpus().length });
```

- [ ] **Step 4: Verify nothing else changed — the 11 gate sites still reference `MAX_INFLIGHT`**

Run: `cd agent-runtime && grep -c "inflight >= MAX_INFLIGHT" server.mjs`
Expected: `7` (the `>=` gates; plus `tryAcquireSlot` at :843). Confirm no gate was edited:
Run: `git diff -- server.mjs | grep '^[-+]' | grep -v '^[-+][-+]'`
Expected: only the import line and the const line change. NO changes to any `inflight++`, `inflight >=`, or 429 line.

- [ ] **Step 5: Full suite green + typecheck + build**

Run: `cd agent-runtime && npm test`
Expected: 259 (existing) + 4 (Task 1) = **263 pass**, 0 fail.
Run: `cd agent-runtime && node -e "import('./server.mjs').catch(e=>{console.error(e);process.exit(1)})" 2>&1 | head -5` — sanity: module loads (note: this boots the server; Ctrl-C / use a load-only guard if it blocks — acceptable to skip if server has no `--check` mode, the npm test + grep already prove wiring).

- [ ] **Step 6: Manual cap sanity (env override + default)**

```bash
cd agent-runtime
node -e "import('./concurrency.mjs').then(m=>{console.log('default(this host):', m.computeMaxInflight({env:{},cpuCount:require('os').cpus().length})); console.log('override:', m.computeMaxInflight({env:{RUNTIME_MAX_INFLIGHT:'9'},cpuCount:4}))})"
```
Expected: default = clamp(hostCPUs-1, 2, 12); override = 9.

- [ ] **Step 7: Commit**

```bash
git add agent-runtime/server.mjs
git commit -m "feat(runtime): MAX_INFLIGHT default now CPU-derived via computeMaxInflight (F1)"
```

---

## Task 3 (OPTIONAL — gate on performance-engineer + security-reviewer): dynamic backoff

> Exit Gate does NOT require this. Only build if perf-engineer says the static cap is insufficient AND security-reviewer confirms no new fork-bomb surface. If skipped, document the decision in the commit/PR.

**Files:** Modify `agent-runtime/concurrency.mjs` + `agent-runtime/test/concurrency.test.mjs`.

**Contract:** `effectiveMaxInflight({ base, quotaCount, quotaMax, softFrac = 0.8 })` → number. When `quotaCount / quotaMax >= softFrac`, shrink toward a floor of 2; else return `base`. Pure, monotonic, never exceeds `base`, never below 2.

- [ ] **Step 1: Failing test**

```javascript
import { effectiveMaxInflight } from "../concurrency.mjs";
test("effectiveMaxInflight shrinks only near the quota soft limit, floor 2, never > base", () => {
  assert.equal(effectiveMaxInflight({ base: 8, quotaCount: 0, quotaMax: 100 }), 8);   // idle → base
  assert.equal(effectiveMaxInflight({ base: 8, quotaCount: 79, quotaMax: 100 }), 8);  // below soft
  assert.ok(effectiveMaxInflight({ base: 8, quotaCount: 95, quotaMax: 100 }) < 8);    // near limit → shrink
  assert.ok(effectiveMaxInflight({ base: 8, quotaCount: 100, quotaMax: 100 }) >= 2);  // floor
  assert.equal(effectiveMaxInflight({ base: 8, quotaCount: 0, quotaMax: 0 }), 8);     // no quota → base
});
```

- [ ] **Step 2: Run → FAIL** (`effectiveMaxInflight is not a function`).

- [ ] **Step 3: Implement**

```javascript
export function effectiveMaxInflight({ base, quotaCount = 0, quotaMax = 0, softFrac = 0.8 }) {
  if (!quotaMax || quotaMax <= 0) return base;
  const used = quotaCount / quotaMax;
  if (used < softFrac) return base;
  // linear shrink from base→2 across [softFrac, 1.0]
  const t = Math.min(1, (used - softFrac) / (1 - softFrac));
  return Math.max(2, Math.round(base - (base - 2) * t));
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: (Wiring is a SEPARATE decision.)** Do NOT rewire all 11 sites. If wired, replace ONLY the engine scheduler's `tryAcquireSlot` cap check at `:843` with `inflight >= effectiveMaxInflight({ base: MAX_INFLIGHT, quotaCount: <global>, quotaMax: MA_QUOTA_MAX })` — but quota is PER-AGENT (`quotaCount(agentId,…)`), so a true global signal needs a new aggregate; if that aggregate doesn't exist cheaply, leave `effectiveMaxInflight` exported-but-unwired and note it. Keep the 429 hard cap (`MAX_INFLIGHT`) as the absolute ceiling regardless.

- [ ] **Step 6: Commit**

```bash
git add agent-runtime/concurrency.mjs agent-runtime/test/concurrency.test.mjs
git commit -m "feat(runtime): optional effectiveMaxInflight dynamic backoff helper (F1, unwired pending perf review)"
```

---

## Security review (MANDATORY before declaring F1 done)

Dispatch `security-reviewer` on the diff. Confirm:
1. Fork-bomb guard intact — the 429 at the hard `MAX_INFLIGHT` cap still fires at every gate site (`:792`, `:1195`, `:1233`, `:1496`, `:1544`, `:1089`, `:1333`).
2. Env override can RAISE the cap (operator intent) but the quota pre-gate (`:676`) + per-call `guardedSpawn` backoff still bound real cost — a high `RUNTIME_MAX_INFLIGHT` cannot bypass quota.
3. No new counter, no slot leak: `tryAcquireSlot`/`releaseSlot` still share the single `inflight`.
4. `computeMaxInflight` cannot return < 2 from cpu path, < 1 from env path → no zero-cap deadlock, no negative.

---

## Exit Gate (F1)

- [ ] Default cap is CPU-derived (`clamp(cpus-1, 2, 12)`) — proven by Task 1 tests + Task 2 Step 6.
- [ ] `RUNTIME_MAX_INFLIGHT` override still wins — Task 1 test.
- [ ] 429 still fires at the cap — gate sites unchanged (Task 2 Step 4 diff proof) + fork-bomb security item.
- [ ] Quota guard intact (`:676`) — security review item 2.
- [ ] Tests green: `cd agent-runtime && npm test` → **263 pass** (259 + 4), 0 fail.
- [ ] `npx tsc --noEmit` clean; `npm run build` clean (if these targets exist in the runtime/root).
- [ ] security-reviewer pass, commits per GREEN.

---

## Self-Review (against F1 spec §53-68)

- **"Replace `|| 4` with computeMaxInflight = env if set else clamp(cpus-1,2,12)"** → Task 1+2. ✔
- **"KEEP single inflight counter + audit ALL inflight sites"** → 11 sites enumerated in anchors; Task 2 Step 4 diff-guard proves none edited. ✔
- **"Preserve hard cap → 429 fork-bomb"** → unchanged gates + security item 1. ✔
- **"(Optional) dynamic backoff"** → Task 3, explicitly optional + gated. ✔
- **"security-reviewer pass; suite green; commit"** → Security section + Exit Gate. ✔
- Placeholder scan: none — every code step has real code + exact commands. ✔
- Type consistency: `computeMaxInflight({env,cpuCount})` / `effectiveMaxInflight({base,quotaCount,quotaMax,softFrac})` consistent across tasks. ✔

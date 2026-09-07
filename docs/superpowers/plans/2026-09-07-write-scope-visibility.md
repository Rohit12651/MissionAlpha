# Write-Scope Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent writes outside its seat's `writeScope`, the operator sees *why* on the surface they actually watch — and the agent is told the truth on retry.

**Architecture:** The scope-breach message already exists (`engine.mjs:386`) and is stored on the task as `error.msg`. Three layers discard it: the `task.failed` SSE payload, the queue snapshot mapper, and the strip that renders them. This plan stops the discarding, adds a pure `failureReasons()` selector, renders it, corrects a misleading retry brief, and moves the twice-mounted Roster strip into Settings.

**Tech Stack:** Node 24 + `node --test` (runtime, `.mjs`), TypeScript + React 18 + Vite (UI), `node --experimental-strip-types --test` (unit, `.ts`), Tailwind.

---

## Ground rules for this plan

Read these before Task 1. They are repo law, not preferences.

1. **NO commits beyond the ones this plan specifies.** Each task ends with its own commit.
2. **Every new test is a RATCHET.** After it passes, you must *prove it fires*: break the thing it protects, run it, **paste the red output into the commit message**, restore the file, confirm `md5` is byte-identical to before, re-run green. A test never watched failing is not evidence (PES addendum #13).
3. **Match on values and structure, never on source text.** Text matching is how three ratchets in this repo shipped vacuous.
4. **`agent-runtime/server.mjs`, `broker.mjs`, `guards.mjs` are CORE_GUARD.** This plan does not modify them. If you think you need to, stop and ask.
5. **Run the gates with dev servers stopped.** Contract: runtime ≥ 2615/0, tsc 0, lint 0.

Commands used throughout:

```bash
cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha
npm run test:unit       # .ts unit tests (src/lib/__tests__)
npm run test:runtime    # .mjs runtime tests
npm run typecheck
npm run lint
```

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/queueModel.ts` | Modify | Pure queue arithmetic. Gains `detail` on `QueueTask` and a `failureReasons()` selector. |
| `src/lib/__tests__/queueModel.test.ts` | Modify | Ratchets for `detail` + `failureReasons()`. |
| `agent-runtime/queue.mjs` | Modify | Adds `detail` to the `task.failed` payload. |
| `agent-runtime/test/queue.test.mjs` | Modify | Ratchet: payload carries `detail`. |
| `agent-runtime/engine.mjs` | Modify | Honest retry brief when refused paths caused the empty diff. |
| `agent-runtime/test/engine.test.mjs` | Modify | Ratchet: brief names the scope breach. |
| `src/components/inbox/QueueStrip.tsx` | Modify | Renders the deduped failure reasons. |
| `src/components/board/JobBoard.tsx` | Modify | Drops the duplicate `RosterStrip` mount. |
| `src/App.tsx` | Modify | Drops the second `RosterStrip` mount. |
| `src/components/settings/SettingsPanel.tsx` | Modify | Becomes the roster's single home. |
| `test/visual/*` | Check only | Visual baselines may reference the strip's old position. |

`RosterStrip.tsx` itself is **not modified** — a second component rendering a `writeScope` is a second thing that can misstate one.

---

### Task 1: `queueModel` carries the failure detail from the snapshot

**Files:**
- Modify: `src/lib/queueModel.ts:16-22` (the `QueueTask` interface), `:100-108` (`QueueSnapshotTask`), `:126` (the mapper)
- Test: `src/lib/__tests__/queueModel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/__tests__/queueModel.test.ts`:

```ts
test("QM-D1: a failed task keeps error.msg as detail — the WHY is not discarded", () => {
  const state = fromSnapshot([
    {
      taskId: "t1",
      agentId: "sr-frontend",
      status: "failed",
      error: {
        kind: "empty-diff",
        msg: "no appliable diff — the agent wrote 2 path(s) OUTSIDE the appliable scope, so nothing can be applied: src/lib/api.ts, src/db.mjs",
      },
    },
  ]);
  assert.equal(state.tasks.t1.kind, "empty-diff");
  assert.match(state.tasks.t1.detail ?? "", /OUTSIDE the appliable scope/);
  assert.match(state.tasks.t1.detail ?? "", /src\/lib\/api\.ts/);
});

test("QM-D2: a non-failed task has no detail", () => {
  const state = fromSnapshot([{ taskId: "t2", agentId: "qa", status: "claimed" }]);
  assert.equal(state.tasks.t2.detail, null);
});

test("QM-D3: a failure with no msg is null detail, NOT the string 'undefined'", () => {
  const state = fromSnapshot([
    { taskId: "t3", agentId: "qa", status: "failed", error: { kind: "test-failed" } },
  ]);
  assert.equal(state.tasks.t3.detail, null);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run test:unit 2>&1 | grep -A4 "QM-D1"
```

Expected: FAIL. `detail` does not exist on the object, so `state.tasks.t1.detail ?? ""` is `""` and `assert.match` reports no match for `/OUTSIDE the appliable scope/`.

- [ ] **Step 3: Add `detail` to the types**

In `src/lib/queueModel.ts`, change the `QueueTask` interface:

```ts
export interface QueueTask {
  agentId: string;
  bucket: QueueBucket;
  /** Classified error kind on a failure (self-heal.mjs), else null. */
  kind: string | null;
  /**
   * The failure's own words — `error.msg`, already scrubbed server-side. Null when the
   * task has not failed or the failure carried no message.
   *
   * This field exists because it was previously DROPPED here: the engine composes a
   * precise scope-breach sentence (engine.mjs), stores it on the task, and this mapper
   * kept only `kind`. The operator was shown `empty-diff` and nothing else.
   */
  detail: string | null;
}
```

And `QueueSnapshotTask`:

```ts
export interface QueueSnapshotTask {
  taskId: string;
  agentId: string;
  status: string;
  attempts?: number;
  error?: { kind?: string; msg?: string } | null;
}
```

- [ ] **Step 4: Populate it in the mapper**

Replace line 126 of `src/lib/queueModel.ts`:

```ts
    out[taskId] = {
      agentId,
      bucket,
      kind: bucket === "failed" ? str(t.error?.kind) || "unknown" : null,
      detail: bucket === "failed" ? str(t.error?.msg) || null : null,
    };
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm run test:unit 2>&1 | tail -8
npm run typecheck
```

Expected: all pass, tsc 0 errors. Any other construction of a `QueueTask` will now fail to typecheck — fix each by adding `detail: null`.

- [ ] **Step 6: Prove the ratchet fires**

```bash
md5 src/lib/queueModel.ts        # record the hash
```

Now delete the `detail:` line you added in Step 4, run `npm run test:unit`, and **copy the failing output**. Restore the line, re-run `md5`, confirm it matches the recorded hash, re-run the tests green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/queueModel.ts src/lib/__tests__/queueModel.test.ts
git commit -F - <<'EOF'
fix(ui): stop discarding the failure reason in queueModel

fromSnapshot kept only error.kind. The engine composes a precise
scope-breach sentence and stores it as error.msg; this mapper threw it
away, so the operator saw "empty-diff" and nothing else on the surface
they actually watch.

Ratchet QM-D1 proven to fire. With the `detail:` line removed:

  <PASTE THE RED OUTPUT FROM STEP 6 HERE>

Restored byte-identical (md5 unchanged), green.
EOF
```

---

### Task 2: the SSE `task.failed` payload carries the detail

The snapshot is one of two paths into the model. The live event is the other, and it drops the message at the emit site.

**Files:**
- Modify: `agent-runtime/queue.mjs:172`
- Test: `agent-runtime/test/queue.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `agent-runtime/test/queue.test.mjs` (match the file's existing harness for constructing a queue with an `emit` spy — read the top of the file and reuse it rather than inventing one):

```js
test("QD-1: task.failed carries the failure's own words, not just its class", () => {
  const seen = [];
  const q = makeQueue({ emit: (name, data) => seen.push({ name, data }) });
  const id = q.enqueue({ goalId: "g1", task: "x", agentId: "sr-frontend" });
  q.claim("sr-frontend");
  q.update(id, {
    status: "failed",
    error: { kind: "empty-diff", msg: "wrote 2 path(s) OUTSIDE the appliable scope: src/a.ts" },
  });
  const ev = seen.find((e) => e.name === "task.failed");
  assert.ok(ev, "no task.failed emitted");
  assert.equal(ev.data.kind, "empty-diff");
  assert.match(String(ev.data.detail ?? ""), /OUTSIDE the appliable scope/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test agent-runtime/test/queue.test.mjs 2>&1 | grep -A6 "QD-1"
```

Expected: FAIL — `ev.data.detail` is `undefined`, so the match runs against `""`.

- [ ] **Step 3: Add the field at the emit site**

`agent-runtime/queue.mjs:172` becomes:

```js
      // `detail` is the failure's own words. The event catalog is closed by NAME, not by
      // payload shape, and events.mjs scrubs every nested string before framing — so this
      // reaches the client already sanitised. It exists so the UI can say WHY a task
      // failed, not merely that it did.
      emit("task.failed", {
        ...wire(next),
        kind: next.error?.kind || "unknown",
        detail: next.error?.msg || null,
      });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test agent-runtime/test/queue.test.mjs 2>&1 | tail -6
```

Expected: PASS.

- [ ] **Step 5: Prove the ratchet fires**

```bash
md5 agent-runtime/queue.mjs
```

Remove the `detail:` line, run the test, copy the red output, restore, confirm `md5` matches, re-run green.

- [ ] **Step 6: Commit**

```bash
git add agent-runtime/queue.mjs agent-runtime/test/queue.test.mjs
git commit -F - <<'EOF'
fix(runtime): task.failed carries the failure detail

The live event dropped error.msg the same way the snapshot mapper did,
so a UI reading either path saw only the error class.

The v1 event catalog is closed by NAME; payload fields are not fixed,
and events.mjs scrubs every nested string before persisting and framing.

Ratchet QD-1 proven to fire:

  <PASTE THE RED OUTPUT FROM STEP 5 HERE>

Restored byte-identical, green.
EOF
```

---

### Task 3: the model's live path keeps the detail too

**Files:**
- Modify: `src/lib/queueModel.ts:95-98` (`applyQueueEvent`)
- Test: `src/lib/__tests__/queueModel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("QM-D4: a live task.failed event keeps the detail", () => {
  const next = applyQueueEvent(
    { tasks: {} },
    {
      name: "task.failed",
      data: {
        taskId: "t9",
        agentId: "sr-backend",
        kind: "empty-diff",
        detail: "wrote 3 path(s) OUTSIDE the appliable scope: src/db.mjs",
      },
    } as never,
  );
  assert.equal(next.tasks.t9.kind, "empty-diff");
  assert.match(next.tasks.t9.detail ?? "", /OUTSIDE the appliable scope/);
});

test("QM-D5: a detail change alone is a NEW state — the identity check must see it", () => {
  const first = { tasks: { t9: { agentId: "a", bucket: "failed" as const, kind: "empty-diff", detail: "old" } } };
  const next = applyQueueEvent(first, {
    name: "task.failed",
    data: { taskId: "t9", agentId: "a", kind: "empty-diff", detail: "new" },
  } as never);
  assert.notEqual(next, first, "same reference — a changed detail was treated as no change");
  assert.equal(next.tasks.t9.detail, "new");
});
```

QM-D5 matters: the existing short-circuit at line 97 compares `agentId`, `bucket` and `kind`. If `detail` is not in that comparison, an updated message silently fails to re-render.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run test:unit 2>&1 | grep -A5 "QM-D4"
```

Expected: both FAIL — QM-D4 because `detail` is never set, QM-D5 because the short-circuit returns the same reference.

- [ ] **Step 3: Implement**

Replace lines 95-98 of `src/lib/queueModel.ts`:

```ts
  const kind = bucket === "failed" ? str(e.data.kind) || "unknown" : null;
  const detail = bucket === "failed" ? str(e.data.detail) || null : null;
  const prev = state.tasks[taskId];
  // `detail` is part of the identity: a task whose message changed but whose bucket did
  // not is a CHANGED task, and returning the same reference would freeze the old words
  // on screen.
  if (prev && prev.bucket === bucket && prev.agentId === agentId && prev.kind === kind && prev.detail === detail) return state;
  return { tasks: { ...state.tasks, [taskId]: { agentId, bucket, kind, detail } } };
```

- [ ] **Step 4: Run tests, typecheck, lint**

```bash
npm run test:unit 2>&1 | tail -6 && npm run typecheck && npm run lint
```

Expected: pass / 0 / 0.

- [ ] **Step 5: Prove both ratchets fire**

Two separate mutations, both recorded:
1. Remove `detail` from the returned object → QM-D4 red.
2. Remove `&& prev.detail === detail` from the short-circuit → QM-D5 red.

Restore after each; confirm `md5` matches the pre-mutation hash.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queueModel.ts src/lib/__tests__/queueModel.test.ts
git commit -F - <<'EOF'
fix(ui): keep the failure detail on the live event path

applyQueueEvent dropped `detail`, and its identity short-circuit did not
compare it — so even once carried, an updated message would not have
re-rendered.

Ratchets QM-D4 and QM-D5, each proven to fire on its own mutation:

  <PASTE BOTH RED OUTPUTS FROM STEP 5 HERE>

Both restored byte-identical, green.
EOF
```

---

### Task 4: a pure `failureReasons()` selector

The strip renders counts and per-agent chips, not per-task rows. Rather than teach the component to group, add the arithmetic to the pure model where the file's own doctrine says it belongs.

**Files:**
- Modify: `src/lib/queueModel.ts` (append the selector + its type)
- Test: `src/lib/__tests__/queueModel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("QM-D6: identical failure reasons collapse into one row with a count", () => {
  const state = fromSnapshot([
    { taskId: "a", agentId: "x", status: "failed", error: { kind: "empty-diff", msg: "out of scope: src/a.ts" } },
    { taskId: "b", agentId: "y", status: "failed", error: { kind: "empty-diff", msg: "out of scope: src/a.ts" } },
    { taskId: "c", agentId: "z", status: "failed", error: { kind: "test-failed", msg: "2 assertions failed" } },
  ]);
  const rows = failureReasons(state);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].count, 2, "the most common reason comes first");
  assert.equal(rows[0].kind, "empty-diff");
  assert.match(rows[0].detail ?? "", /src\/a\.ts/);
  assert.equal(rows[1].count, 1);
});

test("QM-D7: failures with no detail still produce a row, keyed on kind alone", () => {
  const state = fromSnapshot([
    { taskId: "a", agentId: "x", status: "failed", error: { kind: "no-output" } },
  ]);
  const rows = failureReasons(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "no-output");
  assert.equal(rows[0].detail, null);
});

test("QM-D8: a queue with no failures yields no rows", () => {
  const state = fromSnapshot([{ taskId: "a", agentId: "x", status: "claimed" }]);
  assert.deepEqual(failureReasons(state), []);
});
```

Add `failureReasons` to the import at the top of the test file.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run test:unit 2>&1 | grep -A5 "QM-D6"
```

Expected: FAIL — `failureReasons is not a function` / import error.

- [ ] **Step 3: Implement**

Append to `src/lib/queueModel.ts`:

```ts
/** One distinct failure reason across the queue, with how many tasks share it. */
export interface FailureReason {
  kind: string;
  detail: string | null;
  count: number;
}

/** Cap on rows returned — the strip is a summary, not a log. */
export const MAX_FAILURE_REASONS = 4;

/**
 * PURE. Distinct failure reasons, most frequent first, ties broken by kind so the
 * order is deterministic for a snapshot test.
 *
 * Grouping is on (kind, detail) — two seats refused for the SAME path are one problem
 * the operator solves once, and 1000 identical rows are unreadable.
 */
export function failureReasons(state: QueueState): FailureReason[] {
  const byKey = new Map<string, FailureReason>();
  for (const t of Object.values(state.tasks)) {
    if (t.bucket !== "failed") continue;
    const kind = t.kind || "unknown";
    const detail = t.detail || null;
    const key = `${kind} ${detail ?? ""}`;
    const hit = byKey.get(key);
    if (hit) hit.count += 1;
    else byKey.set(key, { kind, detail, count: 1 });
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    .slice(0, MAX_FAILURE_REASONS);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:unit 2>&1 | tail -6 && npm run typecheck
```

- [ ] **Step 5: Prove the ratchet fires**

`md5 src/lib/queueModel.ts`, then change the sort to `a.count - b.count` (ascending). QM-D6 must go red on `rows[0].count === 2`. Copy the output, restore, confirm `md5`, green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queueModel.ts src/lib/__tests__/queueModel.test.ts
git commit -F - <<'EOF'
feat(ui): failureReasons() — distinct failure reasons, most common first

Pure selector. Groups on (kind, detail) so N seats refused for the same
path read as one problem, and caps the list — the strip is a summary,
not a log.

Ratchet QM-D6 proven to fire with the sort inverted:

  <PASTE THE RED OUTPUT FROM STEP 5 HERE>

Restored byte-identical, green.
EOF
```

---

### Task 5: the strip renders the reasons

**Files:**
- Modify: `src/components/inbox/QueueStrip.tsx` (import + a block after the agent chips)

- [ ] **Step 1: Add the selector to the import**

`src/components/inbox/QueueStrip.tsx` lines 8-10:

```tsx
import {
  queueCounts,
  agentChips,
  failureReasons,
} from "../../lib/queueModel";
```

Keep whatever else that import already names — add, do not replace.

- [ ] **Step 2: Compute it beside the other memos**

Next to `const chips = useMemo(...)` (around line 98):

```tsx
  const reasons = useMemo(() => failureReasons(state), [state]);
```

- [ ] **Step 3: Render it after the agent-chips `<ul>`**

```tsx
      {reasons.length > 0 && (
        <ul className="flex list-none flex-col gap-1" aria-label="Why work is failing">
          {reasons.map((r) => (
            <li
              key={`${r.kind} ${r.detail ?? ""}`}
              className="helm-mono flex items-start gap-1.5 text-[11px] leading-snug"
            >
              <span className="helm-chip shrink-0" data-tone="red">
                {r.kind}
                {r.count > 1 ? ` ×${r.count}` : ""}
              </span>
              {r.detail && (
                // Plain text. `detail` is scrubbed server-side but is agent- and
                // repo-derived, so it is never interpolated as markup. Clamped to two
                // lines with the full text on hover — truncating in the model would
                // destroy the path the operator needs.
                <span className="line-clamp-2 break-all text-muted" title={r.detail}>
                  {r.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
```

- [ ] **Step 4: Verify in the running app**

```bash
npm run typecheck && npm run lint
```

Then start the runtime and UI, open the Inbox, and confirm the failure rows appear under the queue chips. The live install already carries ~1076 failures, so rows will be present immediately.

```bash
set -a; . ./.env; set +a; node agent-runtime/server.mjs &
npm run dev
```

Expected on screen: red `empty-diff ×N` chips, each followed by the failure's own sentence. At least one should name a path.

- [ ] **Step 5: Commit**

```bash
git add src/components/inbox/QueueStrip.tsx
git commit -m "feat(ui): queue strip says WHY work is failing, not just how much"
```

---

### Task 6: the retry brief tells the agent the truth

**Files:**
- Modify: `agent-runtime/engine.mjs:302-316` (`handleRetryable`) and the `empty-diff` call site at `:386-390`
- Test: `agent-runtime/test/engine.test.mjs`

Today an out-of-scope failure retries with *"prior attempt produced no diff; make the concrete file edit in the working directory NOW."* The agent **did** make the edits — the broker refused them. It is being told to repeat what just failed.

- [ ] **Step 1: Write the failing test**

Reuse the existing engine-test harness in that file for driving a task to `empty-diff` with a broker whose `listChangesDetailed` returns `{ changes: [], refused: [...] }`.

```js
test("ENG-SC1: an out-of-scope empty diff does NOT tell the agent it produced no diff", async () => {
  const enqueued = [];
  const eng = makeEngine({
    broker: { listChangesDetailed: async () => ({ changes: [], refused: ["src/a.ts", "src/b.ts"] }) },
    queue: makeQueueSpy(enqueued),
  });
  await eng.runOnce({ taskId: "t1", goalId: "g1", agentId: "sr-frontend", task: "do a thing", attempts: 0 });
  const retry = enqueued.at(-1);
  assert.ok(retry, "no retry enqueued");
  assert.doesNotMatch(retry.task, /produced no diff/,
    "the agent is told it produced no diff when in fact its writes were REFUSED");
  assert.match(retry.task, /outside .*scope/i);
  assert.match(retry.task, /src\/a\.ts/, "the retry must name the offending path");
});

test("ENG-SC2: a genuine empty diff still gets the original brief", async () => {
  const enqueued = [];
  const eng = makeEngine({
    broker: { listChangesDetailed: async () => ({ changes: [], refused: [] }) },
    queue: makeQueueSpy(enqueued),
  });
  await eng.runOnce({ taskId: "t2", goalId: "g1", agentId: "qa", task: "do a thing", attempts: 0 });
  assert.match(enqueued.at(-1).task, /produced no diff/);
});
```

ENG-SC2 is the honest-code half of the pair: it proves the fix narrows the message rather than replacing it everywhere.

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test agent-runtime/test/engine.test.mjs 2>&1 | grep -A8 "ENG-SC1"
```

Expected: ENG-SC1 FAILS on `doesNotMatch` — the brief currently says "produced no diff" for both cases. ENG-SC2 PASSES already.

- [ ] **Step 3: Carry the refusal into `handleRetryable`**

Change the signature at `agent-runtime/engine.mjs:302`:

```js
  function handleRetryable(task, kind, reason, refused = []) {
```

and the `enrich` ternary at `:311`:

```js
    const enrich = (kind === "empty-diff" || kind === "no-output")
      // A refused-path empty diff is NOT "no work happened". The seat DID write; the
      // broker declined the paths. Telling it to "make the edit NOW" sends it to repeat
      // exactly what just failed, which is how this burned a Phase 14 session.
      ? (refused.length
          ? `\n\n(Your prior attempt DID write files, but ${refused.length} path(s) were outside this seat's write scope and were refused, so nothing could be applied: ${refused.slice(0, 5).join(", ")}${refused.length > 5 ? ", …" : ""}. Make the change INSIDE your scope, or report that the task requires a path you do not own.)`
          : "\n\n(prior attempt produced no diff; make the concrete file edit in the working directory NOW.)")
      : kind === "test-failed"
```

Leave the `test-failed` branch exactly as it is.

- [ ] **Step 4: Pass the refused list at the call site**

At `agent-runtime/engine.mjs:389`:

```js
        return handleRetryable(task, "empty-diff", why, refused);
```

Leave every other `handleRetryable` call unchanged — the default `[]` preserves their behaviour byte-for-byte.

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --test agent-runtime/test/engine.test.mjs 2>&1 | tail -8
```

Expected: both PASS.

- [ ] **Step 6: Prove the ratchet fires**

```bash
md5 agent-runtime/engine.mjs
```

Change `refused.length ?` to `false ?` so the old text always wins. ENG-SC1 must go red on `doesNotMatch`. Copy it, restore, confirm `md5`, green.

- [ ] **Step 7: Commit**

```bash
git add agent-runtime/engine.mjs agent-runtime/test/engine.test.mjs
git commit -F - <<'EOF'
fix(runtime): stop telling a refused agent it produced no diff

An empty diff caused by out-of-scope writes retried with "prior attempt
produced no diff; make the concrete file edit NOW". The seat DID write —
the broker refused the paths — so the brief sent it to repeat exactly
what had just failed. This text is visible on the running install.

The brief now names the scope breach and the paths. A genuine empty diff
keeps the original wording, pinned by ENG-SC2.

Ratchet ENG-SC1 proven to fire with the new branch disabled:

  <PASTE THE RED OUTPUT FROM STEP 6 HERE>

Restored byte-identical, green.
EOF
```

---

### Task 7: the Roster strip moves to Settings

**Files:**
- Modify: `src/components/board/JobBoard.tsx` (remove mount + import)
- Modify: `src/App.tsx:12` (import), `:1037` (mount)
- Modify: `src/components/settings/SettingsPanel.tsx` (add mount)

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/rosterMount.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const reads = (p: string) => readFileSync(join(ROOT, p), "utf8");

// Structural, not textual: count real JSX usages `<RosterStrip`, which cannot be
// spoofed by a comment mentioning the name in prose.
const mounts = (src: string) => (src.match(/<RosterStrip[\s/>]/g) ?? []).length;

test("RM-1: the roster is mounted exactly once in the app — in Settings", () => {
  assert.equal(mounts(reads("src/components/settings/SettingsPanel.tsx")), 1, "Settings must mount it");
  assert.equal(mounts(reads("src/App.tsx")), 0, "App must not mount it");
  assert.equal(mounts(reads("src/components/board/JobBoard.tsx")), 0, "JobBoard must not mount it");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run test:unit 2>&1 | grep -A6 "RM-1"
```

Expected: FAIL — Settings mounts 0, App mounts 1, JobBoard mounts 1.

- [ ] **Step 3: Remove the JobBoard mount**

In `src/components/board/JobBoard.tsx` delete the import at line 10 and this block:

```tsx
        {/* The roster, INCLUDING anyone HR hired mid-job. This is the 10.2 component reused, not
            re-implemented: a second hire card is a second thing that can misstate a writeScope. */}
        <RosterStrip lastEvent={lastEvent ?? null} />
```

If `lastEvent` becomes unused in that component, leave the prop in place — `JobDetail` and other children may still take it. Let `npm run lint` tell you; do not guess.

- [ ] **Step 4: Remove the App mount**

In `src/App.tsx` delete the import at line 12 and this block at ~1037:

```tsx
              {/* Phase 7 / 7.4 — who is on the team and what each seat may write. */}
              <RosterStrip lastEvent={lastEvent} />
```

- [ ] **Step 5: Mount it in Settings**

In `src/components/settings/SettingsPanel.tsx`, import it and render it as its own section. Match the panel's existing section markup — read the file and copy the pattern used by `PolicyEditor` / `AdapterSettings` rather than inventing one.

```tsx
import { RosterStrip } from "../board/RosterStrip";
```

```tsx
        {/* 2026-09-07 — the roster's single home. It was mounted on BOTH the squad board
            and the Job board; it is reference data that changes about once a day, while a
            scope BREACH now reaches the operator through the queue strip instead. */}
        <RosterStrip lastEvent={null} />
```

Check `RosterStrip`'s props first: `lastEvent` drives its re-read on `roster.changed`. If `SettingsPanel` already receives a `lastEvent`, thread it through instead of passing `null` — a hire while Settings is open should still land.

- [ ] **Step 6: Run tests, typecheck, lint**

```bash
npm run test:unit 2>&1 | tail -6 && npm run typecheck && npm run lint
```

Expected: RM-1 passes, tsc 0, lint 0. Fix any now-unused imports lint reports.

- [ ] **Step 7: Verify in the running app**

Open the app. Confirm: the strip is gone from Squad missions and the Job board; it appears in Settings; the kanban is unchanged.

- [ ] **Step 8: Update visual baselines if they moved**

```bash
npm run test:visual 2>&1 | tail -20
```

If snapshots fail **only** because the strip left the board, that is the intended change:

```bash
npm run test:visual:update
```

Review the regenerated images before staging them. If any diff shows something other than the strip's removal, stop — that is a real regression.

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx src/components/board/JobBoard.tsx src/components/settings/SettingsPanel.tsx src/lib/__tests__/rosterMount.test.ts test/visual
git commit -F - <<'EOF'
refactor(ui): the roster lives in Settings, mounted once

It was rendered twice — App.tsx (squad board) and JobBoard.tsx — and it
shows the RULE, which is reference data that changes about once a day.
The BREACH now reaches the operator through the queue strip, which is
the thing that was actually missing.

RosterStrip itself is unchanged: a second component rendering a
writeScope is a second thing that can misstate one.

RM-1 counts real `<RosterStrip` JSX usages rather than matching prose, so
a comment naming the component cannot satisfy it.
EOF
```

---

### Task 8: full gates and the delivery report

- [ ] **Step 1: Stop every dev server**

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3004|3006|3007)'
```

Kill only MissionAlpha's own. Other projects' servers on 3000-3003/5173 belong to the operator — leave them, and note the load in the report if it is high.

- [ ] **Step 2: Run every suite serially**

```bash
npm run typecheck && npm run lint
npm run test:unit
npm run test:runtime
npm run test:vendor
npm run test:electron
npm run test:visual
```

Record each total. The contract floor is runtime ≥ 2615/0, tsc 0, lint 0.

- [ ] **Step 3: Confirm the whole point works end to end**

With the runtime and UI running, find a task that failed out-of-scope and confirm the Inbox names the seat's refused path without opening Stories. A screenshot is the evidence.

- [ ] **Step 4: Write the PES delivery report**

Append to `.planning/STATE.md`: outcome, the scope ledger from the spec's success criteria (each ✅/❌ with evidence), gates G2-G7 with what was run, files changed, the security note (`detail` is scrubbed server-side and rendered as text), and **Known Gaps & Risks**.

Carry forward at minimum: the `deliveries.mjs:1062` land-time `refusedPaths` path is still unrendered and was deliberately out of scope.

- [ ] **Step 5: Commit**

```bash
git add .planning/STATE.md
git commit -m "docs: PES delivery report — write-scope visibility"
```

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| Remove `RosterStrip` from `JobBoard.tsx` | 7 |
| Remove `RosterStrip` from `App.tsx` | 7 |
| Mount in `SettingsPanel.tsx` | 7 |
| `queueModel` carries `error.msg` as `detail` | 1 (snapshot), 3 (live event) |
| Render detail where failures are shown | 4 (selector), 5 (strip) |
| `engine.mjs` honest retry text | 6 |
| Every test a proven ratchet | 1, 2, 3, 4, 6, 7 — each has a mutation step |
| Out of scope: land-time `refusedPaths` | Named in Task 8's Known Gaps |

**Gap found and closed during review:** the spec said "carry `detail`" but only named `queueModel.ts:126`. The SSE emit at `queue.mjs:172` drops it independently, and `applyQueueEvent`'s identity short-circuit would have frozen a stale message even once carried. Tasks 2 and 3 exist because of this review; QM-D5 pins the short-circuit.

**Type consistency:** `detail: string | null` is used identically in `QueueTask` (Task 1), `applyQueueEvent` (Task 3) and `FailureReason` (Task 4). `QueueSnapshotTask.error` gains `msg?: string` in Task 1 and is not redefined later. `failureReasons` is named consistently in Tasks 4 and 5.

**Placeholder scan:** the only `<PASTE …>` markers are in commit-message templates, where the executing engineer must insert the recorded red output. That is the ratchet proof, not a placeholder.

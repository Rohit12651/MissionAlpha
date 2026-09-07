# Write-scope visibility — design

**Date:** 2026-09-07
**Status:** approved by BOSS
**Decision:** options **A + D** from the brainstorm (deduplicate the Roster strip; surface the
breach rather than the rule).

---

## The question that started this

> "Roster — 12 seats · scope enforced by the broker — why do we need this on the page when I
> can already see all agents in the kanban board?"

Partly right. The Roster strip and the kanban answer different questions — the kanban shows what
an agent is **doing**, the roster shows what it is **allowed to write**. But the strip is
rendered **twice** (`App.tsx:1037` and `JobBoard.tsx:96`), and that duplication is real.

Investigating it turned up a larger problem, which is what this design is actually about.

## What is actually broken

The system knows about scope breaches and says so — then throws the words away one layer
before the screen.

| Layer | File | State |
|---|---|---|
| Broker classifies the path | `broker.mjs:120` | Produces `out-of-scope for seat <id>` |
| Engine composes the message | `engine.mjs:386` | *"the agent wrote N path(s) OUTSIDE the appliable scope: …"* |
| Stored on the task | `engine.mjs:305` | `error: { kind, msg }` — the text survives |
| Stories view can render it | `storiesClient.ts:117` | `taskErrorText()` joins `kind · msg` |
| **Queue/kanban view** | **`queueModel.ts:126`** | **`msg` is DROPPED. Only `kind` is kept.** |

So the operator sees `empty-diff` and nothing more, on the surface they actually watch. The
explanation was written, stored, and then discarded at the last hop.

### The second defect, found next door

`engine.mjs:311` enriches an `empty-diff` retry with:

> `(prior attempt produced no diff; make the concrete file edit in the working directory NOW.)`

When the cause was out-of-scope writes this is **false and actively harmful**. The agent *did*
make the edits; the broker refused them. The retry instructs it to repeat exactly what just
failed. This text is visible on the running install today, on the Tech Lead station.

This is PES addendum class #1 — a control that looks alive and enforces nothing — in its
reporting form: the refusal happens, and the operator is told a different story.

## Scope of the change

### 1. Roster relocation (option A, absorbed into D)

A and D overlap: A keeps the strip at `App.tsx:1037`, D moves it to Settings. Combined, both
board mounts go and Settings becomes its single home.

- Remove `<RosterStrip>` and its import from `JobBoard.tsx` and `App.tsx`
- Mount it in `src/components/settings/SettingsPanel.tsx`, unchanged

Settings is a **panel** opened from the sidebar (`App.tsx:735` → `setSettingsOpen(true)`), not a
route. The roster therefore lives one click away rather than on a page of its own.

`RosterStrip` itself is **not modified**. The existing comment at `JobBoard.tsx:94` records why:
a second component that renders a `writeScope` is a second thing that can misstate one.

### 2. Carry the detail to the screen (the real fix)

- `queueModel.ts` — add `detail: string | null`, read from `t.error?.msg`, kept beside `kind`
- Render `detail` on the failed kanban card and in the inbox cluster

### 3. Tell the agent the truth on retry

- `engine.mjs` — when the empty diff was caused by refused paths, the retry enrichment names the
  scope breach and the offending paths instead of claiming no diff was produced

### Explicitly out of scope

- `refusedPaths` on the **land** path (`deliveries.mjs:1062`). A different moment — a refusal at
  apply time, after approval — with no reported operator pain. Not bundled in.
- Any change to `RosterStrip`'s own rendering.
- Any change to `broker.mjs` or `guards.mjs`. Both are CORE_GUARD; the classification is already
  correct. This design only stops discarding its output.

## Testing

Every new test is a **ratchet** and ships with its proof: mutate the thing it protects, record the
red line, restore byte-identical (`md5`), confirm green. Match on values and structure, never on
source text (addendum #13).

| Test | Must fail today |
|---|---|
| `queueModel` preserves `error.msg` as `detail` | Yes — the field does not exist |
| A failed card renders the detail text | Yes |
| Settings mounts the roster; neither board does | Yes — both boards mount it |
| Out-of-scope retry text names the scope breach | Yes — it says "produced no diff" |

## Risks

| Risk | Mitigation |
|---|---|
| `detail` is agent- or repo-derived text rendered in the DOM | It is already scrubbed server-side; render as text, never as HTML |
| `detail` can be long | Clamp in the view, full text on hover/expand — never truncate in the model |
| Roster becomes harder to find in Settings | Accepted. It is reference data that changes ~once a day; the breach now comes to the operator instead |
| Removing a mount breaks a test asserting it | Expected — those assertions encode the duplication and are updated with the change |

## Success criteria

1. An out-of-scope failure names the seat and at least one path **on the kanban**, without opening Stories.
2. The Roster strip renders exactly once in the app, in Settings.
3. An out-of-scope retry brief no longer tells the agent it produced no diff.
4. Full gates green: runtime ≥ 2615/0, unit, vendor, electron, visual, tsc 0, lint 0 — dev servers stopped.

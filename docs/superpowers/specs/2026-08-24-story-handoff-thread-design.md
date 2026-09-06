# Story Handoff Thread — design (Session 14, option A)

## Problem
Agents DO collaborate — pm-analyst → architect → tech-lead hand artifacts forward, and the
reviewer hands work BACK via `story-handback.mjs`. None of it is visible. `StoryDetail`'s
Timeline renders raw machine rows (`plan-drafted | vault:plan-story-… | 22:37`): no who, no
whom, no why. The operator cannot see the collaboration that is actually happening.

## Non-goals
No agent conversation. No new transport, no chat bus, no new auth surface. Free-form
agent↔agent dialogue is explicitly rejected — every upstream artifact is fenced as UNTRUSTED
data (Law 2), and removing that fence would let one poisoned artifact propagate through the
whole swarm (exactly what Session 14's auth-error bug would have done).

## Decision: record the truth, then render it
`story_log` already carries `by_agent`, `to_agent`, `evidence`, `from_stage`. They are
populated for handbacks and NULL for forward transitions. The UI could infer "who" from a
stage→agent lookup, but inferring an attribution and presenting it as fact is the same
instinct that produced this session's bug. Fill the columns instead.

## Backend (additive)
- `stories.update()` / `stories.advance()` accept OPTIONAL `byAgent` / `toAgent`, written to
  the existing columns. Absent ⇒ byte-identical to today (the L3 / session-13b rule: an
  optional signal must default to historical behaviour).
- `pipeline.enterStage` passes `byAgent: <this stage's seat>` and `toAgent: <next stage's
  seat>` when it lands an artifact and advances.
- No migration. No new route.

## Frontend
- `src/lib/storyThread.ts` — PURE. `(log, gates, build) → ThreadEntry[]`, each typed
  `handoff | gate | decision | rework | failure`. No React, no fetch. Unit tested.
- `src/components/bos/StoryThread.tsx` — renders the entries. A handoff reads
  "pm-analyst → architect · requirements spec". Human gates render as distinct rows.
  A handback renders its evidence.
- Artifact bodies load on expand via the EXISTING `/runtime/vault/record?id=` route.
  Collapsed by default — a 10k-char design must not blow up the overlay.
- REPLACES the raw Timeline section. Same rows, same information, stated as who→whom.
  Two logs of the same events is duplication, not redundancy.

## Error handling
- An unparseable/absent log ⇒ empty thread, never a throw (the overlay must still render).
- A failed artifact fetch ⇒ inline "could not load" on that row only; the thread stays up.
- Unknown event names render as themselves rather than being dropped — an event nobody
  mapped is still something that happened.

## Testing
TDD throughout. Pure-module unit tests first (unit suite), backend attribution tests
(runtime suite), then hallmark → impeccable, then full regression + visual verification at
1280 and 390, dark and light.

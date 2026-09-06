# Phase 6 — CORE_GUARD edits (task 6.0, BLOCKING gate)

**APPROVED-BY: BOSS (Rohit), 2026-09-02, in chat: "go phase 6 — yes to CORE_GUARD edits".**
Scope of that approval: the exact edits below, by hand, outside the swarm. Anything not
listed here is NOT approved and needs a new line in this file.

## 1. `agent-runtime/worktree.mjs` — SNAPSHOT_DENY (task 6.1)
Line ~59, row `/(^|\/)(credentials|secrets?)(\.|$)/i`.
- Change: that row applies only to paths that are NOT source code, where source code =
  under a source root (`agent-runtime/`, `src/`, `scripts/`, `electron/`) AND ending in
  `.mjs|.js|.ts|.tsx`. Add explicit row `/(^|\/)\.credentials(\.|$)/i`.
- Invariant protected: a real secret file never reaches the jail; a source module named
  `credentials.mjs` is no longer stripped from the snapshot (which is what made the
  worktree stale and the broker blame the operator's edits on the agent).
- Everything else in SNAPSHOT_DENY untouched.

## 2. `agent-runtime/worktree.mjs` — expose the snapshot manifest (task 6.2)
- Add `snapshotManifest(taskId) → {sha, refusedPaths[], snapshotAt}` (read-only; records
  what `snapshotAllowed` refused when the base was built, and when).
- No change to `create()`, `remove()`, `release()`, `reapOrphans()` semantics.

## 3. `agent-runtime/broker.mjs` — attribution (task 6.2)
- `listChangesDetailed(taskId)` compares the worktree to the SNAPSHOT COMMIT, not to the
  live operator tree. Any path in `refusedPaths` is excluded and reported under
  `notAttributed: [{path, reason:"snapshot-refused"}]`; any path whose live-tree mtime is
  after `snapshotAt` and whose worktree content equals the snapshot content is reported
  `reason:"operator-edited-after-snapshot"`.
- Invariant protected: `Delivery.changedPaths ⊆ paths the seat wrote`. Approving can never
  revert the operator's uncommitted work.
- `applyChanges`, all guards, and `APPLY_DENY` untouched.

## 4. `agent-runtime/server.mjs` (task 6.6) — not CORE_GUARD for the swarm, listed for completeness
- Engine `claude -p` spawn gains `--setting-sources project`.
- `POST /runtime/engine/apply` decides the Delivery (approved, decidedBy = session user,
  feedback names the paths) and commits on the task branch through the SAME ladder
  `POST /inbox/:id/approve` uses. Branch allow-list `^ma/task/[a-z0-9_]+$`, no push,
  D3 index content-hash asserted unchanged.

## Not approved / not touched
`guards.mjs`, `sandbox.mjs`, `quality*.mjs`, `hooks.mjs`, `policy.mjs`, `test-gate.mjs`,
`test-scope.mjs`, `secret-scrub.mjs`, `pr.mjs`, `factory/*.json`. (`guards.mjs` and
`pr.mjs` are Phase 7 and 11, each with its own gate.)

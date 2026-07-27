# SwarmHero — Functional Live Ops View — Build Progress

**Repo:** MissionAlpha · **Branch:** `feat/multimodal-input` · **Last updated:** 2026-06-23
**Status:** P0 (P0-1..P0-5) DONE · P1 (P1-2, P1-3) DONE · **P2 (P2-1, P2-2, P2-3) DONE** — all committed
on `feat/multimodal-input` (not pushed). Open questions (idle-trickle, a11y keyboard) resolved.
**Spec:** [docs/superpowers/plans/2026-06-22-swarm-hero-functional.md](plans/2026-06-22-swarm-hero-functional.md)

Turned `src/components/hero/SwarmHero.tsx` from a decorative animation into a functional live ops
view: status-driven nodes, real-comms packets (with topic labels), hover tooltip, inline inspect+chat
panel, and an interactive tier filter — all read-only, dark/no-pink, reduced-motion aware.

## Pure helpers (React-free, unit-tested in `src/lib/swarmGraph.ts`)
`src/lib/__tests__/swarmGraph.test.ts` — **65 tests, all green.**

| helper | purpose |
|---|---|
| `statusStyle(agent)` | column+stale+heartbeat → `{alpha,glow,pulse,ring,desaturate}` (P0-1) |
| `packetsFromFeed(prevTs,feed,hasNode)` | new feed events → `{from,to,topic}[]` + lastTs; baseline-on-open, no dupes (P0-2/P1-2) |
| `hitTest(nodes,px,py,ox,oy,pad)` | parallax-correct node under cursor; 12px floor + `pad` forgiving radius (P0-3 + click-fix) |
| `recentComms(feed,id,limit)` | newest-first events touching an agent (P0-4 panel) |
| `selectPacketLabels(items,max,nearPx)` | rank by nearest-cursor, cap, truncate ≤16, emphasize (P1-2) |
| `focusDim(kind,focus,dimmed)` | tier-focus opacity multiplier (P1-3) |
| `edgeWeights(feed,hasNode)` | normalized per-pair comms volume for edge weighting (P2-2) |

## Phases

- **P0-1 status node visuals** — in_progress bright · blocked red ring `#e24b4a` · stale dim/desaturated · idle faint. Verified (screenshot: senior-web-2 red ring).
- **P0-2 real-feed packets** — packets ride real `FeedEvent` from→to; quiet idle-trickle; build-once canvas (deps `[open,agentSig]`, status via `statusRef`, feed via `feedRef`) — fixed pre-existing per-poll flash.
- **P0-3 hover tooltip** — `id·role·tier·status·task` at cursor; parallax hit-test; state only on hovered-CHANGE; a11y (canvas `aria-hidden`, sr-only keyboard→roster cue, contrast 17/9/12:1). Verified.
- **P0-4 inline inspect+chat panel (v2)** — click node → inline panel inside hero (hero stays open); embeds the EXISTING `ChatPane` (`isBoss=false`, `onCommand=sendCommand` — no 2nd engine); App owns `heroAgentId` + lazy per-agent message store; live RECENT COMMS via `useMemo(openAgentId,feed)`; white selection ring (P1-1 folded in); ✕/Esc-once→panel, Esc-again→hero; empty-click closes; display-only when `onSelectAgent` omitted (P0-5). **security-reviewer PASS** (no new mutation path, XSS-safe, `encodeURIComponent`, `isBoss=false` excludes boss dispatch gate). Verified dev (automated click-through) + packaged Electron.
- **Click-fix (post-P0-4):** clicks "did nothing" in packaged = near-miss on small/drifting node. Added `hitTest` `pad` (10px click / 6px hover) + 12px floor. Proven: dev static + **+9px off-center click opens panel**. Repackaged.
- **P1-2 comms label on packet** — mono `topic` label (≤16 chars) rides each real packet, fades `sin(π·p)`; nearest-cursor emphasized; cap ≤6; none under reduced-motion. Verified via injected comm (`deploy-prod` rode the packet + faded).
- **P1-3 tier filter (interactive legend)** — bottom legend chips → accessible toggle buttons (`aria-pressed`, Tab+Enter/Space, focus ring); click a tier → others' nodes/edges/packets dim (no glow) via per-node eased `dim` (≤200ms; instant reduced-motion); multi-select union; toggle off; none→all full. a11y-architect fixes applied (inactive text `#b8bdc9` AA, `ring-white`+offset, `aria-live` filter announcement). Verified: click + multi + keyboard (Space/Enter) + dim screenshot.

- **P2-2 edge weighting** — `edgeWeights` pure helper (unit-tested) synced to a `weightsRef`; canvas
  scales each link's width (0.8+w*2.4) + brightness (0.55+0.45*w) by pair comms volume. Read-only. Committed `f14599c`.
- **P2-3 mini live-ops dock** — `variant="dock"` reuse of SwarmHero (small embedded graph + accessible
  expand button); App mounts it bottom-left on the cockpit home; expand/node-click opens the full hero. Committed `05031a6`.
- **P2-1 in-hero gated actions** — `Ack` / `Re-dispatch` in the panel, each confirmed via the EXISTING
  `PermissionGate` before `sendCommand` fires (no one-click mutation, existing ack/respawn verbs).
  onCommand scoped to the full hero only (dock/display-only ungated). **security-reviewer PASS.** Committed `2edda98`.

- **Dock UX upgrade** — the P2-3 mini dock is now **movable + dismissible**: a title bar with a grip
  drag-handle (grab to move anywhere, pointer-capture, clamped on-screen via unit-tested
  `clampDockPos`, position persisted to `localStorage`), an expand button, and an `✕` close button
  (dismissed state persisted; dock returns after opening/closing the full hero). `SwarmHero
  variant="dock"` is now canvas-only; App owns the draggable chrome. Committed `e2f5e12`.

## Gates (all phases)
- `npm run test:unit` → **69/69** · `cd agent-runtime && npm test` → **297/297** (unaffected)
- `npm run typecheck` exit 0 · `npm run build` exit 0 · `npm run electron:build` exit 0 (DMG + `.app`)

## Helpers added for P2
- `edgeWeights(feed,hasNode)` (P2-2) · `clampDockPos(x,y,w,h,vpW,vpH,margin)` (movable dock).

## Commit trail (all on `feat/multimodal-input`, LOCAL — NOT pushed)
- `236f536` pure helpers + tests · `71a1e82` functional live ops view (P0-1..P0-5 + P1-2/P1-3) ·
  `d44a7b7` P0/P1 docs · `f14599c` P2-2 edge weighting · `05031a6` P2-3 mini dock ·
  `2edda98` P2-1 gated actions (security PASS) · `ff302b7` P2 directive + mockup + progress ·
  `e2f5e12` movable/dismissible dock.

## Status / next
- **COMPLETE:** P0 (P0-1..P0-5), P1 (P1-2, P1-3), P2 (P2-1..P2-3), + movable/dismissible dock.
  Open questions (idle-trickle, a11y keyboard) resolved. PRD has nothing left.
- All committed locally on `feat/multimodal-input`; **NOT pushed** (no PR opened).
- P2-1 is the only mutation surface — gated via existing `PermissionGate` + `sendCommand`; `security-reviewer` PASS.
- Packaged desktop app (`release/mac-arm64/MissionAlpha.app`) rebuilt with all features.
- Verification tooling: playwright + chromium local (devDep reverted from `package.json`; chromium in global cache).
- Pending decisions: push / open PR (awaiting boss); the pre-existing `ROOT` hardcoded path in
  `src/lib/actions.ts` + unauthenticated `issuedBy:"operator"` are tracked separately (not P2 regressions).

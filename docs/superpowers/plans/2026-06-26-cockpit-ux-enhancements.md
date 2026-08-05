# MissionAlpha Cockpit UX Enhancements
## Feature: Stop Button · Modes Picker · New Session · Context Window
### Plan Document — 2026-06-26 (v2 — CODE-VERIFIED)
### Status: APPROVED FOR BUILD

> **v2 changelog (verified against real source):**
> 1. REMOVED entire IPC/preload layer — renderer talks to runtime via direct `fetch(runtimeUrl(...))`, not IPC proxy.
> 2. Auth header is `x-runtime-token` (NOT `x-ma-token`).
> 3. Feature C server endpoint `DELETE /runtime/:id/thread` ALREADY EXISTS (server.mjs:1391) → calls `deleteThread()` (329). Do not rebuild.
> 4. `registerKill` at 953 is ENGINE-only. `cliReply` (chat) has NO kill wiring — must add child exposure.
> 5. Stop needs client `AbortController` + server `/cancel` (child keeps running otherwise → burns tokens).
> 6. Modes only bite when tools enabled. Default `RUNTIME_TOOLS="none"` (server.mjs:138) → chat-only agents get NO `--permission-mode` flag. PLAN mode (prompt-prefix) works universally; ASK/EDITS/AUTO only affect tool-enabled/factory agents.

---

## 0. SKILLS PIPELINE — MANDATORY FIRE ORDER

Per CLAUDE.md superpowers rules — fire in order, never skip:

| Step | Skill | Trigger |
|------|-------|---------|
| 0 | `sp-using-superpowers` | Session start |
| 1 | `sp-brainstorming` | BEFORE any feature work (done — this doc) |
| 2 | `kw-product-management-write-spec` | BEFORE implementing each feature |
| 3 | `kw-engineering-system-design` | Architecture decisions per feature |
| 4 | `sp-writing-plans` | This document |
| 5 | `sp-executing-plans` | Executing each phase |
| 6 | `sp-test-driven-development` | BEFORE writing impl code — every feature |
| 7 | `react-specialist` | React component work |
| 8 | `typescript-pro` | TypeScript types + strict mode |
| 9 | `impeccable craft` | UI design pass on every new component |
| 10 | `hallmark` | Anti-slop design audit before PR |
| 11 | `security-review` | Before any commit touching server endpoints |
| 12 | `sp-verification-before-completion` | BEFORE claiming feature done |
| 13 | `sp-finishing-a-development-branch` | After tests pass |
| 14 | `sp-requesting-code-review` | Before merge |
| 15 | `kw-engineering-code-review` | Peer review gate |
| 16 | `kw-engineering-deploy-checklist` | Before shipping |

Subagents that fire **during implementation** (auto-detect, never ask):
- `kw-engineering-debug` / `sp-systematic-debugging` → any bug, BEFORE proposing fix
- `code-reviewer` → after every file written
- `security-reviewer` → server endpoints, env exposure, kill paths
- `typescript-reviewer` → all `.ts`/`.tsx` changes
- `react-reviewer` → all React component changes
- `tdd-guide` → enforces write-tests-first per feature

---

## 1. SCOPE

Four features. Each is a complete server → renderer path (NO IPC layer — direct fetch).

```
Feature A: Stop Button     — abort in-flight claude -p spawn (client abort + server kill)
Feature B: Modes Picker    — runtime permission-mode + plan-mode (tool-enabled agents only)
Feature C: New Session (+) — clear thread history (server DELETE already exists)
Feature D: Context Window  — always-visible usage bar (~90% built)
```

**Build order:**
1. **Feature D** — 20min, ship first
2. **Feature C** — server done, only UI + direct DELETE fetch
3. **Feature A** — needs cliReply child-exposure rework
4. **Feature B** — most complex, TOOLS caveat, last

---

## 2. CODE-VERIFIED STATE AUDIT

### Renderer → runtime contract (CRITICAL — read first)
- Renderer calls runtime via **direct fetch**: `fetch(runtimeUrl(path), { headers: { "x-runtime-token": token } })`
- `runtimeUrl(path)` from `src/lib/runtimeBase.ts` — base "" in dev (vite proxy), `http://127.0.0.1:3005` packaged
- `runtimeToken()` from same file — token from `/api/runtime-token` (dev) or `window.missionAlpha.getRuntimeToken()` (packaged)
- Auth header name: **`x-runtime-token`** (ChatPane.tsx:255, 271)
- Existing examples in ChatPane: `/changes` (253), `/apply` (269), `/chat` (296), `/run` (386)
- **NO IPC proxy for runtime calls.** `electron/main.cjs` IPC handles only: token, pick-folder, repo-root. Do NOT add runtime-call IPC.

### Already exists (do NOT rebuild)
- `threads` Map — server.mjs:227
- `deleteThread(id)` — server.mjs:329 → wipes memory Map + `threadUsage` + disk file (`rmSync(threadFile(id))`)
- `DELETE /runtime/:id/thread` HTTP endpoint — server.mjs:1391-1393 → calls `deleteThread`. Auth-gated (in needsAuth regex 1256).
- `UsageMeter` + `TurnUsage` — src/components/workspace/UsageMeter.tsx (returns `null` when no usage)
- `streaming` state — ChatPane.tsx:103
- `cliReply()` — server.mjs:530, spawns `child` at 641 (cli backend chat path)
- `handleChat()` — server.mjs:701, calls cliReply at 748
- `stream.usage(turn)` → `setUsage` in ChatPane (337)
- childEnv secret strip — server.mjs:636

### Does NOT exist (must build)
- `chatKillMap` + child exposure from `cliReply` (Feature A)
- `POST /runtime/:agentId/cancel` (Feature A)
- Client `AbortController` around send fetch (Feature A)
- `runtimePermMode` runtime variable + `GET/POST /runtime/config` (Feature B)
- `ModesPicker.tsx` component (Feature B)
- `+` New Session button + direct DELETE call (Feature C)
- `UsageMeter` zero-state (Feature D)

### Key constraints discovered
- `TOOLS = process.env.RUNTIME_TOOLS || "none"` (server.mjs:138). Default "none" = chat-only = NO `--permission-mode` flag.
- `--permission-mode acceptEdits` pushed ONLY at: 563 (factory-write), 578 (RUNTIME_TOOLS=write). NOT in chat-only path.
- `BACKEND = KEY ? "api" : "cli"` (server.mjs:53). Stop targets cli `child` spawn.
- `registerKill` (953) is in `engineDispatch.runOnce` — ENGINE path only, NOT chat.

---

## 3. FEATURE D — CONTEXT WINDOW ALWAYS-VISIBLE (ship first)

### 3.1 Problem
`UsageMeter` returns `null` when `usage === null`. Invisible on fresh thread. User never sees context state until first turn completes.

### 3.2 Fix — `src/components/workspace/UsageMeter.tsx`

```tsx
// Add above component:
const ZERO_USAGE: TurnUsage = {
  inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0,
  cacheReadTokens: 0, thinkingTokens: 0,
  contextTokens: 0, contextWindow: 200_000,
  contextPct: 0, tier: "—", estimated: false,
};

// Replace null guard:
export function UsageMeter({ usage }: { usage: TurnUsage | null }) {
  const u = usage ?? ZERO_USAGE;
  // ...replace every `usage.` → `u.` in body
```

Update tooltip to Claude-Code format:
```tsx
title={`${compact(u.contextTokens)} / ${compact(u.contextWindow)} · ${pct}% context used · in ${u.inputTokens.toLocaleString()} · out ${u.outputTokens.toLocaleString()}`}
```

`ChatPane` already renders `<UsageMeter usage={usage} />` (426) — fix propagates, no ChatPane change.

### 3.3 Tests (TDD first)
```
□ UsageMeter renders with usage=null (zero state visible)
□ bar width 0% when contextPct=0
□ bar color green <60, amber 60-85, red >85
□ tier shows "—" in zero state
□ Snapshot: zero-state
```

### 3.4 Skills: `react-specialist`, `impeccable craft`, then `react-reviewer` subagent

---

## 4. FEATURE C — NEW SESSION (+)

### 4.1 Problem
Thread history grows unbounded per agent. No fresh-start without runtime restart.

### 4.2 Server — ALREADY DONE
`DELETE /runtime/:id/thread` (server.mjs:1391) calls `deleteThread()` (329) → clears memory Map + `threadUsage` + disk file. Auth-gated. **No server change needed.**

### 4.3 UI — `src/components/workspace/ChatPane.tsx` (direct fetch, mirror existing pattern)

```tsx
const [clearing, setClearing] = useState(false);

const handleNewSession = useCallback(async () => {
  if (streaming) return;
  const name = isBoss ? "CEO" : threadId;
  // Irreversible — wipes history + disk. Native confirm.
  if (!window.confirm(`Clear ${name}'s conversation history?\nThis deletes saved history and starts fresh. Cannot be undone.`)) return;
  setClearing(true);
  try {
    const token = await runtimeToken();
    await fetch(runtimeUrl(`/runtime/${encodeURIComponent(threadId)}/thread`), {
      method: "DELETE",
      headers: { "x-runtime-token": token },
    });
    setMessages([]);   // clear local list
    setUsage(null);    // reset context meter (Feature D shows zero-state)
    setChanges([]);    // clear any pending proposed changes
  } catch (e) {
    setErr(`clear failed: ${(e as Error).message}`);
  } finally {
    setClearing(false);
  }
}, [streaming, isBoss, threadId, setMessages]);
```

Button in ChatPane header (rightmost, near UsageMeter):
```tsx
<button
  onClick={handleNewSession}
  disabled={streaming || clearing}
  className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-panel-2 disabled:opacity-40"
  style={{ color: tok("muted") }}
  aria-label="New session (clear history)"
  title="New session"
>
  <Plus size={13} />
</button>
```

### 4.4 Design (fire `impeccable craft`)
- `+` icon, 28×28px, muted, hover bg panel-2, disabled-dim while streaming
- After clear: empty chat shows placeholder "Start a new conversation with [agent]"
- Native `window.confirm` — no custom modal this phase

### 4.5 Tests (TDD first)
```
□ + button renders in header
□ + button disabled when streaming=true
□ handleNewSession → DELETE /thread with x-runtime-token header
□ confirmed → setMessages([]) + setUsage(null) + setChanges([])
□ cancelled confirm → no fetch, state unchanged
□ fetch error → setErr called, clearing reset
□ (server already covered: deleteThread wipes Map+usage+disk — existing tests)
```

### 4.6 Skills: `react-specialist`, `impeccable craft`, `react-reviewer` + `typescript-reviewer` subagents

---

## 5. FEATURE A — STOP BUTTON

### 5.1 Problem
No abort for runaway agent. `streaming=true` but client read via `res.body.getReader()` and server `child` (cliReply) have no kill path. Aborting client fetch alone leaves `child` running → burns tokens.

### 5.2 Architecture — TWO halves, both required

```
CLIENT (stop streaming + free UI):
  Stop click → abortController.abort() → getReader() throws → setStreaming(false)

SERVER (kill child → stop token burn):
  Stop click ALSO → POST /runtime/:id/cancel → chatKillMap.get(id)() → child.kill('SIGTERM') → SIGKILL@5s
```

### 5.3 Server — `agent-runtime/server.mjs`

**Add kill map near top (after line 227 threads):**
```javascript
// Active chat kill handles, keyed by agentId. Only ONE in-flight chat per agent
// (inflight guard at 1204 blocks concurrent). Set when cliReply spawns, deleted on child close.
const chatKillMap = new Map(); // agentId → () => void
```

**Expose `child` from `cliReply` — add `onSpawn` param (server.mjs:530):**
```javascript
// signature gains trailing onSpawn callback (optional, back-compat)
function cliReply(agentId, system, hist, stream, onDone, modelId, attachments = [], attachDir = null, onSpawn = null) {
  // ...existing through spawn at 641...
  const child = spawn(CLAUDE_BIN, spawnArgs, { stdio: ["pipe","pipe","pipe"], cwd, env: childEnv });
  // NEW: hand the child to caller so the chat path can register a kill.
  if (onSpawn) onSpawn(child);
  // ...existing stdout/close handlers...
}
```

**Register kill in `handleChat` cli branch (server.mjs:748):**
```javascript
cliReply(agentId, sysPrompt, hist, stream, (acc, usage) => {
  save(acc || "(no output)", usage);
  chatKillMap.delete(agentId);   // turn done — drop handle
  stream.done();
}, modelId, attachments, attachDir, (child) => {
  // SIGTERM, then SIGKILL fallback if it ignores (kill-switch must be decisive).
  chatKillMap.set(agentId, () => {
    try { child.kill("SIGTERM"); } catch { /* */ }
    setTimeout(() => { try { if (!child.killed) child.kill("SIGKILL"); } catch { /* */ } }, 5000).unref?.();
  });
});
```

**Add cancel endpoint. NOT auth-gated** — same trust as sending a chat (client already owns the agentId; only stopping its own in-flight turn; no data leak). Place near other /runtime/:id POSTs, BEFORE needsAuth gate:
```javascript
// POST /runtime/:agentId/cancel — abort in-flight chat child. Not auth-gated:
// stopping your own turn leaks nothing and writes nothing.
const mcancel = url.pathname.match(/^\/runtime\/([a-z0-9_-]{1,64})\/cancel$/i);
if (req.method === "POST" && mcancel) {
  const aid = mcancel[1];
  const killFn = chatKillMap.get(aid);
  if (killFn) {
    killFn();
    chatKillMap.delete(aid);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cancelled: true }));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cancelled: false, reason: "no active chat" }));
  }
  return;
}
```

> SECURITY NOTE: `/cancel` stays unauthenticated to match `/chat` (also unauthenticated — not in needsAuth regex 1256). It only kills a child the caller already started. If `/chat` is ever moved behind auth, move `/cancel` too. Map key is regex-bounded `[a-z0-9_-]{1,64}` — no traversal.

### 5.4 UI — `src/components/workspace/ChatPane.tsx`

**Add abort ref + wrap send fetch:**
```tsx
const abortRef = useRef<AbortController | null>(null);

// inside send(), before fetch:
const controller = new AbortController();
abortRef.current = controller;
// add `signal: controller.signal` to BOTH fetch branches (multipart + json)

// in send() catch: ignore AbortError (user-initiated stop, not a real error)
catch (e) {
  if ((e as Error).name !== "AbortError") setErr((e as Error).message);
} finally {
  setStreaming(false);
  abortRef.current = null;
}
```

**Stop handler:**
```tsx
const stop = useCallback(async () => {
  abortRef.current?.abort();              // halt client read immediately
  setStreaming(false);                    // optimistic UI
  try {
    const token = await runtimeToken();
    await fetch(runtimeUrl(`/runtime/${encodeURIComponent(threadId)}/cancel`), {
      method: "POST",
      headers: { "x-runtime-token": token }, // harmless even though endpoint is open
    });
  } catch { /* child may already be done */ }
}, [threadId]);
```

**Swap send→stop button when streaming:**
```tsx
{streaming ? (
  <button
    onClick={stop}
    className="flex h-8 w-8 items-center justify-center rounded-md transition-transform duration-150 active:scale-95"
    style={{ backgroundColor: tok("stale-red"), color: "#fff" }}
    aria-label="Stop generation"
    title="Stop (⌘.)"
  >
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect width="10" height="10" rx="1.5" /></svg>
  </button>
) : (
  /* existing send button */
)}
```

**⌘. shortcut in composer keydown:**
```tsx
if ((e.metaKey || e.ctrlKey) && e.key === "." && streaming) {
  e.preventDefault();
  void stop();
  return;
}
```

### 5.5 Design (fire `impeccable craft` + `emil-design-eng`)
- Red square ■, 32×32px, same slot as send
- Press: `active:scale-95` 150ms ease-out (emil: button press 100-160ms)
- Reduced-motion: drop scale
- Tooltip "Stop (⌘.)", aria-label "Stop generation"

### 5.6 Tests (TDD first)
```
SERVER
□ cliReply calls onSpawn(child) after spawn
□ chatKillMap set on spawn, deleted on done
□ POST /cancel with active handle → 200 {cancelled:true} + child SIGTERM
□ POST /cancel no handle → 404 {cancelled:false}
□ agentId regex bounds reject traversal
CLIENT
□ streaming=true → stop button renders, send hidden
□ streaming=false → send renders
□ stop() → abortRef.abort() called
□ stop() → POST /cancel fired
□ AbortError swallowed (no setErr)
□ ⌘. while streaming → stop() fires
□ ⌘. while idle → no-op
```

### 5.7 Skills: `react-specialist`, `impeccable craft`, `emil-design-eng`, `security-reviewer` + `react-reviewer` + `typescript-reviewer` subagents

---

## 6. FEATURE B — MODES PICKER

### 6.1 Problem + HONEST SCOPE
`--permission-mode` hardcoded `acceptEdits` at 563 (factory-write) and 578 (RUNTIME_TOOLS=write). 

**CAVEAT (verified):** default `RUNTIME_TOOLS="none"` → chat-only agents get NO `--permission-mode` flag. So:
- **ASK / EDITS / AUTO** → affect ONLY tool-enabled agents (RUNTIME_TOOLS=write, or factory-write agents). No effect on plain chat.
- **PLAN** → prompt-prefix injection → works on ALL agents (independent of tools).

Picker still valuable: most MissionAlpha write-work runs through factory/write agents, and PLAN is universal. But UI must not imply ASK/EDITS/AUTO change a chat-only agent's behavior.

### 6.2 Modes

| Label | `--permission-mode` | Behavior | Applies when | Risk |
|-------|--------------------|----------|--------------|------|
| **ASK** | `default` | Prompt before every tool | tools enabled | Low |
| **EDITS** | `acceptEdits` | Auto-accept edits, prompt others | tools enabled (current default) | Med |
| **AUTO** | `bypassPermissions` | No prompts | tools enabled | HIGH — confirm |
| **PLAN** | _(prompt prefix, no flag)_ | Plan only, no execution | ALL agents | Safe |

### 6.3 Server — `agent-runtime/server.mjs`

**Runtime-mutable mode near top:**
```javascript
let runtimePermMode = process.env.RUNTIME_PERM_MODE || "acceptEdits";
const VALID_PERM_MODES = new Set(["default", "acceptEdits", "bypassPermissions"]);
```

**Replace hardcoded values:**
```javascript
// line 563 (factory-write):
args.push("--add-dir", cwd, "--permission-mode", runtimePermMode);
// line 578 (RUNTIME_TOOLS=write):
args.push("--permission-mode", runtimePermMode);
```

**engineDispatch (941) — DO NOT change. Keep literal `acceptEdits`:**
```javascript
// engineDispatch is the AUTONOMOUS background path. NEVER inherit runtimePermMode —
// a UI mode flip to bypassPermissions must not silently turn the autonomous engine loose.
args.push("--add-dir", workdir, "--permission-mode", "acceptEdits");
```

**Config endpoints (auth-gated):**
```javascript
// GET /runtime/config
if (req.method === "GET" && url.pathname === "/runtime/config") {
  return ok2(res, { permissionMode: runtimePermMode });
}
// POST /runtime/config {permissionMode}
if (req.method === "POST" && url.pathname === "/runtime/config") {
  let body = "";
  req.on("data", c => { body += c; if (body.length > 1000) req.destroy(); });
  req.on("end", () => {
    let pm; try { pm = JSON.parse(body || "{}").permissionMode; } catch { /* */ }
    if (!pm || !VALID_PERM_MODES.has(pm)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid permissionMode", valid: [...VALID_PERM_MODES] }));
      return;
    }
    runtimePermMode = pm;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ permissionMode: runtimePermMode }));
  });
  return;
}
```

**Add to needsAuth (1255-1258):**
```javascript
url.pathname === "/runtime/config" ||
```

### 6.4 Types — `src/lib/runtimeBase.ts`
```typescript
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";
export type AgentMode = PermissionMode | "plan";
```
(NO MABridge additions — modes use direct fetch, not the bridge.)

### 6.5 New component — `src/components/workspace/ModesPicker.tsx`

```tsx
import { ShieldCheck, Pencil, Zap, Map as MapIcon } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { runtimeUrl, runtimeToken, type AgentMode } from "../../lib/runtimeBase";

const MODES: { id: AgentMode; label: string; icon: React.ReactNode; title: string; danger?: boolean }[] = [
  { id: "default",           label: "ASK",   icon: <ShieldCheck size={11} />, title: "Ask before each tool call (tool-enabled agents)" },
  { id: "acceptEdits",       label: "EDITS", icon: <Pencil size={11} />,      title: "Auto-accept edits, ask for other tools (tool-enabled agents)" },
  { id: "bypassPermissions", label: "AUTO",  icon: <Zap size={11} />,         title: "No permission prompts (tool-enabled agents)", danger: true },
  { id: "plan",              label: "PLAN",  icon: <MapIcon size={11} />,     title: "Plan only — no execution (all agents)" },
];

export function ModesPicker({ value, onChange, disabled }: {
  value: AgentMode; onChange: (m: AgentMode) => void; disabled?: boolean;
}) {
  async function select(m: AgentMode) {
    if (m === value) return;
    if (m === "bypassPermissions") {
      const ok = window.confirm(
        "AUTO mode bypasses all permission prompts.\n\nTool-enabled agents will run tool calls — including file writes — without asking.\n\nOnly use when you fully trust the task. Continue?"
      );
      if (!ok) return;
    }
    onChange(m);
    if (m !== "plan") {  // PLAN is prompt-level, no server flag
      try {
        const token = await runtimeToken();
        await fetch(runtimeUrl("/runtime/config"), {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-runtime-token": token },
          body: JSON.stringify({ permissionMode: m }),
        });
      } catch { /* keep optimistic UI; next turn falls back to server default */ }
    }
  }

  return (
    <div className="flex items-center gap-0.5 rounded-md p-0.5"
      style={{ backgroundColor: tok("panel-2"), border: `1px solid ${tok("border")}` }}
      role="group" aria-label="Agent mode">
      {MODES.map((m) => {
        const active = value === m.id;
        const accent = m.danger && active ? tok("stale-red") : active ? tok("accent") : tok("muted");
        return (
          <button key={m.id} onClick={() => select(m.id)} disabled={disabled}
            title={m.title} aria-pressed={active}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-all duration-150"
            style={{
              backgroundColor: active ? (m.danger ? tok("stale-red") + "22" : tok("accent") + "18") : "transparent",
              color: accent,
              border: active ? `1px solid ${accent}40` : "1px solid transparent",
            }}>
            {m.icon}{m.label}
          </button>
        );
      })}
    </div>
  );
}
```

### 6.6 Wire into ChatPane
```tsx
const [agentMode, setAgentMode] = useState<AgentMode>("acceptEdits");

// load current server mode on mount:
useEffect(() => {
  let live = true;
  (async () => {
    try {
      const token = await runtimeToken();
      const r = await fetch(runtimeUrl("/runtime/config"), { headers: { "x-runtime-token": token } });
      const j = await r.json();
      if (live && j?.permissionMode) setAgentMode(j.permissionMode);
    } catch { /* default stays */ }
  })();
  return () => { live = false; };
}, []);

// PLAN mode: prefix the outgoing message (prompt-level, universal):
const text = input.trim();
const outgoing = agentMode === "plan"
  ? `PLAN ONLY — Do not call tools or write files. Output your implementation plan in markdown with phases and file paths.\n\n${text}`
  : text;
// ...send `outgoing` as the message field (json + multipart paths)

// header, beside ModelTierPicker:
<ModesPicker value={agentMode} onChange={setAgentMode} disabled={streaming} />
```

### 6.7 Design (fire `impeccable craft` + `hallmark audit` + `a11y-architect`)
- 4-segment pill, 10px uppercase, active = colored fill
- AUTO active = red tint + red border (visually alarming)
- PLAN active = amber/accent (map icon)
- Disabled while streaming
- Roving tabindex, arrow-key cycle, aria-pressed per button

### 6.8 Tests (TDD first)
```
SERVER
□ GET /runtime/config → {permissionMode:"acceptEdits"} default
□ POST /runtime/config {permissionMode:"default"} → 200
□ POST invalid → 400 {valid:[...]}
□ POST unauthorized → 401
□ next factory-write/write spawn uses updated runtimePermMode
□ engineDispatch spawn STILL "acceptEdits" after a mode flip (never inherits)
CLIENT
□ ModesPicker renders 4 modes
□ active mode highlighted; AUTO active = red
□ AUTO → confirm dialog; cancel → mode unchanged, no fetch
□ select non-plan → POST /runtime/config with x-runtime-token
□ select plan → NO fetch; outgoing message gets PLAN prefix
□ mount → GET /runtime/config sets initial mode
□ disabled prop → buttons unclickable
□ keyboard arrows cycle; aria-pressed correct
```

### 6.9 Skills: `react-specialist`, `typescript-pro`, `impeccable craft`, `hallmark audit`, `emil-design-eng`, `a11y-architect`, `security-review` + `security-reviewer`/`react-reviewer`/`typescript-reviewer` subagents

---

## 7. FILE CHANGE MAP (v2 — IPC layer removed)

### `agent-runtime/server.mjs`
- Add `chatKillMap` Map (Feature A)
- `cliReply`: add `onSpawn` param, call `onSpawn(child)` after spawn (Feature A)
- `handleChat` cli branch: register kill via onSpawn, delete on done (Feature A)
- Add `POST /runtime/:id/cancel` — unauthenticated (Feature A)
- Add `runtimePermMode` + `VALID_PERM_MODES` (Feature B)
- Replace `acceptEdits` → `runtimePermMode` at 563, 578 ONLY (Feature B)
- Add comment at 941: engineDispatch keeps literal `acceptEdits` (Feature B)
- Add `GET`+`POST /runtime/config` (Feature B)
- Add `/runtime/config` to needsAuth (Feature B)
- **Feature C: NO change — `DELETE /thread` already exists (1391)**

### `src/lib/runtimeBase.ts`
- Add `PermissionMode`, `AgentMode` types (Feature B)
- **NO MABridge additions** (all features use direct fetch)

### `src/components/workspace/UsageMeter.tsx`
- `ZERO_USAGE` const, drop null-return, `usage ?? ZERO_USAGE`, tooltip format (Feature D)

### `src/components/workspace/ChatPane.tsx`
- `abortRef` + `signal` on send fetch + swallow AbortError (Feature A)
- `stop()` handler + send→stop button swap + ⌘. shortcut (Feature A)
- `handleNewSession` + `+` button via direct DELETE (Feature C)
- `agentMode` state + mount GET config + PLAN prefix + `<ModesPicker>` (Feature B)

### NEW: `src/components/workspace/ModesPicker.tsx` (Feature B)

### `electron/main.cjs` / `electron/preload.cjs`
- **NO CHANGE.** Renderer reaches runtime by direct fetch. (v1 IPC handlers deleted from plan.)

---

## 8. EXECUTION PHASES

### Phase 1 — Feature D (Context HUD)
Skills: `react-specialist`, `impeccable craft`
1. Test: UsageMeter null → zero-state (RED)
2. Add ZERO_USAGE, drop guard → GREEN
3. `react-reviewer` subagent

### Phase 2 — Feature C (New Session)
Skills: `react-specialist`, `impeccable craft`
1. UI tests for + button (RED)
2. `handleNewSession` + button (direct DELETE) → GREEN
3. Confirm server `deleteThread` covered by existing tests
4. `react-reviewer` + `typescript-reviewer`

### Phase 3 — Feature A (Stop) — server first
Skills: `sp-test-driven-development`, `security-review`, `react-specialist`, `emil-design-eng`
1. Server tests (onSpawn, killMap, /cancel) RED
2. cliReply onSpawn + handleChat register + /cancel endpoint → GREEN
3. `security-reviewer` on /cancel (unauth justification, regex bounds)
4. Client tests (abort, button swap, ⌘.) RED
5. abortRef + stop() + button + shortcut → GREEN
6. `impeccable craft` press animation; `react-reviewer`+`typescript-reviewer`

### Phase 4 — Feature B (Modes) — most complex, last
Skills: `react-specialist`, `typescript-pro`, `impeccable craft`, `hallmark audit`, `a11y-architect`, `security-review`
1. Server tests (config endpoints, engineDispatch isolation) RED
2. runtimePermMode + config endpoints + 563/578 swap → GREEN
3. `security-reviewer`: confirm engineDispatch never inherits; bypass behind confirm + auth
4. ModesPicker tests RED
5. Build ModesPicker + wire ChatPane + PLAN prefix → GREEN
6. `impeccable craft` (AUTO looks dangerous), `hallmark audit` (no template look), `a11y-architect` (keyboard/aria)

### Phase 5 — Verify + commit
Skills: `sp-verification-before-completion`, `sp-finishing-a-development-branch`, `sp-requesting-code-review`, `kw-engineering-deploy-checklist`
1. `npm run typecheck` → 0 errors
2. All tests GREEN
3. Manual smoke each feature end-to-end in Electron
4. `security-review` full diff
5. Conventional commit on `feat/cockpit-ux-enhancements`
6. Push — **requires explicit user authorization for main**

---

## 9. SECURITY CONSTRAINTS (non-negotiable, verified)

1. **`/cancel` unauthenticated** — justified: matches `/chat` (also open, not in needsAuth 1256); kills only a child the caller started; agentId regex-bounded `[a-z0-9_-]{1,64}`. If `/chat` gains auth, `/cancel` must too.
2. **`/runtime/config` auth-gated** — `x-runtime-token` + originOk. Mode change affects all tool-enabled spawns.
3. **`DELETE /thread` auth-gated** — already in needsAuth (1256). UI sends token.
4. **`bypassPermissions` requires UI confirm** — explicit prose dialog, no silent escalation.
5. **engineDispatch NEVER inherits `runtimePermMode`** — autonomous path stays literal `acceptEdits`. A UI flip to AUTO must not unleash the background engine.
6. **childEnv secret strip unchanged** — `_KEY|_SECRET|_TOKEN|_TOKEN_DIR|PASSWORD|APIKEY` + `ANTHROPIC_API_KEY` stripped every spawn (636), regardless of mode.
7. **PLAN mode = prompt prefix only** — no flag change; agent instructed via message prefix.
8. **No secrets in argv** — modes/tokens passed as headers/body, never shell args.

---

## 10. DEFINITION OF DONE

Per feature:
- [ ] Tests written BEFORE impl (TDD)
- [ ] All tests GREEN
- [ ] `tsc --noEmit` 0 errors
- [ ] `security-reviewer` on changed server files → no CRITICAL/HIGH
- [ ] `react-reviewer` → no CRITICAL/HIGH
- [ ] `impeccable craft` → intentional, not default-template UI
- [ ] Manual end-to-end in running Electron app
- [ ] `sp-verification-before-completion` fired

Full set:
- [ ] 4 features individually done
- [ ] `hallmark audit` full UI → no AI-default look
- [ ] `kw-engineering-deploy-checklist` cleared
- [ ] `security-review` full diff cleared
- [ ] PR via `/commit-push-pr`

---

## 11. EFFORT (v2 — IPC removed, Feature C server pre-built)

| Feature | Server | UI | Tests | Total |
|---------|--------|-----|-------|-------|
| D: Context HUD | 0 | 10m | 10m | ~20m |
| C: New Session | 0 (done) | 20m | 15m | ~35m |
| A: Stop | 35m | 30m | 30m | ~1.5h |
| B: Modes | 45m | 60m | 45m | ~2.5h |
| **Total** | | | | **~5h** |

(v1 estimated ~7h — IPC removal + pre-built `DELETE /thread` cut ~2h.)

---

*v2 created: 2026-06-26 — verified against server.mjs, ChatPane.tsx, runtimeBase.ts, main.cjs*
*Branch: `feat/cockpit-ux-enhancements`*
*Next: `sp-executing-plans` → Phase 1 (Feature D)*

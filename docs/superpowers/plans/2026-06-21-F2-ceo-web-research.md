# F2 — CEO live web research (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`). Every code step is RED→GREEN→commit (superpowers:test-driven-development).

**Goal:** Grant `WebSearch` + `WebFetch` to the boss/CEO thread ONLY at `claude` spawn, so the CEO does live web research — no other agent gets web egress.

**Architecture:** Add a pure, unit-testable helper `webToolArgs(agentId)` in `agent-runtime/agent-tools.mjs` (returns the `--allowed-tools` args for boss/ceo, `[]` otherwise). `cliReply` in `server.mjs` appends it UNCONDITIONALLY after the `TOOLS`-mode branch and after the `--strict-mcp-config` dedup, so the default `TOOLS="none"` branch cannot strip it. Web tools only fire under `RUNTIME_BACKEND=cli` (the mock path intercepts `boss` and never spawns `claude`).

**Tech Stack:** Node ESM, `node --test`, `claude` CLI (subscription).

## Pre-flight findings (VERIFIED 2026-06-21, empirical)
- **Tool names:** `WebSearch` and `WebFetch` — PascalCase, no prefix. Confirmed by the repo's own `.claude/agents/ceo.md:4` AND a live `claude -p` probe.
- **Headless works:** `claude -p "…" --allowed-tools WebSearch WebFetch` ran non-interactively, **exit 0**, and cited real web sources (`calendardate.com`, `datetoday.net`). No permission hang.
- **`claude` 2.1.140**; `--allowed-tools` takes comma/space-separated names (repeated-flag form `--allowed-tools X --allowed-tools Y` also works — the repo already uses that form). `--strict-mcp-config` scopes MCP servers only; orthogonal to built-in web tools.
- (Note: the mandated `claude-code-guide` agent aborted twice on its own context limit (`Prompt is too long`); substituted a definitive LOCAL empirical probe — strictly stronger evidence than docs lookup.)

## Verified anchors
- `const TOOLS = process.env.RUNTIME_TOOLS || "none"` — `server.mjs:111`
- `READ_TOOLS` `:118`, `WRITE_TOOLS` `:119`
- `cliReply(...)` `:480`; TOOLS-mode branch `:515-536`; attachments `:540-548`; MCP block `:550-565`; **`--strict-mcp-config` dedup `:571`** (append point is right AFTER this); child env strip + spawn `:574-582`.
- Backend dispatch: `if (BACKEND === "cli") { … cliReply(); return }` `:674-690`; mock path `mockReply` `:699`; `mockReply` intercepts `boss` `:374`.

---

## File Structure
- **Modify:** `agent-runtime/agent-tools.mjs` — add `WEB_RESEARCH_AGENTS` + pure `webToolArgs()`.
- **Modify:** `agent-runtime/server.mjs` — import `webToolArgs`; append after `:571`.
- **Create:** `agent-runtime/test/web-tools.test.mjs` — scope + content tests.

---

## Task 1: Pure `webToolArgs` helper (RED→GREEN)

**Files:**
- Modify: `agent-runtime/agent-tools.mjs`
- Test: `agent-runtime/test/web-tools.test.mjs`

**Contract:** `webToolArgs(agentId)` → `string[]`.
- `agentId ∈ {"boss","ceo"}` → `["--allowed-tools","WebSearch","--allowed-tools","WebFetch"]`.
- Any other id (built-in like `architect`, factory id, empty, undefined) → `[]`.
- Pure, no I/O.

- [ ] **Step 1: Write the failing test**

```javascript
// agent-runtime/test/web-tools.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { webToolArgs, WEB_RESEARCH_AGENTS } from "../agent-tools.mjs";

const EXPECTED = ["--allowed-tools", "WebSearch", "--allowed-tools", "WebFetch"];

test("boss + ceo get WebSearch and WebFetch appended", () => {
  assert.deepEqual(webToolArgs("boss"), EXPECTED);
  assert.deepEqual(webToolArgs("ceo"), EXPECTED);
});

test("scope-leak guard: no other agent gets web tools", () => {
  for (const id of ["architect", "senior-web-1", "qa", "factory-abc123", "", undefined, "BOSS", "Ceo"]) {
    assert.deepEqual(webToolArgs(id), [], `web tools must NOT leak to ${String(id)}`);
  }
});

test("WEB_RESEARCH_AGENTS is exactly {boss, ceo}", () => {
  assert.deepEqual([...WEB_RESEARCH_AGENTS].sort(), ["boss", "ceo"]);
});

test("returned array is a fresh copy (no shared mutable state)", () => {
  const a = webToolArgs("boss");
  a.push("X");
  assert.deepEqual(webToolArgs("boss"), EXPECTED); // not mutated by caller
});
```

- [ ] **Step 2: Run → FAIL**

Run: `cd agent-runtime && node --test test/web-tools.test.mjs`
Expected: FAIL — `webToolArgs` / `WEB_RESEARCH_AGENTS` not exported.

- [ ] **Step 3: Implement (append to `agent-tools.mjs`)**

```javascript
// F2 — agents granted LIVE web research (WebSearch/WebFetch) at `claude` spawn.
// Boss/CEO thread ONLY — no other agentId gets web egress. Case-sensitive match.
export const WEB_RESEARCH_AGENTS = new Set(["boss", "ceo"]);

/**
 * --allowed-tools args granting live web research, for the boss/CEO thread only.
 * Returns a FRESH array each call ([] for every non-web agent) so callers can't
 * mutate shared state. Appended UNCONDITIONALLY in cliReply (after the TOOLS-mode
 * branch) so the default TOOLS="none" branch cannot strip it.
 * @param {string} agentId
 * @returns {string[]}
 */
export function webToolArgs(agentId) {
  if (!WEB_RESEARCH_AGENTS.has(agentId)) return [];
  return ["--allowed-tools", "WebSearch", "--allowed-tools", "WebFetch"];
}
```

- [ ] **Step 4: Run → PASS** (4 tests).

Run: `cd agent-runtime && node --test test/web-tools.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha
git add agent-runtime/agent-tools.mjs agent-runtime/test/web-tools.test.mjs
git commit -m "feat(runtime): webToolArgs — grant WebSearch/WebFetch to boss/CEO only (F2)"
```

---

## Task 2: Wire `webToolArgs` into `cliReply` (append after the mode branch)

**Files:**
- Modify: `agent-runtime/server.mjs` (import near `:91`; append after `:571`)

- [ ] **Step 1: Import the helper**

Change the existing import at `server.mjs:91`:
```javascript
import { allowedToolsForAgent } from "./agent-tools.mjs";
```
to:
```javascript
import { allowedToolsForAgent, webToolArgs } from "./agent-tools.mjs";
```

- [ ] **Step 2: Append the web tools AFTER the strict-mcp dedup (`:571`), BEFORE the child-env block (`:574`)**

Insert immediately after the line:
```javascript
  if (needStrictMcp && !args.includes("--strict-mcp-config")) args.push("--strict-mcp-config");
```
this block:
```javascript

  // F2 — boss/CEO live web research. Unconditional append AFTER the TOOLS-mode branch
  // (and after strict-mcp dedup) so the default "none" branch can't strip it. Built-in
  // web tools are orthogonal to --strict-mcp-config (which only scopes MCP servers).
  // Granted to the boss/CEO thread ONLY — webToolArgs() returns [] for every other id.
  args.push(...webToolArgs(agentId));
```

- [ ] **Step 3: Verify the diff is minimal (import + one append block only)**

Run: `cd agent-runtime && git diff server.mjs | grep '^[-+]' | grep -v '^[-+][-+]'`
Expected: ONLY the import line change and the inserted append block (5 lines incl. comment). No TOOLS-branch edit, no spawn edit.

- [ ] **Step 4: Full suite green**

Run: `cd agent-runtime && npm test`
Expected: 263 (F1 baseline) + 4 (Task 1) = **267 pass**, 0 fail.

- [ ] **Step 5: Typecheck (cockpit unaffected, but the spec requires it)**

Run: `cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha
git add agent-runtime/server.mjs
git commit -m "feat(runtime): append WebSearch/WebFetch for boss/CEO in cliReply (F2)"
```

---

## Task 3: Live check under `RUNTIME_BACKEND=cli` (manual, real `claude`)

> Web tools NEVER fire under mock — `mockReply` intercepts `boss` (`:374`). MUST use `RUNTIME_BACKEND=cli`. Requires `claude` on PATH + subscription login (both present on this host).

- [ ] **Step 1: Boot the runtime with the cli backend**

```bash
cd /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha/agent-runtime
RUNTIME_BACKEND=cli RUNTIME_TOKEN=f2livecheck0000000000000 RUNTIME_PORT=3056 node server.mjs > /tmp/ma-f2.log 2>&1 &
sleep 2
curl -s -H "x-runtime-token: f2livecheck0000000000000" http://127.0.0.1:3056/runtime/health
```
Expected: `{"ok":true,"backend":"cli",...}`.

- [ ] **Step 2: Send a boss/CEO turn that requires current web info**

```bash
curl -sN -X POST -H "x-runtime-token: f2livecheck0000000000000" -H "Content-Type: application/json" \
  -d '{"message":"Using web research, what is the current latest stable Node.js LTS major version? Cite the source URL."}' \
  http://127.0.0.1:3056/runtime/boss/chat | tail -40
```
Expected: reply text references a real, current source (a URL / nodejs.org / a version number it could only know via WebSearch/WebFetch).

- [ ] **Step 3: Confirm scope — a non-CEO agent does NOT get web tools (static proof)**

The pure-helper test already proves `webToolArgs("architect") === []`. Additionally confirm no leak in the live process logs:
```bash
grep -c "WebSearch" /tmp/ma-f2.log || true   # boss turn may log the flag; that's expected for boss only
```

- [ ] **Step 4: Tear down**

```bash
pkill -f "RUNTIME_PORT=3056"; lsof -ti:3056 | xargs kill -9 2>/dev/null; true
```

---

## Security review (MANDATORY — BLOCKING before final F2 claim)

Dispatch `security-reviewer` on the diff + egress surface. Confirm:
1. **Scope:** `webToolArgs` returns `[]` for every non-{boss,ceo} id (case-sensitive) — no scope leak. The append is the ONLY new tool grant.
2. **Egress reachable now from the CEO turn** — but child env is already secret-stripped (`server.mjs:574-580` drops `*_KEY/_SECRET/_TOKEN/PASSWORD/APIKEY` + `ANTHROPIC_API_KEY`); the runtime's own token is redacted on egress (`:317`); CEO chat mode is `TOOLS="none"` → NO Write/Edit/Bash → the model can read the web but cannot read repo secrets or write/exfil files. Confirm there is no read+web combo enabling exfiltration.
3. `--strict-mcp-config` + existing per-agent MCP/tool scoping intact — the append did not alter the MCP block or the TOOLS branch.
4. Mark **smoke-test finding #1 resolved** in `docs/superpowers/smoke-test-billsplitter.md` (CEO was memory-only; now does live web).

---

## Exit Gate (F2)
- [ ] boss/CEO spawn args include `WebSearch` + `WebFetch` — Task 1 tests + Task 2 wiring.
- [ ] A live `RUNTIME_BACKEND=cli` CEO reply cites a real web source — Task 3.
- [ ] No other agent gets web tools — scope-leak test (Task 1) + security item 1.
- [ ] Security review clean (no CRITICAL/HIGH) — egress section.
- [ ] Suite green: `cd agent-runtime && npm test` → **267 pass**, 0 fail; `npm run typecheck` exit 0.
- [ ] Commits per GREEN; not pushed.

## Self-Review (against F2 spec §72-95)
- "Grant WebSearch/WebFetch to boss/CEO at spawn" → Task 1+2. ✔
- "Boss MOCKED → live work under RUNTIME_BACKEND=cli" → Task 3 explicit. ✔
- "Append OUTSIDE/AFTER the TOOLS=none branch" → Task 2 Step 2 (after `:571`, unconditional). ✔
- "Keep --strict-mcp-config + scoping" → untouched; security item 3. ✔
- "Confirm exact tool names + headless" → Pre-flight findings (empirical). ✔
- "Test: boss has them, non-CEO does not" → Task 1 scope-leak test. ✔
- "security-reviewer egress + mark smoke finding #1 resolved" → Security section item 4. ✔
- Placeholder scan: none. Type consistency: `webToolArgs`/`WEB_RESEARCH_AGENTS` consistent across tasks. ✔

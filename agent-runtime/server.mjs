// Track B / Chat Fork — Agent Runtime service (Phase 1: streaming chat, NO tools).
//
// SEPARATE process from the MissionAlpha watcher (preserves the decoupled-watcher
// principle — the dashboard is a thin streaming client over /runtime, proxied by
// vite to this port). Each agent gets its own conversation thread + Claude session.
//
// SECURITY (Phase 1): chat-only. NO filesystem, NO command exec, NO tools. F2
// (fs/repo tools + sandbox + permission broker) is a SEPARATE later phase, gated.
//
// Dual mode:
//   • ANTHROPIC_API_KEY set  → real streaming via @anthropic-ai/sdk.
//   • no key                 → live caveman MOCK stream (proves the UX; flips to
//                              real Claude the moment a key is exported).
//
// CAVEMAN MANDATE: every agent replies in /caveman full (per .claude/agents/PROTOCOL.md).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.RUNTIME_PORT || 3005);
const MODEL = process.env.RUNTIME_MODEL || "claude-sonnet-4-6";

// ── Model tiers (ADR-022) — STRICT closed allowlist ─────────────────────────
// User code names a TIER KEY, never a model id. The id that reaches spawn/SDK is
// read out of this frozen map BY KEY. Unknown key → 400, no spawn. Raw user input
// NEVER becomes an argv token (defense-in-depth on top of the argv-array spawn).
const MODEL_TIERS = Object.freeze({
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
});
const DEFAULT_TIER = "sonnet";
const TIER_KEYS = Object.keys(MODEL_TIERS);
// Resolve a tier key → fixed model id. hasOwnProperty (not `in`) so prototype keys
// (toString/constructor) can't resolve as valid. Returns {error} on unknown tier.
function resolveTier(raw) {
  // strict-typing: only a string, null, or undefined is acceptable. Reject
  // numbers/arrays/objects outright (no coercion surprises) — sr-security LOW.
  if (raw != null && typeof raw !== "string") return { error: "unknown model tier", valid: TIER_KEYS };
  const tier = raw == null || raw === "" ? DEFAULT_TIER : raw;
  if (!Object.prototype.hasOwnProperty.call(MODEL_TIERS, tier)) {
    return { error: "unknown model tier", valid: TIER_KEYS };
  }
  return { tier, modelId: MODEL_TIERS[tier] };
}
const MAX_TOKENS = Number(process.env.RUNTIME_MAX_TOKENS || 1024);
const KEY = process.env.ANTHROPIC_API_KEY || "";
// Backend: "api" (Anthropic key, costs credits) · "cli" (local `claude` CLI =
// your Claude Code SUBSCRIPTION, no key/credits) · "mock" (no LLM). Auto: key→api,
// else→cli (subscription). Override with RUNTIME_BACKEND.
const BACKEND = process.env.RUNTIME_BACKEND || (KEY ? "api" : "cli");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

// F2 — agent tools (cli backend only). "none" = chat-only (Phase 1). "read" =
// READ-ONLY repo access (Read/Glob/Grep, no write/exec) — the safe F2a slice.
// "write" = Read+Write+Edit (F2b, edits land in a per-agent SANDBOX worktree, never
// the live repo) — gated/opt-in. Bash stays OFF in all modes for now.
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { cp, readdir, readFile, writeFile, mkdir, stat, lstat, realpath } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
// Agent Factory — registry, agent-creator, credential broker, posting (own module).
import * as factory from "./factory.mjs";
// F2b apply-broker guards — moved VERBATIM to guards.mjs so the engine (ADR-024)
// + policy (ADR-029) reuse the SAME predicates without booting the HTTP server.
// Logic unchanged; server behavior byte-for-byte identical.
import { REPO_ROOT, SEED_DIRS, SEED_FILES, APPLY_DENY, CONFIG_GUARD, applyAllowed, configGuardViolation } from "./guards.mjs";
// F2b broker (walk/listChanges/applyChanges) — moved verbatim to broker.mjs, shared
// with the engine. Wired below with workdirFor=sandboxDir (copy-sandbox, manual path).
import { createBroker } from "./broker.mjs";
// S1 Autonomous Loop Engine (ADRs 024–029) — auto-chain, parallel dispatch, git
// worktree isolation, durable task queue, retry/self-heal, auto-apply policy.
import { createQueue } from "./queue.mjs";
import { createPolicy } from "./policy.mjs";
import { createWorktreeMgr, isGitRepo } from "./worktree.mjs";
import { createScheduler } from "./scheduler.mjs";
import { createEngine } from "./engine.mjs";
import { escalationArgs } from "./self-heal.mjs";
// ADR-030 usage math (pure; token/context only, never $).
import { usageFromResult as usageFromResultPure, estimateUsage as estimateUsagePure, rollupUsage as rollupUsagePure } from "./usage.mjs";
// ADR-032/033 MCP connector registry (reuses factory.mjs AES broker for cred values).
import { createMcpRegistry } from "./mcp-registry.mjs";
import { createSecretScrubber, once } from "./secret-scrub.mjs";
// ADR-037/038 full tool loop — real OS sandbox + mediated command broker.
import { createSandbox } from "./sandbox.mjs";
import { createToolBroker, classify } from "./tool-broker.mjs";
// ADR-050 G5 — derive --allowed-tools from factory agent's spec at spawn frame.
import { allowedToolsForAgent, webToolArgs } from "./agent-tools.mjs";
import { computeMaxInflight } from "./concurrency.mjs";
// ADR-050 A1+A2 — capability index + gap detector for /runtime/factory/detect-gaps (B3).
import { capabilityIndex } from "./capabilities.mjs";
import { detectGaps } from "./gap-detector.mjs";
import { resolveAgents } from "./router.mjs"; // Phase 4 (#7) dynamic team routing
// ADR-050 B1 — system-prompt builder (extracted to avoid server startup in unit tests).
import { buildSystemFor, CAVEMAN_SYSTEM, CEO_BOSS_SYSTEM, TOOL_NOTE } from "./system-prompt.mjs";
// F4.1 — cockpit data feeds (no token required; loopback-gated by hostOk above).
import { stateHandler, commandHandler, auditHandler, commandStatusHandler, sessionsHandler } from "./cockpit-feeds.mjs";
// ADR-049 multimodal chat attachments — file intake for /chat (images/pdf/csv/txt).
import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import {
  MAX_FILES, MAX_FILE_BYTES, extAllowed, kindFor, sniffOk,
  safeName, displayName, uploadMsgDir, ensureUploadDir, buildManifest,
  sweepStaleUploads, xlsxToCsv,
} from "./uploads.mjs";
// Quota guard — self-throttle (pre-gate) + 429 backoff around every `claude` spawn,
// so a runaway swarm can't lock the BOSS out of his Claude subscription. File-based.
import { guardedSpawn, logCall as quotaLog, countInWindow as quotaCount, quotaStatus, is429 as isRateLimited, QuotaExceeded, MA_QUOTA_MAX, MA_QUOTA_WINDOW_MS } from "./quota-guard.mjs";
const __dir = dirname(fileURLToPath(import.meta.url));
// F4.1 — state file for the cockpit feeds (operator sets WAAHYU_STATE_PATH or drops a
// state.json in <userData>/agent-status; absent → 503 → cockpit shows "connecting…" gracefully).
const COCKPIT_STATE_PATH = process.env.WAAHYU_STATE_PATH || join(__dir, "..", "agent-status", "state.json");
// Pre-build the 5 handlers once at module scope (pure factories, statePath is closed over).
const _stateH = stateHandler(COCKPIT_STATE_PATH);
const _commandH = commandHandler(COCKPIT_STATE_PATH);
const _auditH = auditHandler(COCKPIT_STATE_PATH);
const _commandStatusH = commandStatusHandler(COCKPIT_STATE_PATH);
const _sessionsH = sessionsHandler(COCKPIT_STATE_PATH);
const TOOLS = process.env.RUNTIME_TOOLS || "none";
// SANDBOX OUTSIDE the repo (sr-security: must not be inside REPO_ROOT). Each agent
// edits an isolated COPY here; nothing reaches the live repo until the operator
// confirms via the permission broker (/apply). NOTE (ADR-026): when git worktree
// isolation is active, seedSandbox() backs this with a per-task worktree instead.
const SANDBOX_ROOT = process.env.RUNTIME_SANDBOX_ROOT || join(tmpdir(), "missionalpha-sandboxes");

const READ_TOOLS = ["Read", "Glob", "Grep"];
const WRITE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit"];

// Auth token — the mutating/sensitive endpoints (/apply, /changes) require this
// shared secret so ONLY the dashboard (which fetches it same-origin via vite) can
// call them — not a random local process / browser tab (DNS-rebinding). Minted on
// startup, written to a file vite reads. Override with RUNTIME_TOKEN.
const RUNTIME_TOKEN = process.env.RUNTIME_TOKEN || randomBytes(24).toString("hex");
// Token file lives OUTSIDE the repo (sr-security #5: a read-mode agent runs with
// cwd=REPO_ROOT, so an in-repo token would be readable → self-authorize /apply).
// tmpdir is never in any agent's read scope. vite reads from the same fixed path.
const TOKEN_DIR = process.env.RUNTIME_TOKEN_DIR || join(tmpdir(), "missionalpha-runtime");
const TOKEN_FILE = join(TOKEN_DIR, ".runtime-token");
// MCP scoped-config dir (ADR-032/033) — OUTSIDE every agent worktree/--add-dir, so an
// agent's Read tool cannot reach its own injected connector creds.
const MCP_CONFIG_DIR = join(TOKEN_DIR, "mcp");
try {
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, RUNTIME_TOKEN, { mode: 0o600 });
} catch {
  /* non-fatal */
}
// F5 — the sandbox/token/worktree roots MUST stay OUTSIDE REPO_ROOT (a read-mode
// agent runs with cwd=REPO_ROOT; an in-root token/sandbox would be self-readable →
// self-authorize /apply). Default tmpdir roots already satisfy this; assert it for
// ANY configured root + any operator-set RUNTIME_*_ROOT. Fail closed.
{
  const rootPfx = resolve(REPO_ROOT) + sep;
  const outside = (p, name) => {
    if (resolve(p).startsWith(rootPfx)) throw new Error(`${name} must be OUTSIDE RUNTIME_REPO_ROOT: ${p}`);
  };
  outside(SANDBOX_ROOT, "RUNTIME_SANDBOX_ROOT");
  outside(TOKEN_DIR, "RUNTIME_TOKEN_DIR");
  outside(process.env.RUNTIME_WORKTREE_ROOT || join(tmpdir(), "missionalpha-worktrees"), "RUNTIME_WORKTREE_ROOT");
  if (process.env.RUNTIME_EXEC_WT_ROOT) outside(process.env.RUNTIME_EXEC_WT_ROOT, "RUNTIME_EXEC_WT_ROOT");
  // Only assert these when the operator OVERRODE them — their defaults live under
  // agent-runtime/ (inside the default root) and hold queue/thread state, not the
  // token; a custom path nested in a configured REPO_ROOT would be agent-readable.
  if (process.env.RUNTIME_ENGINE_STORE) outside(process.env.RUNTIME_ENGINE_STORE, "RUNTIME_ENGINE_STORE");
  if (process.env.RUNTIME_THREADS_DIR) outside(process.env.RUNTIME_THREADS_DIR, "RUNTIME_THREADS_DIR");
}
// Constant-time token compare.
function tokenOk(req) {
  const got = req.headers["x-runtime-token"];
  if (typeof got !== "string" || got.length !== RUNTIME_TOKEN.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(RUNTIME_TOKEN));
  } catch {
    return false;
  }
}
// Reject cross-origin browser callers (DNS-rebinding): if an Origin header is
// present it MUST be our dashboard origin. Non-browser callers (no Origin) pass
// this check but still need the token.
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}
// Host-header allowlist — the canonical anti-DNS-rebinding control (sr-security #4).
// A rebound page still sends its real Host (evil.com); drop anything not loopback.
function hostOk(req) {
  const h = req.headers.host || "";
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h);
}

// Concurrency cap on spawned `claude` children — bounds cost/quota abuse + local
// fork-bomb (sr-security #6). Excess /chat requests get 429.
// CPU-derived default; RUNTIME_MAX_INFLIGHT still overrides (F1). All inflight gate
// sites below read this single const — only its value source changed.
const MAX_INFLIGHT = computeMaxInflight({ env: process.env, cpuCount: cpus().length });
let inflight = 0;

// Per-agent conversation history. In-memory Map, backed by disk (ADR-023 §3B) so
// history survives a runtime restart. Each thread → agent-runtime/threads/<id>.json
// (gitignored). Loaded on startup, persisted after every completed turn.
/** @type {Map<string, Array<{role:string, content:string}>>} */
const threads = new Map();
// Per-thread USAGE rollup (ADR-030 — tokens + context%, NEVER $). id → rollup.
const threadUsage = new Map();
const THREADS_DIR = process.env.RUNTIME_THREADS_DIR || join(__dir, "threads");
const THREAD_KEEP = Number(process.env.RUNTIME_THREAD_KEEP || 40); // last-N messages
const THREAD_MAX_BYTES = 256 * 1024; // per-file cap (bound disk + replay cost)
// Context window denominator for the usage % bar (ADR-030). The CLI reports consumed
// tokens but NOT the window, so this is a documented constant (all current Claude tiers
// share ~200k). Env-overridable; becomes a per-tier map only if a window diverges.
const CONTEXT_WINDOW = Number(process.env.RUNTIME_CONTEXT_WINDOW || 200000);
const threadSafeId = (id) => String(id).replace(/[^a-z0-9_-]/gi, "_").slice(0, 64);
const threadFile = (id) => join(THREADS_DIR, `${threadSafeId(id)}.json`);

// ── Usage (ADR-030) — pure math in usage.mjs (token/context ONLY, never $). ───
// Thin wrappers bind the CONTEXT_WINDOW const + the per-thread rollup Map.
const turnFromResult = (u, tier) => usageFromResultPure(u, tier || DEFAULT_TIER, CONTEXT_WINDOW);
const turnEstimate = (pc, rc, tier) => estimateUsagePure(pc, rc, tier || DEFAULT_TIER, CONTEXT_WINDOW);
function rollupThreadUsage(id, turn) {
  const next = rollupUsagePure(threadUsage.get(id), turn);
  threadUsage.set(id, next);
  return next;
}

// Low-level atomic-ish thread record write (messages + tier + usage rollup).
function writeThreadRecord(id, messages, tier, usage) {
  let msgs = messages.slice(-THREAD_KEEP);
  let rec = JSON.stringify({ id, tier: tier || DEFAULT_TIER, messages: msgs, usage: usage || null, updatedAt: new Date().toISOString() });
  if (Buffer.byteLength(rec) > THREAD_MAX_BYTES) {
    msgs = messages.slice(-Math.floor(THREAD_KEEP / 2)); // shed more under the byte cap
    rec = JSON.stringify({ id, tier: tier || DEFAULT_TIER, messages: msgs, usage: usage || null, updatedAt: new Date().toISOString() });
  }
  try { writeFileSync(threadFile(id), rec, { mode: 0o600 }); } catch { /* non-fatal */ }
}

// Hydrate all persisted threads (+ usage rollups) into memory at startup.
function loadThreads() {
  try {
    mkdirSync(THREADS_DIR, { recursive: true });
    for (const name of readdirSync(THREADS_DIR)) {
      if (!name.endsWith(".json")) continue;
      try {
        const obj = JSON.parse(readFileSync(join(THREADS_DIR, name), "utf-8"));
        if (obj && obj.id && Array.isArray(obj.messages)) {
          threads.set(obj.id, obj.messages.slice(-THREAD_KEEP));
          if (obj.usage) threadUsage.set(obj.id, obj.usage);
        }
      } catch {
        /* skip a corrupt thread file */
      }
    }
  } catch {
    /* threads dir unavailable — fall back to in-memory only */
  }
}
// Persist one thread (messages + current usage rollup). Fire-and-forget.
function persistThread(id, hist, tier) {
  writeThreadRecord(id, hist, tier, threadUsage.get(id) || null);
}

// ── Thread fork/resume helpers (ADR-031) — "session" = a chat thread. ─────────
// List persisted threads from disk (source of truth; current after every turn).
function listThreads() {
  const out = [];
  let names = [];
  try { names = readdirSync(THREADS_DIR); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const o = JSON.parse(readFileSync(join(THREADS_DIR, name), "utf-8"));
      if (o && o.id && Array.isArray(o.messages)) {
        out.push({ id: o.id, tier: o.tier || DEFAULT_TIER, messageCount: o.messages.length, updatedAt: o.updatedAt || null, usage: o.usage || null });
      }
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}
// Full record for resume hydration (scrubbed message bodies). null if missing.
function getThreadRecord(id) {
  try {
    const o = JSON.parse(readFileSync(threadFile(id), "utf-8"));
    if (!o || !Array.isArray(o.messages)) return null;
    return {
      id: o.id, tier: o.tier || DEFAULT_TIER, usage: o.usage || null,
      messages: o.messages.map((m) => ({ role: m.role, content: scrub(String(m.content || "")) })),
    };
  } catch { return null; }
}
// Fork a thread into a NEW server-minted id (optionally truncated to `upTo` msgs).
// The new thread starts a fresh usage meter (it's a new branch). Returns {id} or null.
function forkThread(id, upTo) {
  const src = getThreadRecord(id);
  if (!src) return null;
  let msgs = src.messages;
  if (Number.isInteger(upTo) && upTo >= 0 && upTo <= msgs.length) msgs = msgs.slice(0, upTo);
  const newId = `${threadSafeId(id)}__fork_${randomBytes(4).toString("hex")}`;
  threads.set(newId, msgs.slice(-THREAD_KEEP));
  threadUsage.delete(newId); // fresh meter for the branch
  writeThreadRecord(newId, msgs, src.tier, null);
  return { id: newId };
}
// Delete a thread (lets the operator clean up forks). Returns true if removed.
function deleteThread(id) {
  threads.delete(id);
  threadUsage.delete(id);
  try { rmSync(threadFile(id), { force: true }); return true; } catch { return false; }
}

// systemFor — thin wrapper over buildSystemFor that captures the module-level TOOLS mode.
// buildSystemFor, CAVEMAN_SYSTEM, CEO_BOSS_SYSTEM, TOOL_NOTE are all imported from system-prompt.mjs.
const systemFor = (id) => buildSystemFor(id, TOOLS);

// Lazy SDK load (only if key present + installed).
let Anthropic = null;
async function getClient() {
  if (!KEY) return null;
  if (!Anthropic) {
    try {
      ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
    } catch {
      return null; // sdk not installed → fall back to mock
    }
  }
  return new Anthropic({ apiKey: KEY });
}

// Egress scrub — last-line defense: never stream secret-shaped strings to the
// client, even if a tool read one or the model echoed it. Defense-in-depth on top
// of the .claude/settings.json Read denylist.
const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
// MCP connector secret values, registered per-spawn (ADR-033) so even an arbitrary
// (non-secret-shaped) cred value is redacted from SSE if a tool result echoes it.
// Ref-counted across concurrent spawns (createSecretScrubber); each spawn's cleanup is
// once()-guarded so the error+close double-fire can't over-decrement a sibling's cred.
const mcpScrubber = createSecretScrubber();
const addSpawnSecrets = (list) => mcpScrubber.add(list);
const removeSpawnSecrets = (list) => mcpScrubber.remove(list);
const scrub = (t) => {
  if (typeof t !== "string") return t;
  let out = t.replace(SECRET_RE, "[redacted-secret]");
  out = factory.scrubExt(out); // extended shapes: bearer/oauth/access_token/JWT/google/meta/slack
  if (RUNTIME_TOKEN) out = out.split(RUNTIME_TOKEN).join("[redacted-token]"); // never egress our own token
  out = mcpScrubber.scrub(out); // ADR-033 — live per-spawn MCP cred values
  return out;
};

// MCP connector registry (ADR-032/033) — cred VALUES resolved from the factory AES
// broker ONLY at spawn frame (composeConfig / collectSecretValues). Default-deny grants.
const mcpRegistry = createMcpRegistry({
  dir: process.env.RUNTIME_MCP_DIR || join(__dir, "engine-store", "mcp"),
  getCredValue: factory.getCredValue,
  credExists: factory.credExists,
  seedDefaults: process.env.RUNTIME_SEED_DEFAULTS !== "0", // pre-seed Playwright connector (default-deny until granted); off for deterministic tests
});

// ── Full tool loop (ADR-037/038/039) — exec jailed in a Docker sandbox ──────────
// Per-agent exec worktree (git-state isolation, bind-mounted /work); execution is
// jailed by the container, NOT the worktree. Approvals are per-call (once/session/deny).
const execWorktrees = createWorktreeMgr({ repoRoot: REPO_ROOT, worktreeRoot: process.env.RUNTIME_EXEC_WT_ROOT });
const sandbox = createSandbox();
const execWorktreeFor = (agentId) => { try { return execWorktrees.create(agentId).path; } catch { return null; } };
const toolBroker = createToolBroker({ sandbox, worktreeFor: execWorktreeFor, audit: factory.audit, isFactoryAgent: factory.isFactoryAgent });
const pendingExec = new Map();        // callId → {agentId, command, network, klass, createdAt}
const sessionGrants = new Map();       // agentId → Set(normalized command) approved for the session
const normCmd = (c) => String(c).trim().replace(/\s+/g, " ");
let execSeq = 0;
const newCallId = () => `exec_${(execSeq++).toString(36)}_${randomBytes(4).toString("hex")}`;

// JSON responder for factory routes.
function ok2(res, obj, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  return {
    token: (t) => res.write(`event: token\ndata: ${JSON.stringify(scrub(t))}\n\n`),
    meta: (m) => res.write(`event: meta\ndata: ${JSON.stringify(m)}\n\n`),
    // ADR-030 — usage event: token/context numerics ONLY, never $.
    usage: (u) => res.write(`event: usage\ndata: ${JSON.stringify(u)}\n\n`),
    done: () => {
      res.write(`event: done\ndata: "[DONE]"\n\n`);
      res.end();
    },
    error: (e) => {
      res.write(`event: error\ndata: ${JSON.stringify(String(e))}\n\n`);
      res.end();
    },
  };
}

// Mock streamer — deterministic, word-by-word, when no real Claude.
function mockReply(agentId, msg) {
  if (agentId === "boss") return mockCeoReply(msg);
  const m = msg.toLowerCase();
  let body;
  if (/(hi|hello|hey|status|doing)/.test(m)) {
    body = `${agentId} here. Active. Reading bus. Next step queued. What you need?`;
  } else if (/(build|impl|add|create|fix|write)/.test(m)) {
    body = `Got it. Plan: 1) read peer state. 2) draft change. 3) heartbeat IN_PROGRESS. 4) hand to QA. No tools yet — chat-only. Say go, I detail steps.`;
  } else if (/(block|stuck|wait)/.test(m)) {
    body = `Checked. Blocker = upstream sign-off. Chase root, not proximate. Nudge sent. ETA after review.`;
  } else {
    body = `Heard: "${msg.slice(0, 60)}". ${agentId} parse done. Chat-only mode — no fs/exec. Tell me action, I caveman it back.`;
  }
  return `[mock · no ANTHROPIC_API_KEY] ${body}`;
}

// CEO-voice mock (prose, not caveman) for the BOSS console when no API key.
function mockCeoReply(msg) {
  const m = msg.toLowerCase();
  let body;
  if (/(hi|hello|hey|status|how)/.test(m)) {
    body =
      "BOSS. Swarm is up — 16 agents, board live. First-principles read: we're in good shape on the control plane (Cycle 1) and session history (Cycle 2). What outcome are you after? Give me the goal and I'll bring you 3 options with a recommendation.";
  } else if (/(build|ship|add|feature|want|need|should)/.test(m)) {
    body =
      "Heard. First-principles: scope small, ship reversible (Type-2), measure. Plan — architect drafts the ADR, senior-web-1 builds the UI, senior-qa verifies. I've staged the dispatch below; confirm to fire it to the swarm.\n\n" +
      "```dispatch\n" +
      "task architect draft ADR for this feature\n" +
      "task senior-web-1 build UI per ADR\n" +
      "task senior-qa write E2E + a11y tests\n" +
      "```";
  } else if (/(problem|risk|worried|blocked|fail)/.test(m)) {
    body =
      "Let's pressure-test it. Name the failure mode and I'll give you the pre-mortem + the mitigation. If it's a blocker, I'll chase the root cause agent, not the proximate one. What's the concern?";
  } else {
    body = `On it, BOSS. "${msg.slice(0, 80)}" — let me frame this first-principles and come back with options + a recommendation. Confirm the goal and any hard constraints (budget, time, non-negotiables).`;
  }
  return `[mock · no ANTHROPIC_API_KEY — add credits for real CEO] ${body}`;
}

// ── F2b permission broker ────────────────────────────────────────────────────
// Agent writes to an isolated sandbox COPY (outside repo). Nothing touches the live
// repo until the operator confirms a diff via POST /apply. apply() re-validates
// every path server-side (never trust the agent or client).

const safeId = (id) => id.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64);
const sandboxDir = (id) => join(SANDBOX_ROOT, safeId(id));

// Seed an agent's sandbox with a fresh copy of the seeded scope (once).
async function seedSandbox(agentId) {
  const sb = sandboxDir(agentId);
  if (existsSync(sb)) return sb;
  await mkdir(sb, { recursive: true });
  // dereference:true → symlinks become regular file copies (no link target carried
  // into the sandbox). filter skips any symlink outright. Removes the apply-time
  // symlink-write-through vector at the source.
  const noSymlink = async (src) => {
    try {
      return !(await lstat(src)).isSymbolicLink();
    } catch {
      return true;
    }
  };
  for (const d of SEED_DIRS) {
    const src = join(REPO_ROOT, d);
    if (existsSync(src)) await cp(src, join(sb, d), { recursive: true, dereference: true });
  }
  for (const f of SEED_FILES) {
    const src = join(REPO_ROOT, f);
    if (existsSync(src) && (await noSymlink(src))) await cp(src, join(sb, f), { dereference: true });
  }
  return sb;
}

// walk + listChanges + applyChanges now live in broker.mjs (moved verbatim, logic
// unchanged) so the engine (ADR-024, worktree-backed) reuses the SAME broker. The
// manual /run path keeps its copy-sandbox via workdirFor=sandboxDir below.
const { listChanges, applyChanges } = createBroker({ repoRoot: REPO_ROOT, workdirFor: sandboxDir, scrub });
// F5 — warn loudly if NOTHING is seedable under the configured root (foreign repo
// with a different layout) so an empty sandbox fails loud, not silent.
if (!SEED_DIRS.some((d) => existsSync(join(REPO_ROOT, d)))) {
  console.warn(`[runtime] WARNING: none of SEED_DIRS [${SEED_DIRS.join(", ")}] exist under REPO_ROOT (${REPO_ROOT}). Set RUNTIME_SEED_DIRS to this repo's source dirs, or the agent sandbox will be empty.`);
}

// Report-back — after an operator-confirmed apply, tell the swarm bus the agent's
// task is DONE: a heartbeat (→ kanban/board) + a sync TO BOSS (→ live feed + Boss
// console). Reuses the proven shell writers. Fire-and-forget.
function reportBack(agentId, summary) {
  const HB = join(REPO_ROOT, "scripts", "agent-heartbeat.sh");
  const SYNC = join(REPO_ROOT, "scripts", "agent-sync.sh");
  // Sanitize: strip quotes/newlines/control chars so a crafted file path can't
  // break the BROADCAST/SYNC_LOG markdown the dashboard parses (bus-format injection).
  // (spawn array already prevents SHELL injection — no shell:true.)
  // eslint-disable-next-line no-control-regex
  const clean = (s) => String(s).replace(/[\x00-\x1f"'`|$=]/g, " ").replace(/\s+/g, " ").trim();
  const safeId = String(agentId).replace(/[^a-z0-9_-]/gi, "");
  const sum = clean(summary).slice(0, 140);
  // F5 — a foreign repo has no scripts/agent-*.sh → skip cleanly instead of spawning doomed bash.
  if (existsSync(HB)) { try { spawn("bash", [HB, ...[safeId, "DONE_CYCLE", `task applied: ${sum}`.slice(0, 120), "-", "", "report to BOSS"].map(String)], { stdio: "ignore", cwd: REPO_ROOT }); } catch { /* */ } }
  if (existsSync(SYNC)) { try { spawn("bash", [SYNC, ...[safeId, "BOSS", "task-done", "-", `done: ${sum}`].map(String)], { stdio: "ignore", cwd: REPO_ROOT }); } catch { /* */ } }
}

// CLI backend — drive the local `claude` CLI headless. Uses the Claude Code
// SUBSCRIPTION (logged-in), NOT an API key. Single-shot per turn; we embed the
// system persona + prior thread into the prompt (claude -p is stateless here).
// Streams assistant text deltas out via SSE; ignores hook/system noise.
function cliReply(agentId, system, hist, stream, onDone, modelId, attachments = [], attachDir = null) {
  const transcript = hist
    .map((h) => `${h.role === "user" ? "BOSS" : "YOU"}: ${h.content}`)
    .join("\n\n");
  // ADR-049 — list attached files (by absolute path) so the agent reads them via Read.
  const manifest = buildManifest(attachments);
  const prompt = `${system}\n\n--- conversation so far ---\n${transcript}${manifest}\n\n--- now reply as YOU (one turn) ---`;

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--no-session-persistence",
  ];
  // modelId is ALWAYS a server-resolved allowlisted id (ADR-022) — NEVER the raw
  // request field. Distinct argv token, no shell → cannot flag-inject.
  if (modelId) args.push("--model", modelId);
  // F2 tool scoping. Bash NEVER allowed yet. Unlisted tools are auto-denied in -p.
  // G5 (ADR-050): if this is a factory-minted agent, derive --allowed-tools from the
  // agent's validated spec (Read always; Write+Edit if write-class skill; Bash never).
  // Built-in agents keep the existing global TOOLS mode unchanged.
  let cwd = REPO_ROOT;
  let needStrictMcp = false; // G5: factory agents load NO global MCP — flag, push once below
  const factoryTools = allowedToolsForAgent(agentId); // G5: null for built-ins
  if (factoryTools !== null) {
    // Factory agent — spec-derived tools, cwd = sandbox (Write-class) or repo (Read-only).
    for (const t of factoryTools) args.push("--allowed-tools", t);
    if (factoryTools.includes("Write")) {
      cwd = sandboxDir(agentId); // isolated sandbox for write-capable factory agents
      args.push("--add-dir", cwd, "--permission-mode", "acceptEdits");
    }
    // Factory agents get --strict-mcp-config (load NO global MCP). DEFERRED to after the
    // MCP block + deduped (the MCP block also pushes it when an operator granted a
    // connector) so a granted factory agent never gets a malformed double flag.
    needStrictMcp = true;
  } else if (TOOLS === "read") {
    for (const t of READ_TOOLS) args.push("--allowed-tools", t);
    cwd = REPO_ROOT; // read the live repo (no mutation possible — read tools only)
  } else if (TOOLS === "write") {
    for (const t of WRITE_TOOLS) args.push("--allowed-tools", t);
    cwd = sandboxDir(agentId); // isolated copy OUTSIDE repo (seeded before spawn)
    args.push("--add-dir", cwd); // scope tool access to the sandbox only
    // auto-accept edits — SAFE because the ONLY writable dir is the sandbox copy;
    // the live repo is reached solely via the operator-gated /apply broker.
    args.push("--permission-mode", "acceptEdits");
  }
  // TOOLS === "none" (and no factory override) → no --allowed-tools → chat-only.

  // ── ADR-049 attachments — grant Read SCOPED TO THE UPLOAD DIR ONLY. In chat-only
  // ("none") mode the agent otherwise has no Read tool, so attachments would be
  // unreadable; we enable Read and point cwd at the upload dir (NOT the repo) so the
  // read scope is exactly the uploaded files. In read/write modes Read is already on;
  // we just widen --add-dir to include the upload dir.
  if (attachments.length && attachDir) {
    if (TOOLS === "none") {
      args.push("--allowed-tools", "Read");
      cwd = attachDir; // confine Read to the uploads, never REPO_ROOT
    }
    args.push("--add-dir", attachDir);
  }

  // ── MCP connectors (ADR-032/033) — inject this agent's GRANTED + ENABLED servers.
  // --strict-mcp-config makes claude load ONLY these (host/global .mcp.json ignored) =
  // the claude-layer half of the per-agent allowlist. Scoped config is 0o600 OUTSIDE
  // the worktree (agent Read can't reach it) and deleted after spawn. Cred values are
  // decrypted from the AES broker here, at the spawn frame, and registered for egress scrub.
  let mcpCleanup = () => {};
  try {
    const composed = mcpRegistry.composeConfig(agentId);
    if (composed) {
      mkdirSync(MCP_CONFIG_DIR, { recursive: true });
      const cfgPath = join(MCP_CONFIG_DIR, `${safeId(agentId)}-${randomBytes(6).toString("hex")}.json`);
      writeFileSync(cfgPath, JSON.stringify({ mcpServers: composed.mcpServers }), { mode: 0o600 });
      args.push("--mcp-config", cfgPath, "--strict-mcp-config");
      for (const t of composed.allowedTools) args.push("--allowed-tools", t);
      const secrets = mcpRegistry.collectSecretValues(agentId);
      addSpawnSecrets(secrets);
      // once() — Node may fire BOTH 'error' and 'close' on a spawn failure; this must
      // decrement the refcount EXACTLY once, or a concurrent spawn's shared cred could
      // drop from the scrub set while it's still streaming (ADR-033 leak — sr-review HIGH).
      mcpCleanup = once(() => {
        removeSpawnSecrets(secrets);
        try { rmSync(cfgPath, { force: true }); } catch { /* */ }
      });
    }
  } catch {
    /* MCP is optional — never block a turn on connector composition */
  }
  // G5 — single --strict-mcp-config for a factory agent: push the bare flag only if the
  // MCP block above didn't already add one (granted connector). Never a double flag.
  if (needStrictMcp && !args.includes("--strict-mcp-config")) args.push("--strict-mcp-config");

  // F2 — boss/CEO live web research. Unconditional append AFTER the TOOLS-mode branch
  // (and after strict-mcp dedup) so the default "none" branch can't strip it. Built-in
  // web tools are orthogonal to --strict-mcp-config (which only scopes MCP servers).
  // Granted to the boss/CEO thread ONLY — webToolArgs() returns [] for every other id.
  args.push(...webToolArgs(agentId));

  // Minimal child env — strip secret-shaped vars so a tool/log can't leak them
  // (claude CLI uses subscription auth via ~/.claude, not env keys).
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/(_KEY|_SECRET|_TOKEN|_TOKEN_DIR|PASSWORD|APIKEY)$/i.test(k) || k === "ANTHROPIC_API_KEY") continue;
    childEnv[k] = v;
  }
  const child = spawn(CLAUDE_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: childEnv,
  });

  let acc = "";
  let buf = "";
  let streamed = false;
  let lastUsage = null; // ADR-030 — captured from the cli `result` event
  let rateLimited = false; // quota guard — set if the cli `result` signals a 429

  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let obj;
      try {
        obj = JSON.parse(s);
      } catch {
        continue;
      }
      // partial text deltas (preferred — real streaming)
      if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
        const t = obj.event.delta?.text;
        if (t) {
          acc += t;
          streamed = true;
          stream.token(t);
        }
      } else if (obj.type === "result") {
        // capture token usage (ADR-030) — total_cost_usd is intentionally IGNORED.
        if (obj.usage) lastUsage = obj.usage;
        // quota guard — note a rate-limit so the call is logged ok:false.
        if (obj.is_error && isRateLimited({ message: String(obj.result || ""), subtype: obj.subtype })) rateLimited = true;
        if (typeof obj.result === "string" && !streamed) {
          // fallback: no partials seen → emit the final result text once
          acc = obj.result;
          stream.token(obj.result);
        }
      }
    }
  });

  child.on("error", (e) => { mcpCleanup(); stream.error(`claude CLI: ${e.message}`); });
  child.on("close", () => {
    mcpCleanup();
    // quota guard accounting — one line per completed call (ok:false on a 429).
    try { quotaLog(agentId, !rateLimited); } catch { /* logging must never break a turn */ }
    onDone(acc, lastUsage);
  });

  // feed the prompt on stdin, then close it
  child.stdin.write(prompt);
  child.stdin.end();
}

async function handleChat(agentId, message, res, tier, modelId, attachments = [], attachDir = null) {
  const stream = sse(res);
  const hist = threads.get(agentId) || [];
  // Note attachments in the persisted user turn (text marker — paths live in the
  // prompt manifest, not in history, so old turns don't leak stale tmp paths).
  const attachNote = attachments.length
    ? ` [attached ${attachments.length} file(s): ${attachments.map((a) => displayName(a.origName)).join(", ")}]`
    : "";
  hist.push({ role: "user", content: message + attachNote });
  // save the turn + (ADR-030) roll up token usage, persist, and stream the meter.
  const save = (acc, rawUsage) => {
    hist.push({ role: "assistant", content: acc });
    const trimmed = hist.slice(-THREAD_KEEP);
    threads.set(agentId, trimmed);
    const turn = rawUsage
      ? turnFromResult(rawUsage, tier)
      : turnEstimate(message.length, (acc || "").length, tier);
    rollupThreadUsage(agentId, turn);
    persistThread(agentId, trimmed, tier);
    stream.usage(turn); // token/context only — never $
  };

  // System prompt — when MCP connectors are granted (ADR-032), tell the agent it HAS
  // those tools (the base persona says "chat-only"; this note overrides for MCP).
  let sysPrompt = systemFor(agentId);
  const mcpNames = mcpRegistry.grantedNames(agentId);
  if (mcpNames.length) {
    sysPrompt +=
      `\n\nMCP CONNECTORS GRANTED: ${mcpNames.join(", ")}. You DO have tool access via these MCP servers ` +
      `(their tools are named mcp__<server>__*). Disregard any earlier "chat-only / no tool access" framing — ` +
      `USE these MCP tools to read/fetch/act as the task requires, then report the real results.`;
  }

  // CLI backend — Claude Code subscription, no key/credits.
  if (BACKEND === "cli") {
    // Quota guard pre-gate (runaway brake). If this agent already hit its self-imposed
    // call limit for the window, DON'T spawn — stream a calm pause and end cleanly.
    // (Self-imposed: Anthropic's real cap isn't readable; the 429 backoff handles the
    // real limit. See quota-guard.mjs.)
    if (quotaCount(agentId, MA_QUOTA_WINDOW_MS) >= MA_QUOTA_MAX) {
      stream.meta({ mode: "cli", model: modelId, tier, agentId, paused: "quota" });
      stream.token("⏸ paused: quota — this agent hit its call limit for the window. Will retry shortly.");
      stream.done();
      return;
    }
    stream.meta({ mode: "cli", model: modelId, tier, tools: TOOLS, agentId, mcp: mcpNames });
    if (TOOLS === "write") await seedSandbox(agentId); // isolated copy ready before edits
    cliReply(agentId, sysPrompt, hist, stream, (acc, usage) => {
      save(acc || "(no output)", usage);
      stream.done();
    }, modelId, attachments, attachDir);
    return;
  }

  const client = BACKEND === "api" ? await getClient() : null;

  if (!client) {
    // MOCK mode — stream caveman reply word by word.
    stream.meta({ mode: "mock", model: "none", tier, agentId });
    const reply = mockReply(agentId, message);
    const words = reply.split(" ");
    let acc = "";
    for (let i = 0; i < words.length; i++) {
      const chunk = (i ? " " : "") + words[i];
      acc += chunk;
      stream.token(chunk);
      await new Promise((r) => setTimeout(r, 45));
    }
    save(acc);
    stream.done();
    return;
  }

  // REAL mode — stream from Claude. modelId is the allowlisted id (ADR-022).
  try {
    stream.meta({ mode: "live", model: modelId, tier, agentId });
    let acc = "";
    const s = await client.messages.stream({
      model: modelId,
      max_tokens: MAX_TOKENS,
      system: systemFor(agentId),
      messages: hist.map((h) => ({ role: h.role, content: h.content })),
    });
    s.on("text", (t) => {
      acc += t;
      stream.token(t);
    });
    await s.finalMessage();
    save(acc);
    stream.done();
  } catch (e) {
    stream.error(e?.message || e);
  }
}

// ADR-049 — multipart /chat: stream-parse attachments to disk (caps + type +
// magic-byte sniff enforced), then dispatch the turn with the file manifest. Files
// are written under tmp (0o600), never the repo; client filenames never touch a path.
function handleChatMultipart(req, res, agentId) {
  const jsonErr = (code, obj) => {
    if (!res.headersSent) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
  };
  const msgId = randomBytes(8).toString("hex");
  const dir = uploadMsgDir(agentId, msgId);
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } };

  let bb;
  try {
    bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 12, fieldSize: 8192, fieldNameSize: 100 } });
  } catch {
    return jsonErr(400, { error: "bad multipart request" });
  }

  const fields = {};
  const accepted = []; // { absPath, origName, kind }
  const rejected = []; // "reason:name"
  let idx = 0;
  let tooManyFiles = false;

  bb.on("field", (name, val) => { if (name === "message" || name === "model") fields[name] = String(val); });
  bb.on("filesLimit", () => { tooManyFiles = true; });

  bb.on("file", (name, file, info) => {
    const orig = (info && info.filename) || "file";
    if (name !== "files" || !extAllowed(orig)) {
      if (name === "files") rejected.push(`type:${displayName(orig)}`);
      file.resume();
      return;
    }
    const dest = join(dir, safeName(idx++, orig));
    let head = true, bad = false, ws = null;
    file.on("data", (chunk) => {
      if (bad) return;
      if (head) {
        head = false;
        if (!sniffOk(chunk, orig)) { bad = true; rejected.push(`content:${displayName(orig)}`); file.resume(); return; }
        ensureUploadDir(dir);
        ws = createWriteStream(dest, { mode: 0o600 });
      }
      if (ws && !ws.write(chunk)) { file.pause(); ws.once("drain", () => file.resume()); }
    });
    file.on("limit", () => { bad = true; rejected.push(`size:${displayName(orig)}`); if (ws) { try { ws.destroy(); } catch { /* */ } } });
    file.on("end", () => {
      if (bad) { if (ws) { try { ws.destroy(); } catch { /* */ } } return; }
      if (ws) { ws.end(); accepted.push({ absPath: dest, origName: orig, kind: kindFor(orig) }); }
    });
  });

  bb.on("error", () => { cleanup(); jsonErr(400, { error: "upload parse error" }); });
  bb.on("close", () => {
    if (rejected.length) { cleanup(); return jsonErr(415, { error: "rejected attachment(s)", rejected }); }
    const message = String(fields.message || "").slice(0, 8000);
    if (!message.trim() && !accepted.length) { cleanup(); return jsonErr(400, { error: "message or attachment required" }); }
    const t = resolveTier(fields.model);
    if (t.error) { cleanup(); return jsonErr(400, { error: t.error, valid: t.valid }); }
    if (inflight >= MAX_INFLIGHT) { cleanup(); return jsonErr(429, { error: "busy — too many in-flight requests" }); }
    inflight++;
    // Release the slot AND delete the upload dir when the turn's response closes — the
    // CLI has already read the files by then (read happens during the turn, before
    // stream.done() → res.end() → close), so this is the success-path cleanup that
    // prevents UPLOADS_ROOT from accumulating between restarts (code-review HIGH).
    res.on("close", () => { inflight = Math.max(0, inflight - 1); cleanup(); });
    const note = tooManyFiles ? `\n(note: only the first ${MAX_FILES} files were kept)` : "";

    // ADR-049 §2 — XLSX→CSV conversion inside an async IIFE so we can await xlsxToCsv
    // before dispatching handleChat. The outer bb "close" handler stays synchronous;
    // the async work is fully enclosed and unhandled-rejection-safe (caught inside).
    void (async () => {
      // Convert spreadsheet attachments to CSV before the agent sees them.
      // The model can't read binary xlsx; CSV is text the Read tool handles.
      // Mutate the accepted entry (absPath+kind+note) or drop on failure (soft note).
      const xlsxSoftNotes = [];
      for (let i = accepted.length - 1; i >= 0; i--) {
        const entry = accepted[i];
        if (entry.kind !== "spreadsheet") continue;
        const result = await xlsxToCsv(entry.absPath); // eslint-disable-line no-await-in-loop
        if (result.error) {
          xlsxSoftNotes.push(`(xlsx "${displayName(entry.origName)}" could not be converted — skipped)`);
          accepted.splice(i, 1);
        } else {
          const truncNote = result.truncated ? ", truncated" : "";
          entry.absPath = result.csvPath;
          entry.kind = "text";
          entry.note = `from Excel "${displayName(entry.origName)}", ${result.rows} rows${truncNote}`;
        }
      }
      const softNote = xlsxSoftNotes.length ? `\n${xlsxSoftNotes.join("\n")}` : "";
      await handleChat(agentId, (message || "(see attached files)") + note + softNote, res, t.tier, t.modelId, accepted, dir);
    })();
  });

  req.pipe(bb);
}

// ── S1 AUTONOMOUS LOOP ENGINE (ADRs 024–029) ────────────────────────────────
// Orchestrates the proven loop: a goal auto-chains through per-task git worktrees,
// policy-gated auto-apply (exec/config ALWAYS held), retry/self-heal, durable queue.
// Shares the SINGLE inflight/MAX_INFLIGHT budget (no second counter). The engine NEVER
// writes the repo itself — every apply flows through the SAME broker.applyChanges.
const ENGINE_STORE = process.env.RUNTIME_ENGINE_STORE || join(__dir, "engine-store");
const engineQueue = createQueue({ dir: ENGINE_STORE, scrub });
const enginePolicy = createPolicy({ file: join(ENGINE_STORE, "policy.json"), token: RUNTIME_TOKEN });
const engineWorktrees = createWorktreeMgr({ repoRoot: REPO_ROOT });
// F5 — probe once at boot; if the target is not a git repo, the engine uses copy-sandbox
// isolation (same as the manual path) instead of git worktrees.
const targetIsGit = isGitRepo(REPO_ROOT);
if (!targetIsGit) console.warn(`[runtime] REPO_ROOT is not a git repo — engine uses copy-sandbox isolation (worktrees disabled).`);
// Worktree-backed broker: per-task isolation keyed by taskId (vs the manual path's copy-sandbox).
// F5 — non-git: fall back to sandboxDir (copy-sandbox), same boundary as the manual path.
const engineBroker = createBroker({ repoRoot: REPO_ROOT, workdirFor: targetIsGit ? (id) => engineWorktrees.pathFor(id) : sandboxDir, scrub });
// Slot helpers over the EXISTING inflight counter (ADR-025 §2 — shared budget, never a 2nd one).
function tryAcquireSlot() { if (inflight >= MAX_INFLIGHT) return false; inflight++; return true; }
function releaseSlot() { inflight = Math.max(0, inflight - 1); }
const engineScheduler = createScheduler({ tryAcquireSlot, releaseSlot, claimNext: () => engineQueue.claimNext() });

// Headless agent dispatch — runs `claude` write-mode in the per-task WORKTREE (cwd),
// no SSE client. Mirrors cliReply's write args (Bash NEVER allowed). cli backend only;
// other backends reject (the write-loop is the subscription path for S1).
async function engineDispatch(ctx) {
  if (BACKEND !== "cli") return { error: "engine write-loop requires the cli backend (claude subscription)" };
  const { modelId } = resolveTier(ctx.tier);
  // F5 — non-git target: ctx.workdir is null (worktreeMgr was null → engine skipped create).
  // Fall back to the copy-sandbox path (same as the manual /run path). The apply broker
  // stays identical — only the workdir SOURCE changes.
  const workdir = ctx.workdir ?? await seedSandbox(ctx.agentId);
  // One spawn attempt as a promise: resolves the agent's output text, REJECTS with a
  // 429-shaped error on a detected rate limit (so the guard backs off + retries), or a
  // plain error on spawn failure.
  const runOnce = () => new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--no-session-persistence"];
    if (modelId) args.push("--model", modelId);
    // G5 (ADR-050): factory agents get spec-derived tools; built-ins keep WRITE_TOOLS.
    const factoryToolsEng = allowedToolsForAgent(ctx.agentId);
    if (factoryToolsEng !== null) {
      for (const t of factoryToolsEng) args.push("--allowed-tools", t);
      args.push("--strict-mcp-config");
    } else {
      for (const t of WRITE_TOOLS) args.push("--allowed-tools", t);
    }
    args.push("--add-dir", workdir, "--permission-mode", "acceptEdits");
    const childEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/(_KEY|_SECRET|_TOKEN|_TOKEN_DIR|PASSWORD|APIKEY)$/i.test(k) || k === "ANTHROPIC_API_KEY") continue;
      childEnv[k] = v;
    }
    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"], cwd: workdir, env: childEnv });
    } catch (e) {
      return reject(new Error(e.message));
    }
    ctx.registerKill(() => {
      try { child.kill("SIGTERM"); } catch { /* */ }
      // SIGKILL fallback if the child ignores SIGTERM (kill-switch must be decisive).
      setTimeout(() => { try { if (!child.killed) child.kill("SIGKILL"); } catch { /* */ } }, 5000).unref?.();
    });
    let acc = "", buf = "", rateLimited = false;
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let o;
        try { o = JSON.parse(s); } catch { continue; }
        if (o.type === "stream_event" && o.event?.type === "content_block_delta") {
          const t = o.event.delta?.text;
          if (t) acc += t;
        } else if (o.type === "result") {
          if (typeof o.result === "string" && !acc) acc = o.result;
          if (o.is_error && isRateLimited({ message: String(o.result || ""), subtype: o.subtype })) rateLimited = true;
        }
      }
    });
    child.on("error", (e) => reject(new Error(`claude CLI: ${e.message}`)));
    child.on("close", () => {
      if (rateLimited) { const err = new Error("rate limit"); err.status = 429; return reject(err); }
      resolve(acc);
    });
    const prompt =
      `${systemFor(ctx.agentId)}\n\nTASK from BOSS: ${ctx.task}\n\n` +
      `Use your Write/Edit tools to make this change in the working directory NOW. ` +
      `Then summarize what you changed (caveman). Policy/operator will review the diff before it reaches the live repo.`;
    child.stdin.write(prompt);
    child.stdin.end();
  });
  // Quota guard: pre-gate (runaway brake) + 429 backoff + per-call logging. The guard
  // logs ok:true on success and ok:false on each 429. On QuotaExceeded we surface a
  // retryable error string — the scheduler retries on the next heartbeat, so the
  // autonomous loop keeps running instead of crashing. Contract unchanged: {acc}|{error}.
  return guardedSpawn({ agentId: ctx.agentId, max: MA_QUOTA_MAX, windowMs: MA_QUOTA_WINDOW_MS }, runOnce)
    .then((acc) => ({ acc }))
    .catch((e) => e instanceof QuotaExceeded
      ? { error: "paused: quota — will retry next heartbeat" }
      : { error: e.message });
}

const engine = createEngine({
  queue: engineQueue,
  policy: enginePolicy,
  // F5 — pass null when the target is not a git repo; engine.runStep skips worktree
  // creation (workdir stays null), and engineDispatch seeds a copy-sandbox instead.
  worktreeMgr: targetIsGit ? engineWorktrees : null,
  scheduler: engineScheduler,
  broker: engineBroker,
  dispatchFn: engineDispatch,
  reportBackFn: reportBack,
  escalateFn: (agentId, kind, attempts, reason) => {
    const HB = join(REPO_ROOT, "scripts", "agent-heartbeat.sh");
    const SYNC = join(REPO_ROOT, "scripts", "agent-sync.sh");
    const { heartbeat, sync } = escalationArgs(agentId, kind, attempts, reason);
    // F5 — a foreign repo has no scripts/agent-*.sh → skip cleanly instead of spawning doomed bash.
    if (existsSync(HB)) { try { spawn("bash", [HB, ...heartbeat.map(String)], { stdio: "ignore", cwd: REPO_ROOT }); } catch { /* */ } }
    if (existsSync(SYNC)) { try { spawn("bash", [SYNC, ...sync.map(String)], { stdio: "ignore", cwd: REPO_ROOT }); } catch { /* */ } }
  },
  watchdogMs: Number(process.env.RUNTIME_STEP_TIMEOUT_MS || 300_000),
  goalsDir: join(ENGINE_STORE, "goals"),
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Global anti-rebinding host gate — every request must carry a loopback Host
  // (health excepted so local probes still work).
  if (url.pathname !== "/runtime/health" && !hostOk(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden host" }));
    return;
  }

  // ── F4.1 COCKPIT FEEDS — no token required (matches dev vite posture) ────────
  // Loopback-gated by the hostOk check above. No shell exec. READ-only except
  // /api/command which validates + atomic-writes under dirname(statePath)/commands.
  if (url.pathname === "/api/state.json")       return _stateH(req, res);
  if (url.pathname === "/api/command")          return _commandH(req, res);
  if (url.pathname === "/api/audit")            return _auditH(req, res);
  if (url.pathname === "/api/commands/status")  return _commandStatusH(req, res);
  if (url.pathname.startsWith("/api/sessions")) return _sessionsH(req, res);

  // ── S1 ENGINE ROUTES (ADRs 024–029) ───────────────────────────────────────
  // Handled BEFORE the generic /runtime/:agentId/* routes so "engine" is never
  // captured as an agentId. All require the same gate as /apply (token + origin;
  // host already enforced globally above).
  if (url.pathname.startsWith("/runtime/engine/")) {
    if (!originOk(req) || !tokenOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const readJson = (cap = 32_000) =>
      new Promise((resolveBody) => {
        let b = "";
        req.on("data", (c) => { b += c; if (b.length > cap) req.destroy(); });
        req.on("end", () => { try { resolveBody(JSON.parse(b || "{}")); } catch { resolveBody({}); } });
      });

    // GET /runtime/engine/runs — backlog + run state + slot/queue depth (read-only).
    if (req.method === "GET" && url.pathname === "/runtime/engine/runs") {
      const tasks = engineQueue.all().map((t) => ({
        taskId: t.taskId, goalId: t.goalId, agentId: t.agentId, tier: t.tier, stepIndex: t.stepIndex,
        status: t.status, engineState: t.engineState || null, attempts: t.attempts, priority: t.priority,
        heldReason: t.heldReason || null, error: t.error || null, result: t.result || null,
        branch: t.branch || null, createdAt: t.createdAt, updatedAt: t.updatedAt,
      }));
      return ok2(res, { tasks, counts: engineQueue.counts(), inflight, maxInflight: MAX_INFLIGHT });
    }
    // GET /runtime/engine/changes?taskId=… — diff of a (usually HELD) task's worktree.
    if (req.method === "GET" && url.pathname === "/runtime/engine/changes") {
      const taskId = url.searchParams.get("taskId") || "";
      if (!/^task_[0-9a-f]{6,}$/i.test(taskId)) return ok2(res, { error: "valid taskId required" }, 400);
      const changes = await engineBroker.listChanges(taskId);
      return ok2(res, { changes });
    }
    // POST /runtime/engine/enqueue {agentId, tier?, priority?, steps:[...]} → goal.
    if (req.method === "POST" && url.pathname === "/runtime/engine/enqueue") {
      const body = await readJson(64_000);
      const agentId = String(body.agentId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64);
      const steps = Array.isArray(body.steps) ? body.steps.filter((s) => typeof s === "string" && s.trim()).slice(0, 50) : [];
      if (!agentId || !steps.length) return ok2(res, { error: "agentId + steps[] required" }, 400);
      const t = resolveTier(body.tier);
      if (t.error) return ok2(res, { error: t.error, valid: t.valid }, 400);
      try {
        const r = engine.enqueueGoal({ agentId, tier: t.tier, priority: ["high", "normal", "low"].includes(body.priority) ? body.priority : "normal", steps });
        return ok2(res, r, 201);
      } catch (e) {
        return ok2(res, { error: e.message }, 400);
      }
    }
    // POST /runtime/engine/apply {taskId, paths:[...]} — operator applies a HELD step
    // from its worktree (SAME broker, all guards re-run), then advances the chain.
    if (req.method === "POST" && url.pathname === "/runtime/engine/apply") {
      const body = await readJson(64_000);
      const taskId = String(body.taskId || "");
      const paths = Array.isArray(body.paths) ? body.paths.slice(0, 100) : [];
      if (!/^task_[0-9a-f]{6,}$/i.test(taskId) || !paths.length) return ok2(res, { error: "taskId + paths[] required" }, 400);
      const results = await engineBroker.applyChanges(taskId, paths);
      const okPaths = results.filter((r) => r.ok).map((r) => r.path);
      if (okPaths.length) { reportBack(engineQueue.get(taskId)?.agentId || taskId, `${okPaths.length} file(s): ${okPaths.join(", ")}`); engine.onOperatorApplied(taskId); }
      return ok2(res, { results });
    }
    // POST /runtime/engine/cancel {taskId} — kill + discard worktree, never apply.
    if (req.method === "POST" && url.pathname === "/runtime/engine/cancel") {
      const body = await readJson(8_000);
      const taskId = String(body.taskId || "");
      if (!/^task_[0-9a-f]{6,}$/i.test(taskId)) return ok2(res, { error: "valid taskId required" }, 400);
      engine.cancel(taskId);
      return ok2(res, { ok: true });
    }
    // POST /runtime/engine/policy {agentId, level} — set per-agent auto-apply level (signed).
    if (req.method === "POST" && url.pathname === "/runtime/engine/policy") {
      const body = await readJson(8_000);
      const agentId = String(body.agentId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64);
      if (!agentId) return ok2(res, { error: "agentId required" }, 400);
      try {
        enginePolicy.setLevel(agentId, body.level);
        return ok2(res, { ok: true, agentId, level: body.level });
      } catch (e) {
        return ok2(res, { error: e.message }, 400);
      }
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // B3 (ADR-050): POST /runtime/factory/detect-gaps {manifest} — advisory read-only gap check.
  // Auth: same token+origin+host gate as engine routes (host already enforced globally).
  // NEVER calls createAgent. Returns {gaps, covered} from detectGaps(manifest, capabilityIndex()).
  if (req.method === "POST" && url.pathname === "/runtime/factory/detect-gaps") {
    if (!originOk(req) || !tokenOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 32_000) req.destroy(); });
    req.on("end", () => {
      let manifest = {};
      try { manifest = JSON.parse(b || "{}"); } catch { /* use empty */ }
      // Read-only: never mutates registry. capabilityIndex() is a pure static snapshot.
      const result = detectGaps(manifest, capabilityIndex());
      return ok2(res, result);
    });
    return;
  }

  // Phase 4 (#7 / ADR-050): POST /runtime/factory/resolve {needs} — map a stack to its
  // owner agent (built-in OR minted; minted specialist wins the tie-break). Advisory
  // read-only — NEVER mutates the registry. Same auth as detect-gaps.
  if (req.method === "POST" && url.pathname === "/runtime/factory/resolve") {
    if (!originOk(req) || !tokenOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 32_000) req.destroy(); });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(b || "{}"); } catch { /* use empty */ }
      const needs = body.needs || body || {};
      // listAgents() = minted registry (read-only). Built-ins come from capabilityIndex.
      return ok2(res, resolveAgents(needs, factory.listAgents()));
    });
    return;
  }

  // POST /runtime/:agentId/chat  body {message}
  const m = url.pathname.match(/^\/runtime\/([a-z0-9_-]{1,64})\/chat$/i);
  if (req.method === "POST" && m) {
    const agentId = m[1];
    // bound concurrent LLM children (cost/quota + fork-bomb guard)
    if (inflight >= MAX_INFLIGHT) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "busy — too many in-flight requests" }));
      return;
    }
    // ADR-049 — multipart = chat with file attachments. JSON path below is unchanged.
    if (/^multipart\/form-data/i.test(String(req.headers["content-type"] || ""))) {
      handleChatMultipart(req, res, agentId);
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 16_000) req.destroy(); // cap
    });
    req.on("end", () => {
      let message = "";
      let rawModel;
      try {
        const j = JSON.parse(body || "{}");
        message = String(j.message || "").slice(0, 4000);
        rawModel = j.model;
      } catch {
        /* empty */
      }
      if (!message.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "message required" }));
        return;
      }
      // STRICT model-tier allowlist (ADR-022). Unknown tier → 400, no spawn.
      const t = resolveTier(rawModel);
      if (t.error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: t.error, valid: t.valid }));
        return;
      }
      inflight++;
      res.on("close", () => {
        inflight = Math.max(0, inflight - 1);
      });
      void handleChat(agentId, message, res, t.tier, t.modelId);
    });
    return;
  }
  // Auth gate for the sensitive endpoints (/changes leaks file content, /apply
  // writes to the live repo, /thread + /fork leak/branch conversation content).
  // Token + same-origin required.
  const needsAuth =
    /^\/runtime\/[a-z0-9_-]{1,64}\/(changes|apply|run|thread|fork|exec)$/i.test(url.pathname) ||
    /^\/runtime\/exec\/[a-z0-9_]{1,64}\/(approve|kill)$/i.test(url.pathname) ||
    url.pathname === "/runtime/threads" ||
    url.pathname === "/runtime/quota";
  if (needsAuth && (!originOk(req) || !tokenOk(req))) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // GET /runtime/quota — read-only quota-guard status (auth-gated above). { count, max,
  // windowMs, paused }. count = total calls across the swarm in the window (account-
  // wide pressure); paused = any agent at/over its self-imposed cap. No write path.
  if (url.pathname === "/runtime/quota") {
    if (req.method !== "GET") { res.writeHead(405, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "method not allowed" })); return; }
    return ok2(res, quotaStatus({ max: MA_QUOTA_MAX, windowMs: MA_QUOTA_WINDOW_MS }));
  }

  // ── S3.5 full tool loop (ADR-038/039) — exec jailed in the Docker sandbox ──────
  // POST /runtime/:id/exec {command, network?} → classify → forbidden:reject /
  // safe|session-granted:run-in-sandbox / sensitive:return a pending approval.
  const mex = url.pathname.match(/^\/runtime\/([a-z0-9_-]{1,64})\/exec$/i);
  if (req.method === "POST" && mex) {
    const agentId = mex[1];
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 16_000) req.destroy(); });
    req.on("end", async () => {
      let command = "", wantNet = false;
      try { const j = JSON.parse(body || "{}"); command = String(j.command || "").slice(0, 4000); wantNet = !!j.network; } catch { /* */ }
      if (!command.trim()) return ok2(res, { error: "command required" }, 400);

      // B2 (ADR-050): exec-capability gate — only builtins OR factory agents that hold a
      // dev:true skill may reach the sandbox. A minted content-only agent cannot exec.
      // Built-ins are NOT in the factory registry (isFactoryAgent returns false) → always pass.
      // Factory agents: check their spec for at least one dev:true skill.
      const isFactory = factory.isFactoryAgent(agentId);
      if (isFactory) {
        const agSpec = factory.specForAgent(agentId);
        const hasDevSkill = Array.isArray(agSpec?.skills) &&
          agSpec.skills.some((sid) => factory.SKILL_CATALOG.find((c) => c.id === sid)?.dev);
        if (!hasDevSkill) {
          factory.audit("exec.capability-denied", { agentId, reason: "no dev skill" });
          return ok2(res, { error: "exec not permitted for this agent" }, 403);
        }
      }
      // Non-factory (builtin) agents pass through unconditionally.

      const c = classify(command);
      if (c.klass === "forbidden") {
        factory.audit("exec.forbidden", { agentId, reason: c.reason });
        return ok2(res, { refused: true, klass: "forbidden", reason: c.reason });
      }
      // G1 (ADR-050): factory (AI-authored) agents NEVER auto-run — even a `safe` command
      // requires operator approval. Built-ins keep auto-run for `safe`. Session grants only
      // exist for built-ins (factory grants are denied at approve time below).
      const granted = (!isFactory && c.klass === "safe") || (sessionGrants.get(agentId)?.has(normCmd(command)));
      if (granted) {
        if (inflight >= MAX_INFLIGHT) return ok2(res, { error: "busy" }, 429);
        inflight++;
        const callId = newCallId();
        try {
          const r = await toolBroker.execTool(agentId, command, { network: wantNet && c.network, callId, timeoutMs: 180000 });
          return ok2(res, { ran: true, klass: c.klass, network: !!(wantNet && c.network), exitCode: r.exitCode, timedOut: r.timedOut, killed: r.killed, stdout: scrub(r.stdout || ""), stderr: scrub(r.stderr || "") });
        } catch (e) {
          return ok2(res, { error: String(e?.message || e) }, 500);
        } finally {
          inflight = Math.max(0, inflight - 1); // never leak a slot, even on throw (QA HIGH)
        }
      }
      // SENSITIVE + not session-granted → pending approval
      const callId = newCallId();
      pendingExec.set(callId, { agentId, command, network: wantNet && c.network, klass: c.klass, createdAt: Date.now() });
      return ok2(res, { pending: true, callId, klass: c.klass, network: !!(wantNet && c.network), preview: command.slice(0, 500), capabilities: (wantNet && c.network) ? ["network"] : [] });
    });
    return;
  }
  // POST /runtime/exec/:callId/approve {scope:"once"|"session"|"deny"}
  const map = url.pathname.match(/^\/runtime\/exec\/([a-z0-9_]{1,64})\/approve$/i);
  if (req.method === "POST" && map) {
    const callId = map[1];
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4_000) req.destroy(); });
    req.on("end", async () => {
      const pend = pendingExec.get(callId);
      if (!pend) return ok2(res, { error: "unknown or expired call" }, 404);
      let scope = "once";
      try { scope = JSON.parse(body || "{}").scope || "once"; } catch { /* */ }
      pendingExec.delete(callId);
      if (scope === "deny") { factory.audit("exec.denied", { agentId: pend.agentId, callId }); return ok2(res, { denied: true }); }
      // G1 (ADR-050): factory agents get `once` ONLY — never a persistent session grant,
      // so every exec re-prompts the operator. Session scope is silently downgraded to once.
      if (scope === "session" && !factory.isFactoryAgent(pend.agentId)) {
        if (!sessionGrants.has(pend.agentId)) sessionGrants.set(pend.agentId, new Set());
        sessionGrants.get(pend.agentId).add(normCmd(pend.command));
      }
      if (inflight >= MAX_INFLIGHT) return ok2(res, { error: "busy" }, 429);
      factory.audit("exec.approved", { agentId: pend.agentId, callId, scope, klass: pend.klass }); // audit who/what authorized
      inflight++;
      try {
        const r = await toolBroker.execTool(pend.agentId, pend.command, { network: pend.network, callId, timeoutMs: 180000 });
        return ok2(res, { ran: true, scope, klass: pend.klass, exitCode: r.exitCode, timedOut: r.timedOut, killed: r.killed, stdout: scrub(r.stdout || ""), stderr: scrub(r.stderr || "") });
      } catch (e) {
        return ok2(res, { error: String(e?.message || e) }, 500);
      } finally {
        inflight = Math.max(0, inflight - 1); // never leak a slot (QA HIGH)
      }
    });
    return;
  }
  // POST /runtime/exec/:callId/kill → kill-switch for a running sandbox.
  const mkl = url.pathname.match(/^\/runtime\/exec\/([a-z0-9_]{1,64})\/kill$/i);
  if (req.method === "POST" && mkl) {
    await sandbox.kill(mkl[1]);
    factory.audit("exec.kill", { callId: mkl[1] });
    return ok2(res, { ok: true });
  }

  // ── S2 thread fork/resume (ADR-031) — "session" = a chat thread ────────────
  // GET /runtime/threads → list persisted threads (no message bodies).
  if (req.method === "GET" && url.pathname === "/runtime/threads") {
    return ok2(res, { threads: listThreads() });
  }
  // GET /runtime/:id/thread → full thread for resume hydration (scrubbed).
  const mt = url.pathname.match(/^\/runtime\/([a-z0-9_-]{1,64})\/thread$/i);
  if (req.method === "GET" && mt) {
    const rec = getThreadRecord(mt[1]);
    if (!rec) return ok2(res, { error: "thread not found" }, 404);
    return ok2(res, rec);
  }
  // DELETE /runtime/:id/thread → remove a thread (clean up forks).
  if (req.method === "DELETE" && mt) {
    deleteThread(mt[1]);
    return ok2(res, { ok: true });
  }
  // POST /runtime/:id/fork {upTo?} → branch into a NEW server-minted thread id.
  const mf = url.pathname.match(/^\/runtime\/([a-z0-9_-]{1,64})\/fork$/i);
  if (req.method === "POST" && mf) {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 8_000) req.destroy(); });
    req.on("end", () => {
      let upTo;
      try { upTo = JSON.parse(body || "{}").upTo; } catch { /* */ }
      const r = forkThread(mf[1], Number.isInteger(upTo) ? upTo : undefined);
      if (!r) return ok2(res, { error: "thread not found" }, 404);
      return ok2(res, r, 201);
    });
    return;
  }

  // F2b — GET /runtime/:agentId/changes → proposed diffs (sandbox vs live repo).
  const mc = url.pathname.match(/^\/runtime\/([a-z0-9_-]{1,64})\/changes$/i);
  if (req.method === "GET" && mc) {
    const changes = await listChanges(mc[1]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ changes }));
    return;
  }
  // F2b — POST /runtime/:agentId/apply {paths:[...]} → THE PERMISSION BROKER.
  // Only called after the operator confirms in the UI. Re-validates every path.
  const ma = url.pathname.match(/^\/runtime\/([a-z0-9_-]{1,64})\/apply$/i);
  if (req.method === "POST" && ma) {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 64_000) req.destroy();
    });
    req.on("end", async () => {
      let paths = [];
      try {
        paths = JSON.parse(body || "{}").paths;
      } catch {
        /* empty */
      }
      if (!Array.isArray(paths) || paths.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "paths[] required" }));
        return;
      }
      const results = await applyChanges(ma[1], paths.slice(0, 100));
      const okPaths = results.filter((r) => r.ok).map((r) => r.path);
      if (okPaths.length) reportBack(ma[1], `${okPaths.length} file(s): ${okPaths.join(", ")}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results }));
    });
    return;
  }
  // Loop — POST /runtime/:agentId/run {task} → agent does the task in its sandbox
  // (write-mode F2b). Diff surfaces via /changes; operator applies → report-back.
  const mr = url.pathname.match(/^\/runtime\/([a-z0-9_-]{1,64})\/run$/i);
  if (req.method === "POST" && mr) {
    if (TOOLS !== "write") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "runtime not in write mode (RUNTIME_TOOLS=write)" }));
      return;
    }
    if (inflight >= MAX_INFLIGHT) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "busy" }));
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 16_000) req.destroy();
    });
    req.on("end", () => {
      let task = "";
      let rawModel;
      try {
        const j = JSON.parse(body || "{}");
        task = String(j.task || "").slice(0, 4000);
        rawModel = j.model;
      } catch {
        /* empty */
      }
      if (!task.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "task required" }));
        return;
      }
      const t = resolveTier(rawModel);
      if (t.error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: t.error, valid: t.valid }));
        return;
      }
      const prompt =
        `TASK from BOSS: ${task}\n\n` +
        `Use your Write/Edit tools to make this change in your sandbox NOW. ` +
        `IMPORTANT: write every file INSIDE src/ or public/ (e.g. public/billsplit.html). ` +
        `Those are the ONLY paths the operator can review and apply — files written at the ` +
        `sandbox root (or any other dir) are dropped and will NOT reach the live repo. ` +
        `Then summarize what you changed (caveman). The operator will review the diff before it reaches the live repo.`;
      inflight++;
      res.on("close", () => {
        inflight = Math.max(0, inflight - 1);
      });
      void handleChat(mr[1], prompt, res, t.tier, t.modelId);
    });
    return;
  }
  // ── AGENT FACTORY ───────────────────────────────────────────────────────────
  // Mutating/sensitive factory routes need the same gate as /apply: loopback Host +
  // Origin + runtime token. Read-only catalog/health are host-gated only (no secrets).
  if (url.pathname.startsWith("/factory/")) {
    const authed = originOk(req) && tokenOk(req); // host already enforced globally above
    const readBody = (cap = 64_000) =>
      new Promise((resolveBody) => {
        let b = "";
        req.on("data", (c) => {
          b += c;
          if (b.length > cap) req.destroy();
        });
        req.on("end", () => {
          try {
            resolveBody(JSON.parse(b || "{}"));
          } catch {
            resolveBody({});
          }
        });
      });

    // GET /factory/health — meta (composio configured?, catalog size). Open (host-gated).
    if (req.method === "GET" && url.pathname === "/factory/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...factory.factoryMeta }));
      return;
    }
    // GET /factory/skills — the closed skill catalog + platforms. Read-only.
    if (req.method === "GET" && url.pathname === "/factory/skills") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ skills: factory.SKILL_CATALOG, platforms: factory.PLATFORMS }));
      return;
    }

    // Everything below mutates or could surface sensitive data → require auth.
    if (!authed) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // GET /factory/agents — created-agent registry (persona elided to a preview).
    if (req.method === "GET" && url.pathname === "/factory/agents") {
      return ok2(res, { agents: factory.listAgents() });
    }
    // GET /factory/connections — accounts (NEVER secrets).
    if (req.method === "GET" && url.pathname === "/factory/connections") {
      return ok2(res, { connections: factory.listConnections() });
    }
    // GET /factory/audit?limit=N — runtime audit log tail (READ-ONLY, ADR-041).
    // limit clamped to [1,2000] (default 200) so a huge slice can't DoS the read.
    // The writer (factory.audit) + log format are UNCHANGED — this only reads more.
    if (req.method === "GET" && url.pathname === "/factory/audit") {
      const raw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(raw) ? Math.min(2000, Math.max(1, raw)) : 200;
      // Egress scrub the read payload too (consistency with the SSE path): an
      // exec.run cmd could carry an inline secret. Same last-line defense, read-only.
      let entries = factory.readAudit(limit);
      try { entries = JSON.parse(scrub(JSON.stringify(entries))); } catch { /* keep raw on parse edge */ }
      return ok2(res, { entries });
    }

    // ── MCP CONNECTORS (ADR-032/033) — all auth-gated (inside the `authed` block). ──
    // GET /factory/connectors — list (refs only, NEVER cred values) + grants.
    if (req.method === "GET" && url.pathname === "/factory/connectors") {
      return ok2(res, { connectors: mcpRegistry.listConnectors(), grants: mcpRegistry.allGrants(), creds: factory.listCredIds() });
    }
    // POST /factory/connectors/cred {secret} → store a secret in the AES broker, return credId.
    if (req.method === "POST" && url.pathname === "/factory/connectors/cred") {
      const body = await readBody(16_000);
      const r = factory.addCred(body.secret);
      return ok2(res, r, r.error ? 400 : 201);
    }
    // DELETE /factory/connectors/cred/:credId → remove a stored secret.
    const dcred = url.pathname.match(/^\/factory\/connectors\/cred\/(cred_[a-z0-9]+)$/i);
    if (req.method === "DELETE" && dcred) {
      const r = factory.deleteCred(dcred[1]);
      return ok2(res, r, r.error ? 404 : 200);
    }
    // POST /factory/connectors {name,transport,command?,args?,url?,envRefs?,headersRef?,scopes?}
    if (req.method === "POST" && url.pathname === "/factory/connectors") {
      const body = await readBody(16_000);
      const r = mcpRegistry.addConnector(body);
      return ok2(res, r, r.error ? 400 : 201);
    }
    // POST /factory/connectors/grant {agentId, connectorId, action:"grant"|"revoke"}
    if (req.method === "POST" && url.pathname === "/factory/connectors/grant") {
      const body = await readBody(8_000);
      const agentId = String(body.agentId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64);
      if (!agentId) return ok2(res, { error: "agentId required" }, 400);
      const r = body.action === "revoke"
        ? mcpRegistry.revoke(agentId, String(body.connectorId))
        : mcpRegistry.grant(agentId, String(body.connectorId));
      return ok2(res, r, r.error ? 400 : 200);
    }
    // POST /factory/connectors/:id/enable {enabled:bool}
    const men = url.pathname.match(/^\/factory\/connectors\/(mcp_[a-z0-9]+)\/enable$/i);
    if (req.method === "POST" && men) {
      const body = await readBody(4_000);
      const r = mcpRegistry.setEnabled(men[1], !!body.enabled);
      return ok2(res, r, r.error ? 404 : 200);
    }
    // PATCH /factory/connectors/:id {patch}
    const mpc = url.pathname.match(/^\/factory\/connectors\/(mcp_[a-z0-9]+)$/i);
    if (req.method === "PATCH" && mpc) {
      const body = await readBody(16_000);
      const r = mcpRegistry.patchConnector(mpc[1], body);
      return ok2(res, r, r.error ? 400 : 200);
    }
    // DELETE /factory/connectors/:id (cascades grant revocation)
    if (req.method === "DELETE" && mpc) {
      const r = mcpRegistry.removeConnector(mpc[1]);
      return ok2(res, r, r.error ? 404 : 200);
    }

    // POST /factory/author {description} → SSE: stream reasoning, then a `spec` event.
    if (req.method === "POST" && url.pathname === "/factory/author") {
      if (inflight >= MAX_INFLIGHT) return ok2(res, { error: "busy" }, 429);
      const body = await readBody(16_000);
      const description = String(body.description || "").slice(0, 4000);
      if (!description.trim()) return ok2(res, { error: "description required" }, 400);
      const t = resolveTier(body.model);
      if (t.error) return ok2(res, { error: t.error, valid: t.valid }, 400);
      const stream = sse(res);
      stream.meta({ mode: BACKEND === "cli" ? "cli" : "mock", phase: "authoring", tier: t.tier, model: t.modelId });
      const finish = (raw) => {
        const parsed = factory.parseSpecFromText(raw);
        res.write(`event: spec\ndata: ${JSON.stringify(scrub(JSON.stringify(parsed)))}\n\n`);
        stream.done();
      };
      if (BACKEND === "cli") {
        inflight++;
        res.on("close", () => (inflight = Math.max(0, inflight - 1)));
        factory.authorSpec(description, stream, finish, t.modelId);
      } else {
        // mock author (no claude binary) — emit reasoning then a parsed spec.
        const mk = factory.mockAuthorSpec(description);
        stream.token(mk.reasoning + "\n");
        const v = factory.validateSpec(mk.spec);
        res.write(`event: spec\ndata: ${JSON.stringify(JSON.stringify(v))}\n\n`);
        stream.done();
      }
      return;
    }
    // POST /factory/create {spec} — persist a BOSS-confirmed agent.
    if (req.method === "POST" && url.pathname === "/factory/create") {
      const body = await readBody(32_000);
      const r = factory.createAgent(body.spec || body);
      return ok2(res, r, r.error ? 400 : 201);
    }
    // POST /factory/connect {platform, handle, secret} — credential broker IN.
    // The raw secret enters ONLY here and is encrypted immediately; never logged.
    if (req.method === "POST" && url.pathname === "/factory/connect") {
      const body = await readBody(16_000);
      const r = factory.connectAccount({ platform: body.platform, handle: body.handle, secret: body.secret });
      return ok2(res, r, r.error ? 400 : 201);
    }
    // POST /factory/post/preview {agentId, connId, content} — dry run (mints confirmToken).
    if (req.method === "POST" && url.pathname === "/factory/post/preview") {
      const body = await readBody(16_000);
      const r = factory.previewPost(body);
      return ok2(res, r, r.error ? 400 : 200);
    }
    // POST /factory/post/execute {agentId, connId, content, confirmToken} — BOSS-confirmed post.
    if (req.method === "POST" && url.pathname === "/factory/post/execute") {
      if (inflight >= MAX_INFLIGHT) return ok2(res, { error: "busy" }, 429);
      const body = await readBody(16_000);
      const r = await factory.executePost(body);
      return ok2(res, r, r.error ? 400 : 200);
    }
    // DELETE /factory/connections/:connId — revoke an account.
    const dconn = url.pathname.match(/^\/factory\/connections\/(conn_[a-z0-9]+)$/i);
    if (req.method === "DELETE" && dconn) {
      const r = factory.deleteConnection(dconn[1]);
      return ok2(res, r, r.error ? 404 : 200);
    }
    // PATCH /factory/:id — edit a created agent (skills/tools/integrations/persona).
    // Same auth as create (block already requires `authed`). Re-validated in factory.
    const pagent = url.pathname.match(/^\/factory\/([a-z][a-z0-9-]{2,48})$/i);
    if (req.method === "PATCH" && pagent) {
      const body = await readBody(32_000);
      const r = factory.updateAgent(pagent[1], body);
      return ok2(res, r, r.error ? 400 : 200);
    }
    // DELETE /factory/:id — remove a created agent from the registry.
    const dagent = url.pathname.match(/^\/factory\/([a-z][a-z0-9-]{2,48})$/i);
    if (req.method === "DELETE" && dagent) {
      const r = factory.deleteAgent(dagent[1]);
      return ok2(res, r, r.error ? 404 : 200);
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // GET /runtime/health
  if (req.method === "GET" && url.pathname === "/runtime/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, backend: BACKEND, tools: TOOLS, model: BACKEND === "api" ? MODEL : BACKEND === "cli" ? "claude-code (subscription)" : "none", tiers: TIER_KEYS, defaultTier: DEFAULT_TIER, engine: { inflight, maxInflight: MAX_INFLIGHT, queue: engineQueue.counts() } }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// SECURITY INVARIANT (ADR-050 G1/G2/G5): loadRegistry() is SYNCHRONOUS (readFileSync)
// and MUST run before server.listen() below — the factory trust-tier guards fail OPEN
// for an unknown id (treated as built-in), so the registry must be fully hydrated
// before any request is accepted. Do not make this async or move it after listen().
factory.loadRegistry(); // hydrate created-agent personas before serving
loadThreads(); // hydrate persisted conversation threads (ADR-023 §3B)
try { const n = sweepStaleUploads(); if (n) console.log(`agent-runtime: swept ${n} stale upload dir(s)`); } catch { /* best-effort */ } // ADR-049
// Crash recovery FIRST (reclaim leases, re-converge 'applying' markers, prune orphan
// worktrees) — THEN start draining, so the scheduler never races recovery (code-review).
await engine.reconcile().catch(() => { /* crash-recovery is best-effort */ }); // ADR-024 §4 + ADR-026 §6
engine.start(); // register the loop with the scheduler (ADR-024/025)
server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `agent-runtime: listening :${PORT} · backend=${BACKEND}` +
      (BACKEND === "cli" ? " (Claude Code subscription — no API key)" : BACKEND === "api" ? ` (${MODEL})` : "") +
      ` · tools=${TOOLS} · tiers=[${TIER_KEYS.join(",")}] default=${DEFAULT_TIER}` +
      ` · threads=${threads.size} · factory=on (composio:${factory.factoryMeta.composio})`,
  );
});

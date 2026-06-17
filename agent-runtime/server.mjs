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
import { mkdirSync, existsSync } from "node:fs";
import { cp, readdir, readFile, writeFile, mkdir, stat, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, ".."); // MissionAlpha repo root
const TOOLS = process.env.RUNTIME_TOOLS || "none";
// SANDBOX OUTSIDE the repo (sr-security: must not be inside REPO_ROOT). Each agent
// edits an isolated COPY here; nothing reaches the live repo until the operator
// confirms via the permission broker (/apply).
const SANDBOX_ROOT = process.env.RUNTIME_SANDBOX_ROOT || join(tmpdir(), "missionalpha-sandboxes");
// Seeded + appliable scope. src/ + README + package.json. Still EXCLUDES
// *.config.ts + scripts/ (pure exec). package.json IS appliable BUT its exec/
// supply-chain keys are hard-guarded server-side (CONFIG_GUARD below) — sr-security F2b.
const SEED_DIRS = ["src"];
const SEED_FILES = ["README.md", "package.json"];
// apply() refuses any path matching these (defense beyond the .claude denylist).
const APPLY_DENY = /(^|\/)(\.env|\.git|\.claude|node_modules|.*\.(pem|key|p12))(\/|$)/i;
// Files whose exec-relevant keys must NEVER change via the broker. If any protected
// key differs between repo + sandbox, the whole file apply is refused.
const CONFIG_GUARD = {
  "package.json": ["scripts", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bin", "main", "module", "exports"],
};

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
try {
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, RUNTIME_TOKEN, { mode: 0o600 });
} catch {
  /* non-fatal */
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
const MAX_INFLIGHT = Number(process.env.RUNTIME_MAX_INFLIGHT || 4);
let inflight = 0;

// Per-agent conversation history (in-memory; resets on restart).
/** @type {Map<string, Array<{role:string, content:string}>>} */
const threads = new Map();

const CAVEMAN_SYSTEM = (agentId) =>
  `You are the "${agentId}" agent in the MissionAlpha swarm (a multi-agent dev org building the Waahyu platform). ` +
  `MANDATE: reply in /caveman FULL style — drop articles/filler/pleasantries/hedging, fragments OK, ` +
  `keep technical terms + file paths + API names exact. Be terse and useful. ` +
  `You are CHAT-ONLY right now: you have NO filesystem, command, or tool access — never claim you ran code or edited files. ` +
  `If asked to do real work, say what you WOULD do, caveman-style.`;

// BOSS console — Rohit (BOSS) sits ABOVE the CEO. This is the CEO answering its boss.
// CEO speaks PERSUASIVE PROSE to BOSS (not caveman — caveman is for the bus), blends
// Bezos/Musk/Solomon/Fink, is strategic, and is the supreme agent over the 16-agent swarm.
const CEO_BOSS_SYSTEM =
  `You are the CEO of the MissionAlpha / Waahyu multi-agent swarm — supreme over architect, ` +
  `principals, seniors, QA, reviewer (16 agents). You report ONLY to BOSS (Rohit), the ultimate ` +
  `authority above you. The person chatting with you now IS the BOSS. ` +
  `Persona blend: Jeff Bezos (customer-obsession, long-term, Day 1, regret-minimization), ` +
  `Elon Musk (first-principles, "best part is no part", speed), David Solomon (capital + ` +
  `risk-adjusted return, Type-1 vs Type-2 decisions), Larry Fink (long-duration stewardship). ` +
  `Stack reality: 13 FastAPI Python microservices (MongoDB/Motor/Redis), 4 React+Vite web apps, ` +
  `4 Expo RN mobile apps, GCP Cloud Run, Stripe+Twilio. ` +
  `Style to BOSS: clear, persuasive, decisive PROSE (NOT caveman — caveman is only for the agent ` +
  `bus). Think first-principles. When proposing action, give options + a recommendation + the ` +
  `tradeoff, and ask for GO/NO-GO. You can RECOMMEND dispatching work to specific agents ` +
  `(architect, senior-web-1, etc.) but you never claim to have executed anything — BOSS confirms ` +
  `dispatches. Be the strategic brain the BOSS talks to.\n\n` +
  `DISPATCH PROTOCOL: when you want to command agents, END your reply with a fenced block:\n` +
  "```dispatch\n" +
  `task <agent-id> <short caveman instruction>\n` +
  `task <agent-id> <short caveman instruction>\n` +
  "```\n" +
  `Valid verbs: task (assign work), ack (quiet a stalled agent), respawn (revive offline agent). ` +
  `Valid agent-ids: ceo, architect, principal-ux-design, principal-db-engineer, ` +
  `senior-security-engineer, senior-cicd-engineer, senior-lead-dev, senior-web-1, senior-web-2, ` +
  `principal-rn-mobile-1, principal-rn-mobile-2, senior-backend-1, senior-backend-2, senior-qa, ` +
  `senior-code-reviewer, memory-updater. Only include the block when BOSS actually wants action ` +
  `taken — it becomes confirm-buttons the BOSS clicks. NEVER fabricate that it already ran.`;

const TOOL_NOTE = {
  none: "",
  read:
    "\n\nTOOLS: you have READ-ONLY repo access (Read, Glob, Grep) rooted at the MissionAlpha repo. " +
    "Use them to inspect real files before answering. You CANNOT write, edit, or run commands — " +
    "if asked to change something, read + propose the exact change, don't claim you made it.",
  write:
    "\n\nTOOLS: you can Read/Glob/Grep AND Write/Edit files — but ONLY inside your sandbox working " +
    "directory (a scratch copy, never the live repo). No Bash/exec. Make changes in the sandbox and report what you did.",
};
const systemFor = (id) =>
  (id === "boss" ? CEO_BOSS_SYSTEM : CAVEMAN_SYSTEM(id)) + (TOOL_NOTE[TOOLS] || "");

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
const scrub = (t) => {
  if (typeof t !== "string") return t;
  let out = t.replace(SECRET_RE, "[redacted-secret]");
  if (RUNTIME_TOKEN) out = out.split(RUNTIME_TOKEN).join("[redacted-token]"); // never egress our own token
  return out;
};

function sse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  return {
    token: (t) => res.write(`event: token\ndata: ${JSON.stringify(scrub(t))}\n\n`),
    meta: (m) => res.write(`event: meta\ndata: ${JSON.stringify(m)}\n\n`),
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

// Recursively list relative file paths under a dir. Skips symlinks (no link
// following — closes cycle/escape vectors). Bounded depth + file count (DoS guard).
async function walk(root, base = root, depth = 0, acc = { n: 0 }) {
  const out = [];
  if (depth > 24 || acc.n > 5000) return out;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // never follow links
    const full = join(root, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base, depth + 1, acc)));
    else if (e.isFile()) {
      acc.n++;
      out.push(relative(base, full));
      if (acc.n > 5000) break;
    }
  }
  return out;
}

// True if a relPath is safe to apply — validated on the RESOLVED path, not the raw
// string (sr-security F2b: re-derive scope from the normalized path).
function applyAllowed(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  if (isAbsolute(relPath)) return false;
  if (/[\x00-\x1f]/.test(relPath)) return false; // control chars / NUL
  if (/["'`|$=]/.test(relPath)) return false; // bus-format metachars — no legit use in src/
  const dest = resolve(REPO_ROOT, relPath);
  const rootPrefix = resolve(REPO_ROOT) + sep;
  if (!dest.startsWith(rootPrefix)) return false; // containment (kills ../ escape)
  const relNorm = relative(REPO_ROOT, dest); // canonical
  if (APPLY_DENY.test(relNorm)) return false;
  const top = relNorm.split(sep)[0];
  return SEED_DIRS.includes(top) || SEED_FILES.includes(relNorm);
}

const trunc = (s, n = 4000) => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);

// Config guard — for a CONFIG_GUARD file, return the first protected key that
// differs between repo (before) and sandbox (after), or null if safe. Blocks
// supply-chain / exec-on-apply key changes (e.g. package.json scripts/deps).
function configGuardViolation(relNorm, before, after) {
  const keys = CONFIG_GUARD[relNorm];
  if (!keys) return null;
  let a, b;
  try {
    b = JSON.parse(before ?? "{}");
    a = JSON.parse(after);
  } catch {
    return "unparseable JSON"; // refuse if we can't verify
  }
  const norm = (v) => JSON.stringify(v ?? null);
  for (const k of keys) {
    if (norm(b[k]) !== norm(a[k])) return k;
  }
  return null;
}

// Diff the sandbox against the live repo → list of proposed changes.
async function listChanges(agentId) {
  const sb = sandboxDir(agentId);
  if (!existsSync(sb)) return [];
  const files = await walk(sb);
  const changes = [];
  for (const rel of files) {
    if (!applyAllowed(rel)) continue;
    let after = "";
    try {
      after = await readFile(join(sb, rel), "utf-8");
    } catch {
      continue;
    }
    let before = null;
    try {
      before = await readFile(join(REPO_ROOT, rel), "utf-8");
    } catch {
      before = null; // new file
    }
    if (before === after) continue; // unchanged
    changes.push({
      path: rel,
      status: before === null ? "new" : "modified",
      before: before === null ? null : scrub(trunc(before)),
      after: scrub(trunc(after)),
    });
  }
  return changes;
}

// Apply operator-confirmed paths from sandbox → live repo. Re-validates every path.
async function applyChanges(agentId, paths) {
  const sb = sandboxDir(agentId);
  const results = [];
  for (const rel of paths) {
    if (!applyAllowed(rel)) {
      results.push({ path: rel, ok: false, error: "path not allowed" });
      continue;
    }
    try {
      const content = await readFile(join(sb, rel), "utf-8");
      const dest = resolve(REPO_ROOT, rel);
      // CONFIG GUARD — refuse if a protected exec/supply-chain key changed.
      const relNorm = relative(REPO_ROOT, dest);
      if (CONFIG_GUARD[relNorm]) {
        let repoBefore = null;
        try {
          repoBefore = await readFile(dest, "utf-8");
        } catch {
          /* new file */
        }
        const bad = configGuardViolation(relNorm, repoBefore, content);
        if (bad) {
          results.push({ path: rel, ok: false, error: `protected key changed: ${bad}` });
          continue;
        }
      }
      await mkdir(dirname(dest), { recursive: true });
      // refuse symlink destination (no write-through to a link target)
      try {
        if ((await lstat(dest)).isSymbolicLink()) {
          results.push({ path: rel, ok: false, error: "dest is a symlink" });
          continue;
        }
      } catch {
        /* dest doesn't exist yet — fine */
      }
      // realpath the parent + assert it stays inside the repo (no symlinked dir escape)
      const realParent = await realpath(dirname(dest));
      if (!(realParent + sep).startsWith(resolve(REPO_ROOT) + sep)) {
        results.push({ path: rel, ok: false, error: "dest escapes repo" });
        continue;
      }
      await writeFile(dest, content, "utf-8");
      results.push({ path: rel, ok: true });
    } catch (e) {
      results.push({ path: rel, ok: false, error: e.message });
    }
  }
  return results;
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
  const sh = (script, args) => {
    try {
      spawn("bash", [script, ...args.map(String)], { stdio: "ignore", cwd: REPO_ROOT });
    } catch {
      /* non-fatal */
    }
  };
  sh(HB, [safeId, "DONE_CYCLE", `task applied: ${sum}`.slice(0, 120), "-", "", "report to BOSS"]);
  sh(SYNC, [safeId, "BOSS", "task-done", "-", `done: ${sum}`]);
}

// CLI backend — drive the local `claude` CLI headless. Uses the Claude Code
// SUBSCRIPTION (logged-in), NOT an API key. Single-shot per turn; we embed the
// system persona + prior thread into the prompt (claude -p is stateless here).
// Streams assistant text deltas out via SSE; ignores hook/system noise.
function cliReply(agentId, system, hist, stream, onDone) {
  const transcript = hist
    .map((h) => `${h.role === "user" ? "BOSS" : "YOU"}: ${h.content}`)
    .join("\n\n");
  const prompt = `${system}\n\n--- conversation so far ---\n${transcript}\n\n--- now reply as YOU (one turn) ---`;

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--no-session-persistence",
  ];
  // F2 tool scoping. Bash NEVER allowed yet. Unlisted tools are auto-denied in -p.
  let cwd = REPO_ROOT;
  if (TOOLS === "read") {
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
  // TOOLS === "none" → no --allowed-tools → chat-only (all tools auto-denied).

  // Minimal child env — strip secret-shaped vars so a tool/log can't leak them
  // (claude CLI uses subscription auth via ~/.claude, not env keys).
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/(_KEY|_SECRET|_TOKEN|PASSWORD|APIKEY)$/i.test(k) || k === "ANTHROPIC_API_KEY") continue;
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
      } else if (obj.type === "result" && typeof obj.result === "string" && !streamed) {
        // fallback: no partials seen → emit the final result text once
        acc = obj.result;
        stream.token(obj.result);
      }
    }
  });

  child.on("error", (e) => stream.error(`claude CLI: ${e.message}`));
  child.on("close", () => onDone(acc));

  // feed the prompt on stdin, then close it
  child.stdin.write(prompt);
  child.stdin.end();
}

async function handleChat(agentId, message, res) {
  const stream = sse(res);
  const hist = threads.get(agentId) || [];
  hist.push({ role: "user", content: message });

  // CLI backend — Claude Code subscription, no key/credits.
  if (BACKEND === "cli") {
    stream.meta({ mode: "cli", model: "claude-code (subscription)", tools: TOOLS, agentId });
    if (TOOLS === "write") await seedSandbox(agentId); // isolated copy ready before edits
    cliReply(agentId, systemFor(agentId), hist, stream, (acc) => {
      hist.push({ role: "assistant", content: acc || "(no output)" });
      threads.set(agentId, hist.slice(-20));
      stream.done();
    });
    return;
  }

  const client = BACKEND === "api" ? await getClient() : null;

  if (!client) {
    // MOCK mode — stream caveman reply word by word.
    stream.meta({ mode: "mock", model: "none", agentId });
    const reply = mockReply(agentId, message);
    const words = reply.split(" ");
    let acc = "";
    for (let i = 0; i < words.length; i++) {
      const chunk = (i ? " " : "") + words[i];
      acc += chunk;
      stream.token(chunk);
      await new Promise((r) => setTimeout(r, 45));
    }
    hist.push({ role: "assistant", content: acc });
    threads.set(agentId, hist.slice(-20));
    stream.done();
    return;
  }

  // REAL mode — stream from Claude.
  try {
    stream.meta({ mode: "live", model: MODEL, agentId });
    let acc = "";
    const s = await client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemFor(agentId),
      messages: hist.map((h) => ({ role: h.role, content: h.content })),
    });
    s.on("text", (t) => {
      acc += t;
      stream.token(t);
    });
    await s.finalMessage();
    hist.push({ role: "assistant", content: acc });
    threads.set(agentId, hist.slice(-20));
    stream.done();
  } catch (e) {
    stream.error(e?.message || e);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Global anti-rebinding host gate — every request must carry a loopback Host
  // (health excepted so local probes still work).
  if (url.pathname !== "/runtime/health" && !hostOk(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden host" }));
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
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 16_000) req.destroy(); // cap
    });
    req.on("end", () => {
      let message = "";
      try {
        message = String(JSON.parse(body || "{}").message || "").slice(0, 4000);
      } catch {
        /* empty */
      }
      if (!message.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "message required" }));
        return;
      }
      inflight++;
      res.on("close", () => {
        inflight = Math.max(0, inflight - 1);
      });
      void handleChat(agentId, message, res);
    });
    return;
  }
  // Auth gate for the sensitive endpoints (/changes leaks file content, /apply
  // writes to the live repo). Token + same-origin required.
  const needsAuth = /^\/runtime\/[a-z0-9_-]{1,64}\/(changes|apply|run)$/i.test(url.pathname);
  if (needsAuth && (!originOk(req) || !tokenOk(req))) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
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
      try {
        task = String(JSON.parse(body || "{}").task || "").slice(0, 4000);
      } catch {
        /* empty */
      }
      if (!task.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "task required" }));
        return;
      }
      const prompt =
        `TASK from BOSS: ${task}\n\n` +
        `Use your Write/Edit tools to make this change in your sandbox NOW. ` +
        `Then summarize what you changed (caveman). The operator will review the diff before it reaches the live repo.`;
      inflight++;
      res.on("close", () => {
        inflight = Math.max(0, inflight - 1);
      });
      void handleChat(mr[1], prompt, res);
    });
    return;
  }
  // GET /runtime/health
  if (req.method === "GET" && url.pathname === "/runtime/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, backend: BACKEND, tools: TOOLS, model: BACKEND === "api" ? MODEL : BACKEND === "cli" ? "claude-code (subscription)" : "none" }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `agent-runtime: listening :${PORT} · backend=${BACKEND}` +
      (BACKEND === "cli" ? " (Claude Code subscription — no API key)" : BACKEND === "api" ? ` (${MODEL})` : "") +
      ` · tools=${TOOLS}`,
  );
});

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readFile, writeFile, rename, mkdir, appendFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { Plugin } from "vite";

// ── Data seam ──────────────────────────────────────────────────────────────
// MissionAlpha is a STANDALONE watcher. It does NOT live inside the swarm it
// watches. It reads ONE file — the swarm's exported state.json — via a
// configurable path. Default points at the Waahyu swarm (sibling repo), but
// any swarm that emits the same schema can be pointed at by changing
// WAAHYU_STATE_PATH in .env. This is the seam that makes it global-ready.
function resolveStatePath(env: Record<string, string>): string {
  const p = env.WAAHYU_STATE_PATH;
  if (p && p.trim()) return resolve(p.trim());
  // default: sibling Waahyu repo's exported state
  return resolve(__dirname, "../WaahyuPython/agent-status/state.json");
}

// READ side (unchanged): serve the swarm snapshot to the browser.
function serveAgentState(statePath: string): Plugin {
  const handler = async (_req: unknown, res: any) => {
    try {
      const data = await readFile(statePath, "utf-8");
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(data);
    } catch {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "state.json not found",
          lookedAt: statePath,
          hint: "set WAAHYU_STATE_PATH in .env, and ensure the swarm scheduler is exporting state (python3 scripts/emit_state.py in WaahyuPython).",
        }),
      );
    }
  };
  return {
    name: "serve-agent-state",
    configureServer(server) {
      server.middlewares.use("/api/state.json", handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/state.json", handler);
    },
  };
}

// ── Command channel (write-back) — the reverse arrow ─────────────────────────
// POST /api/command writes ONE validated command file into the swarm's
// agent-status/commands/ dir (sibling of state.json). The swarm drains it via
// consume_commands.py. This middleware is the only write surface; it is
// deliberately small and strict.
//
// SECURITY (local-dev posture; harden before any network exposure — Phase 6):
//   • POST only.                         • allow-list the command `type`.
//   • `target` must exist in state.json. • `target` format-checked (no path traversal).
//   • id generated server-side.          • atomic write (tmp → rename).
//   • every command appended to an audit log (who/what/when).
//   • NO shell execution here — we only persist intent; the swarm decides how to act.
const ALLOWED_TYPES = new Set(["ack", "respawn", "task"]); // Phase 1: ack. Phase 2: respawn. Phase 3: task.
const TARGET_RE = /^[a-z0-9_-]{1,64}$/i; // also blocks "../" path traversal in the id.
const MAX_BODY_BYTES = 8 * 1024;

function readJsonBody(req: any): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function knownAgentIds(statePath: string): Promise<Set<string>> {
  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as { agents?: Array<{ id?: string }> };
    return new Set((parsed.agents ?? []).map((a) => a.id).filter(Boolean) as string[]);
  } catch {
    return new Set();
  }
}

function serveCommandChannel(statePath: string): Plugin {
  const commandsDir = join(dirname(statePath), "commands");
  const auditLog = join(commandsDir, "AUDIT.log");

  const handler = async (req: any, res: any) => {
    const reject = (code: number, error: string) => {
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error }));
    };

    if (req.method !== "POST") return reject(405, "POST only");

    let reqBody: any;
    try {
      reqBody = await readJsonBody(req);
    } catch (e) {
      return reject(400, (e as Error).message);
    }

    const type = reqBody?.type;
    const target = reqBody?.target;
    const issuedBy = typeof reqBody?.issuedBy === "string" ? reqBody.issuedBy : "operator";
    const reason = typeof reqBody?.reason === "string" ? reqBody.reason.slice(0, 280) : undefined;
    // Phase 3: `body` carries the task description text (capped at 2000 chars).
    const body = typeof reqBody?.body === "string" ? reqBody.body.slice(0, 2000) : undefined;

    if (typeof type !== "string" || !ALLOWED_TYPES.has(type)) {
      return reject(400, `unsupported command type: ${String(type)}`);
    }
    // Phase 3 validation: task requires a non-empty body after trimming.
    if (type === "task" && (!body || !body.trim())) {
      return reject(400, "task requires a body");
    }
    if (typeof target !== "string" || !TARGET_RE.test(target)) {
      return reject(400, "invalid target");
    }
    const known = await knownAgentIds(statePath);
    if (known.size > 0 && !known.has(target)) {
      return reject(404, `unknown agent: ${target}`);
    }

    const id = `cmd_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const issuedAt = new Date().toISOString();
    const envelope = { id, type, target, issuedBy, reason, body, issuedAt, status: "pending" };

    try {
      await mkdir(commandsDir, { recursive: true });
      // atomic: write tmp then rename so the consumer never reads a half file.
      const finalPath = join(commandsDir, `${id}.json`);
      const tmpPath = `${finalPath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(envelope, null, 2), "utf-8");
      await rename(tmpPath, finalPath);
      await appendFile(
        auditLog,
        `${issuedAt}\t${id}\t${issuedBy}\t${type}\t${target}\t${reason ?? ""}\t${body ?? ""}\n`,
        "utf-8",
      );
    } catch (e) {
      return reject(500, `write failed: ${(e as Error).message}`);
    }

    res.statusCode = 202; // accepted: durably queued, not yet applied by the swarm.
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, id }));
  };

  return {
    name: "serve-command-channel",
    configureServer(server) {
      server.middlewares.use("/api/command", handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/command", handler);
    },
  };
}

// ── Read-only control-plane endpoints (Cycle 1: F5 audit + F7 command status) ──
// Both surface files the swarm ALREADY writes — no new state, no shell, no schema.
// GET-only. Bounded reads (tail-N) so a huge log never blocks the UI thread.
const AUDIT_TAIL_DEFAULT = 200;
const AUDIT_TAIL_MAX = 1000;
const STATUS_RECENT = 60;

// F5 — GET /api/audit?limit=N → parsed tail of commands/AUDIT.log (newest first).
// AUDIT.log line: issuedAt \t id \t issuedBy \t type \t target \t reason \t body
function serveAuditLog(statePath: string): Plugin {
  const auditLog = join(dirname(statePath), "commands", "AUDIT.log");
  const handler = async (req: any, res: any) => {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "GET only" }));
      return;
    }
    let limit = AUDIT_TAIL_DEFAULT;
    try {
      const u = new URL(req.url, "http://x");
      const q = Number(u.searchParams.get("limit"));
      if (Number.isFinite(q) && q > 0) limit = Math.min(q, AUDIT_TAIL_MAX);
    } catch {
      /* keep default */
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    try {
      const raw = await readFile(auditLog, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const tail = lines.slice(-limit).reverse(); // newest first
      const entries = tail.map((l) => {
        const [at, id, issuedBy, type, target, reason, ...rest] = l.split("\t");
        return {
          at: at ?? "",
          cmdId: id ?? "",
          issuedBy: issuedBy ?? "",
          type: type ?? "",
          target: target ?? "",
          reason: reason || undefined,
          note: rest.length ? rest.join("\t") : undefined,
        };
      });
      res.end(JSON.stringify({ entries }));
    } catch {
      // no audit log yet → empty, not an error (swarm may not have run commands).
      res.end(JSON.stringify({ entries: [] }));
    }
  };
  return {
    name: "serve-audit-log",
    configureServer(s) {
      s.middlewares.use("/api/audit", handler);
    },
    configurePreviewServer(s) {
      s.middlewares.use("/api/audit", handler);
    },
  };
}

// F7 — GET /api/commands/status → lifecycle of recent commands from the 3 dirs
// the consumer moves files between: commands/ (pending) · done/ · rejected/.
async function readDirJson(dir: string): Promise<Array<{ name: string; data: any }>> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    const out: Array<{ name: string; data: any }> = [];
    for (const name of names) {
      try {
        out.push({ name, data: JSON.parse(await readFile(join(dir, name), "utf-8")) });
      } catch {
        /* skip unparseable */
      }
    }
    return out;
  } catch {
    return [];
  }
}
function serveCommandStatus(statePath: string): Plugin {
  const cmds = join(dirname(statePath), "commands");
  const handler = async (req: any, res: any) => {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "GET only" }));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const [pending, done, rejected] = await Promise.all([
      readDirJson(cmds),
      readDirJson(join(cmds, "done")),
      readDirJson(join(cmds, "rejected")),
    ]);
    const toEntry = (lifecycle: string) => (f: { data: any }) => ({
      id: f.data?.id ?? "",
      type: f.data?.type ?? "",
      target: f.data?.target ?? "",
      lifecycle,
      at: f.data?.issuedAt ?? "",
      error: f.data?.error ?? undefined,
    });
    const recent = [
      ...pending.map(toEntry("pending")),
      ...done.map(toEntry("done")),
      ...rejected.map(toEntry("rejected")),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : -1)) // newest first
      .slice(0, STATUS_RECENT);
    res.end(
      JSON.stringify({
        pending: pending.length,
        done: done.length,
        rejected: rejected.length,
        recent,
      }),
    );
  };
  return {
    name: "serve-command-status",
    configureServer(s) {
      s.middlewares.use("/api/commands/status", handler);
    },
    configurePreviewServer(s) {
      s.middlewares.use("/api/commands/status", handler);
    },
  };
}

// ── Session history endpoints (Cycle 2: F4) ──────────────────────────────────
// Read-only over the sidecar recorder's store: agent-status/history/<date>.ndjson
// (one state.json snapshot per line). No coupling change — the recorder reads
// state.json and writes MissionAlpha's own history; these endpoints only read it.
const SESSION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // also blocks path traversal in :id
const SESSION_SNAPSHOT_CAP = 240; // decimate big days so the UI never loads MBs

// Count audit-log commands per calendar day (UTC date prefix of each ISO line).
async function commandsPerDay(auditLog: string): Promise<Record<string, number>> {
  try {
    const raw = await readFile(auditLog, "utf-8");
    const out: Record<string, number> = {};
    for (const l of raw.split("\n")) {
      const day = l.slice(0, 10);
      if (SESSION_DATE_RE.test(day)) out[day] = (out[day] ?? 0) + 1;
    }
    return out;
  } catch {
    return {};
  }
}

function summarizeLines(date: string, lines: string[], commandsFired: number) {
  let startTs = "";
  let endTs = "";
  let peakActive = 0;
  let maxBlocked = 0;
  const agentsSeen = new Set<string>();
  for (const l of lines) {
    try {
      const s = JSON.parse(l);
      const gen = s.generatedAt ?? "";
      if (gen) {
        if (!startTs) startTs = gen;
        endTs = gen;
      }
      const c = s.counts ?? {};
      if (typeof c.active === "number") peakActive = Math.max(peakActive, c.active);
      if (typeof c.blocked === "number") maxBlocked = Math.max(maxBlocked, c.blocked);
      for (const a of s.agents ?? []) if (a.id) agentsSeen.add(a.id);
    } catch {
      /* skip bad line */
    }
  }
  return {
    id: date,
    date,
    startTs,
    endTs,
    snapshotCount: lines.length,
    agentsSeen: agentsSeen.size,
    peakActive,
    maxBlocked,
    commandsFired,
  };
}

function serveSessions(statePath: string): Plugin {
  const histDir = join(dirname(statePath), "history");
  const auditLog = join(dirname(statePath), "commands", "AUDIT.log");

  const list = async (res: any) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    let files: string[] = [];
    try {
      files = (await readdir(histDir)).filter((n) => n.endsWith(".ndjson"));
    } catch {
      return res.end(JSON.stringify({ sessions: [] }));
    }
    const cmds = await commandsPerDay(auditLog);
    const sessions = [];
    for (const f of files.sort().reverse()) {
      // newest first
      const date = f.slice(0, -".ndjson".length);
      if (!SESSION_DATE_RE.test(date)) continue;
      try {
        const raw = await readFile(join(histDir, f), "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());
        sessions.push(summarizeLines(date, lines, cmds[date] ?? 0));
      } catch {
        /* skip */
      }
    }
    res.end(JSON.stringify({ sessions }));
  };

  const detail = async (res: any, id: string) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (!SESSION_DATE_RE.test(id)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "bad session id" }));
    }
    let raw: string;
    try {
      raw = await readFile(join(histDir, `${id}.ndjson`), "utf-8");
    } catch {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "session not found" }));
    }
    const lines = raw.split("\n").filter((l) => l.trim());
    const cmds = await commandsPerDay(auditLog);
    const summary = summarizeLines(id, lines, cmds[id] ?? 0);
    // decimate evenly to the cap so big days stay light.
    let kept = lines;
    if (lines.length > SESSION_SNAPSHOT_CAP) {
      const step = lines.length / SESSION_SNAPSHOT_CAP;
      kept = [];
      for (let i = 0; i < SESSION_SNAPSHOT_CAP; i++) kept.push(lines[Math.floor(i * step)]);
    }
    const snapshots = kept
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.end(JSON.stringify({ summary, snapshots }));
  };

  const handler = async (req: any, res: any) => {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "GET only" }));
    }
    // connect strips the mounted prefix, so req.url is "/" (list) or "/<id>"
    // (detail). Tolerate either the stripped or full form.
    const path = (req.url || "").split("?")[0];
    const rest = path.replace(/^\/api\/sessions/, "").replace(/^\/+/, "");
    if (rest) return detail(res, decodeURIComponent(rest));
    return list(res);
  };

  return {
    name: "serve-sessions",
    configureServer(s) {
      s.middlewares.use("/api/sessions", handler);
    },
    configurePreviewServer(s) {
      s.middlewares.use("/api/sessions", handler);
    },
  };
}

// Serve the agent-runtime auth token to the SAME-ORIGIN dashboard only. The
// browser fetches this once and sends it as x-runtime-token on /apply + /changes.
// Cross-origin pages can issue the request but CORS blocks them reading the token.
function serveRuntimeToken(env: Record<string, string>): Plugin {
  // Read from the runtime's token file OUTSIDE the repo (sr-security #5).
  const tokenDir = env.RUNTIME_TOKEN_DIR || join(tmpdir(), "missionalpha-runtime");
  const tokenFile = join(tokenDir, ".runtime-token");
  const loopbackHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
  const handler = async (req: any, res: any) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // anti-rebinding: drop non-loopback Host, and any cross-origin Origin.
    const host = String(req.headers.host || "");
    const origin = req.headers.origin;
    if (!loopbackHost.test(host) || (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    try {
      const token = (await readFile(tokenFile, "utf-8")).trim();
      res.end(JSON.stringify({ token }));
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "runtime token not available — is agent-runtime started?" }));
    }
  };
  return {
    name: "serve-runtime-token",
    configureServer(s) {
      s.middlewares.use("/api/runtime-token", handler);
    },
    configurePreviewServer(s) {
      s.middlewares.use("/api/runtime-token", handler);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const statePath = resolveStatePath(env);
  return {
    plugins: [
      react(),
      serveAgentState(statePath),
      serveCommandChannel(statePath),
      serveAuditLog(statePath),
      serveCommandStatus(statePath),
      serveSessions(statePath),
      serveRuntimeToken(env),
    ],
    server: {
      port: 3004,
      strictPort: false,
      // anti-DNS-rebinding: reject requests whose Host isn't loopback (sr-security #4).
      allowedHosts: ["localhost", "127.0.0.1"],
      // Track B chat fork — proxy chat to the SEPARATE agent-runtime service so the
      // browser stays same-origin. The watcher process never hosts the LLM runtime.
      proxy: {
        "/runtime": {
          target: `http://localhost:${env.RUNTIME_PORT || "3005"}`,
          changeOrigin: true,
        },
        // Agent Factory endpoints live on the same separate runtime service.
        "/factory": {
          target: `http://localhost:${env.RUNTIME_PORT || "3005"}`,
          changeOrigin: true,
        },
      },
    },
    // Keep a single three.js instance across r3f / drei so refs/types line up.
    resolve: { dedupe: ["three", "@react-three/fiber"] },
  };
});

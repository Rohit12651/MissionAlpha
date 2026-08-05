// cockpit-feeds.mjs — shared swarm-state data-plane handlers (F4.1)
//
// Framework-agnostic ESM module. Each export is a factory function that closes
// over a `statePath` and returns an async (req, res) => {} handler compatible
// with both node:http and vite/connect middleware.
//
// Logic moved VERBATIM from vite.config.ts (same validation, atomic tmp→rename,
// audit append, tail caps, allow-list). No behavior change.
//
// SECURITY (local-only posture — matches dev vite behavior):
//   • All routes are loopback-gated in server.mjs via the existing `hostOk` check.
//   • /api/command: allow-list + TARGET_RE + MAX_BODY_BYTES + atomic write. No shell exec.
//   • Reads are bounded (tail caps) so a huge log can't DoS.
//   • statePath/commandsDir derived from env/config, not from request input.

import { readFile, writeFile, rename, mkdir, appendFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// ── Shared constants (verbatim from vite.config.ts) ───────────────────────────
const ALLOWED_TYPES = new Set(["ack", "respawn", "task"]);
const TARGET_RE = /^[a-z0-9_-]{1,64}$/i; // also blocks "../" path traversal in the id
const MAX_BODY_BYTES = 8 * 1024;

const AUDIT_TAIL_DEFAULT = 200;
const AUDIT_TAIL_MAX = 1000;
const STATUS_RECENT = 60;

const SESSION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_SNAPSHOT_CAP = 240;

// decodeURIComponent throws URIError on a malformed escape (e.g. "/api/sessions/%").
// These routes are host-gated only — no token — so an unhandled throw here is an
// UNAUTHENTICATED process kill. null means "undecodable" → the caller 400s.
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

// ── Shared helpers (verbatim from vite.config.ts) ─────────────────────────────

function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy?.();
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

async function knownAgentIds(statePath) {
  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    return new Set((parsed.agents ?? []).map((a) => a.id).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function readDirJson(dir) {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    const out = [];
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

async function commandsPerDay(auditLog) {
  try {
    const raw = await readFile(auditLog, "utf-8");
    const out = {};
    for (const l of raw.split("\n")) {
      const day = l.slice(0, 10);
      if (SESSION_DATE_RE.test(day)) out[day] = (out[day] ?? 0) + 1;
    }
    return out;
  } catch {
    return {};
  }
}

function summarizeLines(date, lines, commandsFired) {
  let startTs = "";
  let endTs = "";
  let peakActive = 0;
  let maxBlocked = 0;
  const agentsSeen = new Set();
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

// ── Exported handler factories ────────────────────────────────────────────────

/**
 * GET /api/state.json — serve the swarm snapshot or 503 if absent.
 */
export function stateHandler(statePath) {
  return async (_req, res) => {
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
          hint: "set WAAHYU_STATE_PATH and ensure the swarm scheduler is exporting state.",
        }),
      );
    }
  };
}

/**
 * POST /api/command — validate + write + 202; atomic tmp→rename + AUDIT.log append.
 */
export function commandHandler(statePath) {
  const commandsDir = join(dirname(statePath), "commands");
  const auditLog = join(commandsDir, "AUDIT.log");

  return async (req, res) => {
    const reject = (code, error) => {
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error }));
    };

    if (req.method !== "POST") return reject(405, "POST only");

    let reqBody;
    try {
      reqBody = await readJsonBody(req);
    } catch (e) {
      return reject(400, e.message);
    }

    const type = reqBody?.type;
    const target = reqBody?.target;
    // Sanitize tab/newline so a caller can't inject extra TSV columns into AUDIT.log
    // (security-reviewer MEDIUM — log-integrity), and cap length.
    const issuedBy = typeof reqBody?.issuedBy === "string" ? reqBody.issuedBy.replace(/[\t\n\r]/g, " ").slice(0, 200) : "operator";
    const reason = typeof reqBody?.reason === "string" ? reqBody.reason.slice(0, 280) : undefined;
    const body = typeof reqBody?.body === "string" ? reqBody.body.slice(0, 2000) : undefined;

    if (typeof type !== "string" || !ALLOWED_TYPES.has(type)) {
      return reject(400, `unsupported command type: ${String(type)}`);
    }
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
      return reject(500, `write failed: ${e.message}`);
    }

    res.statusCode = 202;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, id }));
  };
}

/**
 * GET /api/audit?limit=N — parsed tail of commands/AUDIT.log (newest first).
 */
export function auditHandler(statePath) {
  const auditLog = join(dirname(statePath), "commands", "AUDIT.log");

  return async (req, res) => {
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
      // no audit log yet → empty, not an error
      res.end(JSON.stringify({ entries: [] }));
    }
  };
}

/**
 * GET /api/commands/status — lifecycle counts across pending/done/rejected dirs.
 */
export function commandStatusHandler(statePath) {
  const cmds = join(dirname(statePath), "commands");

  return async (req, res) => {
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
    const toEntry = (lifecycle) => (f) => ({
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
      .sort((a, b) => (a.at < b.at ? 1 : -1))
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
}

/**
 * GET /api/sessions — list sessions or return detail for /api/sessions/:date.
 */
export function sessionsHandler(statePath) {
  const histDir = join(dirname(statePath), "history");
  const auditLog = join(dirname(statePath), "commands", "AUDIT.log");

  const list = async (res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    let files = [];
    try {
      files = (await readdir(histDir)).filter((n) => n.endsWith(".ndjson"));
    } catch {
      return res.end(JSON.stringify({ sessions: [] }));
    }
    const cmds = await commandsPerDay(auditLog);
    const sessions = [];
    for (const f of files.sort().reverse()) {
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

  const detail = async (res, id) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (!SESSION_DATE_RE.test(id)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "bad session id" }));
    }
    let raw;
    try {
      raw = await readFile(join(histDir, `${id}.ndjson`), "utf-8");
    } catch {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "session not found" }));
    }
    const lines = raw.split("\n").filter((l) => l.trim());
    const cmds = await commandsPerDay(auditLog);
    const summary = summarizeLines(id, lines, cmds[id] ?? 0);
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

  return async (req, res) => {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "GET only" }));
    }
    // Handle both the connect-stripped form (url="/") and full form (url="/api/sessions/...")
    const path = (req.url || "").split("?")[0];
    const rest = path.replace(/^\/api\/sessions/, "").replace(/^\/+/, "");
    if (rest) {
      const id = safeDecode(rest);
      if (id === null) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: "bad session id" }));
      }
      return detail(res, id);
    }
    return list(res);
  };
}

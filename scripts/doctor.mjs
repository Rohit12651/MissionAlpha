#!/usr/bin/env node
// Phase 1 / R4 — the doctor CLI. Composes REAL probes into the pure reporter in
// agent-runtime/doctor.mjs. This file owns the I/O; doctor.mjs owns the judgement.
//
// Usage:  npm run doctor            human-readable
//         npm run doctor -- --json  machine-readable (same data, for the cockpit route)
//
// Exit code: 0 when no check FAILS (warns are fine — a warn is degraded, not broken),
// 1 when any check fails. That makes `npm run doctor` usable as a pre-flight in CI.

import { execFile } from "node:child_process";
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDoctor, renderDoctor } from "../agent-runtime/doctor.mjs";
import { createResourceGuard } from "../agent-runtime/resource-guard.mjs";
import { WORKER_CAP } from "../agent-runtime/hr.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_MODE = process.argv.includes("--json");

// argv array, shell:false — no shell, no interpolation (quality.mjs law).
function exec(bin, args, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout, shell: false, windowsHide: true }, (err, stdout) =>
        resolve({ ok: !err, stdout: String(stdout || "") }));
    } catch { resolve({ ok: false, stdout: "" }); }
  });
}

async function which(bin) {
  const r = await exec("/usr/bin/which", [bin]);
  const p = r.stdout.trim();
  return r.ok && p ? p : null;
}

function portState(port) {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(600);
    s.on("connect", () => done("listening"));
    s.on("timeout", () => done("free"));
    s.on("error", () => done("free"));
  });
}

// The accounts store is METADATA ONLY (credentials.mjs) — reading it never touches a
// secret. We report standing, never a token.
async function readinessProbe() {
  const cfgDir = process.env.RUNTIME_CONFIG_DIR || join(process.env.HOME || "", ".missionalpha");
  const file = join(cfgDir, "accounts.json");
  if (!existsSync(file)) return { standing: "none" };
  try {
    const meta = JSON.parse(await readFile(file, "utf8"));
    const activeId = meta?.activeAccountId;
    if (!activeId) return { standing: "none" };
    const acct = (meta.accounts || []).find((a) => a.id === activeId);
    if (!acct) return { standing: "none" };
    const backend = process.env.RUNTIME_BACKEND || "cli";
    if (process.env.RUNTIME_ENGINE_SPAWNER === "deterministic") {
      return { standing: "deterministic", accountId: activeId };
    }
    // Transport sanity: a claude-CLI account under the api backend cannot dispatch.
    if (acct.providerType === "claude" && backend === "api" && !acct.hasKey) {
      return { standing: "backend", accountId: activeId };
    }
    if (acct.capability === "cannot") return { standing: "cannot", accountId: activeId };
    if (!acct.capability || acct.capability === "unmeasured") {
      return { standing: "unmeasured", accountId: activeId };
    }
    return { standing: "runs", accountId: activeId };
  } catch (e) {
    return { standing: "none", reason: e?.message };
  }
}

function dbProbe() {
  const path = process.env.RUNTIME_DB_PATH || join(ROOT, "agent-runtime/data/mission.db");
  if (!existsSync(path)) return { open: false, path };
  try {
    statSync(path);
    return { open: true, path, wal: existsSync(`${path}-wal`) || true };
  } catch { return { open: false, path }; }
}

async function repoProbe() {
  const path = process.env.RUNTIME_REPO_ROOT || ROOT;
  return { path, isGit: existsSync(join(path, ".git")) };
}

async function cadenceProbe() {
  const file = join(ROOT, "factory/cadence.json");
  if (!existsSync(file)) return { ok: true, workers: 3 }; // built-in CADENCE_SEED (2 enabled + monitor)
  try {
    const cfg = JSON.parse(await readFile(file, "utf8"));
    const rows = Array.isArray(cfg?.cadences) ? cfg.cadences : [];
    return { ok: true, workers: rows.filter((r) => r?.enabled).length };
  } catch (e) {
    return { ok: false, error: e?.message || "unparseable" };
  }
}

async function embedProbe() {
  if (process.env.RUNTIME_EMBED_DISABLED === "1") return { present: true };
  const dir = join(ROOT, "agent-runtime/data/models");
  return { present: existsSync(dir) };
}

async function encryptionProbe() {
  const enabled = process.env.RUNTIME_ENCRYPT_AT_REST === "1";
  if (!enabled) return { enabled: false, keyPresent: false };
  const keyFile = join(process.env.RUNTIME_TOKEN_DIR || join(process.env.HOME || "", ".missionalpha"), "atrest.key");
  return { enabled: true, keyPresent: existsSync(keyFile) };
}

// Phase 14 / 14.2 — the Manager-loop checks, for the CLI.
//
// THE HTTP ROUTE HAD THEM AND THIS DID NOT, which is addendum #25 exactly: a dependency every
// test injects is a dependency no test proves is WIRED. `npm run doctor` — the documented
// command — reported "probe not wired" for all four, so the checks 14.2 added were invisible
// on the surface an operator actually runs.
//
// Three of the four are answerable from DISK and are wired here. `manager` is not: a tick age
// is runtime state, and this process is not the runtime. It stays unwired on purpose and the
// check now says so in those words rather than reading like a bug.
function rosterProbe() {
  const file = process.env.RUNTIME_ROSTER_FILE || join(ROOT, "agent-runtime", "roster.json");
  try {
    // An ABSENT roster is not an error — it is an install with no seats yet, which is what a
    // fresh clone looks like.
    if (!existsSync(file)) return { ok: true, members: 0, workers: 0 };
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const members = Array.isArray(parsed?.members) ? parsed.members : [];
    return { ok: true, members: members.length, workers: members.filter((m) => m?.role === "worker").length };
  } catch (e) {
    return { ok: false, error: `roster.json: ${e?.message || "unreadable"}` };
  }
}

function hrProbe() {
  const r = rosterProbe();
  return { workers: r.ok ? r.workers : 0, cap: WORKER_CAP };
}

function mailboxProbe() {
  // Undelivered = still in an OUTBOX. The router drains outbox → inbox each heartbeat, so a
  // backlog here means the router is not running or not draining.
  const root = process.env.RUNTIME_MAIL_DIR
    || join(process.env.RUNTIME_ENGINE_STORE || join(ROOT, "agent-runtime", "engine-store"), "mail");
  try {
    if (!existsSync(root)) return { undelivered: 0 };
    let n = 0;
    for (const seat of readdirSync(root, { withFileTypes: true })) {
      if (!seat.isDirectory()) continue;
      try { n += readdirSync(join(root, seat.name, "outbox")).filter((f) => f.endsWith(".json")).length; }
      catch { /* a seat with no outbox has nothing undelivered */ }
    }
    return { undelivered: n };
  } catch { return { undelivered: 0 }; }
}

const report = await createDoctor({
  nodeVersion: () => process.version,
  which,
  run: exec,
  readiness: readinessProbe,
  guard: createResourceGuard({}),
  db: dbProbe(),
  ports: async () => ({ 3004: await portState(3004), 3005: await portState(3005) }),
  repoRoot: repoProbe,
  cadenceConfig: cadenceProbe,
  embedModel: embedProbe,
  encryption: encryptionProbe,
  rosterHealth: rosterProbe,
  hrHealth: hrProbe,
  mailbox: mailboxProbe,
  // `managerTick` is deliberately absent — see the note above rosterProbe.
}).run();

if (JSON_MODE) console.log(JSON.stringify(report, null, 2));
else console.log(renderDoctor(report));

process.exit(report.status === "fail" ? 1 : 0);

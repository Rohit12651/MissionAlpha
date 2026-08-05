#!/usr/bin/env node
// Story-Pipeline S7 — the AUTONOMY SOAK harness. Proves a story ships itself, unattended, through
// EVERY SDLC stage with EXACTLY TWO human taps (design-approval + release-accept), then that the
// SRE monitor mints a linked bug story that runs the pipeline itself (the 🔧 loop closes).
//
// It is fully self-contained and DISPOSABLE:
//   • builds a THROWAWAY git repo in a tmpdir (the story's build target — NOT MissionAlpha),
//   • boots agent-runtime/server.mjs as a CHILD on a disposable port with a temp DB + temp dirs,
//     RUNTIME_BACKEND=none (mock text legs) + RUNTIME_ENGINE_SPAWNER=deterministic (canned build
//     diffs) + the Docker-jailed test/deploy gates unchanged,
//   • drives the two scripted human taps via the API and NOTHING else human,
//   • samples the server's RSS + watches for crashes / unhandled rejections,
//   • prints a console transcript of every stage transition, tap, and loop as the evidence.
//
// TAP ACCOUNTING (stated explicitly): the TWO taps are the two GATE decisions — design-approval
// and release-accept. Answering a clarify question is an operator INPUT, not a gate decision, so it
// is NOT counted as one of the two taps (it is logged separately as "clarify-answer").
//
// USAGE:
//   node scripts/soak.mjs                 # ONE full cycle (seed→ship + monitor→bug-story), then exit
//   node scripts/soak.mjs --minutes 45    # run cycles continuously for ≥45 min (the long soak)
//   node scripts/soak.mjs --port 3016     # pick the disposable port (default 3016; NEVER 3004/3005)
//   node scripts/soak.mjs --keep          # leave the tmp dirs + server up for inspection
//
// SAFETY: RUNTIME_PORT is ALWAYS set to a disposable port here; the server defaults to 3005 if it
// is unset, so this harness never leaves it to chance. No MissionAlpha git ops; temp target only.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "..");
const SERVER = join(REPO, "agent-runtime", "server.mjs");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const MINUTES = Number(argOf("--minutes", "0")) || 0;
const PORT = Number(argOf("--port", "3016"));
const KEEP = argv.includes("--keep");
if (PORT === 3004 || PORT === 3005) { console.error(`REFUSING port ${PORT} (reserved). Use 3016 or 3960-3969.`); process.exit(2); }
const TOKEN = "soak-" + Math.random().toString(16).slice(2, 10);
const BASE = `http://localhost:${PORT}`;

// ── console transcript ────────────────────────────────────────────────────────
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(8);
const log = (tag, msg) => console.log(`${stamp()} [${tag}] ${msg}`);
const banner = (m) => console.log(`\n${"─".repeat(78)}\n  ${m}\n${"─".repeat(78)}`);

// ── tmp workspace + throwaway git repo (the story's build target) ─────────────
function setup() {
  // realpathSync canonicalizes the tmp path (macOS tmpdir is /var → /private/var symlinked). The
  // runtime sets REPO_ROOT = resolve(RUNTIME_REPO_ROOT) and, at apply time, realpaths the write's
  // parent and asserts it stays under REPO_ROOT. If REPO_ROOT kept the /var form while realpath
  // returned /private/var, every apply would be rejected as "dest escapes repo". A real deploy
  // target's path is already canonical; the throwaway repo lives under tmp, so we canonicalize it
  // here so the SAME containment check the runtime enforces passes. (Harness path hygiene only —
  // no runtime security control is relaxed.)
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ma-soak-")));
  const target = join(root, "target-repo");   // the THROWAWAY git repo stories build in
  mkdirSync(join(target, "src"), { recursive: true });
  // A trivial, self-verifying test the Docker jail runs post-diff (the unit-test gate) AND as the
  // repo's own `npm test`. It asserts every canned build output reports STATUS=PASS; on the base
  // tree (no build outputs yet) it is trivially green. A STATUS=FAIL output makes it go RED.
  writeFileSync(join(target, "gate.test.mjs"),
`import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
test('build outputs are healthy', () => {
  if (!existsSync('src')) return;
  for (const f of readdirSync('src').filter((x) => /^build-.*\\.txt$/.test(x))) {
    assert.match(readFileSync('src/' + f, 'utf8'), /STATUS=PASS/, f + ' must report STATUS=PASS');
  }
});
`);
  // A trivial, network-free "deploy" step: exits 0 (healthy). The deploy executor runs this argv in
  // the Docker jail (network:false); healthUrl is null so a clean exit ships the story.
  writeFileSync(join(target, "deploy-check.mjs"),
`console.log('[deploy] soak target build OK'); process.exit(0);\n`);
  writeFileSync(join(target, "src", ".keep"), "");
  writeFileSync(join(target, "README.md"), "# Soak target\nDisposable build target for the S7 autonomy soak.\n");
  writeFileSync(join(target, "package.json"), JSON.stringify({
    name: "soak-target", version: "1.0.0", private: true,
    scripts: { test: "node --test gate.test.mjs", build: "node deploy-check.mjs" },
  }, null, 2) + "\n");
  const git = (...a) => execFileSync("git", a, { cwd: target, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "soak@local");
  git("config", "user.name", "soak");
  git("add", "-A");
  git("commit", "-qm", "soak target: initial commit");

  // Per-run temp configs pointing the runtime's gates at the throwaway repo's trivial cmds.
  const factory = join(root, "factory"); mkdirSync(factory, { recursive: true });
  const qualityFile = join(factory, "quality.json");
  const deployFile = join(factory, "deploy.json");
  writeFileSync(qualityFile, JSON.stringify({ testCmd: ["node", "--test", "gate.test.mjs"], e2eCmd: null, timeoutMs: 120000, workdir: null }));
  writeFileSync(deployFile, JSON.stringify({ deployCmd: ["node", "deploy-check.mjs"], healthUrl: null, timeoutMs: 120000, network: false }));
  const errorLog = join(root, "runtime-error.log");
  writeFileSync(errorLog, "");

  return { root, target, qualityFile, deployFile, errorLog };
}

// ── boot the server child ─────────────────────────────────────────────────────
function boot(ws) {
  const env = {
    ...process.env,
    RUNTIME_PORT: String(PORT),
    RUNTIME_TOKEN: TOKEN,
    RUNTIME_BACKEND: "none",                    // mock text legs (pm-analyst/architect/docs/reviewer)
    RUNTIME_ENGINE_SPAWNER: "deterministic",    // canned build diffs (the S7 substitution)
    RUNTIME_SPAWNER_FAILFIRST_SEAT: "sr-backend", // sr-backend's 1st build attempt goes RED → red→green
    RUNTIME_REPO_ROOT: ws.target,               // stories build in the THROWAWAY repo
    RUNTIME_PIPELINE: "1",
    RUNTIME_DB_PATH: join(ws.root, "mission.db"),
    RUNTIME_ENGINE_STORE: join(ws.root, "engine-store"),
    RUNTIME_TOKEN_DIR: join(ws.root, "token"),
    RUNTIME_QUALITY_FILE: ws.qualityFile,
    RUNTIME_DEPLOY_FILE: ws.deployFile,
    RUNTIME_ERROR_LOG: ws.errorLog,
    RUNTIME_VAULT_DIR: join(ws.root, "vault"),
    ANTHROPIC_API_KEY: "",                      // force backend=none (never api)
  };
  const child = spawn("node", [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  const health = { crashes: 0, unhandled: 0, exited: false, lines: [] };
  const scan = (buf) => {
    for (const line of buf.toString().split("\n")) {
      if (!line.trim()) continue;
      health.lines.push(line);
      if (/unhandledRejection|uncaughtException/i.test(line)) { health.unhandled++; log("SERVER-ERR", line.slice(0, 200)); }
    }
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", scan);
  child.on("exit", (code, sig) => { health.exited = true; if (!health.stopping) { health.crashes++; log("CRASH", `server exited unexpectedly code=${code} sig=${sig}`); } });
  return { child, health };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "x-runtime-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await api("GET", "/runtime/health"); if (r.status === 200 && r.json?.ok) return true; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("server did not become healthy in time");
}

// ── story helpers ───────────────────────────────────────────────────────────
async function getStory(id) { const r = await api("GET", `/runtime/stories/${id}`); return r.json?.story || null; }

// Poll a story until `pred(story)` holds, logging every stage/status transition it observes.
async function awaitStage(id, pred, { timeoutMs = 90000, label = "" } = {}) {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    const s = await getStory(id);
    if (s) {
      const key = `${s.stage}/${s.status}`;
      if (key !== last) { log("STAGE", `${id} → ${key}${label ? "  " + label : ""}`); last = key; }
      if (pred(s)) return s;
    }
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${label || "stage"} on ${id} (last=${last})`);
}

async function pendingOfKind(kind, storyId) {
  const r = await api("GET", "/inbox?status=pending&limit=100");
  const rows = r.json?.deliveries || [];
  return rows.find((d) => d.kind === kind && d.storyId === storyId) || null;
}

// Drive ONE story from idea → shipped: 1 scripted clarify-answer + the 2 human-gate taps.
// Returns { taps, answers } accounting.
async function driveStory(id, tag) {
  const acct = { taps: 0, answers: 0 };
  banner(`DRIVE ${tag} story ${id}`);

  // idea → requirements (advancing INTO requirements is what kicks pm-analyst; it is a state
  // transition, not a human decision — the operator "starts" the story, then steps back). An
  // auto-filed bug story is ALREADY at requirements (the SRE monitor pre-advanced it), so only a
  // fresh idea-stage story needs this nudge.
  const start = await getStory(id);
  if (start.stage === "idea") {
    await api("POST", `/runtime/stories/${id}/advance`, { event: "soak-start" });
  }
  await awaitStage(id, (s) => s.stage !== "idea", { label: "entered requirements" });

  // clarify loop: pm-analyst raises a question → the story parks waiting-you. Answer it (INPUT).
  await awaitStage(id, (s) => s.stage === "requirements" && (s.status === "waiting-you" || s.stage === "design"),
    { label: "requirements dispatched" });
  let q = await pendingOfKind("question", id);
  if (q) {
    log("CLARIFY", `${id} question raised (delivery ${q.id}) — answering (operator INPUT, not a tap)`);
    const a = await api("POST", `/runtime/stories/${id}/answer`, { deliveryId: q.id, answer: "Ship the primary create flow first." });
    if (a.status >= 400) throw new Error(`answer failed: ${JSON.stringify(a.json)}`);
    acct.answers++;
    log("CLARIFY", `${id} answered → requirements re-runs with the answer fed back`);
  } else {
    log("CLARIFY", `${id} no question raised (already had answers)`);
  }

  // design gate = TAP 1.
  await awaitStage(id, (s) => s.stage === "design", { label: "reached design gate" });
  const dg = await awaitGate("design-approval", id);
  log("TAP", `#1 design-approval → approving (delivery ${dg.id})`);
  await approve(dg.id); acct.taps++;

  // plan → build → (red→green under fail-first) → review-qa. Fully autonomous, no taps.
  await awaitStage(id, (s) => s.stage === "build" || s.stage === "review-qa" || s.stage === "plan", { label: "design approved → planning/build" });
  await awaitStage(id, (s) => s.stage === "review-qa" || s.stage === "deploy-watch", { timeoutMs: 180000, label: "build+gates complete → review-qa" });

  // deploy-watch → release gate = TAP 2.
  const rg = await awaitGate("release-approval", id, 120000);
  log("TAP", `#2 release-accept → approving (delivery ${rg.id})`);
  await approve(rg.id); acct.taps++;

  // ship.
  const shipped = await awaitStage(id, (s) => s.status === "shipped" || s.status === "blocked", { timeoutMs: 120000, label: "deploy fired → accept" });
  if (shipped.status !== "shipped") throw new Error(`${id} did not ship (status=${shipped.status})`);
  // Red→green evidence from the persisted build panel: the fail-first seat should show ≥1
  // test-failed attempt followed by a DONE attempt (the loop the engine ran over the REAL gate).
  const rgEvidence = await redGreenEvidence(id);
  if (rgEvidence) { log("RED-GREEN", `${id} ${rgEvidence}`); acct.redGreen = true; }
  log("SHIP", `${id} SHIPPED — taps=${acct.taps} clarify-answers=${acct.answers}`);
  return acct;
}

// Read the persisted build panel and summarize the fail-first seat's red→green loop.
async function redGreenEvidence(id) {
  const r = await api("GET", `/runtime/stories/${id}`);
  const goals = r.json?.build?.goals || [];
  const seat = "sr-backend";
  const g = goals.find((x) => x.seat === seat);
  if (!g) return null;
  const tasks = g.tasks || [];
  const failed = tasks.filter((t) => t.status === "failed" && t.error?.kind === "test-failed").length;
  const done = tasks.filter((t) => t.status === "done").length;
  if (failed >= 1 && done >= 1) return `${seat}: ${failed} test-failed attempt(s) → then DONE (real Docker-jailed gate went RED then GREEN)`;
  return `${seat}: ${failed} test-failed / ${done} done (attempts=${tasks.length})`;
}

async function awaitGate(kind, storyId, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const g = await pendingOfKind(kind, storyId);
    if (g) return g;
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${kind} gate on ${storyId}`);
}
async function approve(deliveryId) {
  const r = await api("POST", `/inbox/${deliveryId}/approve`, { by: "BOSS" });
  if (r.status >= 400) throw new Error(`approve ${deliveryId} failed: ${JSON.stringify(r.json)}`);
}

// ── monitor: inject a health breach → mint a linked bug story ─────────────────
async function injectBreachAndMonitor(ws, originId) {
  banner("MONITOR — inject health breach → auto bug-story");
  appendFileSync(ws.errorLog, `${new Date().toISOString()} FATAL uncaughtException: injected deploy health breach (soak)\n`);
  log("BREACH", "wrote FATAL line into the error log (the SRE monitor's error-log breach vector)");
  const cadences = (await api("GET", "/runtime/cadence")).json?.cadences || [];
  const mon = cadences.find((c) => c.agent === "sre" && c.skill === "repo-health-check");
  if (!mon) throw new Error("monitor-tick cadence not found");
  const run = await api("POST", "/runtime/cadence/run", { id: mon.id });
  log("MONITOR", `triggered monitor-tick (cadence ${mon.id}) → ${JSON.stringify(run.json)}`);
  // The bug story is auto-created + linked + advanced idea→requirements. Find it.
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const rows = (await api("GET", "/runtime/stories?limit=50")).json?.stories || [];
    const bug = rows.find((s) => s.id !== originId && /^Bug: deployed surface unhealthy/.test(s.title || ""));
    if (bug) {
      log("BUG-STORY", `minted ${bug.id} "${bug.title}" (stage=${bug.stage}/${bug.status})`);
      // Confirm the origin↔bug link in the origin's story log.
      const originLog = (await api("GET", `/runtime/stories/${originId}`)).json?.log || [];
      const link = originLog.find((e) => e.event === "monitor-bug" && e.ref === bug.id);
      log("BUG-STORY", link ? `origin ${originId} log links → bug ${bug.id} (monitor-bug ref) ✓` : `WARNING: origin link not found`);
      return bug.id;
    }
    await sleep(400);
  }
  throw new Error("bug story was not minted within 30s");
}

// ── RSS sampler ───────────────────────────────────────────────────────────────
function rssKb(pid) {
  try { return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()); }
  catch { return null; }
}

// ── one full cycle ────────────────────────────────────────────────────────────
async function runCycle(ws, n) {
  banner(`CYCLE ${n}: seed a story → ship (two taps) → monitor → bug-story runs`);
  const created = await api("POST", "/runtime/stories", { title: `Soak feature ${n}`, idea: "Add a small feature that greets the user on the home page." });
  const id = created.json?.story?.id;
  if (!id) throw new Error(`create failed: ${JSON.stringify(created.json)}`);
  log("SEED", `created origin story ${id}`);
  const originAcct = await driveStory(id, "ORIGIN");

  const bugId = await injectBreachAndMonitor(ws, id);
  // Prove the bug story RUNS the pipeline: at minimum it reached requirements + raised its clarify.
  await awaitStage(bugId, (s) => s.stage === "requirements", { label: "bug story entered pipeline (pm-analyst dispatched)" });
  log("LOOP", `🔧 bug story ${bugId} is running the pipeline (linked to origin ${id})`);
  // Drive the bug story to shipped too (same machinery; its taps are its OWN, separate from the
  // origin's two). This fully closes the 🔧 loop end to end.
  const bugAcct = await driveStory(bugId, "BUG");

  return { id, originAcct, bugId, bugAcct };
}

// ── main ──────────────────────────────────────────────────────────────────────
let ws, server;
async function main() {
  banner(`S7 AUTONOMY SOAK — port ${PORT} · backend=none · spawner=deterministic · ${MINUTES ? MINUTES + "min continuous" : "one cycle"}`);
  ws = setup();
  log("SETUP", `throwaway git repo ${ws.target}`);
  log("SETUP", `temp db/engine/vault under ${ws.root}`);
  server = boot(ws);
  log("BOOT", `server pid=${server.child.pid} — waiting for health…`);
  await waitHealth();
  log("BOOT", "server healthy");

  // Grant the two build seats auto-apply trust (so their PLAIN-SAFE canned diffs auto-apply and the
  // story flows build→review-qa with NO operator hold — keeping the human taps at exactly two).
  for (const seat of ["sr-backend", "sr-frontend"]) {
    const r = await api("POST", "/runtime/engine/policy", { agentId: seat, level: "auto-safe" });
    log("POLICY", `${seat} → auto-safe (${r.status === 200 ? "ok" : JSON.stringify(r.json)})`);
  }

  // RSS sampling loop.
  const rss = [];
  const startRss = rssKb(server.child.pid);
  const sampler = setInterval(() => { const kb = rssKb(server.child.pid); if (kb) { rss.push(kb); log("RSS", `${(kb / 1024).toFixed(1)} MB (server pid ${server.child.pid})`); } }, MINUTES ? 15000 : 8000);

  const deadline = MINUTES ? Date.now() + MINUTES * 60000 : 0;
  let n = 0, cycles = [];
  try {
    do {
      n++;
      const out = await runCycle(ws, n);
      cycles.push(out);
      if (deadline) { const kb = rssKb(server.child.pid); if (kb) rss.push(kb); }
    } while (deadline && Date.now() < deadline && server.health.crashes === 0);
  } finally {
    clearInterval(sampler);
  }

  const endRss = rssKb(server.child.pid);
  banner("SOAK RESULT");
  console.log(`cycles completed      : ${cycles.length}`);
  console.log(`origin taps / cycle   : ${cycles[0]?.originAcct.taps} (design-approval + release-accept)`);
  console.log(`origin clarify-answers: ${cycles[0]?.originAcct.answers} (operator INPUT, NOT counted as a tap)`);
  console.log(`bug story (per cycle) : minted + linked + ran pipeline; taps=${cycles[0]?.bugAcct.taps} answers=${cycles[0]?.bugAcct.answers}`);
  console.log(`crashes               : ${server.health.crashes}`);
  console.log(`unhandled rejections  : ${server.health.unhandled}`);
  if (rss.length) {
    const min = Math.min(...rss), max = Math.max(...rss);
    console.log(`RSS samples (n=${rss.length}) : start ${(startRss / 1024).toFixed(1)}MB · min ${(min / 1024).toFixed(1)}MB · max ${(max / 1024).toFixed(1)}MB · end ${(endRss / 1024).toFixed(1)}MB`);
  }
  console.log(`elapsed               : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const ok = cycles.length > 0 && server.health.crashes === 0 && server.health.unhandled === 0;
  console.log(`\nVERDICT: ${ok ? "PASS — story shipped itself with two taps; monitor→bug-story loop closed." : "FAIL — see log above."}`);
  return ok;
}

async function shutdown() {
  if (server) { server.health.stopping = true; try { server.child.kill("SIGTERM"); } catch { /* */ } }
  await sleep(400);
  if (ws && !KEEP) { try { rmSync(ws.root, { recursive: true, force: true }); } catch { /* */ } }
  else if (KEEP) log("KEEP", `left tmp workspace at ${ws?.root} and server pid ${server?.child?.pid}`);
}

main()
  .then(async (ok) => { if (!KEEP) await shutdown(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.error(`\nSOAK ERROR: ${e?.stack || e}`); await shutdown(); process.exit(1); });

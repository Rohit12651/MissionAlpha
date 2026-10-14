// Phase 10 · task 10.2 — THE HIRE, END TO END, ON A REAL RUNTIME (no model).
//
// The claim: paste a brief that needs a skill NOBODY on the roster holds, and without a human
// touching anything the Manager asks HR, HR makes exactly one worker, the roster gains it, and
// the parked task is assigned to the new seat.
//
// ITS OWN SERVER AND ITS OWN ROSTER FILE, for the reason JOBHTTP-8/12 have one: this test
// MUTATES the roster, and a shared instance would leak a hired seat into every later test.
// RUNTIME_ROSTER_FILE points at a copy, so the repo's roster.json is never written.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3997;
const TOK = "hrtok";
const auth = { Host: `localhost:${PORT}`, "Content-Type": "application/json", "x-runtime-token": TOK };

let proc, dir, rosterFile;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), "hr-http-"));
  // A COPY of the real roster: the hire must be provable against the seats this app really
  // has, without the test writing to the repo's own file.
  rosterFile = join(dir, "roster.json");
  writeFileSync(rosterFile, readFileSync(join(ROOT, "agent-runtime", "roster.json"), "utf-8"), "utf-8");

  proc = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: {
      ...process.env,
      RUNTIME_BACKEND: "mock", RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK,
      RUNTIME_TOKEN_DIR: dir, RUNTIME_DB_PATH: join(dir, "mission.db"),
      RUNTIME_MAIL_DIR: join(dir, "mail"), RUNTIME_ROSTER_FILE: rosterFile,
      RUNTIME_AGENTS_DIR: join(dir, "agents"),
      RUNTIME_MANAGER_DISPATCH: "deterministic", RUNTIME_SLA_SWEEP_MS: "3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hr server did not start")), 30_000);
    proc.stdout.on("data", (b) => { if (String(b).includes(`listening :${PORT}`)) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`hr server exited ${c}`)); });
  });
});
test.after(() => { try { proc?.kill(); } catch { /* gone */ } });

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: auth }, (res) => {
      let out = ""; res.on("data", (c) => { out += c; });
      res.on("end", () => { let j = null; try { j = JSON.parse(out); } catch { /* */ } resolve({ status: res.statusCode, json: j, body: out }); });
    });
    r.on("error", reject); r.end(body);
  });
}

test("HRHTTP-1: nobody on the seeded roster holds `notifications` — the trap is armed", async () => {
  const r = await req("GET", "/runtime/roster");
  assert.equal(r.status, 200, r.body);
  const holders = r.json.members.filter((m) => (m.skills || []).includes("notifications"));
  assert.equal(holders.length, 0,
    "if a seat already held notifications this test would prove nothing — it would be a match, not a hire");
});

test("HRHTTP-2: a brief needing an unstaffed skill HIRES, and the new seat gets the task", async () => {
  const c = await req("POST", "/runtime/jobs", JSON.stringify({
    title: "Notify on delivery", brief: "send a notification when a delivery lands",
  }));
  assert.equal(c.status, 201, c.body);
  const id = c.json.id;

  let seen = null;
  for (let i = 0; i < 160; i++) {
    seen = (await req("GET", `/runtime/jobs/${id}`)).json;
    const t = (seen.tasks || []).find((x) => (x.skillsRequired || []).includes("notifications"));
    if (t && t.seat && t.status === "queued") break;
    if (["blocked", "awaiting-you"].includes(seen.job.status)) break;
    await new Promise((res) => setTimeout(res, 500));
  }

  const task = (seen.tasks || []).find((x) => (x.skillsRequired || []).includes("notifications"));
  assert.ok(task, `no notifications task was planned: ${JSON.stringify(seen.tasks)}`);
  assert.equal(task.seat, "notifications-engineer",
    `the parked task was not assigned to the hire (job ${seen.job.status}, task ${task.status})`);
  assert.equal(task.status, "queued", "a hired seat's task must be ENQUEUED, not left parked");
});

test("HRHTTP-3: the hire is on the roster, persisted, with createdBy `hr`", async () => {
  const r = await req("GET", "/runtime/roster");
  const hire = r.json.members.find((m) => m.id === "notifications-engineer");
  assert.ok(hire, "the board's roster does not show the new seat");
  assert.equal(hire.role, "worker");
  assert.equal(hire.createdBy, "hr", "a hire must be distinguishable from a seeded seat");
  assert.deepEqual(hire.skills, ["notifications"]);

  // …and it SURVIVES a restart, because roster.add wrote it to disk.
  const onDisk = JSON.parse(readFileSync(rosterFile, "utf-8"));
  assert.ok(onDisk.members.some((m) => m.id === "notifications-engineer"),
    "the hire is only in memory — a restart would lose the agent the Manager is depending on");
});

test("HRHTTP-4: the hire's writeScope is narrow and never CORE_GUARD", async () => {
  const r = await req("GET", "/runtime/roster");
  const hire = r.json.members.find((m) => m.id === "notifications-engineer");
  assert.ok(hire.writeScope.length, "a worker with no scope can do nothing");
  for (const g of hire.writeScope) {
    assert.equal(g.split("/")[0], "src", `hire scope escaped src: ${g}`);
    assert.ok(!/guards\.mjs|roster\.(json|mjs)/.test(g), `hire scope names a CORE_GUARD path: ${g}`);
  }
});

test("HRHTTP-5: the hire has an identity document on disk", async () => {
  assert.ok(existsSync(join(dir, "agents", "notifications-engineer.md")),
    "the seat exists in the roster but nothing records who it is");
});

test("HRHTTP-6: a SECOND job needing the same skill REUSES the hire — one specialist, not two", async () => {
  const c = await req("POST", "/runtime/jobs", JSON.stringify({
    title: "Notify again", brief: "another notification path",
  }));
  const id = c.json.id;
  for (let i = 0; i < 160; i++) {
    const j = (await req("GET", `/runtime/jobs/${id}`)).json;
    const t = (j.tasks || []).find((x) => (x.skillsRequired || []).includes("notifications"));
    if (t && t.seat) break;
    if (["blocked", "awaiting-you"].includes(j.job.status)) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const r = await req("GET", "/runtime/roster");
  const hires = r.json.members.filter((m) => m.createdBy === "hr");
  assert.equal(hires.length, 1, `HR made ${hires.length} agents for one skill — the roster grows without bound`);
});

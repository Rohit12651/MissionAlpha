// Phase 14 · task 14.1 — THE WHOLE LOOP, DETERMINISTICALLY, WITH NO MODEL.
//
// This is the milestone's must_have in one file: paste → plan → build → held → review →
// job-approval → typed approve → SHIPPED, with commits on `ma/job/<id>`, run entirely from
// canned parts so it can live in CI.
//
// WHAT MAKES IT DETERMINISTIC, and none of it weakens a control:
//   RUNTIME_MANAGER_DISPATCH=deterministic  — the Manager's five turns are canned answers
//                                             instead of `claude -p`. The SAME manager.mjs
//                                             validates, bounds and routes them.
//   RUNTIME_ENGINE_SPAWNER=deterministic    — the build leg writes a canned `src/build-<seat>.txt`
//                                             instead of asking a model to author a diff. It
//                                             still flows through the real policy gate, the real
//                                             broker and the real test gate.
//   RUNTIME_BACKEND=mock                    — no chat model anywhere.
//
// NO DOCKER IS NEEDED, and that is a property rather than a wish: the canned file is
// `src/build-*.txt`, `factory/quality.json` scopes tests to known test directories, and a diff
// with no related tests SKIPS the jail and passes. A gate that skipped is recorded as a gate
// that ran with nothing to run — the loop-step receipt says so.
//
// IT RUNS AGAINST A THROWAWAY GIT REPO. `RUNTIME_REPO_ROOT` points at a fresh repo in tmp, so
// the branch, the commits and every worktree land there. A CI test that commits branches into
// the repository under test is a test with a side effect on its own subject.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 3993;
const TOK = "looptok";
const auth = { Host: `localhost:${PORT}`, "Content-Type": "application/json", "x-runtime-token": TOK };

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let proc;
let repo;

/** A minimal target repo: one commit, a `src/` the canned diff can land in. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "loop-repo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "loop@test.local");
  git(dir, "config", "user.name", "Loop Test");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "seed.txt"), "seed\n");
  writeFileSync(join(dir, "README.md"), "# throwaway target repo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: auth }, (res) => {
      let out = ""; res.on("data", (c) => { out += c; });
      res.on("end", () => { let j = null; try { j = JSON.parse(out); } catch { /* */ } resolve({ status: res.statusCode, body: out, json: j }); });
    });
    r.on("error", reject); r.end(body);
  });
}

/** Poll until `pred` holds, recording every DISTINCT job status seen on the way. */
async function until(id, pred, seenStatuses, ms = 180_000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    const r = await req("GET", `/runtime/jobs/${id}`);
    last = r.json;
    const st = last?.job?.status;
    if (st && seenStatuses[seenStatuses.length - 1] !== st) seenStatuses.push(st);
    if (pred(last)) return last;
    await new Promise((res) => setTimeout(res, 400));
  }
  return last;
}

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-run-"));
  repo = makeRepo();
  // SEED the isolated roster from the real one. An EMPTY roster is not a neutral starting
  // point: every task then matches no seat and parks in `awaiting-hire`, so the run measures
  // HR's queue rather than the loop. Copying keeps the seed seats and still keeps the HIRE
  // this brief triggers (`notifications` — a skill no seed seat holds) out of the real file.
  copyFileSync(join(ROOT, "agent-runtime", "roster.json"), join(dir, "roster.json"));
  proc = spawn(process.execPath, [join(ROOT, "agent-runtime", "server.mjs")], {
    env: {
      ...process.env,
      RUNTIME_BACKEND: "mock",
      RUNTIME_MANAGER_DISPATCH: "deterministic",
      RUNTIME_ENGINE_SPAWNER: "deterministic",
      RUNTIME_PORT: String(PORT),
      RUNTIME_TOKEN: TOK,
      RUNTIME_TOKEN_DIR: dir,
      RUNTIME_DB_PATH: join(dir, "mission.db"),
      RUNTIME_MAIL_DIR: join(dir, "mail"),
      RUNTIME_THREADS_DIR: join(dir, "threads"),
      // The roster is WRITTEN to by HR. An isolated copy keeps a hire out of the real one.
      RUNTIME_ROSTER_FILE: join(dir, "roster.json"),
      RUNTIME_REPO_ROOT: repo,
      RUNTIME_WORKTREE_ROOT: join(dir, "worktrees"),
      RUNTIME_SLA_SWEEP_MS: "5000",
      // The resource guard is a THROTTLE keyed to the HOST's load: above 1.5 load/core workers
      // DEFER, which is correct behaviour and fatal to a test that must finish. Raising the
      // ceiling does not bypass the guard — it still runs, still measures, still reports — it
      // just stops this test from being a load test of whatever else the machine is doing.
      // (Measured: on this box at load 3.5/core every task sat `queued` until the poll expired.)
      RUNTIME_GUARD_MAX_LOAD_PER_CORE: "99",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 30_000);
    proc.stdout.on("data", (b) => { if (String(b).includes(`listening :${PORT}`)) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}`)); });
  });
});
test.after(() => { try { proc?.kill(); } catch { /* gone */ } });

test("LOOP-1: paste → shipped, with no model anywhere in the chain", async (t) => {
  // The operator's tree, measured BEFORE. The ship writes commits on its own branch in its own
  // worktree; if any of it reaches the checkout the operator is sitting in, these move.
  const beforeHead = git(repo, "rev-parse", "HEAD");
  const beforeTree = git(repo, "write-tree");
  const beforeBranch = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const beforeDirty = git(repo, "status", "--porcelain");

  const statuses = [];
  const created = await req("POST", "/runtime/jobs", JSON.stringify({
    title: "Relative dates",
    brief: "change the api endpoint so dates read as relative time, and send a notification when it lands",
  }));
  assert.equal(created.status, 201, created.body);
  const id = created.json.id;
  statuses.push(created.json.status);
  assert.equal(created.json.status, "intake");

  // ── to the gate ──────────────────────────────────────────────────────────
  const gated = await until(id, (s) => s?.job?.status === "awaiting-you" && (s.gates || []).some((g) => g.kind === "job-approval"), statuses);
  assert.equal(gated?.job?.status, "awaiting-you",
    `never reached a decision — statuses seen: ${statuses.join(" → ")}, tasks: ${JSON.stringify(gated?.tasks)}`);

  const gate = gated.gates.find((g) => g.kind === "job-approval");
  assert.ok(gate,
    `a job that finished its tasks must ask for ONE ship decision. gates=${JSON.stringify((gated.gates || []).map((g) => ({ kind: g.kind, title: g.title })))} `
    + `tasks=${JSON.stringify((gated.tasks || []).map((tk) => ({ t: tk.title, seat: tk.seat, st: tk.status, paths: tk.changedPaths, blocked: tk.blockedOn })))}`);

  // Every task ended, and each carries the paths it actually changed — the ship commits from
  // exactly these, so an empty set here is a job that would ship nothing and say `shipped`.
  assert.ok(gated.tasks.length >= 1, "the Manager planned no tasks");
  for (const tk of gated.tasks) {
    assert.notEqual(tk.status, "queued", `task "${tk.title}" never resolved`);
  }
  const done = gated.tasks.filter((tk) => (tk.changedPaths || []).length > 0);
  assert.ok(done.length >= 1, `no task reported a changed path: ${JSON.stringify(gated.tasks)}`);

  // EVERY path is inside the seat's own writeScope. This is the assertion that caught the
  // harness bug: the canned diff used to land at `src/build-<seat>.txt` while `sr-backend` is
  // scoped to `src/lib/**`, so the broker filtered the whole thing away and both tasks
  // terminal-failed with an empty diff. A green "loop" that never reaches `held` for a scoped
  // seat is proving a system nobody runs.
  const roster0 = (await req("GET", "/runtime/roster")).json;
  const scopeOf = (seat) => (roster0.members || []).find((m) => m.id === seat)?.writeScope ?? [];
  for (const tk of done) {
    const scope = scopeOf(tk.seat);
    const prefix = String(scope[0] ?? "").split("*")[0].replace(/\/$/, "");
    for (const path of tk.changedPaths) {
      assert.ok(path.startsWith(prefix),
        `${tk.seat} wrote ${path}, outside its writeScope ${JSON.stringify(scope)}`);
    }
  }

  // ── HR: the plan asks for a skill no seed seat holds ──────────────────────
  const roster = (await req("GET", "/runtime/roster")).json;
  const hired = (roster.members || []).filter((m) => m.createdBy === "hr");
  assert.ok(hired.length >= 1,
    "the brief asks for `notifications`, which no seed seat holds — HR should have hired for it");
  assert.ok(gated.tasks.some((tk) => hired.some((h) => h.id === tk.seat)),
    "a seat was hired and then given nothing to do");
  t.diagnostic(`roster ${roster.members?.length} seats, hired: ${hired.map((h) => h.id).join(", ")}`);

  // ── ONE decision ─────────────────────────────────────────────────────────
  const decided = await req("POST", `/inbox/${gate.id}/approve`, JSON.stringify({ confirmHighRisk: true }));
  assert.ok(decided.status < 300, `approve failed: ${decided.status} ${decided.body}`);

  const shipped = await until(id, (s) => s?.job?.status === "shipped", statuses);
  assert.equal(shipped?.job?.status, "shipped",
    `never shipped — statuses seen: ${statuses.join(" → ")}`);

  // ── the branch, and what is on it ─────────────────────────────────────────
  const branch = `ma/job/${id}`;
  const exists = git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  assert.ok(exists, `the ship reported success but ${branch} does not exist`);
  const commits = git(repo, "rev-list", "--count", `${beforeHead}..${branch}`);
  assert.ok(Number(commits) >= 1, `${branch} carries ${commits} commits — a ship with nothing on it is not a ship`);
  // Each commit carries only files from the task it belongs to; nothing outside src/ from the
  // canned build leg should ever appear.
  const files = git(repo, "diff", "--name-only", beforeHead, branch).split("\n").filter(Boolean);
  assert.ok(files.length >= 1, "the branch has no changed files");
  for (const f of files) assert.match(f, /^src\//, `${f} landed outside src/ — the policy gate should have refused it`);

  // ── the operator's checkout is untouched ──────────────────────────────────
  assert.equal(git(repo, "rev-parse", "HEAD"), beforeHead, "HEAD moved under the operator");
  assert.equal(git(repo, "write-tree"), beforeTree, "the operator's INDEX changed");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), beforeBranch, "the operator was moved onto another branch");
  assert.equal(git(repo, "status", "--porcelain"), beforeDirty, "the operator's working tree changed");

  // ── the status ladder ─────────────────────────────────────────────────────
  assert.equal(statuses[0], "intake");
  assert.equal(statuses[statuses.length - 1], "shipped");
  assert.ok(statuses.includes("building"), `never passed through building: ${statuses.join(" → ")}`);
  assert.ok(statuses.includes("review") || statuses.includes("awaiting-you"),
    `never reached a review/decision state: ${statuses.join(" → ")}`);
  t.diagnostic(`ladder: ${statuses.join(" → ")} · ${commits} commit(s) on ${branch} · files ${files.join(", ")}`);

  // ── gh is absent on this machine, so the ship stops at a BRANCH and says so ─
  const ship = shipped.job.summary?.ship;
  assert.ok(ship, "the ship recorded nothing about itself");
  assert.equal(ship.branch, branch);
  assert.equal(shipped.job.prUrl ?? null, null,
    "a PR url appeared with no gh — a branch reported as a PR is the failure this asserts against");
  assert.equal(ship.mode, "branch");
});

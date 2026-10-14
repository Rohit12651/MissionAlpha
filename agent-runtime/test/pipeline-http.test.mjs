// Story-Pipeline S2 — the stage driver at the WIRE, through a REAL booted runtime (mock
// backend, deterministic dispatch, ephemeral state under tmp, pipeline ON). Proves the S2
// exit criteria end to end:
//   create story → advance into requirements → a `question` gate lands + story `waiting-you`
//   → POST /answer → story `active` + auto-advances into design + a `design-approval` gate
//   → approve the design gate → story advances to `plan`.
// Plus the answer route's adversarial sweep: no-token 401, unknown story 404, empty answer 400.
import "./fixtures/isolate-state.mjs"; // FIRST — the booted server must not touch live runtime state (STATE-ISO-2)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, "..", "server.mjs");
const PORT = 3964, TOK = "piptok", BASE = `http://127.0.0.1:${PORT}`;

let root, child;
const H = (x = {}) => ({ Host: `localhost:${PORT}`, "Content-Type": "application/json", ...x });
const auth = (x = {}) => H({ "x-runtime-token": TOK, ...x });
const post = (path, body, headers) => fetch(`${BASE}${path}`, { method: "POST", headers: headers ?? auth(), body: JSON.stringify(body ?? {}) });
const get = (path, headers) => fetch(`${BASE}${path}`, { headers: headers ?? auth() });

async function waitHealth(ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/runtime/health`, { headers: { Host: `localhost:${PORT}` } })).ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server not healthy");
}

// Poll a story until `pred(story, log)` holds — the pipeline runs fire-and-forget, so the
// board settles a beat after the mutation that kicked it.
async function waitStory(id, pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await get(`/runtime/stories/${id}`);
    if (r.ok) { const j = await r.json(); if (pred(j.story, j.log, j)) return j; }
    await new Promise((r) => setTimeout(r, 80));
  }
  return null;
}
async function pendingGates(storyId, kind) {
  const j = await (await get("/inbox?limit=200")).json();
  return (j.deliveries || []).filter((d) => d.storyId === storyId && d.status === "pending" && (!kind || d.kind === kind));
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "ma-pip-http-"));
  mkdirSync(join(root, "repo", "src"), { recursive: true }); // RUNTIME_REPO_ROOT must exist
  mkdirSync(join(root, "sb"), { recursive: true });
  child = spawn(process.execPath, [SERVER], {
    cwd: join(__dir, ".."),
    env: {
      ...process.env,
      RUNTIME_PORT: String(PORT), RUNTIME_TOKEN: TOK, RUNTIME_BACKEND: "mock", RUNTIME_TOOLS: "none",
      RUNTIME_REPO_ROOT: join(root, "repo"), RUNTIME_SEED_DIRS: "src",
      RUNTIME_DB_PATH: join(root, "data", "mission.db"),
      RUNTIME_VAULT_DIR: join(root, "vault"),
      RUNTIME_SANDBOX_ROOT: join(root, "sb"),
      RUNTIME_TOKEN_DIR: join(root, "x", "tok"), RUNTIME_THREADS_DIR: join(root, "x", "threads"),
      RUNTIME_MCP_DIR: join(root, "x", "mcp"), RUNTIME_ENGINE_STORE: join(root, "x", "eng"),
      RUNTIME_WORKTREE_ROOT: join(root, "x", "wt"), RUNTIME_EXEC_WT_ROOT: join(root, "x", "exwt"),
      RUNTIME_SEED_DEFAULTS: "0", ANTHROPIC_API_KEY: "",
      RUNTIME_POLICY_FILE: join(root, "x", "policy.json"),
      RUNTIME_ADAPTERS_FILE: join(root, "x", "adapters.json"),
      FACTORY_REGISTRY_FILE: join(root, "x", "factory", "registry.json"), RUNTIME_AGENTS_DIR: join(root, "x", "agents"),
    },
    stdio: "ignore",
  });
  await waitHealth();
});

after(async () => {
  await new Promise((r) => { if (!child) return r(); child.once("exit", r); try { child.kill("SIGKILL"); } catch { r(); } });
  if (root) rmSync(root, { recursive: true, force: true });
});

test("full gate flow: requirements question → answer → design gate → approve → plan", async () => {
  // Create a story (lands at idea) and advance it into requirements.
  const created = await (await post("/runtime/stories", { title: "Referral bonus", idea: "reward inviters at checkout" })).json();
  const id = created.story.id;
  assert.equal(created.story.stage, "idea");
  await post(`/runtime/stories/${id}/advance`, {}); // idea → requirements → pipeline fires

  // The pm-analyst raises a clarify question — story parks waiting-you, a question gate lands.
  const parked = await waitStory(id, (s) => s.stage === "requirements" && s.status === "waiting-you");
  assert.ok(parked, "story parked waiting-you on a clarify question");
  assert.ok(parked.story.spec && parked.story.spec.startsWith("vault:"), "requirement draft ref stored");
  const qGates = await pendingGates(id, "question");
  assert.equal(qGates.length, 1, "one question gate in the Inbox");
  assert.equal(qGates[0].risk.band, "high");
  assert.equal(qGates[0].diffstat.files, 0);

  // Answer it — the story re-runs requirements, produces the spec, and advances into design.
  const answered = await (await post(`/runtime/stories/${id}/answer`, { deliveryId: qGates[0].id, answer: "the checkout flow" })).json();
  assert.equal(answered.status, "active");
  const inDesign = await waitStory(id, (s) => s.stage === "design" && s.status === "waiting-you");
  assert.ok(inDesign, "auto-advanced into the design gate");
  assert.ok(inDesign.story.designRef && inDesign.story.designRef.startsWith("vault:"));
  assert.equal((await pendingGates(id, "question")).length, 0, "question gate resolved");
  const dGates = await pendingGates(id, "design-approval");
  assert.equal(dGates.length, 1, "a design-approval gate is pending");

  // Approve the design gate via the EXISTING decide route → story advances plan → build and
  // the tech-lead decompose spawns two per-seat engine goals tagged with this storyId (S3).
  const decided = await (await post(`/inbox/${dGates[0].id}/approve`, {})).json();
  assert.equal(decided.status, "approved");
  const inBuild = await waitStory(id, (s) => s.stage === "build", 15000);
  assert.ok(inBuild, "design approval decomposed the plan and advanced the story into build");
  // GET /runtime/stories/:id aggregates the story's engine goals + tasks (the Build panel).
  const withGoals = await waitStory(id, (s, l, j) => (j?.build?.goals || []).length >= 2, 15000);
  assert.ok(withGoals, "the Build panel aggregates the spawned goals");
  const seats = withGoals.build.goals.map((g) => g.seat).sort();
  assert.deepEqual(seats, ["sr-backend", "sr-frontend"], "one goal per seat, parallel");
  assert.ok(withGoals.build.goals.every((g) => g.tasks.length >= 1), "each goal has at least its step-0 task");
});

// S3 — the autonomy fail-safe at the wire. The mock backend cannot produce a diff (the engine
// write-loop needs the cli backend), so every spawned build goal exhausts its retries and fails.
// The story-build driver detects that all goals are terminal-with-failures and parks the story
// `blocked` + surfaces an Inbox alert — a story never sits half-built with no signal.
test("build goals that all fail park the story `blocked` and mint an Inbox alert", async () => {
  const created = await (await post("/runtime/stories", { title: "Blocked build", idea: "will fail under mock" })).json();
  const id = created.story.id;
  await post(`/runtime/stories/${id}/advance`, {}); // → requirements
  await waitStory(id, (s) => s.status === "waiting-you");
  const q = (await pendingGates(id, "question"))[0];
  await post(`/runtime/stories/${id}/answer`, { deliveryId: q.id, answer: "the primary flow" });
  await waitStory(id, (s) => s.stage === "design" && s.status === "waiting-you");
  const dg = (await pendingGates(id, "design-approval"))[0];
  await post(`/inbox/${dg.id}/approve`, {}); // → plan → build → 2 goals spawned (which will fail)

  // Wait out the retry budget (backoff 2+4+8s per goal, parallel) → story blocked.
  const blocked = await waitStory(id, (s) => s.status === "blocked", 45000);
  assert.ok(blocked, "the story is blocked once its goals exhaust their retries");
  assert.equal(blocked.story.stage, "build", "blocking parks status, it does not move the stage");
  assert.ok(blocked.build.counts.failed >= 1, "the Build panel reflects the failed goal(s)");

  // A story-level build-blocked alert is in the Inbox (a diff-less failure delivery).
  const inbox = await (await get("/inbox?limit=200")).json();
  const alert = (inbox.deliveries || []).find((d) => d.kind === "failure" && d.taskId === id);
  assert.ok(alert, "a build-blocked alert surfaced in the Inbox for this story");
});

// S8 — a manual advance may NOT skip a story's OWN open human gate. A story parked at the
// design gate (an open design-approval delivery) is refused a manual advance (409); the legal
// path past the gate is the decide verb. A non-gated stage, and a gate once decided, advance fine.
test("manual advance past an OPEN human gate is refused (409); non-gated + decided still advance", async () => {
  const created = await (await post("/runtime/stories", { title: "No skip", idea: "must not skip the gate" })).json();
  const id = created.story.id;

  // idea → requirements: a non-gated stage with no open gate advances normally.
  assert.equal((await post(`/runtime/stories/${id}/advance`, {})).status, 200, "non-gated advance works");

  // Answer the clarify question → auto-advance into the design gate (parked waiting-you).
  await waitStory(id, (s) => s.status === "waiting-you");
  const q = (await pendingGates(id, "question"))[0];
  await post(`/runtime/stories/${id}/answer`, { deliveryId: q.id, answer: "the primary flow" });
  const inDesign = await waitStory(id, (s) => s.stage === "design" && s.status === "waiting-you");
  assert.ok(inDesign, "parked at the design gate");
  const dg = (await pendingGates(id, "design-approval"))[0];
  assert.ok(dg, "an open design-approval gate exists");

  // Manual advance while the gate is OPEN → 409, and the story does not move.
  const skip = await post(`/runtime/stories/${id}/advance`, {});
  assert.equal(skip.status, 409, "manual advance past an open gate is refused");
  assert.match((await skip.json()).error, /open gate/i, "409 reason names the open gate");
  assert.equal((await (await get(`/runtime/stories/${id}`)).json()).story.stage, "design", "story stayed at the gate");

  // Deciding the gate is the legal path — approve auto-advances the story past design.
  await post(`/inbox/${dg.id}/approve`, {});
  assert.ok(await waitStory(id, (s) => s.stage !== "design", 15000), "the gate-approve path advances the story");
});

test("answer route: 401 without a token, 404 unknown story, 400 empty answer", async () => {
  // Set up a fresh story parked on a question.
  const created = await (await post("/runtime/stories", { title: "Second", idea: "another idea" })).json();
  const id = created.story.id;
  await post(`/runtime/stories/${id}/advance`, {});
  await waitStory(id, (s) => s.status === "waiting-you");
  const q = (await pendingGates(id, "question"))[0];

  // No token → 401 (needsAuth gate).
  const noTok = await post(`/runtime/stories/${id}/answer`, { deliveryId: q.id, answer: "x" }, H());
  assert.equal(noTok.status, 401);
  // Unknown story → 404.
  const unknown = await post(`/runtime/stories/story_deadbeef/answer`, { deliveryId: q.id, answer: "x" });
  assert.equal(unknown.status, 404);
  // Empty answer → 400.
  const empty = await post(`/runtime/stories/${id}/answer`, { deliveryId: q.id, answer: "   " });
  assert.equal(empty.status, 400);
  // The story is still parked (nothing resolved by the rejected attempts).
  const still = await get(`/runtime/stories/${id}`);
  assert.equal((await still.json()).story.status, "waiting-you");
});

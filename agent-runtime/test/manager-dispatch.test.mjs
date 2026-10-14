// Phase 9 · task 9.3 — the Manager's dispatcher.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createManagerDispatch, parseFencedJson, repoFacts, MANAGER_TOOLS, MANAGER_MAX_TURNS } from "../manager-dispatch.mjs";

// ── parsing is FAIL-CLOSED ───────────────────────────────────────────────────
test("MD-PARSE-1: the LAST fenced block wins — a model may fence its working first", () => {
  const r = parseFencedJson('thinking...\n```json\n{"tasks":[]}\n```\nactually:\n```json\n{"tasks":[{"title":"real"}]}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.data.tasks[0].title, "real");
});

test("MD-PARSE-2: no block, bad json, or a non-object is ok:false — never an empty success", () => {
  // A Manager that read `{}` as "no questions, no tasks" would mark a job planned with
  // nothing in it. Every one of these must refuse.
  for (const bad of ["no fences here", "```json\n{not json}\n```", "```json\n[1,2]\n```", "```json\nnull\n```", ""]) {
    const r = parseFencedJson(bad);
    assert.equal(r.ok, false, `must refuse: ${JSON.stringify(bad).slice(0, 40)}`);
    assert.ok(r.error, "and say why");
  }
});

test("MD-PARSE-3: a valid empty object IS a success — that is a real answer", () => {
  assert.equal(parseFencedJson('```json\n{}\n```').ok, true);
});

// ── repo facts ───────────────────────────────────────────────────────────────
test("MD-FACTS-1: facts come from the real tree, and a missing dir is stated not invented", () => {
  const root = mkdtempSync(join(tmpdir(), "ma-facts-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "");
  const f = repoFacts(root, { seedDirs: ["src", "nope"] });
  assert.match(f, /src\/: a\.ts/);
  assert.match(f, /nope\/: \(not present\)/, "a missing directory is a fact, not an omission");
});

test("MD-FACTS-2: a huge directory is capped and says how many were left out", () => {
  const root = mkdtempSync(join(tmpdir(), "ma-facts-"));
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < 90; i++) writeFileSync(join(root, "src", `f${i}.ts`), "");
  assert.match(repoFacts(root, { seedDirs: ["src"], cap: 10 }), /\(\+80 more\)/);
});

// ── deterministic mode ───────────────────────────────────────────────────────
const detFor = (root) => createManagerDispatch({ mode: "deterministic", repoRoot: root });

test("MD-DET-1: intake returns findings and, by default, NO questions", async () => {
  const d = detFor(process.cwd());
  const r = await d.dispatch({ stage: "intake", job: { id: "j", title: "t", brief: "add a formatter" } });
  assert.equal(r.ok, true);
  assert.ok(r.findings.length, "findings come from the real tree");
  assert.deepEqual(r.needs, [], "the good case asks nothing");
});

test("MD-DET-2: a brief containing 'ask' drives the clarify branch deterministically", async () => {
  const r = await detFor(process.cwd()).dispatch({ stage: "intake", job: { id: "j", title: "t", brief: "please ask me about the format" } });
  assert.equal(r.needs.length, 1);
});

test("MD-DET-3: plan derives tasks from the brief's own words", async () => {
  const d = detFor(process.cwd());
  const r = await d.dispatch({ stage: "plan", job: { id: "j", title: "t", brief: "change the ui component and add a test" } });
  const skills = r.tasks.flatMap((t) => t.skillsRequired);
  assert.ok(skills.includes("ui"));
  assert.ok(skills.includes("test"));
});

test("MD-DET-4: a brief naming notifications asks for a skill NO seed seat holds", async () => {
  // 10.2 and 14.1 need a deterministic HIRE. If this stops producing an unstaffed skill,
  // those phases silently lose their hire proof.
  const r = await detFor(process.cwd()).dispatch({ stage: "plan", job: { id: "j", title: "t", brief: "send a notification on ship" } });
  assert.ok(r.tasks.some((t) => t.skillsRequired.includes("notifications")));
});

test("MD-DET-5: a brief with no keywords still yields ONE actionable task", async () => {
  const r = await detFor(process.cwd()).dispatch({ stage: "plan", job: { id: "j", title: "t", brief: "make it nicer" } });
  assert.equal(r.tasks.length, 1);
  assert.ok(r.tasks[0].steps.length, "a task with no steps is not a task");
});

test("MD-DET-6: manage reorders around a blocked task", async () => {
  const jobs = { tasks: () => [{ status: "blocked" }, { status: "queued" }] };
  const d = createManagerDispatch({ mode: "deterministic", repoRoot: process.cwd(), jobs });
  const r = await d.dispatch({ stage: "manage", job: { id: "j", title: "t", brief: "b" } });
  assert.equal(r.action, "replan");
  assert.deepEqual(r.order, [2, 1], "the blocked task moves last");
});

test("MD-DET-7: an unknown stage is refused", async () => {
  assert.equal((await detFor(process.cwd()).dispatch({ stage: "teleport", job: { id: "j" } })).ok, false);
});

// ── claude mode ──────────────────────────────────────────────────────────────
test("MD-CLAUDE-1: the Manager's tools are READ-ONLY — no Write, no Edit, Bash allow-listed", () => {
  assert.equal(MANAGER_TOOLS.includes("Write"), false, "the Manager must never be able to write code");
  assert.equal(MANAGER_TOOLS.includes("Edit"), false);
  assert.equal(MANAGER_TOOLS.includes("Bash"), false, "bare Bash would grant rm/curl/git push");
  for (const t of MANAGER_TOOLS.filter((x) => x.startsWith("Bash("))) {
    assert.match(t, /^Bash\([a-z ]+:\*\)$/, `${t} must be a command-scoped specifier`);
    assert.equal(/\b(rm|mv|cp|curl|wget|push|chmod|npm|node|sh)\b/.test(t), false, `${t} is mutating`);
  }
});

test("MD-CLAUDE-2: the spawn receives the read-only tools, a turn cap and a cwd", async () => {
  let got = null;
  const d = createManagerDispatch({
    mode: "claude", repoRoot: process.cwd(),
    spawn: async (a) => { got = a; return '```json\n{"findings":[],"needs":[]}\n```'; },
  });
  const r = await d.dispatch({ stage: "intake", job: { id: "j", title: "t", brief: "b" } });
  assert.equal(r.ok, true);
  assert.deepEqual(got.tools, MANAGER_TOOLS);
  assert.equal(got.maxTurns, MANAGER_MAX_TURNS, "an uncapped Manager is a runaway");
  assert.ok(got.cwd, "it runs somewhere explicit, never an inherited cwd");
  assert.match(got.prompt, /READ-ONLY/);
});

test("MD-CLAUDE-3: a malformed model reply is ok:false, and the job is not advanced on it", async () => {
  const d = createManagerDispatch({ mode: "claude", repoRoot: process.cwd(), spawn: async () => "I could not do that." });
  const r = await d.dispatch({ stage: "intake", job: { id: "j", title: "t", brief: "b" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /no fenced json/);
});

test("MD-CLAUDE-4: a spawn that throws becomes ok:false, never an exception through tick()", async () => {
  const d = createManagerDispatch({ mode: "claude", repoRoot: process.cwd(), spawn: async () => { throw new Error("429 rate limit"); } });
  const r = await d.dispatch({ stage: "intake", job: { id: "j", title: "t", brief: "b" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /429/);
});

test("MD-CLAUDE-5: mode=claude with no spawn wired refuses instead of pretending", async () => {
  const d = createManagerDispatch({ mode: "claude", repoRoot: process.cwd() });
  assert.equal((await d.dispatch({ stage: "intake", job: { id: "j" } })).ok, false);
});

test("MD-CLAUDE-6: the throwaway worktree is RELEASED even when the spawn throws", async () => {
  const released = [];
  const d = createManagerDispatch({
    mode: "claude", repoRoot: process.cwd(),
    worktrees: { create: (k) => ({ path: `/tmp/wt-${k}` }), release: (k) => released.push(k) },
    spawn: async () => { throw new Error("boom"); },
  });
  await d.dispatch({ stage: "intake", job: { id: "j1", title: "t", brief: "b" } });
  assert.deepEqual(released, ["mgr_j1"], "a leaked checkout per failed turn would fill the disk");
});

// ── /cso 2026-09-24 (HIGH, variant of the chat-path fix) ─────────────────────────
// The Manager spawns with `--setting-sources project`. In a worktree that is safe: worktree.mjs
// strips `.claude/` at creation. With NO worktree (a non-git target, or a failed create) the
// fallback cwd is the TARGET itself, and `-p` skips workspace trust — so a foreign folder's
// committed `.claude/settings.json` hooks would run on the host at job intake. Untrusted repo
// + no isolated checkout ⇒ refuse the stage; never spawn in it.
test("MD-UNTRUSTED-1: no worktree + untrusted repo ⇒ the stage is refused and nothing is spawned", async () => {
  let spawned = 0;
  const d = createManagerDispatch({ mode: "claude", repoRoot: process.cwd(), repoTrusted: false, spawn: async () => { spawned++; return "```json\n{}\n```"; } });
  const r = await d.dispatch({ stage: "intake", job: { id: "job_x", brief: "b" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /untrusted/);
  assert.equal(spawned, 0, "the Manager ran inside a repo nobody vetted");
});

test("MD-UNTRUSTED-2 (GOOD): an untrusted repo WITH an isolated worktree still runs, in the worktree", async () => {
  let cwdSeen = null;
  const worktrees = { create: () => ({ path: "/tmp/wt/mgr_job_y" }), release: () => {} };
  const d = createManagerDispatch({ mode: "claude", repoRoot: process.cwd(), repoTrusted: false, worktrees, spawn: async ({ cwd }) => { cwdSeen = cwd; return "```json\n{\"findings\":[],\"needs\":[]}\n```"; } });
  const r = await d.dispatch({ stage: "intake", job: { id: "job_y", brief: "b" } });
  assert.equal(r.ok, true, r.error);
  assert.equal(cwdSeen, "/tmp/wt/mgr_job_y");
});

test("MD-UNTRUSTED-WIRED: server.mjs hands createManagerDispatch the repo-scripts trust decision", async () => {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("acorn");
  const ast = parse(readFileSync(new URL("../server.mjs", import.meta.url), "utf8"), { ecmaVersion: "latest", sourceType: "module" });
  let prop = null;
  const walk = (n) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "CallExpression" && n.callee?.name === "createManagerDispatch") prop = n.arguments[0]?.properties?.find((p) => p.key?.name === "repoTrusted") ?? prop;
    for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") walk(v); }
  };
  walk(ast);
  assert.ok(prop, "createManagerDispatch must receive repoTrusted — its default is the trusting one");
  assert.equal(prop.value?.object?.name, "repoScripts");
  assert.equal(prop.value?.property?.name, "trusted");
});

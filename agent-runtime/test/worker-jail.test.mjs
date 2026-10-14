// Phase E · Task 18 — WORKERS IN A JAIL (Option 2, BOSS-approved 2026-09-24).
//
// Every worker seat runs `claude -p` on the HOST. applyAllowed, CORE_GUARD, writeScope and strict
// ship all guard what gets LANDED; none of them guard what the child DOES while it runs. A worker's
// Bash could write ~/.zshrc or delete another repo, and the broker would never see it.
//
// Option 2: the Claude CLI's own OS sandbox (Seatbelt on macOS, bubblewrap on Linux), passed per
// spawn with `--settings`. Writes are confined to the worktree + session temp; the model's
// `dangerouslyDisableSandbox` retry is off; a missing sandbox is a hard failure, never a silent
// unsandboxed run. Scope (docs): Bash and its children — NOT the Read/Edit/Write tools, which stay
// bounded by `--add-dir` + permission mode.
//
// Mode: RUNTIME_WORKER_JAIL=cli ⇒ on; =off ⇒ off; unset ⇒ on exactly when the target is NOT trusted
// (a repo that is not MissionAlpha) — the same trust decision as Task 17.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "acorn";

import { workerJail } from "../worker-jail.mjs";
import { CORE_GUARD, applyAllowed } from "../guards.mjs";

test("JAIL-MODE-1: the flag decides; unset follows target trust", () => {
  assert.equal(workerJail({ env: "cli", trusted: true }).on, true);
  assert.equal(workerJail({ env: "off", trusted: false }).on, false);
  assert.equal(workerJail({ env: undefined, trusted: false }).on, true, "a foreign repo is jailed by default");
  assert.equal(workerJail({ env: undefined, trusted: true }).on, false, "MissionAlpha itself keeps today's behaviour");
});

test("JAIL-MODE-2: an unrecognised flag value fails CLOSED, never open", () => {
  assert.equal(workerJail({ env: "docker", trusted: true }).on, true);
  assert.equal(workerJail({ env: "yes", trusted: true }).on, true);
});

test("JAIL-1 (argv): jailed settings enable the sandbox, close the escape hatch, and refuse to run unsandboxed", () => {
  const j = workerJail({ env: "cli", trusted: true });
  const s = JSON.parse(j.settings).sandbox;
  assert.equal(s.enabled, true);
  assert.equal(s.allowUnsandboxedCommands, false, "the model's dangerouslyDisableSandbox retry must be ignored");
  assert.equal(s.failIfUnavailable, true, "JAIL-3: no sandbox ⇒ the CLI refuses to start, it never runs on the host");
  assert.ok(s.filesystem.denyRead.includes("~/.ssh"), "a worker's shell must not read the operator's keys");
  assert.equal(s.filesystem.allowWrite, undefined, "the jail adds no writable path beyond the worktree + temp");
  assert.equal(workerJail({ env: "off", trusted: true }).settings, null);
});

test("JAIL-2: jail off ⇒ a readiness WARNING naming the risk; on ⇒ none", () => {
  assert.match(workerJail({ env: "off", trusted: true }).warning, /workers run on the host/);
  assert.equal(workerJail({ env: "cli", trusted: true }).warning, null);
});

test("JAIL-GUARD: the jail's own definition is behind the floor", () => {
  assert.equal(CORE_GUARD.test("agent-runtime/worker-jail.mjs"), true);
  assert.equal(applyAllowed("agent-runtime/worker-jail.mjs"), false);
});

// ── the wiring: every test above passes against a server that never passes the settings ──
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit));
    else if (v && typeof v === "object" && typeof v.type === "string") walk(v, visit);
  }
}
const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
const fnNamed = (name) => { let f = null; walk(ast, (n) => { if (n.type === "FunctionDeclaration" && n.id?.name === name) f = n; }); return f; };

test("JAIL-WIRED-1: the engine argv builder passes --settings <jail> when ctx carries it — and stays pure", async () => {
  const fn = fnNamed("buildEngineSpawnArgs");
  assert.ok(fn);
  const build = (await import(`data:text/javascript;base64,${Buffer.from(`${src.slice(fn.start, fn.end)}\nexport { buildEngineSpawnArgs };`).toString("base64")}`)).buildEngineSpawnArgs;
  const base = (ctx) => ["-p", "--add-dir", ctx.workdir];
  const jailed = build({ engineId: "claude", workdir: "/w", jailSettings: '{"sandbox":{}}' }, base);
  const i = jailed.indexOf("--settings");
  assert.ok(i >= 0, JSON.stringify(jailed));
  assert.equal(jailed[i + 1], '{"sandbox":{}}');
  assert.ok(!build({ engineId: "claude", workdir: "/w", jailSettings: null }, base).includes("--settings"), "no jail ⇒ no flag");
  assert.ok(!build({ engineId: "codex", workdir: "/w", jailSettings: '{"sandbox":{}}' }, base).includes("--settings"),
    "--settings is a claude flag; codex would reject it as an unknown argument (codex has its own workspace-write sandbox)");
});

test("JAIL-WIRED-2: engineDispatch hands the builder the server's jail settings", () => {
  const fn = fnNamed("engineDispatch");
  assert.ok(fn);
  let passed = false;
  walk(fn, (n) => {
    if (n.type !== "CallExpression" || n.callee?.name !== "buildEngineSpawnArgs") return;
    const p = n.arguments[0]?.properties?.find((x) => x.key?.name === "jailSettings");
    if (p?.value?.type === "MemberExpression" && p.value.object?.name === "jail" && p.value.property?.name === "settings") passed = true;
  });
  assert.ok(passed, "buildEngineSpawnArgs must receive jailSettings: jail.settings");
});

test("JAIL-WIRED-3: GET /runtime/engine/readiness carries the jail warning", () => {
  let route = null;
  walk(ast, (n) => {
    if (n.type !== "IfStatement") return;
    const lits = []; walk(n.test, (x) => { if (x.type === "Literal") lits.push(x.value); });
    if (lits.includes("GET") && lits.includes("/runtime/engine/readiness")) route = n;
  });
  assert.ok(route, "the GET readiness route must exist");
  let reads = false;
  walk(route.consequent, (n) => { if (n.type === "MemberExpression" && n.object?.name === "jail" && n.property?.name === "warning") reads = true; });
  assert.ok(reads, "the readiness route must read jail.warning");
});

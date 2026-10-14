// Phase E · Task 16 — THE FLOOR FAILS CLOSED.
//
// Until now `applyAllowed(p, { seat: undefined })` returned the LEGACY allow-set: every
// SEED_DIRS path. That is the right answer for a single-argument caller that never had a seat
// to give (patch-edit, policy). It is the wrong answer on the two paths that land an AGENT's
// work — the engine broker and the ship ladder — where "I could not resolve which seat wrote
// this" means the narrowing never ran. There, unknown must mean no.
//
// A task whose seat does not resolve reaches those paths today whenever its agentId is not on
// the roster: /runtime/engine/enqueue takes any sanitised agentId, and scheduled cadences and
// reruns enqueue by agent name. Each one got the whole seed tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "acorn";

import { applyAllowed, CORE_GUARD } from "../guards.mjs";
import { createBroker } from "../broker.mjs";
import { createPr } from "../pr.mjs";
import { createWorktreeMgr } from "../worktree.mjs";

const FRONTEND = { id: "sr-frontend", role: "worker", writeScope: ["src/**"] };

// ── GUARD-1 (BAD): no seat on a strict path is a refusal ──────────────────────
test("GUARD-1a: strict + no seat refuses a path the legacy rule allows", () => {
  assert.equal(applyAllowed("src/x.ts"), true, "premise: the legacy rule allows it");
  assert.equal(applyAllowed("src/x.ts", { seat: undefined, strict: true }), false);
  assert.equal(applyAllowed("src/x.ts", { seat: null, strict: true }), false);
  assert.equal(applyAllowed("src/x.ts", { strict: true }), false);
});

test("GUARD-1b (GOOD): strict does not change a resolved seat's answer", () => {
  assert.equal(applyAllowed("src/components/X.tsx", { seat: FRONTEND, strict: true }), true);
  assert.equal(applyAllowed("agent-runtime/kpis.mjs", { seat: FRONTEND, strict: true }), false);
  // A resolved non-worker seat is a roster decision (roster.json is CORE_GUARD). Strict refuses
  // the UNRESOLVED case only; it does not re-decide what the operator configured.
  const station = { id: "architect", role: "station", writeScope: [] };
  assert.equal(applyAllowed("src/x.ts", { seat: station, strict: true }), applyAllowed("src/x.ts"));
});

function brokerFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ma-guard-strict-")));
  const repoRoot = join(root, "repo");
  const workdir = join(root, "work");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeFileSync(join(workdir, "src", "x.ts"), "export const x = 1;\n");
  return { repoRoot, workdir };
}

test("GUARD-1c: the ENGINE broker, strict, refuses an unresolved seat's work and writes nothing", async () => {
  const f = brokerFixture();
  const broker = createBroker({ repoRoot: f.repoRoot, workdirFor: () => f.workdir, scrub: (s) => s, seatFor: () => null, strict: true });
  const listed = await broker.listChangesDetailed("task_unrostered");
  assert.equal(listed.changes.length, 0, "an unresolved seat's work must not be listed as appliable");
  assert.ok(listed.refused.some((r) => String(r).startsWith("src/x.ts")), "and it must be REPORTED as refused, not dropped");
  const r = await broker.applyChanges("task_unrostered", ["src/x.ts"]);
  assert.equal(r[0].ok, false);
  assert.match(r[0].error, /no roster seat/, "the operator must be told WHY, not just 'not allowed'");
  assert.equal(existsSync(join(f.repoRoot, "src", "x.ts")), false, "refused means no side-effect");
});

test("GUARD-1d (GOOD): the same strict broker still lands a resolved worker's in-scope work", async () => {
  const f = brokerFixture();
  const broker = createBroker({ repoRoot: f.repoRoot, workdirFor: () => f.workdir, scrub: (s) => s, seatFor: () => FRONTEND, strict: true });
  const r = await broker.applyChanges("task_frontend", ["src/x.ts"]);
  assert.deepEqual(r, [{ path: "src/x.ts", ok: true }]);
  assert.equal(readFileSync(join(f.repoRoot, "src", "x.ts"), "utf-8"), "export const x = 1;\n");
});

function shipFixture(prOpts) {
  const root = mkdtempSync(join(tmpdir(), "ma-guard-ship-"));
  const repoRoot = join(root, "repo");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  const g = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" }).trim();
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  writeFileSync(join(repoRoot, "src", "x.ts"), "old\n");
  g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  const wt = createWorktreeMgr({ repoRoot, worktreeRoot: join(root, "wt") });
  const pr = createPr({ repoRoot, worktreeMgr: wt, audit: () => {}, scrub: (s) => s, ...prOpts });
  return { wt, pr, baseSha: g(["rev-parse", "HEAD"]) };
}

test("GUARD-1e: the SHIP ladder, strict, refuses to commit an unresolved seat's work", async () => {
  const s = shipFixture({ strict: true, seatFor: () => null });
  const jb = await s.pr.createJobBranch("job_strict", s.baseSha);
  assert.ok(jb.ok, jb.reason);
  const p = s.wt.create("task_unrostered").path ?? s.wt.pathFor("task_unrostered");
  writeFileSync(join(p, "src", "x.ts"), "new\n");
  const c = await s.pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_unrostered", paths: ["src/x.ts"], message: "feat: x" });
  assert.equal(c.ok, false, "ship committed work from a task whose seat could not be resolved");
  assert.ok(c.refused.some((r) => r.startsWith("src/x.ts")), JSON.stringify(c));
});

test("GUARD-1f (GOOD): the strict ship ladder commits a resolved worker's in-scope work", async () => {
  const s = shipFixture({ strict: true, seatFor: () => FRONTEND });
  const jb = await s.pr.createJobBranch("job_strict_ok", s.baseSha);
  const p = s.wt.create("task_frontend").path ?? s.wt.pathFor("task_frontend");
  writeFileSync(join(p, "src", "x.ts"), "new\n");
  const c = await s.pr.commitTask({ jobWorktree: jb.worktree, taskId: "task_frontend", paths: ["src/x.ts"], message: "feat: x" });
  assert.ok(c.ok, c.reason);
});

test("GUARD-1g: the P5 approve ladder (deliverApproved), strict, refuses an unresolved seat's paths", async () => {
  const s = shipFixture({ strict: true, seatFor: () => null });
  const p = s.wt.create("task_p5").path ?? s.wt.pathFor("task_p5");
  writeFileSync(join(p, "src", "x.ts"), "new\n");
  const out = await s.pr.deliverApproved({ taskId: "task_p5", paths: ["src/x.ts"], title: "t", summary: "s", agentId: "ghost", kind: "code" });
  assert.ok(out.refused.some((r) => r.startsWith("src/x.ts")), JSON.stringify(out));
});

// ── the wiring: every GUARD-1 test above passes against a server that never asks ──
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit));
    else if (v && typeof v === "object" && typeof v.type === "string") walk(v, visit);
  }
}
const serverAst = () => parse(readFileSync(new URL("../server.mjs", import.meta.url), "utf8"), { ecmaVersion: "latest", sourceType: "module" });
const propOf = (call, name) => call.arguments[0]?.properties?.find((p) => p.key?.name === name);
const isTrue = (p) => p?.value?.type === "Literal" && p.value.value === true;

test("GUARD-1-WIRED: server.mjs builds the engine broker and the ship ladder strict, with a seat resolver", () => {
  const brokers = [];
  const ladders = [];
  walk(serverAst(), (n) => {
    if (n.type !== "CallExpression") return;
    if (n.callee?.name === "createBroker") brokers.push(n);
    if (n.callee?.name === "createPr") ladders.push(n);
  });
  // The ENGINE broker is the one whose seat resolver goes through the engine queue.
  const engineBroker = brokers.find((b) => {
    let viaQueue = false;
    walk(propOf(b, "seatFor"), (n) => { if (n.type === "Identifier" && n.name === "engineQueue") viaQueue = true; });
    return viaQueue;
  });
  assert.ok(engineBroker, "no createBroker call resolves its seat through engineQueue");
  assert.ok(isTrue(propOf(engineBroker, "strict")), "the engine broker must be built with strict: true");
  assert.equal(ladders.length, 1, "expected exactly one ship ladder");
  assert.ok(isTrue(propOf(ladders[0], "strict")), "the ship ladder must be built with strict: true");
  assert.ok(propOf(ladders[0], "seatFor"), "a strict ladder with no seatFor refuses every task — ship would never land");
});

// ── GUARD-2 (GOOD): the legacy single-argument callers, enumerated ──────────────
// Addendum #11: enumerate the call graph. The plan named FOUR legacy callers; the census on
// 2026-09-24 found these, and every one is either not a write path or a human-approved one:
//   patch-edit.mjs  `applyAllowed(path)`          — operator's own patch edit, pre-broker check
//   policy.mjs ×2   `applyAllowed(relPath)` / `(p)` — auto-safe predicate; must stay ⊆ broker
//   factory.mjs     `applyAllowed(entry)`         — validates a roster SPEC; writes nothing
//   broker.mjs ×2   `applyAllowed(rel)`           — diagnostic only, AFTER a refusal, to word it
// Any NEW single-argument caller turns this red, so it has to be argued for here.
const LEGACY_SINGLE_ARG = { "patch-edit.mjs": 1, "policy.mjs": 2, "factory.mjs": 1, "broker.mjs": 2 };

function runtimeSources() {
  const dir = new URL("../", import.meta.url);
  const out = [];
  for (const f of readdirSync(dir)) if (f.endsWith(".mjs")) out.push(f);
  for (const f of readdirSync(new URL("providers/", dir))) if (f.endsWith(".mjs")) out.push(`providers/${f}`);
  return out;
}

test("GUARD-2: the single-argument applyAllowed callers are exactly the documented legacy set", () => {
  const found = {};
  for (const f of runtimeSources()) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    if (!src.includes("applyAllowed") && !src.includes("allowed(")) continue;
    walk(parse(src, { ecmaVersion: "latest", sourceType: "module" }), (n) => {
      if (n.type !== "CallExpression") return;
      const name = n.callee?.name;
      // pr.mjs calls it through the `allowed` alias (so tests can inject one).
      if (name !== "applyAllowed" && !(f === "pr.mjs" && name === "allowed")) return;
      if (n.arguments.length < 2) found[f] = (found[f] || 0) + 1;
    });
  }
  assert.deepEqual(found, LEGACY_SINGLE_ARG);
});

test("GUARD-2b (GOOD): the legacy answer is unchanged for those callers", () => {
  assert.equal(applyAllowed("src/a.ts"), true);
  assert.equal(applyAllowed("public/billsplit.html"), true);
  assert.equal(applyAllowed("README.md"), true);
  assert.equal(applyAllowed("agent-runtime/test/kpis.test.mjs"), true);
  // Decision #1 (2026-09-27): every runtime module is behind RUNTIME_FLOOR, for these callers too.
  assert.equal(applyAllowed("agent-runtime/kpis.mjs"), false);
  assert.equal(applyAllowed("agent-runtime/guards.mjs"), false);
});

// ── GUARD-3: the floor now covers the files that route, dispatch and hire ────────
test("GUARD-3: CORE_GUARD refuses factory, mailbox, manager, seat-settings-guard and providers/*", () => {
  for (const p of [
    "agent-runtime/factory.mjs",             // validates roster specs → what a hire may write
    "agent-runtime/mailbox.mjs",             // the routing table: who may mail whom
    "agent-runtime/manager.mjs",             // dispatch, scope disjointness, ship
    "agent-runtime/seat-settings-guard.mjs", // a seat's CLI permission settings
    "agent-runtime/workdir-guard.mjs",       // assertCanonicalInside — the containment check broker AND pr call
    "agent-runtime/providers/credentials.mjs",
    "agent-runtime/providers/crypto.mjs",
    "agent-runtime/providers/child-env.mjs",
    "agent-runtime/providers/url-guard.mjs",
    "agent-runtime/providers/exec-tools.mjs",
    "agent-runtime/providers/adapters/anything.mjs",
    // Open MEDIUM from the Phase E security pass (independent reviewer), closed 2026-09-24:
    "agent-runtime/engine.mjs",           // the loop that decides auto-apply vs hold
    "agent-runtime/tool-broker.mjs",      // executes tool calls for non-CLI providers
    "agent-runtime/mcp/mail-tools.mjs",   // the mail tool every seat is handed
    "agent-runtime/mail-env.mjs",         // what that tool may address
    // …and three control files added in Phases E/F whose whole job is to refuse something:
    "agent-runtime/manager-prompts.mjs",  // the approved prompt text AND STRATEGY_PROMPT_APPROVED
    "agent-runtime/manager-dispatch.mjs", // repoTrusted refusal + the approval check + which ceo.md
    "agent-runtime/deliveries.mjs",       // decide(): the approve/reject gate itself
  ]) {
    assert.equal(CORE_GUARD.test(p), true, `${p} must be matched by CORE_GUARD`);
    assert.equal(applyAllowed(p), false, `${p} must never be appliable`);
  }
});

test("GUARD-3b (GOOD): CORE_GUARD names are exact — the neighbours are not CORE_GUARD matches", () => {
  // Decision #1 (2026-09-27): the neighbours are no longer APPLIABLE (RUNTIME_FLOOR refuses all of
  // agent-runtime/ outside its test dirs), but the CORE_GUARD regex must stay exact: fatalScopeProblem
  // treats a literal CORE_GUARD match as an attack and refuses the whole roster entry.
  for (const p of [
    "agent-runtime/factory-notes.md",
    "agent-runtime/mailbox-helpers.mjs",
    "agent-runtime/providers-legacy/x.mjs",
    "agent-runtime/engine-readiness.mjs", // engine.mjs is guarded; its exact-name neighbour is not
  ]) {
    assert.equal(CORE_GUARD.test(p), false, `${p} is not a CORE_GUARD file`);
    assert.equal(applyAllowed(p), false, `${p} is refused by RUNTIME_FLOOR`);
  }
});

// ── GUARD-4: Unicode case folding (security pass, 2026-09-24) ─────────────────────
// `i` without `u` folds ASCII only. On case-insensitive APFS, `guardſ.mjs` (U+017F long s) and
// `hooKs.mjs` (U+212A Kelvin sign) resolve to the SAME inode as guards.mjs / hooks.mjs — probe run
// by the reviewer — yet every deny list said "not me". One flag, all three lists.
test("GUARD-4: Unicode case-fold variants of a guarded name are refused by every deny list", () => {
  const S = "\u017f"; // ſ folds to s
  const K = "\u212a"; // K folds to k
  for (const p of [
    `agent-runtime/guard${S}.mjs`,   // CORE_GUARD
    `agent-runtime/hoo${K}s.mjs`,    // CORE_GUARD
    `src/id.${K}ey`,                 // APPLY_DENY — a private key
  ]) assert.equal(applyAllowed(p), false, `${JSON.stringify(p)} slipped a deny list`);
  assert.equal(applyAllowed(`public/app.j${S}`), false, "PUBLIC_DENY: public/*.js served verbatim");
});

test("GUARD-4b (GOOD): ordinary non-ASCII names are still ordinary work", () => {
  assert.equal(applyAllowed("docs/r\u00e9sum\u00e9.md"), true);
  assert.equal(applyAllowed("src/\u65e5\u672c.ts"), true);
});

// ── GUARD-5: no un-routed manual apply (security pass, 2026-09-24) ────────────────
// On a NON-git target the engine's workdir IS sandboxDir(taskId) — the same folder the manual
// broker reads. POST /runtime/task_<hex>/apply went to the bare, non-strict manual applyChanges,
// found the engine task's work there, and landed it with the legacy allow-set. Every apply in
// server.mjs must choose its broker by key (brokerFor), so a task key always meets the strict one.
test("GUARD-5: server.mjs never calls the bare manual applyChanges — every apply picks its broker by key", () => {
  const bare = [];
  walk(serverAst(), (n) => {
    if (n.type === "CallExpression" && n.callee?.type === "Identifier" && n.callee.name === "applyChanges") bare.push(n.start);
  });
  assert.deepEqual(bare, [], "a bare applyChanges(key, …) bypasses brokerFor and, for a task key on a non-git target, strict");
});

// ── GUARD-6 (security review 2026-09-24, HIGH): the rest of the control plane ──────
// A second independent review probed applyAllowed over agent-runtime/ and found these still
// appliable. Each decides who may do what, what gets reviewed, or what runs:
test("GUARD-6: the remaining control-plane files are behind the floor", () => {
  for (const p of [
    "agent-runtime/users.mjs",          // auth and roles
    "agent-runtime/risk.mjs",           // feeds the auto-approve band
    "agent-runtime/patch-edit.mjs",     // a write path
    "agent-runtime/task-diff.mjs",      // what the BOSS is shown at review
    "agent-runtime/jobs.mjs",           // the job status transition table
    "agent-runtime/deploy.mjs",         // runs deploys
    "agent-runtime/story-deploy.mjs",
    "agent-runtime/adapters/github.mjs",// external decisions
    "agent-runtime/station-perms.mjs",  // seat powers …
    "agent-runtime/perm-mode.mjs",
    "agent-runtime/worker-cap.mjs",
    "agent-runtime/trust.mjs",
    "agent-runtime/inject-detect.mjs",  // the prompt-injection detector
    "agent-runtime/mcp/ash-tools.mjs",  // Ash's one tool
    "agent-runtime/engine-spawner.mjs", // what a seat is launched as
    "agent-runtime/pipeline.mjs",       // story gates
    "agent-runtime/db.mjs",             // schema + migrations
    "agent-runtime/hr.mjs",             // hiring writes the roster
  ]) {
    assert.equal(CORE_GUARD.test(p), true, `${p} must be matched by CORE_GUARD`);
    assert.equal(applyAllowed(p), false, `${p} must never be appliable`);
  }
  // Decision #1 (2026-09-27): read-only ingress adapters are not CORE_GUARD, but no runtime module is appliable.
  assert.equal(CORE_GUARD.test("agent-runtime/adapters/slack.mjs"), false);
  assert.equal(applyAllowed("agent-runtime/adapters/slack.mjs"), false);
});

test("GUARD-7: lockfiles are never appliable — an agent has no business rewriting resolved/integrity", () => {
  // A dependency CHANGE is already refused (CONFIG_GUARD on package.json), so an agent-authored
  // lockfile edit has no legitimate source — and `resolved`/`integrity` point `npm ci` at code.
  // Nested paths prove it (a root-level file is refused by the seed rule anyway).
  for (const p of ["agent-runtime/package-lock.json", "src/x/package-lock.json", "agent-runtime/yarn.lock", "src/pnpm-lock.yaml", "agent-runtime/npm-shrinkwrap.json"]) {
    assert.equal(applyAllowed(p), false, p);
  }
});

test("GUARD-8: runtime STATE under agent-runtime/ is never appliable (re-review 2026-09-24, HIGH)", () => {
  // engine-store/mcp/mcp-connectors.json is loaded without re-validation and its launcher
  // allowlist includes node/python — a connector entry is host code. threads/ holds the BOSS and
  // CEO conversation history. The token file is the runtime's auth secret.
  for (const p of ["agent-runtime/engine-store/mcp/mcp-connectors.json", "agent-runtime/engine-store/tasks/task_x.json",
    "agent-runtime/threads/boss.json", "agent-runtime/threads/ceo.json", "agent-runtime/sandboxes/x/file.txt",
    "agent-runtime/.runtime-token"]) {
    assert.equal(applyAllowed(p), false, p);
  }
});

test("GUARD-9: package-manager config files are never appliable — they run code on every npm script", () => {
  // NESTED paths are the ones that prove the rule: a root-level dotfile is refused by the seed
  // rule anyway (only README.md and package.json are appliable at the root).
  for (const p of ["agent-runtime/.npmrc", "src/x/.npmrc", "agent-runtime/.yarnrc", "src/.yarnrc.yml", "agent-runtime/.pnpmfile.cjs", "src/.pnpmfile.cjs"]) {
    assert.equal(applyAllowed(p), false, p);
  }
});

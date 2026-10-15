// Phase 7 · task 7.3 — THE SEAT'S ARGV: per-seat tools and SKILL BODIES.
//
// THE DEFECT THIS CLOSES: today a seat is told the NAMES of its skills. A name is not a
// playbook — "you hold the ui skill" tells a model nothing it did not already know. The
// seat must receive the SKILL.md BODY, capped and scrubbed.
//
// SHAPED LIKE spawn-setting-sources.test.mjs, and for the same reason: server.mjs boots a
// listening runtime on import, so the argv builder is lifted out by ACORN AST — never by
// text matching, which is how three ratchets in this repo shipped vacuous (addendum #13).
//
// SCOPE OF THE CLAIM, stated so no reader over-reads it: --allowed-tools is COURTESY.
// Containment is guards.applyAllowed + the broker (task 7.2). These tests assert the
// argv is composed correctly; they do NOT assert that a model obeys it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

import { readSkillBodies, MAX_SKILL_BODIES, MAX_SKILL_BODY_BYTES } from "../station-skills.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dir, "..", "server.mjs");
const src = readFileSync(SERVER_PATH, "utf-8");
const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
// Step 1 (2026-09-17) moved the mail env OUT of server.mjs into mail-env.mjs, so SEAT-12's
// env literal no longer lives in `ast`. It now pins both halves: the spawn is WIRED to the
// pure builder here, and the builder's shape is asserted on its own AST below.
const MAIL_ENV_PATH = join(__dir, "..", "mail-env.mjs");
const mailEnvAst = parse(readFileSync(MAIL_ENV_PATH, "utf-8"), { ecmaVersion: "latest", sourceType: "module" });
const CURATED = join(__dir, "..", "..", ".claude", "skills-curated");

function* walk(node) {
  if (!node || typeof node.type !== "string") return;
  yield node;
  for (const k of Object.keys(node)) {
    if (k === "type" || k === "start" || k === "end" || k === "loc") continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) yield* walk(c); }
    else if (v && typeof v === "object" && typeof v.type === "string") yield* walk(v);
  }
}
function nodeNamed(name, type) {
  for (const n of walk(ast)) {
    if (n.type === "FunctionDeclaration" && n.id?.name === name) return n;
    if (type === "var" && n.type === "VariableDeclarator" && n.id?.name === name) return n;
  }
  return null;
}

// Lift the builder AND the allowlist constant it closes over into a real module.
async function loadBuilder() {
  const decl = nodeNamed("MANAGER_BASH_ALLOWLIST", "var");
  assert.ok(decl, "server.mjs must declare MANAGER_BASH_ALLOWLIST");
  // Find the whole `const <NAME>_BASH_ALLOWLIST = ...;` statements.
  const parts = [];
  for (const name of ["MANAGER_BASH_ALLOWLIST", "WORKER_BASH_ALLOWLIST"]) {
    let constStmt = null;
    for (const n of walk(ast)) {
      if (n.type === "VariableDeclaration" && n.declarations?.some((d) => d.id?.name === name)) constStmt = n;
    }
    assert.ok(constStmt, `server.mjs must declare ${name}`);
    parts.push(src.slice(constStmt.start, constStmt.end));
  }
  // Lift the two primitives engineDispatch ACTUALLY calls. There is deliberately no
  // composed `buildSeatSpawnArgs` wrapper: a second code path that only tests exercise is
  // a paraphrase of the real one, and paraphrases drift.
  for (const name of ["seatAllowedTools", "seatSystemPrompt"]) {
    const n = nodeNamed(name);
    assert.ok(n, `server.mjs must declare a pure \`function ${name}(...)\``);
    parts.push(src.slice(n.start, n.end));
  }
  const mod = `${parts.join("\n")}\nexport { seatAllowedTools, seatSystemPrompt, MANAGER_BASH_ALLOWLIST, WORKER_BASH_ALLOWLIST };\n`;
  return import(`data:text/javascript;base64,${Buffer.from(mod).toString("base64")}`);
}

// Real seats, matching agent-runtime/roster.json.
const PIKACHU = {
  id: "sr-frontend", name: "sr-frontend", seat: "Build frontend", role: "worker", skills: ["ui"],
  writeScope: ["src/**"],
  tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
};
const MANAGER = {
  id: "tech-lead", name: "tech-lead", seat: "Orchestration", role: "manager", skills: ["repo-read"],
  writeScope: [], tools: ["Read", "Glob", "Grep", "Bash"],
};

// ── tools ────────────────────────────────────────────────────────────────────
test("SEAT-1: a worker keeps its roster tools, with Bash narrowed to the worker allowlist", async () => {
  const { seatAllowedTools, WORKER_BASH_ALLOWLIST } = await loadBuilder();
  const tools = seatAllowedTools(PIKACHU);
  assert.equal(tools.includes("Bash"), false,
    `a bare Bash under acceptEdits runs any command unprompted; got ${JSON.stringify(tools)}`);
  assert.deepEqual(tools.filter((t) => !t.startsWith("Bash(")), ["Read", "Glob", "Grep", "Edit", "Write"]);
  for (const spec of WORKER_BASH_ALLOWLIST) assert.ok(tools.includes(spec), `missing ${spec}`);
});

test("SEAT-1b: the worker allowlist lets it verify its own work (tests, typecheck, lint, diff)", async () => {
  const { WORKER_BASH_ALLOWLIST } = await loadBuilder();
  for (const must of ["Bash(npm test:*)", "Bash(npm run test:*)", "Bash(npm run lint:*)", "Bash(npx tsc:*)",
    "Bash(node --test:*)", "Bash(git diff:*)", "Bash(git status:*)"]) {
    assert.ok(WORKER_BASH_ALLOWLIST.includes(must), `worker allowlist must include ${must}`);
  }
});

test("SEAT-1c: every worker Bash specifier is command-scoped and cannot push, fetch, install or delete", async () => {
  const { WORKER_BASH_ALLOWLIST } = await loadBuilder();
  const FORBIDDEN = /\b(rm|mv|chmod|chown|dd|kill|curl|wget|push|fetch|pull|clone|install|add|ci|exec|eval|sh|bash|sudo|ssh|scp)\b/;
  for (const spec of WORKER_BASH_ALLOWLIST) {
    const m = /^Bash\((.+)\)$/.exec(spec);
    assert.ok(m, `${spec} must be a command-scoped Bash specifier`);
    assert.ok(m[1].endsWith(":*") && m[1].length > 2, `${spec} must scope a command, not grant all of Bash`);
    assert.equal(FORBIDDEN.test(m[1]), false, `${spec} names a forbidden command`);
  }
});

test("SEAT-2: the MANAGER never receives a bare Bash — it is narrowed to read-only specifiers", async () => {
  const { seatAllowedTools, MANAGER_BASH_ALLOWLIST } = await loadBuilder();
  const tools = seatAllowedTools(MANAGER);
  assert.equal(tools.includes("Bash"), false,
    `a bare Bash grants rm/curl/git push; got ${JSON.stringify(tools)}`);
  for (const spec of MANAGER_BASH_ALLOWLIST) assert.ok(tools.includes(spec), `missing ${spec}`);
  assert.deepEqual(tools.filter((t) => !t.startsWith("Bash(")), ["Read", "Glob", "Grep"]);
});

test("SEAT-3: every Manager Bash specifier is command-scoped and read-only", async () => {
  const { MANAGER_BASH_ALLOWLIST } = await loadBuilder();
  const WRITERS = /\b(rm|mv|cp|curl|wget|push|chmod|chown|dd|kill|npm|node|sh|bash|eval)\b/;
  for (const spec of MANAGER_BASH_ALLOWLIST) {
    const m = /^Bash\((.+)\)$/.exec(spec);
    assert.ok(m, `${spec} must be a command-scoped Bash specifier`);
    assert.ok(m[1].includes(":"), `${spec} must scope a command, not grant all of Bash`);
    assert.equal(WRITERS.test(m[1]), false, `${spec} names a mutating command`);
  }
});

// ── the system prompt ────────────────────────────────────────────────────────
test("SEAT-4: the seat prompt carries the seat identity and every one of its scope globs", async () => {
  const { seatSystemPrompt } = await loadBuilder();
  const prompt = seatSystemPrompt(PIKACHU);
  assert.ok(prompt.includes("sr-frontend"));
  for (const g of PIKACHU.writeScope) assert.ok(prompt.includes(g), `scope glob ${g} must be stated to the seat`);
});

test("SEAT-5: the seat receives SKILL BODIES, not skill NAMES", async () => {
  const { seatSystemPrompt } = await loadBuilder();
  const bodies = readSkillBodies(["ui"], { curatedDir: CURATED });
  assert.equal(bodies.length, 1, "the ui SKILL.md must exist on disk (task 7.0)");
  const prompt = seatSystemPrompt(PIKACHU, bodies);
  // The DISTINGUISHING assertion: a substantial run of the body's own prose, which a
  // name-only prompt could never contain.
  const sentence = bodies[0].body.split("\n").find((l) => l.trim().length > 40).trim();
  assert.ok(prompt.includes(sentence),
    "the prompt must carry the SKILL.md body text, not merely the id 'ui'");
  assert.ok(prompt.length > bodies[0].body.length, "the body must be additive to the identity block");
});

test("SEAT-6: an empty writeScope is described HONESTLY, and it means opposite things by role", async () => {
  // This test used to assert /no write scope/ for BOTH roles. That was pinning a lie: the
  // review found that guards.applyAllowed narrows ONLY role:"worker", so telling a Manager
  // "you hold no write scope" contradicted the enforcement, which lets it write the whole
  // seed surface. An empty array means:
  //   worker      + [] → writes NOTHING (matchesWriteScope refuses every path)
  //   non-worker  + [] → NOT narrowed (the legacy rule returns before writeScope is read)
  const { seatSystemPrompt } = await loadBuilder();

  const managerPrompt = seatSystemPrompt(MANAGER);
  assert.match(managerPrompt, /not narrowed/i, "a non-worker seat is not narrowed — say so");
  assert.equal(/no write scope/i.test(managerPrompt), false,
    "claiming a manager holds no write scope contradicts applyAllowed, which does not narrow it");

  const blockedWorker = { ...PIKACHU, writeScope: [] };
  const workerPrompt = seatSystemPrompt(blockedWorker);
  assert.match(workerPrompt, /no write scope/i, "a worker with an empty scope genuinely writes nothing");
  assert.equal(/not narrowed/i.test(workerPrompt), false);
});

test("SEAT-8: the seat prompt is pushed ONLY on the claude engine (codex would reject the flag)", () => {
  // ASSERTED ON THE AST, not on source text. A first version of this test sliced the source
  // for the substrings "seat" and "claude" — and PASSED with `=== "claude"` inverted to
  // `!== "claude"`, i.e. it could not detect the reversal of the one behaviour it names.
  // That is addendum #13/#22, in the very file whose header warns about it.
  let guard = null;
  for (const n of walk(ast)) {
    if (n.type !== "IfStatement") continue;
    const t = n.test;
    if (t?.type !== "LogicalExpression" || t.operator !== "&&") continue;
    if (t.left?.type !== "Identifier" || t.left.name !== "seat") continue;
    const r = t.right;
    if (r?.type !== "BinaryExpression") continue;
    if (r.left?.type !== "MemberExpression") continue;
    if (r.left.object?.name !== "SPAWN_ENGINE" || r.left.property?.name !== "id") continue;
    guard = r;
  }
  assert.ok(guard, "the seat prompt push must be guarded by `seat && SPAWN_ENGINE.id === <engine>`");
  assert.equal(guard.operator, "===",
    "the guard must be an EQUALITY test — `!==` would push a claude-only flag at codex and nothing else");
  assert.equal(guard.right?.value, "claude", "the engine compared against must be claude");
});

// ── readSkillBodies caps and safety ──────────────────────────────────────────
test("BODY-1: a body larger than the cap is truncated AND says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-skills-"));
  mkdirSync(join(dir, "big"));
  writeFileSync(join(dir, "big", "SKILL.md"), "x".repeat(MAX_SKILL_BODY_BYTES * 3));
  const [b] = readSkillBodies(["big"], { curatedDir: dir });
  assert.ok(Buffer.byteLength(b.body, "utf8") <= MAX_SKILL_BODY_BYTES + 80, "must be capped");
  assert.match(b.body, /truncated/i, "silent truncation would hand a seat half a rule with no sign it was cut");
});

test("BODY-2: at most MAX_SKILL_BODIES bodies are ever returned", () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-skills-"));
  const ids = [];
  for (let i = 0; i < MAX_SKILL_BODIES + 7; i++) {
    const id = `s${i}`; ids.push(id);
    mkdirSync(join(dir, id)); writeFileSync(join(dir, id, "SKILL.md"), `body ${id}`);
  }
  assert.equal(readSkillBodies(ids, { curatedDir: dir }).length, MAX_SKILL_BODIES);
});

test("BODY-3: a missing SKILL.md is skipped, never a throw", () => {
  assert.deepEqual(readSkillBodies(["definitely-not-a-skill"], { curatedDir: CURATED }), []);
});

test("BODY-4: a path-traversing id can never escape the curated dir", () => {
  // NON-VACUITY (this test's first version WAS vacuous and the R5 mutation caught it):
  // pointing an id at a non-existent path passes whether or not the charset check exists,
  // because readFileSync throws either way. So the traversal target here REALLY EXISTS and
  // REALLY IS READABLE — remove the charset guard and this test reads it.
  const root = mkdtempSync(join(tmpdir(), "ma-skills-esc-"));
  const curatedDir = join(root, "curated");
  mkdirSync(join(curatedDir, "ok"), { recursive: true });
  writeFileSync(join(curatedDir, "ok", "SKILL.md"), "legitimate body");
  mkdirSync(join(root, "outside"), { recursive: true });
  writeFileSync(join(root, "outside", "SKILL.md"), "STOLEN-FROM-OUTSIDE-THE-CURATED-DIR");

  // Proof the trap is armed: the file the traversal aims at is genuinely readable.
  assert.equal(readFileSync(join(curatedDir, "..", "outside", "SKILL.md"), "utf8"),
    "STOLEN-FROM-OUTSIDE-THE-CURATED-DIR");

  const got = readSkillBodies(["../outside", "ok"], { curatedDir });
  assert.deepEqual(got.map((b) => b.id), ["ok"], "a traversing id must be dropped, not resolved");
  assert.equal(got.some((b) => b.body.includes("STOLEN")), false,
    "an id from the wire must never become a path segment");
});

test("BODY-5: the injected scrub is applied to every body", () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-skills-"));
  mkdirSync(join(dir, "leaky"));
  writeFileSync(join(dir, "leaky", "SKILL.md"), "token sk-live-SECRET-VALUE here");
  const [b] = readSkillBodies(["leaky"], { curatedDir: dir, scrub: (t) => t.replace(/sk-live-\S+/g, "[REDACTED]") });
  assert.equal(b.body.includes("sk-live-SECRET-VALUE"), false, "a vendored body is untrusted text on a prompt path");
  assert.match(b.body, /\[REDACTED\]/);
});

test("BODY-6: every roster skill on disk is within the per-body cap", () => {
  const bodies = readSkillBodies(["ui", "api", "db", "test", "notifications"], { curatedDir: CURATED });
  assert.equal(bodies.length, 5, "all five roster SKILL.md files must exist (task 7.0)");
  for (const b of bodies) {
    assert.ok(Buffer.byteLength(b.body, "utf8") <= MAX_SKILL_BODY_BYTES, `${b.id} exceeds the cap`);
    assert.equal(/truncated/i.test(b.body), false, `${b.id} was truncated — shorten the SKILL.md instead`);
  }
});

// ── WIRING (a builder nothing calls is not done) ─────────────────────────────
test("SEAT-9: engineDispatch REPLACES the default tool list with the seat's, never unions it", () => {
  // Structural, via AST: find the buildEngineSpawnArgs(...) call in the engine spawn and
  // assert its `allowedTools` is a seat-conditional whose consequent is seatAllowedTools().
  // A union (`[...WRITE_TOOLS, ...seatTools]`) would WIDEN, which is the opposite of this
  // phase, and would not match this shape.
  let found = null;
  for (const n of walk(ast)) {
    if (n.type !== "CallExpression") continue;
    if (n.callee?.name !== "buildEngineSpawnArgs") continue;
    const obj = n.arguments?.[0];
    if (obj?.type !== "ObjectExpression") continue;
    const prop = obj.properties.find((pr) => pr.key?.name === "allowedTools");
    if (prop) found = prop.value;
  }
  assert.ok(found, "the engine spawn must pass an allowedTools property");
  assert.equal(found.type, "ConditionalExpression",
    "allowedTools must branch on whether a roster seat resolved");
  assert.equal(found.consequent?.callee?.name, "seatAllowedTools",
    "when a seat resolves, its tools must REPLACE the default list");
});

test("SEAT-10: engineDispatch injects the seat's SKILL BODIES into the spawn", () => {
  // The call must exist AND must be handed the seat's skills, not a literal.
  let ok = false;
  for (const n of walk(ast)) {
    if (n.type !== "CallExpression" || n.callee?.name !== "seatSystemPrompt") continue;
    const bodies = n.arguments?.[1];
    if (bodies?.type === "CallExpression" && bodies.callee?.name === "readSkillBodies") ok = true;
  }
  assert.ok(ok, "the spawn must call seatSystemPrompt(seat, readSkillBodies(...)) — bodies, not names");
});

// ── Phase 8 / 8.2 — the seat's MAILBOX reaches the spawn ─────────────────────
test("SEAT-11: the engine spawn gets --mcp-config + --strict-mcp-config and the mail tools", () => {
  // Structural (AST), because server.mjs cannot be imported. The ENGINE path had NO
  // --mcp-config before 8.2 — only the chat path composed one — so this pins the addition.
  const pushed = [];
  for (const n of walk(ast)) {
    if (n.type !== "CallExpression") continue;
    if (n.callee?.type !== "MemberExpression") continue;
    if (n.callee.object?.name !== "args" || n.callee.property?.name !== "push") continue;
    for (const a of n.arguments) if (a.type === "Literal" && typeof a.value === "string") pushed.push(a.value);
  }
  for (const flag of ["--mcp-config", "--strict-mcp-config", "mcp__mail__mail_send", "mcp__mail__mail_read"]) {
    assert.ok(pushed.includes(flag), `the seat spawn must push ${flag}; got ${JSON.stringify([...new Set(pushed)])}`);
  }
});

test("SEAT-12: the seat's identity is bound in the MCP env, and the roster's SCOPES are not leaked", () => {
  // MA_MAIL_AGENT_ID is what makes `from` unforgeable. And the env must carry ROLES only:
  // shipping every seat's writeScope to a child process is reconnaissance for no benefit.
  //
  // Asserted on the AST, not the source slice. A first version regex'd the slice for
  // "writeScope" and failed on this file's OWN comment saying "never the writeScope" — the
  // exact text-matching trap this file's header warns about (addendum #13/#22).
  //
  // 2026-09-17: the env object moved to mail-env.mjs (Step 1). This ratchet went RED and
  // stayed red because the Phase A gate ran a SUBSET of test:runtime, not all 204 files —
  // addendum #11 (fix where the class lives) applied to a RATCHET's own target. The env
  // literal is now read from mail-env.mjs, and the spawn's CALL is pinned here, so moving
  // the builder again breaks this test loudly instead of silently un-pinning the claim.
  //
  // Mutation proof (2026-09-17): see the two recorded red lines at the end of this test.
  let wired = false;
  for (const n of walk(ast)) {
    if (n.type !== "Property" || n.key?.name !== "env") continue;
    if (n.value?.type === "CallExpression" && n.value.callee?.name === "mailEnvFor") wired = true;
  }
  assert.ok(wired, "the mail MCP server must be spawned with env: mailEnvFor(...) — the binding is not wired");

  let envNode = null;
  for (const n of walk(mailEnvAst)) {
    if (n.type !== "ObjectExpression") continue;
    if (n.properties.some((pr) => pr.key?.name === "MA_MAIL_AGENT_ID")) envNode = n;
  }
  assert.ok(envNode, "mail-env.mjs must build an env with a bound identity");
  const keys = envNode.properties.map((pr) => pr.key?.name).sort();
  assert.deepEqual(keys,
    ["MA_MAIL_AGENT_ID", "MA_MAIL_DIR", "MA_MAIL_GOAL_ID", "MA_MAIL_JOB_ID", "MA_MAIL_ROLES", "MA_MAIL_TASK_ID"],
    "the mail child gets identity + location + roles, and nothing else");
  // No VALUE expression anywhere in the env may read a writeScope.
  for (const n of walk(envNode)) {
    assert.notEqual(n.property?.name, "writeScope", "a seat's scopes must not ride into the mail child");
    assert.notEqual(n.value, "writeScope", "a seat's scopes must not ride into the mail child");
  }
  // Mutation A: server.mjs `env: mailEnvFor({...})` → `env: {}` →
  //   ✖ SEAT-12 ... the binding is not wired (fail 1). Restored, md5 matched.
  // Mutation B: mail-env.mjs gains `MA_MAIL_SCOPE: seat.writeScope` →
  //   ✖ SEAT-12 ... identity + location + roles, and nothing else (fail 1). Restored, md5 matched.
});

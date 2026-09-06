// Phase 6 · task 6.6a — THE SEAT CONTEXT DIET.
//
// THE DEFECT, measured live: a trivial engine task reported cacheCreationTokens 180,199
// before it had read a single repo file. The seat spawns `claude -p` with the operator's
// FULL global configuration — ~/.claude/CLAUDE.md, ~/.claude/rules/**, and 1,562 skill
// directories — none of which the seat asked for, all of which it pays for on every turn.
//
// THE FIX IS ONE FLAG. `--setting-sources project` (verified against the installed CLI:
// "Comma-separated list of setting sources to load (user, project, local)") drops the
// `user` scope and keeps the repo's own CLAUDE.md, which is the context the seat actually
// needs. The ENGINE dispatch gets it. The CHAT path does NOT — that thread is the
// operator's own, talking to the operator's own agents, and its global rules are the point.
//
// WHY THIS TEST IS SHAPED LIKE THIS: server.mjs boots a listening runtime on import, so it
// cannot be imported into a unit test. So the argv builder is read out of it by AST — the
// function declaration is extracted by acorn (never by text matching, which is how three
// ratchets in this repo shipped vacuous) and evaluated in isolation. The chat assertion is
// AST too: the literal must not appear anywhere inside cliReply's subtree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "acorn";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dir, "..", "server.mjs");
const ENGINE_EXEC = pathToFileURL(join(__dir, "..", "providers", "engine-exec.mjs")).href;
const src = readFileSync(SERVER_PATH, "utf-8");
const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });

/** Every node in the tree, depth-first. No text matching anywhere in this file. */
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

function fnNamed(name) {
  for (const n of walk(ast)) {
    if (n.type === "FunctionDeclaration" && n.id?.name === name) return n;
  }
  return null;
}

/** Every string literal value inside a subtree. */
function literals(node) {
  const out = [];
  for (const n of walk(node)) if (n.type === "Literal" && typeof n.value === "string") out.push(n.value);
  return out;
}

// Load the extracted builder as a real module, with the REAL buildEngineArgs injected —
// so this proves the composed argv, not a paraphrase of it.
async function loadBuilder() {
  const fn = fnNamed("buildEngineSpawnArgs");
  assert.ok(fn, "server.mjs must declare a pure `function buildEngineSpawnArgs(...)` — the engine argv seam");
  const body = src.slice(fn.start, fn.end);
  const mod = `import { buildEngineArgs } from ${JSON.stringify(ENGINE_EXEC)};\n${body}\nexport { buildEngineSpawnArgs };\n`;
  return (await import(`data:text/javascript;base64,${Buffer.from(mod).toString("base64")}`)).buildEngineSpawnArgs;
}

const ENGINE_CTX = {
  engineId: "claude", modelId: "claude-sonnet-5", allowedTools: ["Read", "Write", "Edit"],
  strictMcp: false, workdir: "/tmp/wt/task_abc", permissionMode: "acceptEdits",
};

test("the ENGINE spawn carries --setting-sources project — the operator's global config is not the seat's", async () => {
  const build = await loadBuilder();
  const args = build(ENGINE_CTX);
  const i = args.indexOf("--setting-sources");
  assert.ok(i >= 0, `engine argv must carry --setting-sources; got ${JSON.stringify(args)}`);
  assert.equal(args[i + 1], "project",
    "`project` keeps the REPO's CLAUDE.md and drops the ~/.claude user scope — that is the whole diet");
  assert.equal(args.filter((a) => a === "--setting-sources").length, 1, "exactly one flag, never a double");
});

test("the pinned claude argv is preserved — the diet adds a flag, it does not rewrite the contract", async () => {
  const build = await loadBuilder();
  const args = build(ENGINE_CTX);
  assert.deepEqual(args.slice(0, 6),
    ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--no-session-persistence"],
    "the byte-pinned head of the claude contract (engine-exec.test.mjs) must be untouched");
  for (const flag of ["--model", "--allowed-tools", "--add-dir", "--permission-mode"]) {
    assert.ok(args.includes(flag), `${flag} must survive the wrapper`);
  }
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/wt/task_abc");
});

test("codex does NOT get the flag — --setting-sources is a claude flag and would be an unknown arg", async () => {
  const build = await loadBuilder();
  const args = build({ ...ENGINE_CTX, engineId: "codex" });
  assert.ok(!args.includes("--setting-sources"),
    `a codex spawn must not carry a claude-only flag; got ${JSON.stringify(args)}`);
  assert.equal(args[0], "exec", "the codex contract is unchanged");
});

test("the CHAT path is UNCHANGED — cliReply never gains --setting-sources", () => {
  const chat = fnNamed("cliReply");
  assert.ok(chat, "cliReply must still exist — this test is worthless if the function was renamed");
  assert.ok(!literals(chat).includes("--setting-sources"),
    "the operator's chat thread keeps the operator's own global rules; only the autonomous seat is dieted");
});

test("the CALL SITE is wired — engineDispatch spawns what this test asserts, not a parallel argv", () => {
  // A builder nothing calls is not a control. This is the READ SITE assertion: the engine
  // dispatch must compose its argv through the dieted builder, and must NOT still call the
  // raw `buildEngineArgs` (which would spawn the un-dieted shape while the test above
  // passed happily on a function the runtime never reaches).
  const dispatch = fnNamed("engineDispatch");
  assert.ok(dispatch, "engineDispatch must still exist");
  const called = new Set();
  for (const n of walk(dispatch)) {
    if (n.type === "CallExpression" && n.callee?.type === "Identifier") called.add(n.callee.name);
  }
  assert.ok(called.has("buildEngineSpawnArgs"), "the engine dispatch must build its argv through the dieted seam");
  assert.ok(!called.has("buildEngineArgs"),
    "and must not ALSO call the raw builder — one argv, one place, or the flag is a decoration");
});

test("the builder is PURE — it reads no module-scope state, so what the test runs is what the engine spawns", async () => {
  const build = await loadBuilder();
  const a = build(ENGINE_CTX);
  const b = build(ENGINE_CTX);
  assert.deepEqual(a, b, "same ctx, same argv");
  assert.notEqual(a, b, "and a fresh array each call — never a shared, mutated one");
});

// Phase 9 · task 9.6 — THE MANAGER'S SPAWN IS ACTUALLY WIRED.
//
// THE DEFECT THIS CLOSES, found by the 9.6 LIVE run and by nothing before it:
// `createManagerDispatch({ mode: "claude", ... })` was constructed in server.mjs with no
// `spawn` property. manager-dispatch.mjs fails closed on that —
//   { ok:false, error:"no spawn function is wired for mode=claude" }
// — so the first live job went straight to `blocked`:
//   [manager] {"event":"job-blocked","jobId":"job_cda88ffaed30",
//              "reason":"intake: no spawn function is wired for mode=claude"}
//
// Every unit test passed, because every unit test INJECTS its own spawn. That is addendum
// #1 exactly: a mode that exists, is covered, and enforces nothing in production because
// the one call site that matters never passed the dependency. The tests proved the module;
// nothing proved the WIRING.
//
// MATCHED ON THE AST, never on source text (addendum #13). A grep for the string "spawn"
// in server.mjs passes today and passed while the bug was live — the file mentions spawn
// hundreds of times. Only the shape of THIS call expresses the claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

import { MANAGER_TOOLS, MANAGER_MAX_TURNS } from "../manager-dispatch.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dir, "..", "server.mjs");
const src = readFileSync(SERVER_PATH, "utf-8");
const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });

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

/** The single `createManagerDispatch({...})` call, lifted by AST. */
function dispatchCallArg() {
  for (const n of walk(ast)) {
    if (n.type !== "CallExpression") continue;
    if (n.callee?.type !== "Identifier" || n.callee.name !== "createManagerDispatch") continue;
    const arg = n.arguments?.[0];
    assert.equal(arg?.type, "ObjectExpression", "createManagerDispatch takes one object literal");
    return arg;
  }
  assert.fail("no createManagerDispatch(...) call found in server.mjs");
}

const keysOf = (obj) => obj.properties
  .filter((p) => p.type === "Property")
  .map((p) => (p.key.type === "Identifier" ? p.key.name : p.key.value));

test("MSW-1: server.mjs passes a `spawn` to createManagerDispatch — the wiring the live run found missing", () => {
  const keys = keysOf(dispatchCallArg());
  assert.ok(
    keys.includes("spawn"),
    `createManagerDispatch is constructed without a spawn — mode=claude can only ever return ` +
    `{ok:false,"no spawn function is wired for mode=claude"}. Keys present: ${keys.join(", ")}`,
  );
});

test("MSW-2: the spawn passed is a function, not a truthy placeholder", () => {
  const arg = dispatchCallArg();
  const prop = arg.properties.find(
    (p) => p.type === "Property" && (p.key.name || p.key.value) === "spawn",
  );
  assert.ok(prop, "spawn property missing");
  const v = prop.value;
  const ok = v.type === "ArrowFunctionExpression"
    || v.type === "FunctionExpression"
    || v.type === "Identifier";           // a named function declared elsewhere in the file
  assert.ok(ok, `spawn must be a function (got ${v.type}) — an object or literal would satisfy ` +
    `the "is it wired" check while still spawning nothing`);
  // An Identifier must actually name something declared in this module, or the wiring is a
  // reference to nothing and the call throws at the first tick instead of at boot.
  if (v.type === "Identifier") {
    const declared = [...walk(ast)].some((n) =>
      (n.type === "FunctionDeclaration" && n.id?.name === v.name)
      || (n.type === "VariableDeclarator" && n.id?.type === "Identifier" && n.id.name === v.name));
    assert.ok(declared, `spawn references \`${v.name}\`, which is not declared in server.mjs`);
  }
});

test("MSW-3: the Manager's argv is READ-ONLY — no Write, no Edit, Bash is command-scoped", () => {
  // Asserts the CONTRACT the spawn must honour, from the dispatch module's own export, so
  // this test tracks MANAGER_TOOLS rather than restating it and drifting.
  assert.ok(MANAGER_TOOLS.includes("Read"), "Manager must be able to read the repo");
  assert.ok(!MANAGER_TOOLS.includes("Write"), "Manager must never hold Write");
  assert.ok(!MANAGER_TOOLS.includes("Edit"), "Manager must never hold Edit");
  assert.ok(!MANAGER_TOOLS.includes("Bash"), "bare Bash would hand the Manager rm/curl/git push");
  for (const t of MANAGER_TOOLS.filter((t) => t.startsWith("Bash"))) {
    assert.match(t, /^Bash\([a-z ]+:\*\)$/, `${t} must be command-scoped`);
  }
  assert.equal(typeof MANAGER_MAX_TURNS, "number");
  assert.ok(MANAGER_MAX_TURNS > 0 && MANAGER_MAX_TURNS <= 100, "runaway bound must be finite");
});

test("MSW-4: stream-json and --verbose are pushed together, and loop_steps/usage are recorded", () => {
  // The CLI REFUSES "--output-format=stream-json requires --verbose". Shipping one without
  // the other means every Manager turn exits non-zero and the job blocks — a silent outage
  // that no unit test with an injected spawn can see. Asserted on the AST of the builder.
  let fn = null;
  for (const n of walk(ast)) {
    if (n.type === "FunctionDeclaration" && n.id?.name === "buildManagerSpawnArgs") { fn = n; break; }
  }
  assert.ok(fn, "buildManagerSpawnArgs not found in server.mjs");
  const literals = [...walk(fn)].filter((n) => n.type === "Literal").map((n) => n.value);
  if (literals.includes("stream-json")) {
    assert.ok(literals.includes("--verbose"),
      "--output-format stream-json without --verbose: the CLI refuses the invocation and every " +
      "Manager turn fails");
  }
  assert.ok(literals.includes("--output-format"), "output format must be pinned, not left to the CLI default");

  // And the frames must actually be RECORDED, or "the Manager read the code" has no evidence.
  let spawnFn = null;
  for (const n of walk(ast)) {
    if (n.type === "FunctionDeclaration" && n.id?.name === "managerSpawn") { spawnFn = n; break; }
  }
  assert.ok(spawnFn, "managerSpawn not found in server.mjs");
  const calls = [...walk(spawnFn)]
    .filter((n) => n.type === "CallExpression" && n.callee?.type === "MemberExpression")
    .map((n) => `${n.callee.object?.name}.${n.callee.property?.name}`);
  assert.ok(calls.includes("loopSteps.record"),
    "managerSpawn must feed frames to loopSteps.record — 9.6's evidence for 'the Manager read " +
    "the code' is loop_steps, not the Manager's own summary of itself");
  assert.ok(calls.includes("usageStore.record"),
    "managerSpawn must record usage — 9.6 requires a usage row per Manager turn");
});

test("MSW-5: the dispatcher is given the CATALOG, and it reaches planPrompt", () => {
  // Same class as MSW-1, one phase later: `planPrompt` grew a `catalog` parameter and the two
  // call sites between it and the server had to grow with it. If either had been missed the
  // parameter would default to `[]`, the prompt would silently fall back to offering only the
  // staffed skills, and the hire path would stay unreachable — with every test still green,
  // because the tests pass their own catalog in directly (addendum #25).
  const keys = keysOf(dispatchCallArg());
  assert.ok(keys.includes("catalog"),
    `createManagerDispatch is constructed without a catalog — the Manager can then only ask ` +
    `for skills that already have a seat, and HR is unaskable. Keys: ${keys.join(", ")}`);

  // …and the dispatcher must actually hand it to planPrompt, not merely accept it.
  const src = readFileSync(join(__dir, "..", "manager-dispatch.mjs"), "utf-8");
  const ast2 = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  let call = null;
  for (const n of walk(ast2)) {
    if (n.type === "CallExpression" && n.callee?.type === "Identifier" && n.callee.name === "planPrompt") { call = n; break; }
  }
  assert.ok(call, "no planPrompt(...) call in manager-dispatch.mjs");
  assert.ok(call.arguments.length >= 5,
    `planPrompt is called with ${call.arguments.length} arguments — the catalog is the 5th and ` +
    "without it the parameter defaults to [] and the prompt quietly loses the unstaffed skills");
});

test("MSW-6: the REVIEW seams are wired — diffFor and retest are not left on their defaults", () => {
  // Fourth occurrence of addendum #25 in this program. `createManager` defaults `diffFor` to
  // `() => ""` and `retest` to `async () => ({ ok: null })`, so an unwired review turn asks the
  // BOSS to approve an empty diff and a test that was never re-run — with every unit test
  // green, because they inject their own seams.
  let arg = null;
  for (const n of walk(ast)) {
    if (n.type === "CallExpression" && n.callee?.type === "Identifier" && n.callee.name === "createManager") {
      arg = n.arguments?.[0]; break;
    }
  }
  assert.ok(arg && arg.type === "ObjectExpression", "no createManager({...}) call in server.mjs");
  const keys = arg.properties.filter((p) => p.type === "Property")
    .map((p) => (p.key.type === "Identifier" ? p.key.name : p.key.value));
  for (const seam of ["diffFor", "retest"]) {
    assert.ok(keys.includes(seam),
      `createManager is constructed without \`${seam}\` — the review turn would judge the job on ` +
      `nothing and still mint a job-approval gate. Keys: ${keys.join(", ")}`);
  }
});

test("MSW-7: the SHIP ladder is wired — pr and baseSha reach createManager", () => {
  // Fifth occurrence of addendum #25. `manager.ship` refuses honestly when `pr` is absent
  // ("no ship ladder is wired"), so nothing crashes — the approve button would simply do
  // NOTHING, which is the worst of both: a BOSS decision that silently buys nothing.
  let arg = null;
  for (const n of walk(ast)) {
    if (n.type === "CallExpression" && n.callee?.type === "Identifier" && n.callee.name === "createManager") { arg = n.arguments?.[0]; break; }
  }
  assert.ok(arg?.type === "ObjectExpression", "no createManager({...}) in server.mjs");
  const keys = arg.properties.filter((p) => p.type === "Property")
    .map((p) => (p.key.type === "Identifier" ? p.key.name : p.key.value));
  for (const seam of ["pr", "baseSha"]) {
    assert.ok(keys.includes(seam), `createManager has no \`${seam}\` — approving a job would ship nothing. Keys: ${keys.join(", ")}`);
  }
});

test("MSW-8: a job-approval decision routes to SHIP, not to the clarify path", () => {
  // Without the kind check, approving a ship gate would run `onGateDecided`, which sets the job
  // back to `planned` — the BOSS's yes would silently re-plan the work instead of landing it.
  const src = readFileSync(SERVER_PATH, "utf-8");
  const ast2 = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  let found = false;
  for (const n of walk(ast2)) {
    if (n.type !== "IfStatement") continue;
    const t = n.test;
    if (t?.type !== "BinaryExpression" || t.operator !== "===") continue;
    const left = t.left, right = t.right;
    const isKind = left?.type === "MemberExpression" && left.property?.name === "kind";
    const isJobApproval = right?.type === "Literal" && right.value === "job-approval";
    if (isKind && isJobApproval) { found = true; break; }
  }
  assert.ok(found, "no `row.kind === \"job-approval\"` branch — the ship gate falls through to onGateDecided");
});

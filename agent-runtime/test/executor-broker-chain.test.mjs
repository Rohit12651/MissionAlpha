// PHASE 1 — THE CHAIN PROOF: a non-Claude model's tool calls reach the repo the SAME way
// a Claude CLI turn's do, through the SAME broker, behind the SAME guards.
//
// WHAT THIS COVERS, and what it deliberately does not.
//
// The tool loop is proven against a protocol-accurate stub in tool-loop.test.mjs. What was
// still unproven is the JOIN: that files an OpenAI-compatible model writes with its tools
// are picked up by broker.listChanges and landed by broker.applyChanges exactly as the CLI
// path's are — same applyAllowed, same CONFIG_GUARD, same symlink/realpath refusals. That
// join is the whole "no second write path" claim, so it is tested here directly.
//
// NOT COVERED, and disclosed rather than implied: the HTTP hop to a REAL third-party
// provider. There is no non-Claude account with a key on this machine, and the SSRF guard
// (correctly) refuses a loopback stub, so the network leg cannot be exercised here. See the
// phase's Known Gaps — the live proof on a real provider is OWED, not done.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runToolLoop } from "../providers/tool-loop.mjs";
import { createBroker } from "../broker.mjs";

const sse = (frames) => ({
  ok: true,
  status: 200,
  body: (async function* () {
    for (const f of frames) yield `data: ${JSON.stringify(f)}\n`;
    yield "data: [DONE]\n";
  })(),
});
const call = (name, args, id = "c1") => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
});
const done = () => ({ choices: [{ delta: {}, finish_reason: "stop" }] });

function stubFetch(responses) {
  return async () => {
    const n = responses.shift();
    if (!n) throw new Error("stub exhausted");
    return typeof n === "function" ? n() : n;
  };
}

/** A scratch repo + a scratch workdir, mirroring how the engine pairs them. */
function scratch() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "ma-chain-repo-")));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "ma-chain-work-")));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "greet.ts"), "export const greet = 'original';\n");
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src", "greet.ts"), "export const greet = 'original';\n");
  return { repo, work };
}
const clean = (...ds) => ds.forEach((d) => rmSync(d, { recursive: true, force: true }));

const base = { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m", userPrompt: "edit it" };

test("a model's Edit lands in the repo through the SAME broker the CLI path uses", async () => {
  const { repo, work } = scratch();
  try {
    const fetchImpl = stubFetch([
      sse([call("Edit", { path: "src/greet.ts", old_string: "'original'", new_string: "'WRITTEN BY A NON-CLAUDE MODEL'" })]),
      sse([done()]),
    ]);
    const loop = await runToolLoop({ ...base, workdir: work, fetchImpl });
    assert.equal(loop.ok, true, loop.stopDetail);

    // The workdir now differs from the repo. The broker is what turns that into a change
    // set and then lands it — unchanged, and unaware which executor produced the bytes.
    const broker = createBroker({ repoRoot: repo, workdirFor: () => work });
    const changes = await broker.listChanges("agent-1");
    const greet = changes.find((c) => c.path === "src/greet.ts");
    assert.ok(greet, "the broker must see the model's edit as a proposed change");
    assert.match(greet.after, /WRITTEN BY A NON-CLAUDE MODEL/);

    const applied = await broker.applyChanges("agent-1", ["src/greet.ts"]);
    assert.ok(applied, "applyChanges must report a result");
    assert.match(
      readFileSync(join(repo, "src", "greet.ts"), "utf-8"),
      /WRITTEN BY A NON-CLAUDE MODEL/,
      "the bytes must be in the REPO, read off disk",
    );
  } finally { clean(repo, work); }
});

test("a NEW file created by a model's Write is proposed and lands", async () => {
  const { repo, work } = scratch();
  try {
    const fetchImpl = stubFetch([
      sse([call("Write", { path: "src/added.ts", content: "export const added = true;\n" })]),
      sse([done()]),
    ]);
    await runToolLoop({ ...base, workdir: work, fetchImpl });
    const broker = createBroker({ repoRoot: repo, workdirFor: () => work });
    const changes = await broker.listChanges("agent-1");
    assert.ok(changes.some((c) => c.path === "src/added.ts"));
    await broker.applyChanges("agent-1", ["src/added.ts"]);
    assert.equal(readFileSync(join(repo, "src", "added.ts"), "utf-8"), "export const added = true;\n");
  } finally { clean(repo, work); }
});

test("A PATH THE GUARDS FORBID NEVER REACHES THE REPO, even though the model asked", async () => {
  // .env is in APPLY_DENY. The model is allowed to write it into its own workdir — that is
  // just a scratch directory — but applyAllowed must keep it out of the change set, so it
  // can never be approved or landed. This is the guard the CLI path relies on too.
  const { repo, work } = scratch();
  try {
    const fetchImpl = stubFetch([
      sse([call("Write", { path: ".env", content: "SECRET=leaked\n" })]),
      sse([done()]),
    ]);
    const loop = await runToolLoop({ ...base, workdir: work, fetchImpl });
    assert.equal(loop.toolStats.writes, 1, "the workdir write itself is not the boundary");

    const broker = createBroker({ repoRoot: repo, workdirFor: () => work });
    const changes = await broker.listChanges("agent-1");
    assert.equal(
      changes.some((c) => c.path === ".env"),
      false,
      ".env must never be offered as an appliable change",
    );
    assert.equal(existsSync(join(repo, ".env")), false, ".env must not exist in the repo");
  } finally { clean(repo, work); }
});

test("the executor cannot write outside its workdir, so nothing escapes to propose", async () => {
  const { repo, work } = scratch();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ma-chain-out-")));
  try {
    const fetchImpl = stubFetch([
      sse([call("Write", { path: "../../etc-ish/pwned.txt", content: "x" })]),
      sse([done()]),
    ]);
    const loop = await runToolLoop({ ...base, workdir: work, fetchImpl });
    assert.equal(loop.toolStats.writes, 0, "the traversal must be refused at the tool");
    const broker = createBroker({ repoRoot: repo, workdirFor: () => work });
    const changes = await broker.listChanges("agent-1");
    assert.equal(changes.some((c) => /pwned/.test(c.path)), false);
  } finally { clean(repo, work, outside); }
});

test("a symlink planted in the workdir cannot be used to write through", async () => {
  const { repo, work } = scratch();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ma-chain-out2-")));
  try {
    writeFileSync(join(outside, "victim.txt"), "untouched\n");
    symlinkSync(join(outside, "victim.txt"), join(work, "link.txt"));
    const fetchImpl = stubFetch([
      sse([call("Write", { path: "link.txt", content: "pwned" })]),
      sse([done()]),
    ]);
    await runToolLoop({ ...base, workdir: work, fetchImpl });
    assert.equal(readFileSync(join(outside, "victim.txt"), "utf-8"), "untouched\n");
  } finally { clean(repo, work, outside); }
});

test("a capped turn still leaves its partial work visible to the broker, not lost", async () => {
  // A cap is a failure, but the files already written are real and the operator must be
  // able to see them. Silently discarding them would be its own kind of lie.
  const { repo, work } = scratch();
  try {
    const fetchImpl = stubFetch([
      sse([call("Write", { path: "src/partial.ts", content: "export const p = 1;\n" }, "a")]),
      sse([call("Write", { path: "src/more.ts", content: "export const m = 1;\n" }, "b")]),
      sse([call("Write", { path: "src/never.ts", content: "nope\n" }, "c")]),
    ]);
    const loop = await runToolLoop({ ...base, workdir: work, fetchImpl, limits: { maxSteps: 2 } });
    assert.equal(loop.ok, false);
    assert.equal(loop.stopReason, "max_steps");

    const broker = createBroker({ repoRoot: repo, workdirFor: () => work });
    const paths = (await broker.listChanges("agent-1")).map((c) => c.path);
    assert.ok(paths.includes("src/partial.ts"), "work done before the cap must still be reviewable");
  } finally { clean(repo, work); }
});

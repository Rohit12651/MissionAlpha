// MUNDER-ADOPTION A1 — preset-table invariants, pinned.
import test from "node:test";
import assert from "node:assert/strict";
import { CLI_ENGINE_PRESETS, cliEnginePreset, detectEngines, createEngineDetector } from "../providers/cli-engines.mjs";

// A fake `which` matching execFile's (cmd, args, cb) shape.
const fakeWhich = (foundBins) => (cmd, args, cb) => {
  const bin = args[0];
  if (foundBins.has(bin)) cb(null, `/usr/local/bin/${bin}\n`, "");
  else cb(new Error("not found"), "", "");
};

test("the table is frozen, claude-first, and carries NO capability column (Principle 0)", () => {
  assert.ok(Object.isFrozen(CLI_ENGINE_PRESETS));
  assert.equal(CLI_ENGINE_PRESETS[0].id, "claude");
  for (const p of CLI_ENGINE_PRESETS) {
    assert.ok(Object.isFrozen(p));
    assert.ok(!("capability" in p), `${p.id} must not assert capability`);
    assert.ok(["flag", "positional", "type-into-tui"].includes(p.promptDelivery), p.id);
    assert.match(p.bin, /^[a-z]+$/, "bins are fixed lowercase words, never caller input");
  }
});

test("cliEnginePreset resolves by id and refuses prototype keys", () => {
  assert.equal(cliEnginePreset("codex").label, "Codex · GPT");
  assert.equal(cliEnginePreset("constructor"), null);
  assert.equal(cliEnginePreset("__proto__"), null);
  assert.equal(cliEnginePreset("nope"), null);
});

test("crush is type-into-tui (its first positional parses as a subcommand — ported fact)", () => {
  assert.equal(cliEnginePreset("crush").promptDelivery, "type-into-tui");
});

test("detectEngines marks found/missing per PATH, table order preserved", async () => {
  const rows = await detectEngines({ which: fakeWhich(new Set(["claude", "qwen"])) });
  assert.equal(rows.length, CLI_ENGINE_PRESETS.length);
  assert.deepEqual(rows.filter((r) => r.found).map((r) => r.id), ["claude", "qwen"]);
  assert.equal(rows[0].path, "/usr/local/bin/claude");
  assert.equal(rows.find((r) => r.id === "codex").path, null);
});

test("detector caches within ttl, refreshes past it, emits engine.roster on CHANGE only", async () => {
  let t = 0;
  let calls = 0;
  const emitted = [];
  const found = new Set(["claude"]);
  const det = createEngineDetector({
    which: (c, a, cb) => { calls += 1; fakeWhich(found)(c, a, cb); },
    emit: (n, d) => emitted.push({ n, d }),
    now: () => t,
    ttlMs: 1000,
  });
  await det.snapshot();
  const callsAfterFirst = calls;
  await det.snapshot(); // within ttl — cached
  assert.equal(calls, callsAfterFirst);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], { n: "engine.roster", d: { detected: 1, total: CLI_ENGINE_PRESETS.length } });

  t = 2000; // past ttl, same detected set → refresh runs, NO new frame
  await det.snapshot();
  assert.ok(calls > callsAfterFirst);
  assert.equal(emitted.length, 1, "same roster → no frame");

  found.add("codex");
  await det.refresh(); // explicit refresh, set changed → one frame
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].d.detected, 2);
});

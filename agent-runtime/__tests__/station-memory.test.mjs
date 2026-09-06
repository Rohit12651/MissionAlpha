// CC-Primitives P4 — station memory store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStationMemory } from "../station-memory.mjs";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "ma-mem-"));
  return { dir, file: join(dir, "station-memory.json") };
}

test("set + get roundtrip, trimmed, persisted across reload", () => {
  const { dir, file } = fresh();
  try {
    const sm = createStationMemory({ file });
    const r = sm.set("sr-backend", "  Always run tests before PR.\n");
    assert.equal(r.size, "Always run tests before PR.".length);
    assert.equal(sm.get("sr-backend"), "Always run tests before PR.");
    const sm2 = createStationMemory({ file });
    assert.equal(sm2.get("sr-backend"), "Always run tests before PR.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("over-cap is an explicit error, never a silent truncation", () => {
  const { dir, file } = fresh();
  try {
    const sm = createStationMemory({ file, max: 50 });
    const r = sm.set("sr-backend", "x".repeat(51));
    assert.match(r.error, /too long/);
    assert.equal(sm.get("sr-backend"), "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("empty/whitespace clears; off-charset id and non-string rejected", () => {
  const { dir, file } = fresh();
  try {
    const sm = createStationMemory({ file });
    sm.set("sr-backend", "rule");
    assert.deepEqual(sm.set("sr-backend", "   "), { agentId: "sr-backend", memory: "", size: 0 });
    assert.equal(sm.get("sr-backend"), "");
    assert.equal(JSON.parse(readFileSync(file, "utf8"))["sr-backend"], undefined);
    assert.ok(sm.set("../evil", "x").error);
    assert.ok(sm.set("sr-backend", 42).error);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("__proto__ is an ordinary key: real roundtrip, no pollution, no phantom no-op (sr-security P4 LOW-1)", () => {
  const { dir, file } = fresh();
  try {
    const sm = createStationMemory({ file });
    const r = sm.set("__proto__", "proto station rules");
    assert.equal(r.size, "proto station rules".length);
    assert.equal(sm.get("__proto__"), "proto station rules");
    assert.equal(typeof sm.get("constructor"), "string"); // null-proto map: no Object.prototype leak
    assert.equal(({}).polluted, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("load drops off-charset keys and non-strings, caps oversized values", () => {
  const { dir, file } = fresh();
  try {
    writeFileSync(file, JSON.stringify({ "../evil": "a", "qa-station": 9, "sr-backend": "y".repeat(100) }));
    const sm = createStationMemory({ file, max: 50 });
    assert.deepEqual(Object.keys(sm.all()), ["sr-backend"]);
    // R8 — the cap is now a BUDGET WITH AN HONEST EDGE, so the stored value is `<= max`
    // rather than exactly max: an over-length value is cut on a boundary and the drop is
    // declared, and the marker is paid for OUT OF the budget (or it would not be a budget).
    // The contract this test exists for is "an oversized value cannot exceed the cap".
    const stored = sm.get("sr-backend");
    assert.ok(stored.length <= 50, `cap exceeded: ${stored.length}`);
    assert.match(stored, /omitted/, "the drop must be declared, not silent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

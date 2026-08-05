// CC-Primitives P1 — per-station interactive permission mode store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStationPerms } from "../station-perms.mjs";

function freshFile() {
  const dir = mkdtempSync(join(tmpdir(), "ma-stationperms-"));
  return { dir, file: join(dir, "station-perms.json") };
}

test("resolve falls back to the global default when no override", () => {
  const { dir, file } = freshFile();
  try {
    const sp = createStationPerms({ file });
    assert.equal(sp.get("sr-backend"), null);
    assert.equal(sp.resolve("sr-backend", "default"), "default");
    // An off-allowlist global is normalized to acceptEdits, never returned raw.
    assert.equal(sp.resolve("sr-backend", "garbage"), "acceptEdits");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("set + get roundtrip, override wins over global", () => {
  const { dir, file } = freshFile();
  try {
    const sp = createStationPerms({ file });
    const r = sp.set("sr-backend", "default");
    assert.deepEqual(r, { agentId: "sr-backend", permMode: "default" });
    assert.equal(sp.get("sr-backend"), "default");
    assert.equal(sp.resolve("sr-backend", "bypassPermissions"), "default");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid mode is rejected and nothing is persisted", () => {
  const { dir, file } = freshFile();
  try {
    const sp = createStationPerms({ file });
    const r = sp.set("sr-backend", "plan"); // 'plan' is UI-only, never a server mode
    assert.ok(r.error);
    assert.equal(sp.get("sr-backend"), null);
    // File must not contain the rejected value.
    let onDisk = {};
    try { onDisk = JSON.parse(readFileSync(file, "utf8")); } catch { /* no file yet is fine */ }
    assert.equal(onDisk["sr-backend"], undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("override persists across reload (new instance, same file)", () => {
  const { dir, file } = freshFile();
  try {
    createStationPerms({ file }).set("qa-station", "bypassPermissions");
    const sp2 = createStationPerms({ file });
    assert.equal(sp2.get("qa-station"), "bypassPermissions");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("off-allowlist value in the file is dropped on load", () => {
  const { dir, file } = freshFile();
  try {
    writeFileSync(file, JSON.stringify({ "sr-backend": "YOLO", "qa-station": "default" }));
    const sp = createStationPerms({ file });
    assert.equal(sp.get("sr-backend"), null); // dropped
    assert.equal(sp.get("qa-station"), "default"); // kept
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clear removes an override → back to global fallback", () => {
  const { dir, file } = freshFile();
  try {
    const sp = createStationPerms({ file });
    sp.set("sr-backend", "default");
    assert.equal(sp.clear("sr-backend"), true);
    assert.equal(sp.get("sr-backend"), null);
    assert.equal(sp.clear("sr-backend"), false); // idempotent
    assert.equal(sp.resolve("sr-backend", "acceptEdits"), "acceptEdits");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("set rejects an off-charset agentId (no storage pollution)", () => {
  const { dir, file } = freshFile();
  try {
    const sp = createStationPerms({ file });
    const r = sp.set("../evil", "default");
    assert.ok(r.error);
    assert.deepEqual(sp.all(), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("off-charset keys in the file are dropped on load", () => {
  const { dir, file } = freshFile();
  try {
    writeFileSync(file, JSON.stringify({ "../evil": "default", "sr-backend": "default" }));
    const sp = createStationPerms({ file });
    assert.equal(sp.get("../evil"), null);
    assert.equal(sp.get("sr-backend"), "default");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("all() returns a copy, not the live map", () => {
  const { dir, file } = freshFile();
  try {
    const sp = createStationPerms({ file });
    sp.set("sr-backend", "default");
    const snap = sp.all();
    snap["sr-backend"] = "mutated";
    assert.equal(sp.get("sr-backend"), "default");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

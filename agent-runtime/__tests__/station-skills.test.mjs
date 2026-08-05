// CC-Primitives P3 — per-station skills store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStationSkills } from "../station-skills.mjs";

const VALID = new Set(["repo-read", "repo-edit", "research-brief", "content-writing"]);
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "ma-skills-"));
  return { dir, file: join(dir, "station-skills.json") };
}

test("set + get roundtrip, deduped, persisted", () => {
  const { dir, file } = fresh();
  try {
    const ss = createStationSkills({ file, validIds: VALID });
    const r = ss.set("sr-backend", ["repo-read", "repo-edit", "repo-read"]);
    assert.deepEqual(r, { agentId: "sr-backend", skills: ["repo-read", "repo-edit"] });
    assert.deepEqual(ss.get("sr-backend"), ["repo-read", "repo-edit"]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8"))["sr-backend"], ["repo-read", "repo-edit"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown skill id rejected, nothing persisted", () => {
  const { dir, file } = fresh();
  try {
    const ss = createStationSkills({ file, validIds: VALID });
    const r = ss.set("sr-backend", ["repo-read", "evil-skill"]);
    assert.match(r.error, /unknown skill/);
    assert.deepEqual(ss.get("sr-backend"), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("off-charset agentId + non-array rejected; over-cap rejected explicitly", () => {
  const { dir, file } = fresh();
  try {
    const ss = createStationSkills({ file, validIds: VALID });
    assert.ok(ss.set("../evil", ["repo-read"]).error);
    assert.ok(ss.set("sr-backend", "repo-read").error);
    const many = Array.from({ length: 13 }, (_, i) => "s" + i);
    assert.match(ss.set("sr-backend", many).error, /too many|unknown/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("empty array clears the station's list", () => {
  const { dir, file } = fresh();
  try {
    const ss = createStationSkills({ file, validIds: VALID });
    ss.set("sr-backend", ["repo-read"]);
    assert.deepEqual(ss.set("sr-backend", []), { agentId: "sr-backend", skills: [] });
    assert.deepEqual(ss.get("sr-backend"), []);
    assert.equal(JSON.parse(readFileSync(file, "utf8"))["sr-backend"], undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("load drops off-charset keys, unknown ids, non-arrays; survives reload", () => {
  const { dir, file } = fresh();
  try {
    writeFileSync(file, JSON.stringify({
      "../evil": ["repo-read"],
      "sr-backend": ["repo-read", "evil-skill"],
      "qa-station": "not-an-array",
    }));
    const ss = createStationSkills({ file, validIds: VALID });
    assert.deepEqual(ss.all(), { "sr-backend": ["repo-read"] });
    ss.set("qa-station", ["research-brief"]);
    const ss2 = createStationSkills({ file, validIds: VALID });
    assert.deepEqual(ss2.get("qa-station"), ["research-brief"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("get/all return copies, not live references", () => {
  const { dir, file } = fresh();
  try {
    const ss = createStationSkills({ file, validIds: VALID });
    ss.set("sr-backend", ["repo-read"]);
    ss.get("sr-backend").push("mutant");
    ss.all()["sr-backend"].push("mutant2");
    assert.deepEqual(ss.get("sr-backend"), ["repo-read"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A1 — capabilities index + capsForSpec
import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityIndex, capsForSpec } from "../capabilities.mjs";

const BUILTIN_IDS = [
  "ceo", "architect", "principal-ux-design", "principal-db-engineer",
  "senior-security-engineer", "senior-cicd-engineer", "senior-lead-dev",
  "senior-web-1", "senior-web-2", "principal-rn-mobile-1", "principal-rn-mobile-2",
  "senior-backend-1", "senior-backend-2", "senior-qa", "senior-code-reviewer",
  "memory-updater",
];

test("capabilityIndex returns a Map with exactly 16 builtins", () => {
  const idx = capabilityIndex();
  assert.ok(idx instanceof Map, "must be a Map");
  assert.equal(idx.size, 16, "must have exactly 16 entries");
});

test("capabilityIndex contains all builtin agent IDs", () => {
  const idx = capabilityIndex();
  for (const id of BUILTIN_IDS) {
    assert.ok(idx.has(id), `missing builtin: ${id}`);
  }
});

test("capabilityIndex entries have langs/frameworks/dbs arrays", () => {
  const idx = capabilityIndex();
  for (const [id, caps] of idx) {
    assert.ok(Array.isArray(caps.langs), `${id}.langs must be array`);
    assert.ok(Array.isArray(caps.frameworks), `${id}.frameworks must be array`);
    assert.ok(Array.isArray(caps.dbs), `${id}.dbs must be array`);
  }
});

test("senior-backend-1 has python + mongodb (fastapi backend owner)", () => {
  const idx = capabilityIndex();
  const caps = idx.get("senior-backend-1");
  assert.ok(caps.langs.includes("python"), "senior-backend-1 must know python");
  assert.ok(caps.dbs.includes("mongodb"), "senior-backend-1 must know mongodb");
});

test("senior-web-1 has typescript + react (frontend owner)", () => {
  const idx = capabilityIndex();
  const caps = idx.get("senior-web-1");
  assert.ok(caps.langs.includes("typescript"), "senior-web-1 must know typescript");
  assert.ok(caps.frameworks.includes("react"), "senior-web-1 must know react");
});

test("principal-db-engineer has NO sql stacks (MongoDB-only project)", () => {
  const idx = capabilityIndex();
  const caps = idx.get("principal-db-engineer");
  const sqlTerms = ["postgres", "mysql", "sql", "postgresql"];
  for (const s of sqlTerms) {
    assert.ok(!caps.dbs.includes(s), `principal-db-engineer must not list ${s}`);
  }
});

// capsForSpec ──────────────────────────────────────────────────────────────────

test("capsForSpec — code-implement-go skill yields {langs:[go], frameworks:[], dbs:[]}", () => {
  const spec = { skills: ["code-implement-go"] };
  const caps = capsForSpec(spec);
  assert.deepEqual(caps.langs, ["go"]);
  assert.deepEqual(caps.frameworks, []);
  assert.deepEqual(caps.dbs, []);
});

test("capsForSpec — code-implement-angular skill yields typescript + angular", () => {
  const spec = { skills: ["code-implement-angular"] };
  const caps = capsForSpec(spec);
  assert.ok(caps.langs.includes("typescript"), "must have typescript");
  assert.ok(caps.frameworks.includes("angular"), "must have angular");
});

test("capsForSpec — content-only skill yields empty caps (no stack)", () => {
  const spec = { skills: ["content-writing"] };
  const caps = capsForSpec(spec);
  assert.deepEqual(caps.langs, []);
  assert.deepEqual(caps.frameworks, []);
  assert.deepEqual(caps.dbs, []);
});

test("capsForSpec — empty skills array yields empty caps", () => {
  const caps = capsForSpec({ skills: [] });
  assert.deepEqual(caps, { langs: [], frameworks: [], dbs: [] });
});

test("capsForSpec — null/undefined spec yields empty caps", () => {
  assert.deepEqual(capsForSpec(null), { langs: [], frameworks: [], dbs: [] });
  assert.deepEqual(capsForSpec(undefined), { langs: [], frameworks: [], dbs: [] });
});

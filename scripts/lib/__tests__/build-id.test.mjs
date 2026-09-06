// Tests for the build-identity stamp (Phase 0 Task 0.4, autonomy program).
//
// The property that matters: the stamp must CHANGE for every input change that can change
// a pixel, and must NOT change for anything else. A stamp that never changes is a guard
// that always passes, which is the failure mode this whole phase is about.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeSourceId,
  listSourceFiles,
  buildIdMetaTag,
  BUILD_ID_META,
} from "../build-id.mjs";

/** A minimal tree with the same shape as the repo's hashed inputs. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "build-id-"));
  mkdirSync(join(root, "src", "theme"), { recursive: true });
  writeFileSync(join(root, "src", "App.tsx"), "export const App = () => null;\n");
  writeFileSync(join(root, "src", "theme", "helm.css"), ":root{--helm-ink:#050a14}\n");
  writeFileSync(join(root, "index.html"), "<!doctype html><html></html>\n");
  writeFileSync(join(root, "tailwind.config.ts"), "export default {};\n");
  writeFileSync(join(root, "postcss.config.js"), "module.exports = {};\n");
  return root;
}

test("the same tree hashes to the same id", () => {
  const root = fixture();
  try {
    assert.equal(computeSourceId(root), computeSourceId(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a one-character CSS change moves the id", () => {
  const root = fixture();
  try {
    const before = computeSourceId(root);
    // The exact class of change the blind visual net could not see.
    writeFileSync(join(root, "src", "theme", "helm.css"), ":root{--helm-ink:#050a15}\n");
    assert.notEqual(computeSourceId(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a RENAME moves the id even though no bytes changed", () => {
  const root = fixture();
  try {
    const before = computeSourceId(root);
    renameSync(join(root, "src", "App.tsx"), join(root, "src", "Shell.tsx"));
    assert.notEqual(computeSourceId(root), before, "path must be part of the digest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adding a file moves the id", () => {
  const root = fixture();
  try {
    const before = computeSourceId(root);
    writeFileSync(join(root, "src", "New.tsx"), "export const N = 1;\n");
    assert.notEqual(computeSourceId(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting a hashed root config moves the id — ABSENT is not the same as empty", () => {
  const root = fixture();
  try {
    const before = computeSourceId(root);
    rmSync(join(root, "tailwind.config.ts"));
    const absent = computeSourceId(root);
    assert.notEqual(absent, before);
    writeFileSync(join(root, "tailwind.config.ts"), "");
    assert.notEqual(computeSourceId(root), absent, "an empty file must differ from ABSENT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file OUTSIDE the hashed set does not move the id", () => {
  const root = fixture();
  try {
    const before = computeSourceId(root);
    writeFileSync(join(root, "README.md"), "# not a build input\n");
    assert.equal(computeSourceId(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the file list is sorted and path-normalised, so it cannot depend on readdir order", () => {
  const root = fixture();
  try {
    const files = listSourceFiles(root);
    assert.deepEqual(files, [...files].sort());
    for (const f of files) assert.doesNotMatch(f, /\\/, "paths must use forward slashes");
    assert.ok(files.includes("src/theme/helm.css"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the id is short, hex, and stable in shape", () => {
  const root = fixture();
  try {
    assert.match(computeSourceId(root), /^[0-9a-f]{16}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the meta tag carries the id under the agreed name", () => {
  assert.equal(buildIdMetaTag("abc123"), `<meta name="${BUILD_ID_META}" content="abc123" />`);
});

test("the real repo hashes without throwing and covers the theme layer", () => {
  // Guards against the walk silently returning nothing (which would make the stamp a
  // constant and the harness assertion a no-op).
  const repo = new URL("../../../", import.meta.url).pathname;
  const files = listSourceFiles(repo);
  assert.ok(files.length > 50, `only ${files.length} source files hashed`);
  assert.ok(files.includes("src/theme/helm.css"));
  assert.match(computeSourceId(repo), /^[0-9a-f]{16}$/);
});

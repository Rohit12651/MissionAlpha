import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  extOf, extAllowed, kindFor, sniffOk, safeName, displayName,
  uploadMsgDir, buildManifest, UPLOADS_ROOT, MAX_FILES, MAX_FILE_BYTES,
  xlsxToCsv,
} from "../uploads.mjs";

test("extOf lowercases and extracts", () => {
  assert.equal(extOf("Photo.PNG"), ".png");
  assert.equal(extOf("a.tar.gz"), ".gz");
  assert.equal(extOf("noext"), "");
});

test("extAllowed gates by allowlist", () => {
  for (const ok of ["a.png", "b.JPG", "c.pdf", "d.csv", "e.txt", "f.md", "g.webp"]) {
    assert.equal(extAllowed(ok), true, ok);
  }
  for (const bad of ["x.exe", "y.svg", "z.html", "w.zip", "q.js", "noext"]) {
    assert.equal(extAllowed(bad), false, bad);
  }
});

test("kindFor maps families", () => {
  assert.equal(kindFor("a.png"), "image");
  assert.equal(kindFor("a.pdf"), "pdf");
  assert.equal(kindFor("a.csv"), "text");
  assert.equal(kindFor("a.exe"), null);
});

test("sniffOk matches magic bytes for binary types", () => {
  assert.equal(sniffOk(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]), "x.png"), true);
  assert.equal(sniffOk(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "x.jpg"), true);
  assert.equal(sniffOk(Buffer.from("%PDF-1.7"), "x.pdf"), true);
  // webp: RIFF????WEBP
  assert.equal(sniffOk(Buffer.from("RIFF\x00\x00\x00\x00WEBP"), "x.webp"), true);
});

test("sniffOk rejects spoofed binary content", () => {
  // an HTML/script payload renamed to .png
  assert.equal(sniffOk(Buffer.from("<html><script>"), "evil.png"), false);
  assert.equal(sniffOk(Buffer.from([0x00, 0x01, 0x02, 0x03]), "x.pdf"), false);
  assert.equal(sniffOk(Buffer.from([]), "x.png"), false); // too short
});

test("sniffOk passes text types by extension", () => {
  assert.equal(sniffOk(Buffer.from("a,b,c\n1,2,3"), "data.csv"), true);
  assert.equal(sniffOk(Buffer.from("anything"), "n.txt"), true);
});

test("safeName never uses the client filename, keeps allowed ext", () => {
  assert.equal(safeName(0, "../../etc/passwd.png"), "f0.png");
  assert.equal(safeName(3, "weird name;rm -rf.pdf"), "f3.pdf");
  assert.equal(safeName(1, "bad.exe"), "f1.bin"); // disallowed ext → .bin
  assert.equal(safeName(2, "noext"), "f2.bin");
});

test("displayName strips control/path chars and caps length", () => {
  assert.equal(displayName("ok-file_1.png"), "ok-file_1.png");
  assert.ok(!displayName("a/b\\c\n<x>.png").includes("/"));
  assert.ok(!displayName("a/b\\c\n<x>.png").includes("\n"));
  assert.equal(displayName("").length > 0, true);
  assert.ok(displayName("x".repeat(500)).length <= 80);
});

test("uploadMsgDir stays under UPLOADS_ROOT and sanitizes ids", () => {
  const d = uploadMsgDir("../evil", "../../msg");
  assert.ok(d.startsWith(UPLOADS_ROOT), d);
  assert.ok(!d.includes(".."), d);
});

test("buildManifest is empty when no files, lists paths otherwise", () => {
  assert.equal(buildManifest([]), "");
  const out = buildManifest([
    { absPath: "/tmp/u/f0.png", origName: "mock.png", kind: "image" },
    { absPath: "/tmp/u/f1.csv", origName: "data.xlsx→csv", kind: "text", note: "from Excel" },
  ]);
  assert.match(out, /\/tmp\/u\/f0\.png/);
  assert.match(out, /image/);
  assert.match(out, /from Excel/);
  assert.match(out, /read them with the Read tool/i);
});

test("caps are sane numbers", () => {
  assert.ok(MAX_FILES >= 1 && MAX_FILES <= 64);
  assert.ok(MAX_FILE_BYTES >= 1024);
});

// ── XLSX Phase 2 tests (ADR-049 §2) ────────────────────────────────────────

test("xlsx passes extension allowlist, kindFor=spreadsheet, sniffOk on PK header", () => {
  assert.equal(extAllowed("report.xlsx"), true);
  assert.equal(extAllowed("REPORT.XLSX"), true);
  assert.equal(kindFor("report.xlsx"), "spreadsheet");
  // xlsx is a zip → PK header: 0x50 0x4b 0x03 0x04
  const pkBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  assert.equal(sniffOk(pkBuf, "x.xlsx"), true);
  // Wrong magic → reject
  assert.equal(sniffOk(Buffer.from([0x00, 0x01, 0x02, 0x03]), "x.xlsx"), false);
});

test("xlsxToCsv: normal 2-row workbook → csv sidecar, rows=2, truncated=false", async () => {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const tmpFile = join(tmpdir(), `ma_test_${Date.now()}.xlsx`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(tmpFile, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  try {
    const result = await xlsxToCsv(tmpFile);
    assert.ok(!result.error, `unexpected error: ${result.error}`);
    assert.ok(existsSync(result.csvPath), "csv sidecar must exist");
    const csv = readFileSync(result.csvPath, "utf-8");
    assert.match(csv, /a,b/);
    assert.match(csv, /1,2/);
    assert.equal(result.rows, 2);
    assert.equal(result.truncated, false);
  } finally {
    try { rmSync(tmpFile, { force: true }); } catch { /* */ }
    const csvPath = tmpFile.slice(0, -5) + ".csv";
    try { rmSync(csvPath, { force: true }); } catch { /* */ }
  }
});

test("xlsxToCsv: maxRows=1 on 3-row sheet → truncated=true, rows capped", async () => {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet([["x", "y"], ["r1", "r2"], ["r3", "r4"]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const tmpFile = join(tmpdir(), `ma_test_trunc_${Date.now()}.xlsx`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(tmpFile, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  try {
    const result = await xlsxToCsv(tmpFile, { maxRows: 1 });
    assert.ok(!result.error, `unexpected error: ${result.error}`);
    assert.equal(result.truncated, true);
    assert.ok(result.rows <= 1, `rows should be capped at 1, got ${result.rows}`);
    const csv = readFileSync(result.csvPath, "utf-8");
    // Only the first row (header "x,y") should be present; subsequent rows dropped
    assert.match(csv, /x,y/);
    assert.ok(!csv.includes("r1"), "truncated csv must not contain row beyond cap");
  } finally {
    try { rmSync(tmpFile, { force: true }); } catch { /* */ }
    const csvPath = tmpFile.slice(0, -5) + ".csv";
    try { rmSync(csvPath, { force: true }); } catch { /* */ }
  }
});

test("xlsxToCsv: garbage (non-zip) file → returns {error}, no throw", async () => {
  const { writeFileSync } = await import("node:fs");
  const tmpFile = join(tmpdir(), `ma_test_garbage_${Date.now()}.xlsx`);
  writeFileSync(tmpFile, Buffer.from("this is not a zip file at all !!!"));
  try {
    const result = await xlsxToCsv(tmpFile);
    assert.ok(result.error, "should return {error} for garbage input");
    assert.equal(typeof result.error, "string");
  } finally {
    try { rmSync(tmpFile, { force: true }); } catch { /* */ }
  }
});

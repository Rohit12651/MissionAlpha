import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extOf, extAllowed, kindFor, sniffOk, safeName, displayName,
  uploadMsgDir, buildManifest, UPLOADS_ROOT, MAX_FILES, MAX_FILE_BYTES,
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

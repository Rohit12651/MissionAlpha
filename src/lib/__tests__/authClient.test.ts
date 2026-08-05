import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMentions } from "../authClient.ts";

// parseMentions is the pure, display-only @mention splitter used by ReviewPane. It
// must never execute or notify — it only segments text for highlighting.

test("parseMentions returns a single text segment when there is no mention", () => {
  assert.deepEqual(parseMentions("just some feedback"), [{ type: "text", value: "just some feedback" }]);
});

test("parseMentions splits a single @mention out of surrounding text", () => {
  assert.deepEqual(parseMentions("please review @alice thanks"), [
    { type: "text", value: "please review " },
    { type: "mention", value: "@alice" },
    { type: "text", value: " thanks" },
  ]);
});

test("parseMentions handles multiple mentions and a leading mention", () => {
  assert.deepEqual(parseMentions("@bob and @carol-2 please"), [
    { type: "mention", value: "@bob" },
    { type: "text", value: " and " },
    { type: "mention", value: "@carol-2" },
    { type: "text", value: " please" },
  ]);
});

test("parseMentions accepts dot/underscore/hyphen name chars and stops at spaces/punctuation", () => {
  assert.deepEqual(parseMentions("cc @a.b_c! done"), [
    { type: "text", value: "cc " },
    { type: "mention", value: "@a.b_c" },
    { type: "text", value: "! done" },
  ]);
});

test("parseMentions returns an empty array for empty input", () => {
  assert.deepEqual(parseMentions(""), []);
});

test("parseMentions reconstructs the original text exactly (no loss)", () => {
  const src = "hi @x, ping @y.z and finish";
  assert.equal(parseMentions(src).map((s) => s.value).join(""), src);
});

// P5 — the pure half of the workspace client. These labels are what the operator
// reads before approving, so "honest about what will happen" is a TESTED property,
// not a review note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { displayPath, ghLabel, ghTone, modeLabel, isSafePrUrl } from "../workspaceClient.ts";

test("displayPath abbreviates the home prefix and handles the unset case", () => {
  assert.equal(displayPath("/Users/rohit/code/app", "/Users/rohit"), "~/code/app");
  assert.equal(displayPath("/opt/app", "/Users/rohit"), "/opt/app");
  assert.equal(displayPath("/opt/app"), "/opt/app");
  assert.equal(displayPath(null, "/Users/rohit"), "No workspace selected");
  assert.equal(displayPath(undefined), "No workspace selected");
});

test("ghLabel is honest about each capability combination", () => {
  assert.match(ghLabel({ installed: false, authenticated: false, hasRemote: false }), /not installed/i);
  assert.match(ghLabel({ installed: true, authenticated: false, hasRemote: true }), /not authenticated/i);
  assert.match(ghLabel({ installed: true, authenticated: true, hasRemote: false }), /no remote/i);
  assert.match(ghLabel({ installed: true, authenticated: true, hasRemote: true }), /ready/i);
});

test("ghLabel never promises a pull request when one cannot be opened", () => {
  for (const s of [
    { installed: false, authenticated: false, hasRemote: true },
    { installed: true, authenticated: false, hasRemote: true },
    { installed: true, authenticated: true, hasRemote: false },
  ]) {
    assert.match(ghLabel(s), /local branch/i, "must state the branch fallback");
    assert.doesNotMatch(ghLabel(s), /open a pull request/i);
  }
});

test("ghTone is green only when a PR is genuinely possible", () => {
  assert.equal(ghTone({ installed: true, authenticated: true, hasRemote: true }), "green");
  assert.equal(ghTone({ installed: true, authenticated: true, hasRemote: false }), "amber");
  assert.equal(ghTone({ installed: false, authenticated: false, hasRemote: false }), "amber");
});

test("modeLabel maps every recorded mode, and null", () => {
  assert.match(modeLabel("pr", "ma/task/t"), /pull request/i);
  assert.match(modeLabel("branch", "ma/task/t"), /ma\/task\/t/);
  assert.match(modeLabel("branch", null), /unknown/i);
  assert.match(modeLabel("apply", null), /applied directly/i);
  assert.equal(modeLabel(null, null), "");
});

test("isSafePrUrl accepts only https GitHub origins", () => {
  assert.equal(isSafePrUrl("https://github.com/acme/app/pull/42"), true);
  assert.equal(isSafePrUrl("https://gist.github.com/x"), true);
  assert.equal(isSafePrUrl("http://github.com/acme/app/pull/42"), false, "plaintext");
  assert.equal(isSafePrUrl("javascript:alert(1)"), false);
  assert.equal(isSafePrUrl("https://github.com.evil.tld/x"), false, "suffix spoof");
  assert.equal(isSafePrUrl("https://evil.tld/github.com/x"), false, "path spoof");
  assert.equal(isSafePrUrl("https://notgithub.com/x"), false);
  assert.equal(isSafePrUrl("not a url"), false);
  assert.equal(isSafePrUrl(null), false);
  assert.equal(isSafePrUrl(""), false);
});

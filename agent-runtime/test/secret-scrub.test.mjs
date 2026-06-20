// ADR-033 — per-spawn MCP cred egress scrub: ref-counting + once()-guarded cleanup.
// Directly exercises the fix for the sr-review HIGH (error+close double-fire must not
// over-decrement a sibling spawn's live cred out of the redaction set).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSecretScrubber, once } from "../secret-scrub.mjs";

const SECRET = "ghp_live_token_abcdef123456";

test("scrub redacts a registered secret; passes other text through", () => {
  const s = createSecretScrubber();
  s.add([SECRET]);
  assert.equal(s.scrub(`token is ${SECRET} ok`), "token is [redacted-mcp-cred] ok");
  assert.equal(s.scrub("nothing secret here"), "nothing secret here");
});

test("after remove, the secret is no longer redacted", () => {
  const s = createSecretScrubber();
  s.add([SECRET]);
  s.remove([SECRET]);
  assert.equal(s.active(), 0);
  assert.equal(s.scrub(SECRET), SECRET);
});

test("ref-count: a secret shared by 2 spawns survives ONE remove (concurrent safety)", () => {
  const s = createSecretScrubber();
  s.add([SECRET]); // spawn A
  s.add([SECRET]); // spawn B (same cred granted to both)
  s.remove([SECRET]); // A ends
  assert.ok(s.scrub(SECRET).includes("[redacted-mcp-cred]"), "still redacted — B is live");
  s.remove([SECRET]); // B ends
  assert.equal(s.scrub(SECRET), SECRET, "now released");
});

test("once() runs the wrapped fn at most once", () => {
  let n = 0;
  const f = once(() => { n++; });
  f(); f(); f();
  assert.equal(n, 1);
});

test("THE HIGH BUG: error+close double-fire on a spawn must NOT leak a sibling's cred", () => {
  const s = createSecretScrubber();
  // spawn A and spawn B both granted the same cred → refcount 2
  s.add([SECRET]); // A
  s.add([SECRET]); // B
  // A's cleanup is once()-guarded (as in server.mjs); Node fires BOTH 'error' and 'close'
  const cleanupA = once(() => s.remove([SECRET]));
  cleanupA(); // error
  cleanupA(); // close — must be a no-op
  // B is still streaming → its cred MUST remain redacted
  assert.ok(s.scrub(`leak? ${SECRET}`).includes("[redacted-mcp-cred]"), "sibling cred still protected");
  assert.equal(s.active(), 1, "exactly one ref remains (B)");
});

test("WITHOUT once(), the double-fire would over-decrement (proves the guard is necessary)", () => {
  const s = createSecretScrubber();
  s.add([SECRET]); // A
  s.add([SECRET]); // B
  const unguarded = () => s.remove([SECRET]);
  unguarded(); unguarded(); // A's error + close, no guard
  // bug reproduced: B's cred wrongly dropped
  assert.equal(s.scrub(SECRET), SECRET, "demonstrates the leak the once() guard prevents");
});

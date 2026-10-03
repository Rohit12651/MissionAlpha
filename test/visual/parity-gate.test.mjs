// The parity gate: a NO-MATCH frame fails the audit unless it is on the reviewed allowlist,
// and an allowlisted frame that now MATCHes fails too, so the list can only shrink.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateVerdicts, frameKey, PARITY_ALLOWLIST } from "./parity-gate.mjs";

const row = (tab, breakpoint, frame, verdict) => ({ tab, breakpoint, frame, verdict });
const allow = new Map([["inbox-mobile-end", "reviewed reason"]]);

test("BAD: a NO-MATCH frame that is not allowlisted is reported", () => {
  const r = gateVerdicts([row("center", "mobile", "end", "NO-MATCH")], allow);
  assert.deepEqual(r.unexpected, ["center-mobile-end"]);
});

test("GOOD: an allowlisted NO-MATCH frame passes", () => {
  const r = gateVerdicts([row("inbox", "mobile", "end", "NO-MATCH")], allow);
  assert.deepEqual(r, { unexpected: [], stale: [] });
});

test("UNRELATED: a MATCH frame off the list passes", () => {
  assert.deepEqual(gateVerdicts([row("center", "desktop", "top", "MATCH")], allow), { unexpected: [], stale: [] });
});

test("STALE: an allowlisted frame that now MATCHes must be removed from the list", () => {
  const r = gateVerdicts([row("inbox", "mobile", "end", "MATCH")], allow);
  assert.deepEqual(r.stale, ["inbox-mobile-end"]);
});

test("the reviewed allowlist is the 12 escalated frames, each with a reason", () => {
  assert.equal(PARITY_ALLOWLIST.size, 12);
  for (const [key, why] of PARITY_ALLOWLIST) {
    assert.match(key, /^[a-z0-9-]+-(desktop|laptop|tablet|mobile)-(top|end)$/, key);
    assert.ok(why.length > 20, `${key} needs a real reason`);
  }
  assert.equal(frameKey(row("setup-3", "mobile", "top")), "setup-3-mobile-top");
});

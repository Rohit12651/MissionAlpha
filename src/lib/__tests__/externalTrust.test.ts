// Phase 3 (UI) — R10 trust tier + R12 injection flags on an external Delivery.
//
// Both have been persisted on `externalMeta` since sessions 6 and 10 and shown to NOBODY.
// The runtime has been scoring every ingestion source and flagging crafted PR bodies, and
// the operator deciding those rows could not see either.
//
// LAW 4 IS THE LOAD-BEARING CONSTRAINT HERE, and it is a UI constraint too: trust adds
// FRICTION, never permission. A "trusted" chip must never read as a recommendation to
// approve — `trusted` is the BASELINE, not a reward, and the tests below pin that the
// chip has no affirmative/green treatment anywhere in its vocabulary.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trustChip,
  injectionChip,
  type TrustStamp,
  type InjectFlags,
} from "../externalTrust.ts";

const stamp = (over: Partial<TrustStamp> = {}): TrustStamp =>
  ({ source: "github-pr", score: 0.9, tier: "trusted", friction: "none", observations: 42, coldStart: false, ...over });

// ── trust ────────────────────────────────────────────────────────────────────

test("TRUST-1: each tier gets its own label and tone", () => {
  assert.equal(trustChip(stamp({ tier: "trusted" }))?.tone, "muted");
  assert.equal(trustChip(stamp({ tier: "watch" }))?.tone, "amber");
  assert.equal(trustChip(stamp({ tier: "suspect" }))?.tone, "red");
});

test("LAW4-UI: 'trusted' is the BASELINE and never renders as an endorsement", () => {
  // A green chip beside an Approve button is a recommendation. Trust cannot recommend —
  // it can only add friction — so the best tier is visually the QUIETEST, not the
  // most affirmative. `muted` is the same tone the neutral source chip uses.
  const c = trustChip(stamp({ tier: "trusted" }));
  assert.equal(c?.tone, "muted");
  assert.notEqual(c?.tone, "green");
  assert.doesNotMatch(c?.label ?? "", /safe|ok|approved?|verified|good/i);
});

test("TRUST-2: cold start reads as 'new', never as 'suspect'", () => {
  // Collapsing "never seen this source" into "seen it, it misbehaved" throws away the
  // distinction the operator most needs. The runtime already separates them; so does this.
  const c = trustChip(stamp({ tier: "watch", coldStart: true, observations: 2 }));
  assert.match(c?.label ?? "", /new/i);
  assert.doesNotMatch(c?.label ?? "", /suspect/i);
});

test("TRUST-3: the observation count rides in the title — a score with no basis is noise", () => {
  const c = trustChip(stamp({ observations: 42 }));
  assert.match(c?.title ?? "", /42/);
});

test("TRUST-4: an absent or malformed stamp renders NOTHING, never a default tier", () => {
  // Defaulting an unmeasured source to "trusted" would be an unearned claim; defaulting it
  // to "suspect" would slander a source nobody has scored. Absence is absence.
  for (const bad of [null, undefined, {}, { tier: "bogus" }, "nope", 7]) {
    assert.equal(trustChip(bad as unknown as TrustStamp), null, `${JSON.stringify(bad)}`);
  }
});

// ── injection ────────────────────────────────────────────────────────────────

const flags = (over: Partial<InjectFlags> = {}): InjectFlags =>
  ({ count: 2, maxSeverity: "high", score: 12, patterns: ["ignore-previous", "system-turn"], ...over });

test("INJECT-1: a flagged body gets a chip naming the count", () => {
  const c = injectionChip(flags({ count: 3 }));
  assert.ok(c);
  assert.match(c.label, /3/);
  assert.match(c.label, /injection/i);
});

test("INJECT-2: severity drives tone — high/critical red, lower amber", () => {
  assert.equal(injectionChip(flags({ maxSeverity: "critical" }))?.tone, "red");
  assert.equal(injectionChip(flags({ maxSeverity: "high" }))?.tone, "red");
  assert.equal(injectionChip(flags({ maxSeverity: "medium" }))?.tone, "amber");
  assert.equal(injectionChip(flags({ maxSeverity: "low" }))?.tone, "amber");
});

test("INJECT-3: the matched pattern ids ride in the title, so the flag is explicable", () => {
  const c = injectionChip(flags({ patterns: ["ignore-previous", "system-turn"] }));
  assert.match(c?.title ?? "", /ignore-previous/);
  assert.match(c?.title ?? "", /system-turn/);
});

test("INJECT-4: the chip says FLAGGED, never that anything was blocked or removed", () => {
  // R12's behaviour is FLAG ONLY — content is never filtered, rewritten or rejected, and
  // the operator sees the original. A chip implying removal would describe a product that
  // does not exist and would stop the operator reading what is actually there.
  const c = injectionChip(flags());
  assert.doesNotMatch(c?.label ?? "", /blocked|removed|stripped|sanitized|cleaned/i);
  assert.match(c?.title ?? "", /not been (altered|modified|changed)|unaltered|original/i);
});

test("INJECT-5: no flags → no chip", () => {
  for (const bad of [null, undefined, {}, { count: 0 }, { count: "x" }]) {
    assert.equal(injectionChip(bad as unknown as InjectFlags), null, `${JSON.stringify(bad)}`);
  }
});

test("INJECT-6: an unknown severity is treated as the WORSE case, never dismissed", () => {
  // Fail-suspicious: a severity this build does not recognise is not a reason to relax.
  assert.equal(injectionChip(flags({ maxSeverity: "weird" as InjectFlags["maxSeverity"] }))?.tone, "red");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEEN_CAP,
  shouldNotify,
  titleWithBadge,
  notificationText,
} from "../deliveryNotify.ts";

test("one notification per delivery — the second offer is refused (§5.10 dedupe)", () => {
  const seen = new Set<string>();
  assert.equal(shouldNotify(seen, "01J1"), true);
  assert.equal(shouldNotify(seen, "01J1"), false);
  assert.equal(shouldNotify(seen, "01J2"), true);
});

test("an empty id never notifies", () => {
  assert.equal(shouldNotify(new Set(), ""), false);
});

test("the dedupe set is bounded — a long session cannot grow it without limit", () => {
  const seen = new Set<string>();
  for (let i = 0; i < SEEN_CAP + 50; i++) shouldNotify(seen, `id-${i}`);
  assert.ok(seen.size <= SEEN_CAP, `expected <= ${SEEN_CAP}, got ${seen.size}`);
  assert.equal(seen.has(`id-${SEEN_CAP + 49}`), true, "the newest id is retained");
});

test("title badge prefixes a count and never renders (0)", () => {
  assert.equal(titleWithBadge("MissionAlpha", 3), "(3) MissionAlpha");
  assert.equal(titleWithBadge("MissionAlpha", 0), "MissionAlpha");
});

test("title badge is idempotent — re-applying never stacks prefixes", () => {
  assert.equal(titleWithBadge(titleWithBadge("MissionAlpha", 3), 5), "(5) MissionAlpha");
  assert.equal(titleWithBadge(titleWithBadge("MissionAlpha", 3), 0), "MissionAlpha");
});

test("notification text uses the real payload, with an honest fallback", () => {
  assert.deepEqual(notificationText({ title: "Add JWT refresh", agentId: "senior-web-1" }), {
    title: "Add JWT refresh",
    body: "senior-web-1 — awaiting your decision",
  });
  assert.deepEqual(notificationText({}), {
    title: "New delivery",
    body: "an agent — awaiting your decision",
  });
});

test("notification title is length-capped before it crosses the bridge", () => {
  const long = "x".repeat(400);
  assert.equal(notificationText({ title: long }).title.length, 120);
});

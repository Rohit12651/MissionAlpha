import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SELECTION, toggle, selectRange, clear, prune, isSelected, selectedCount, selectedIds } from "../selectionModel.ts";

test("toggle adds then removes, and sets the anchor", () => {
  let s = toggle(EMPTY_SELECTION, "a");
  assert.equal(isSelected(s, "a"), true);
  assert.equal(s.anchor, "a");
  s = toggle(s, "a");
  assert.equal(isSelected(s, "a"), false);
});

test("shift-range selects the inclusive span in visible order", () => {
  const order = ["a", "b", "c", "d"];
  let s = toggle(EMPTY_SELECTION, "a");
  s = selectRange(s, "c", order);
  assert.deepEqual(selectedIds(s).sort(), ["a", "b", "c"]);
});

test("shift-range works backwards too", () => {
  const order = ["a", "b", "c", "d"];
  let s = toggle(EMPTY_SELECTION, "d");
  s = selectRange(s, "b", order);
  assert.deepEqual(selectedIds(s).sort(), ["b", "c", "d"]);
});

test("shift-range with no anchor is just a toggle", () => {
  const s = selectRange(EMPTY_SELECTION, "b", ["a", "b"]);
  assert.deepEqual(selectedIds(s), ["b"]);
});

test("shift-range falls back to toggle when an end vanished from view", () => {
  let s = toggle(EMPTY_SELECTION, "gone");
  s = selectRange(s, "b", ["a", "b"]);
  assert.equal(isSelected(s, "b"), true);
});

test("prune drops ids that left the view so a stale selection cannot be acted on", () => {
  let s = toggle(EMPTY_SELECTION, "a");
  s = toggle(s, "b");
  s = prune(s, ["a"]);
  assert.deepEqual(selectedIds(s), ["a"]);
  assert.equal(selectedCount(s), 1);
});

test("prune returns the SAME object when nothing changed (no needless re-render)", () => {
  const s = toggle(EMPTY_SELECTION, "a");
  assert.equal(prune(s, ["a", "b"]), s);
});

test("prune clears a stale anchor", () => {
  let s = toggle(EMPTY_SELECTION, "a");
  s = prune(s, ["b"]);
  assert.equal(s.anchor, null);
});

test("clear empties everything", () => {
  let s = toggle(EMPTY_SELECTION, "a");
  s = clear();
  assert.equal(selectedCount(s), 0);
});

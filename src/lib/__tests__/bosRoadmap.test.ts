// B7 — the Roadmap constant mirrors the program plan's PROGRAM STATUS by hand. This pins
// the phase set and the statuses the plan and the code agree on, so a stale entry is a red
// test, not a quiet lie on a read-only page.

import test from "node:test";
import assert from "node:assert/strict";
import { BOS_ROADMAP, statusWord } from "../bosRoadmap.ts";

test("the roadmap is the closed, ordered B0–B7 phase set", () => {
  assert.deepEqual(BOS_ROADMAP.map((p) => p.id), ["B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7"]);
});

test("B6 reads removed: the story pipeline (S0) deleted the pipeline and content surfaces", () => {
  assert.equal(BOS_ROADMAP.find((p) => p.id === "B6")?.status, "removed");
});

test("B7 reads done: the plan records it COMPLETE", () => {
  assert.equal(BOS_ROADMAP.find((p) => p.id === "B7")?.status, "done");
});

test("statusWord gives each status the word the page shows", () => {
  assert.deepEqual(["done", "removed", "active", "planned"].map((s) => statusWord(s as never)), ["shipped", "removed", "in progress", "planned"]);
});

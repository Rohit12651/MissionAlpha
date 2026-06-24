import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupSkills,
  flattenRows,
  rowOffsets,
  visibleSlice,
  FAMILY_ORDER,
  type FlatRow,
} from "../skillGroups.ts";
import type { MissionSkill } from "../missionSkills.ts";

const S = (id: string, family: string, hint = id): MissionSkill =>
  ({ id, family, hint, title: `/${id}`, prompt: `Use the ${id} skill. `, kind: "skill" });

const FIX: MissionSkill[] = [
  S("zeta", "misc"), S("alpha", "misc"),
  S("sp-writing-plans", "sp · workflow"), S("impeccable", "ui/ux"),
  { id: "standup", family: "prompts", hint: "h", title: "/standup", prompt: "p", kind: "prompt" },
];

test("groupSkills returns families in FAMILY_ORDER, items sorted by id", () => {
  const g = groupSkills(FIX, "");
  const fams = g.map((x) => x.family);
  assert.equal(fams[0], "prompts");
  assert.ok(fams.indexOf("sp · workflow") < fams.indexOf("misc"));
  const misc = g.find((x) => x.family === "misc")!;
  assert.deepEqual(misc.items.map((s) => s.id), ["alpha", "zeta"]);
  assert.equal(misc.count, 2);
});

test("groupSkills filters by query across id + hint, drops empty families", () => {
  const g = groupSkills(FIX, "impec");
  assert.equal(g.length, 1);
  assert.equal(g[0].family, "ui/ux");
  assert.equal(g[0].items[0].id, "impeccable");
});

test("FAMILY_ORDER puts misc last and prompts first", () => {
  assert.equal(FAMILY_ORDER[0], "prompts");
  assert.equal(FAMILY_ORDER[FAMILY_ORDER.length - 1], "misc");
});

test("flattenRows yields header rows + item rows for expanded families only", () => {
  const groups = groupSkills(FIX, "");
  const collapsed = new Set<string>(["misc"]);
  const rows = flattenRows(groups, collapsed);
  const headers = rows.filter((r) => r.type === "header").map((r) => r.family);
  assert.deepEqual(new Set(headers), new Set(groups.map((g) => g.family)));
  assert.ok(!rows.some((r) => r.type === "item" && r.skill!.family === "misc"));
  assert.ok(rows.some((r) => r.type === "item" && r.skill!.id === "impeccable"));
});

test("rowOffsets returns cumulative tops + total height", () => {
  const rows: FlatRow[] = [
    { type: "header", family: "a", count: 1 },
    { type: "item", family: "a", skill: S("x", "a") },
  ];
  const { tops, total } = rowOffsets(rows, 30, 44);
  assert.deepEqual(tops, [0, 30]);
  assert.equal(total, 30 + 44);
});

test("visibleSlice returns only rows intersecting the viewport (+overscan)", () => {
  const rows: FlatRow[] = Array.from({ length: 1000 }, (_, i) => ({ type: "item", family: "f", skill: S(String(i), "f") }));
  const { tops } = rowOffsets(rows, 30, 40);
  const { start, end } = visibleSlice(tops, 40, 4000, 400, 2);
  assert.ok(start <= 100 && end >= 110);
  assert.ok(end - start < 40);
});

test("visibleSlice includes the row whose top equals scrollTop (boundary)", () => {
  const rows: FlatRow[] = Array.from({ length: 50 }, (_, i) => ({ type: "item", family: "f", skill: S(String(i), "f") }));
  const { tops } = rowOffsets(rows, 0, 40); // row i top = i*40
  const { start, end } = visibleSlice(tops, 40, 400, 200, 0); // scrollTop exactly on row 10
  assert.equal(start, 10); // row 10 (top=400) is at the edge → included, not skipped
  assert.ok(end > start);
});

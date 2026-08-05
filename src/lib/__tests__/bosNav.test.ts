// B0 — the BOS sidebar's nav registry is a CLOSED typed set. The mockup's crash
// class (a nav item pointing at a page that does not exist) is impossible here:
// every entry is either a `view` that flips the existing shellView or an `action`
// that calls an existing setter, and an unknown id resolves to null instead of
// rendering. These tests pin that contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BOS_NAV, resolveNav } from "../../components/bos/bosNav.ts";

test("every nav entry is view, action or page — no dead ids", () => {
  for (const e of BOS_NAV) {
    assert.ok(e.id && e.label && e.icon);
    assert.ok(e.kind === "view" || e.kind === "action" || e.kind === "page");
    if (e.kind === "view") assert.ok(e.view === "inbox" || e.view === "board");
    // B1: a page target comes from the CLOSED BosPage union — a page nobody built
    // cannot be named here. B2 widened the union to deck | vault; B3 added brief;
    // B4 added the Automation pages workflows | schedule; B5 added the Command Center;
    // B6 added the pipeline (kanban) + content (content engine) pages, narrowed again
    // by CC-Primitives P6 (engineering-only scope — backend modules stay dormant).
    // S6 widened the union with `stories` (the pipeline board), inserted directly under Inbox.
    if (e.kind === "page") assert.ok(["center", "stories", "deck", "vault", "brief", "workflows", "schedule", "outputs", "roadmap"].includes(e.page), e.page);
  }
});

test("resolveNav returns null for unknown id (crash class impossible)", () => {
  assert.equal(resolveNav("nope"), null);
  assert.ok(resolveNav("inbox"));
});

test("registry pins the B0 surface set", () => {
  const ids = BOS_NAV.map((e) => e.id);
  for (const id of ["inbox", "missions", "chat", "sessions", "factory", "settings"]) {
    assert.ok(ids.includes(id), id);
  }
});

// ── B1 — the third kind: `page` ──────────────────────────────────────────────
// A page entry is still a CLOSED destination: `page` is a literal union, not a
// free-form href, so the App dispatch can switch exhaustively and an id that
// names a page nobody built is a compile error, not a blank screen.

test("B1: deck entry exists as a page kind pointing at the deck page", () => {
  const deck = resolveNav("deck");
  assert.ok(deck, "deck entry must exist");
  assert.equal(deck.kind, "page");
  assert.equal(deck.kind === "page" ? deck.page : null, "deck");
  assert.equal(deck.label, "Agents");
  assert.equal(deck.icon, "deck");
});

// B3 AMENDMENT: the deck no longer sits DIRECTLY after missions — master spec §4 puts
// the CEO brief above Agents, so B3 inserted `brief` into that slot and the deck moved
// down one. The invariant B1 actually cared about (the deck follows the mission views,
// ahead of the action entries) is unchanged and is what this now asserts.
test("B1+B3: the deck follows missions, with the CEO brief between them", () => {
  const ids = BOS_NAV.map((e) => e.id);
  assert.equal(ids[ids.indexOf("missions") + 1], "brief");
  assert.equal(ids[ids.indexOf("brief") + 1], "deck");
  assert.ok(ids.indexOf("deck") < ids.indexOf("chat"), "the deck still precedes the action entries");
});

test("B1: the B0 view entries are unchanged", () => {
  // B1 added a kind; it did not re-point an existing destination.
  const inbox = resolveNav("inbox");
  const missions = resolveNav("missions");
  assert.equal(inbox?.kind === "view" ? inbox.view : null, "inbox");
  assert.equal(missions?.kind === "view" ? missions.view : null, "board");
});

// ── B2 — the Knowledge Vault joins the closed page union ─────────────────────

test("B2: vault entry exists as a page kind pointing at the vault page", () => {
  const vault = resolveNav("vault");
  assert.ok(vault, "vault entry must exist");
  assert.equal(vault.kind, "page");
  assert.equal(vault.kind === "page" ? vault.page : null, "vault");
  assert.equal(vault.label, "Knowledge vault");
  assert.equal(vault.icon, "vault");
});

test("B2: vault sits between chat and sessions (spec §9 orders Sessions under it)", () => {
  const ids = BOS_NAV.map((e) => e.id);
  assert.equal(ids[ids.indexOf("chat") + 1], "vault");
  assert.equal(ids[ids.indexOf("vault") + 1], "sessions");
});

test("B2: vault sits between chat and sessions (spec §9 orders Sessions under it) — unchanged by B3", () => {
  const ids = BOS_NAV.map((e) => e.id);
  assert.equal(ids[ids.indexOf("chat") + 1], "vault");
});

// ── B3 — the CEO brief joins the closed page union ───────────────────────────

test("B3: brief entry exists as a page kind pointing at the brief page", () => {
  const brief = resolveNav("brief");
  assert.ok(brief, "brief entry must exist");
  assert.equal(brief.kind, "page");
  assert.equal(brief.kind === "page" ? brief.page : null, "brief");
  assert.equal(brief.label, "CEO brief");
  assert.equal(brief.icon, "brief");
});

test("B3+B4+B5+B6(cut by P6)+B7: every page entry still names a page that exists", () => {
  const pages = BOS_NAV.filter((e) => e.kind === "page").map((e) => (e.kind === "page" ? e.page : null));
  assert.deepEqual(pages.sort(), ["brief", "center", "deck", "outputs", "roadmap", "schedule", "stories", "vault", "workflows"]);
});

// ── B5 — the Command Center joins the closed page union at the TOP ────────────

test("B5: center entry exists as a page kind pointing at the center page", () => {
  const center = resolveNav("center");
  assert.ok(center, "center entry must exist");
  assert.equal(center.kind, "page");
  assert.equal(center.kind === "page" ? center.page : null, "center");
  assert.equal(center.label, "Command center");
  assert.equal(center.icon, "center");
});

test("B5: the Command Center takes the TOP slot, above the CEO brief and the mission views", () => {
  const ids = BOS_NAV.map((e) => e.id);
  assert.equal(ids[0], "center", "center is the first entry — the cross-venture home");
  assert.ok(ids.indexOf("center") < ids.indexOf("brief"), "center sits above the CEO brief");
  assert.ok(ids.indexOf("center") < ids.indexOf("missions"), "center sits above the mission views");
});

test("B5: inserting center did not disturb the missions → brief → deck ordering", () => {
  const ids = BOS_NAV.map((e) => e.id);
  assert.equal(ids[ids.indexOf("missions") + 1], "brief");
  assert.equal(ids[ids.indexOf("brief") + 1], "deck");
});

// ── B4 — the Automation pages join the closed page union ─────────────────────

test("B4: workflows + schedule entries exist as page kinds pointing at their pages", () => {
  const wf = resolveNav("workflows");
  assert.ok(wf, "workflows entry must exist");
  assert.equal(wf.kind === "page" ? wf.page : null, "workflows");
  assert.equal(wf.label, "Workflows");
  assert.equal(wf.icon, "workflows");
  const sched = resolveNav("schedule");
  assert.ok(sched, "schedule entry must exist");
  assert.equal(sched.kind === "page" ? sched.page : null, "schedule");
  assert.equal(sched.label, "Schedule");
  assert.equal(sched.icon, "schedule");
});

test("B4+B7(P6-narrowed): Automation → Outputs sit after Agents and before Chat, keeping the page cluster contiguous", () => {
  const ids = BOS_NAV.map((e) => e.id);
  assert.equal(ids[ids.indexOf("deck") + 1], "workflows");
  assert.equal(ids[ids.indexOf("workflows") + 1], "schedule");
  // CC-Primitives P6 — pipeline/content are cut; outputs now sits directly after
  // schedule, keeping the page cluster contiguous.
  assert.equal(ids[ids.indexOf("schedule") + 1], "outputs");
  assert.equal(ids[ids.indexOf("outputs") + 1], "chat");
});

// ── CC-Primitives P6 — B6's pipeline + content pages are cut (engineering-only
// scope; backend modules stay dormant) ───────────────────────────────────────

test("P6: pipeline + content no longer resolve to a nav entry", () => {
  assert.equal(resolveNav("pipeline"), null);
  assert.equal(resolveNav("content"), null);
});

test("P6: no BOS_NAV entry names pipeline or content as its id or page", () => {
  const ids = BOS_NAV.map((e) => e.id);
  assert.ok(!ids.includes("pipeline"));
  assert.ok(!ids.includes("content"));
  const pages: string[] = BOS_NAV.filter((e) => e.kind === "page").map((e) => (e.kind === "page" ? e.page : ""));
  assert.ok(!pages.includes("pipeline"));
  assert.ok(!pages.includes("content"));
});

test("B3: the registry is still a SET — no duplicate ids, no duplicate page targets", () => {
  const ids = BOS_NAV.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate nav id");
  const pages = BOS_NAV.filter((e) => e.kind === "page").map((e) => (e.kind === "page" ? e.page : ""));
  assert.equal(new Set(pages).size, pages.length, "two entries pointing at one page");
});

// ── S6 — Stories joins the closed page union, under Inbox and above Missions ──
test("S6: stories entry exists as a page kind pointing at the stories page", () => {
  const stories = resolveNav("stories");
  assert.ok(stories, "stories entry must exist");
  assert.equal(stories.kind, "page");
  assert.equal(stories.kind === "page" ? stories.page : null, "stories");
  assert.equal(stories.label, "Stories");
  assert.equal(stories.icon, "stories");
});

test("S6: stories sits directly under Inbox and above Missions (board lives under Stories)", () => {
  const ids = BOS_NAV.map((e) => e.id);
  assert.equal(ids[ids.indexOf("inbox") + 1], "stories");
  assert.equal(ids[ids.indexOf("stories") + 1], "missions");
});

// ── B7 — outputs + roadmap join the closed page union ────────────────────────
test("B7: outputs + roadmap entries exist as page kinds pointing at their pages", () => {
  const out = BOS_NAV.find((e) => e.id === "outputs");
  const road = BOS_NAV.find((e) => e.id === "roadmap");
  assert.ok(out && out.kind === "page" && out.page === "outputs");
  assert.ok(road && road.kind === "page" && road.page === "roadmap");
  // Outputs sits directly after Schedule (P6 cut pipeline/content from between them);
  // Roadmap is LAST (documentation surface).
  const ids = BOS_NAV.map((e) => e.id);
  assert.equal(ids[ids.indexOf("schedule") + 1], "outputs");
  assert.equal(ids[ids.length - 1], "roadmap");
});

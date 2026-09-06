// Phase 2 / R8 — SKILL BUDGET.
//
// AUDIT FIRST. What the prompt path actually does today, read off the code rather than
// assumed about it:
//   • factory.SKILL_CATALOG is NINE governed entries; skillsNote emits at most 12 short
//     lines. It was never the size problem.
//   • The 1,439 directories under .claude/skills are read by NOTHING in the runtime. The
//     "never inline the catalog" rule holds today by absence, not by design.
//   • pool.mjs does `persona.slice(0, 6000)` — a HARD MID-CHARACTER CUT. On this install
//     senior-security-engineer.md is 12K on disk and arrives at exactly 6000 chars, cut
//     mid-stream. That is worse than dropping the tail cleanly: a persona sliced through an
//     open code fence or a half-written instruction corrupts everything after it, and the
//     model has no way to know the sentence it is reading was amputated.
//
// So the deliverable is a real budget with an HONEST edge: cut on a boundary, say what was
// dropped, and keep the result inside the number. BOUNDARY-* is the load-bearing group.

import test from "node:test";
import assert from "node:assert/strict";
import { truncateAtBoundary, resolveBudget, buildSkillIndex, MIN_BUDGET, DEFAULT_SKILL_BUDGET } from "../system-prompt.mjs";

// ── the budget number ────────────────────────────────────────────────────────

test("BUDGET-1: the default is 6000 and a floor exists", () => {
  assert.equal(DEFAULT_SKILL_BUDGET, 6000);
  assert.equal(resolveBudget(undefined), 6000);
  assert.ok(MIN_BUDGET > 0 && MIN_BUDGET < DEFAULT_SKILL_BUDGET);
});

test("BUDGET-2: a garbage value falls back to the default, never to zero", () => {
  // A typo'd env that resolved to 0 would silently empty every persona — the guard
  // deleting the thing it guards. Fail to the default, never to nothing.
  for (const raw of ["", "abc", null, {}, [], "-40", "0", NaN]) {
    assert.equal(resolveBudget(raw), DEFAULT_SKILL_BUDGET, `resolveBudget(${JSON.stringify(raw)})`);
  }
});

test("BUDGET-3: a value below the floor is raised to it, an honest one is kept", () => {
  assert.equal(resolveBudget("10"), MIN_BUDGET);
  assert.equal(resolveBudget("12000"), 12000);
  assert.equal(resolveBudget(3000), 3000);
});

// ── boundary truncation ──────────────────────────────────────────────────────

const lines = (n, w = 40) => Array.from({ length: n }, (_, i) => `line ${i} `.padEnd(w, "x")).join("\n");

test("BOUNDARY-1: text inside the budget is returned byte-identical, no marker", () => {
  const t = lines(3);
  assert.equal(truncateAtBoundary(t, 6000), t);
});

test("BOUNDARY-2: an over-budget text is cut on a LINE boundary, never mid-line", () => {
  const t = lines(200);
  const out = truncateAtBoundary(t, 1000);
  const body = out.split("\n").filter((l) => !l.startsWith("[…"));
  // Every surviving line must be one of the originals, whole.
  const original = new Set(t.split("\n"));
  for (const l of body) {
    if (!l) continue;
    assert.ok(original.has(l), `line was cut mid-entry: ${JSON.stringify(l)}`);
  }
});

test("BOUNDARY-3: the result INCLUDING the marker stays inside the budget", () => {
  for (const max of [200, 1000, 4096]) {
    const out = truncateAtBoundary(lines(500), max);
    assert.ok(out.length <= max, `budget ${max} exceeded: got ${out.length}`);
  }
});

test("BOUNDARY-4: the marker says how much was dropped — silent loss is the bug", () => {
  const t = lines(500);
  const out = truncateAtBoundary(t, 1000);
  assert.match(out, /omitted/i);
  const m = /(\d+)\s+character/.exec(out);
  assert.ok(m, `no dropped-count in: ${out.slice(-120)}`);
  assert.ok(Number(m[1]) > 0);
});

test("BOUNDARY-5: with no newline in range it falls back to a WORD boundary", () => {
  const t = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
  const out = truncateAtBoundary(t, 40);
  assert.ok(out.length <= 40);
  const head = out.split("[")[0].trim();
  assert.ok(t.startsWith(head), "the kept head must be a real prefix");
  assert.ok(!/\S$/.test(out.split("[")[0]) || t.split(" ").includes(head.split(" ").pop()),
    "the last kept token must be a whole word");
});

test("BOUNDARY-6: an unbroken blob with NO boundary still respects the budget", () => {
  const out = truncateAtBoundary("x".repeat(5000), 300);
  assert.ok(out.length <= 300, `got ${out.length}`);
  assert.match(out, /omitted/i);
});

test("BOUNDARY-7: an absent or invalid budget does NOT truncate", () => {
  const t = lines(500);
  for (const max of [undefined, null, 0, -1, "abc", NaN]) {
    assert.equal(truncateAtBoundary(t, max), t, `max=${JSON.stringify(max)} must be a no-op`);
  }
});

test("BOUNDARY-8: non-string input is returned unchanged, never a throw", () => {
  assert.equal(truncateAtBoundary(null, 100), null);
  assert.equal(truncateAtBoundary(undefined, 100), undefined);
  assert.equal(truncateAtBoundary(42, 100), 42);
});

// ── the catalog index ────────────────────────────────────────────────────────

const CURATED = [
  { name: "caveman", desc: "Token-efficient output mode." },
  { name: "headroom", desc: "Context compression." },
];
const bigCatalog = [
  ...Array.from({ length: 832 }, (_, i) => `composio-x${i}-automation`),
  ...Array.from({ length: 151 }, (_, i) => `legal-x${i}`),
  ...Array.from({ length: 141 }, (_, i) => `kw-x${i}`),
  "lone-wolf", "solo",
];

test("IDX-1: the CURATED tier is emitted first and in full", () => {
  const out = buildSkillIndex({ curated: CURATED, names: bigCatalog, budget: 6000 });
  const iCav = out.indexOf("caveman");
  const iFam = out.indexOf("composio-");
  assert.ok(iCav >= 0 && iFam >= 0);
  assert.ok(iCav < iFam, "curated entries must not be pushed out by the bulk index");
  assert.match(out, /Token-efficient output mode\./, "a curated entry keeps its one-line description");
});

test("IDX-2: the TRUE total is stated even though most entries are omitted", () => {
  const out = buildSkillIndex({ curated: CURATED, names: bigCatalog, budget: 1200 });
  const total = CURATED.length + bigCatalog.length;
  assert.ok(out.includes(String(total)),
    `the index must not imply the listed set is the whole set: ${out.slice(0, 200)}`);
});

test("IDX-8: a curated skill present in the bulk catalog is counted ONCE", () => {
  const out = buildSkillIndex({
    curated: [{ name: "caveman", desc: "Terse output." }],
    names: ["caveman", "alpha-one", "alpha-two"],
    budget: 6000,
  });
  assert.ok(out.includes("3 total"), `expected 3 unique skills, got: ${out.split("\n")[2]}`);
  assert.match(out, /alpha-\* \(2\)/);
});

test("IDX-3: families roll up with counts — 832 names become one line", () => {
  const out = buildSkillIndex({ curated: [], names: bigCatalog, budget: 6000 });
  assert.match(out, /composio-\*\s*\(832\)/);
  assert.match(out, /legal-\*\s*\(151\)/);
  // …and a name with no family is listed as itself, not invented into a family of one.
  assert.match(out, /\blone-wolf\b/);
});

test("IDX-4: the whole index respects the budget", () => {
  for (const budget of [400, 1200, 6000]) {
    const out = buildSkillIndex({ curated: CURATED, names: bigCatalog, budget });
    assert.ok(out.length <= budget, `budget ${budget} exceeded: ${out.length}`);
  }
});

test("IDX-5: every emitted line is COMPLETE — the index never cuts mid-entry", () => {
  const out = buildSkillIndex({ curated: CURATED, names: bigCatalog, budget: 500 });
  for (const l of out.split("\n")) {
    if (!l || l.startsWith("[…")) continue;
    // A complete line either ends the header sentence or is a whole "- entry" row.
    assert.ok(!l.startsWith("- ") || l.length > 3, `truncated entry: ${JSON.stringify(l)}`);
    assert.ok(!/-\s*$/.test(l), `entry cut mid-name: ${JSON.stringify(l)}`);
  }
});

test("IDX-6: an EMPTY catalog produces an empty string, not a header about nothing", () => {
  assert.equal(buildSkillIndex({ curated: [], names: [], budget: 6000 }), "");
  assert.equal(buildSkillIndex({}), "");
});

test("IDX-7: the 1,439-name catalog is NEVER inlined in full", () => {
  const out = buildSkillIndex({ curated: CURATED, names: bigCatalog, budget: 6000 });
  const listed = bigCatalog.filter((n) => out.includes(n)).length;
  assert.ok(listed < bigCatalog.length * 0.1,
    `the index inlined ${listed}/${bigCatalog.length} names — that is the catalog, not an index`);
});

// ── WIRED: pool.mjs personas ─────────────────────────────────────────────────
// The live defect this task fixes. Twelve of this install's 27 pool agents arrive at
// EXACTLY 6000 characters, every one severed mid-token: "…RETURNED_FOR_DB",
// "…customer/admi", "…mcp__plugin_claude-mem_", "…on new auth/API sur". A model reading
// those has no signal that the instruction it is following was amputated.

import { parsePoolAgent, PERSONA_BUDGET } from "../pool.mjs";

const frontmatter = (body) => `---\nname: big-agent\ndescription: A big agent.\ntools: Read\n---\n${body}`;

test("POOL-1: an over-budget persona is cut at a LINE boundary, not mid-character", () => {
  const body = Array.from({ length: 400 }, (_, i) => `## Section ${i}\nSome instruction text for section ${i}.`).join("\n");
  const a = parsePoolAgent(frontmatter(body), "big-agent.md");
  assert.ok(a.persona.length <= PERSONA_BUDGET);
  const marker = a.persona.slice(a.persona.lastIndexOf("["));
  assert.match(marker, /omitted/i, "the drop must be declared, not silent");
  const kept = a.persona.slice(0, a.persona.lastIndexOf("[")).trimEnd();
  assert.ok(body.startsWith(kept), "the kept text must be a real prefix of the persona");
  assert.ok(!/\S$/.test(kept) || body.split("\n").includes(kept.split("\n").pop()),
    `persona was cut mid-line: ...${JSON.stringify(kept.slice(-60))}`);
});

test("POOL-2: a persona inside the budget is untouched — no marker on a whole file", () => {
  const a = parsePoolAgent(frontmatter("Short and complete persona body for this agent."), "x.md");
  assert.equal(a.persona, "Short and complete persona body for this agent.");
});

// ── WIRED: the on-disk catalog reader ────────────────────────────────────────

import { readSkillCatalog } from "../station-skills.mjs";
import { mkdtempSync, mkdirSync as mkd, writeFileSync as wf } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CAT-1: the curated tier is READ, the bulk catalog is only LISTED", () => {
  const root = mkdtempSync(join(tmpdir(), "cat-"));
  const cur = join(root, "curated"); const all = join(root, "all");
  mkd(join(cur, "alpha"), { recursive: true });
  wf(join(cur, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Does the alpha thing.\n---\nbody\n");
  mkd(join(cur, "beta"), { recursive: true }); // no SKILL.md at all
  for (const n of ["zed-one", "zed-two", "solo"]) mkd(join(all, n), { recursive: true });

  const c = readSkillCatalog({ curatedDir: cur, allDir: all });
  assert.deepEqual(c.curated.map((x) => x.name).sort(), ["alpha", "beta"]);
  assert.equal(c.curated.find((x) => x.name === "alpha").desc, "Does the alpha thing.");
  assert.equal(c.curated.find((x) => x.name === "beta").desc, "", "a missing SKILL.md is a name, never a boot failure");
  assert.deepEqual(c.names.sort(), ["solo", "zed-one", "zed-two"]);
});

test("CAT-2: a YAML block-scalar description is read, not returned as '>'", () => {
  const root = mkdtempSync(join(tmpdir(), "cat2-"));
  const cur = join(root, "c");
  mkd(join(cur, "folded"), { recursive: true });
  // The real .claude/skills-curated/caveman/SKILL.md uses exactly this shape.
  wf(join(cur, "folded", "SKILL.md"), "---\nname: folded\ndescription: >\n  Compressed output mode.\n---\nbody\n");
  const c = readSkillCatalog({ curatedDir: cur, allDir: join(root, "missing") });
  assert.equal(c.curated[0].desc, "Compressed output mode.");
  assert.deepEqual(c.names, [], "a missing catalog dir is an empty tier, not a throw");
});

test("CAT-3: missing directories yield empty tiers rather than throwing at boot", () => {
  const c = readSkillCatalog({ curatedDir: "/nope/a", allDir: "/nope/b" });
  assert.deepEqual(c, { curated: [], names: [] });
  assert.deepEqual(readSkillCatalog(), { curated: [], names: [] });
});

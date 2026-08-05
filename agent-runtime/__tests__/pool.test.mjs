import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePoolAgent, mapTools, isPoolDoc } from "../pool.mjs";

const CEO_MD = `---
name: ceo
description: Chief Executive Officer. SUPREME agent above all. Thinks first, proposes options.
tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch
---

# CEO Agent — Waahyu

Sits on top of every agent. Reports only to USER. Strategic gate.`;

const WEB_MD = `---
name: senior-web-1
description: Senior React Web Developer #1. Owns customer-web + admin-dashboard. React/TS/Vite.
tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch
---

# Senior Web Dev #1

Owns the customer + admin web apps.`;

// ── tool mapping (the security-relevant bit) ──────────────────────────────────
test("mapTools strips Bash/exec and maps Write/Edit → write", () => {
  assert.equal(mapTools("Read, Write, Edit, Bash, Glob, Grep"), "write");
});
test("mapTools → read when no write/edit (Bash alone never grants write)", () => {
  assert.equal(mapTools("Read, Glob, Grep, Bash, WebFetch"), "read");
});
test("mapTools handles empty/missing", () => {
  assert.equal(mapTools(""), "read");
  assert.equal(mapTools(undefined), "read");
});

// ── doc detection ─────────────────────────────────────────────────────────────
test("isPoolDoc flags the governance docs, not agents", () => {
  assert.equal(isPoolDoc("ORCHESTRATION.md"), true);
  assert.equal(isPoolDoc("PROTOCOL.md"), true);
  assert.equal(isPoolDoc("SCHEDULER.md"), true);
  assert.equal(isPoolDoc("ceo.md"), false);
  assert.equal(isPoolDoc("senior-web-1.md"), false);
});

// ── parse ─────────────────────────────────────────────────────────────────────
test("parsePoolAgent extracts id, role (1st sentence), persona, tools", () => {
  const a = parsePoolAgent(CEO_MD, "ceo.md");
  assert.equal(a.id, "ceo");
  assert.equal(a.role, "Chief Executive Officer");
  assert.equal(a.tools, "write");
  assert.ok(a.persona.includes("Sits on top of every agent"), "persona = body");
  assert.ok(a.persona.length >= 20);
});

test("parsePoolAgent id comes from the name frontmatter, lowercased", () => {
  const a = parsePoolAgent(WEB_MD, "senior-web-1.md");
  assert.equal(a.id, "senior-web-1");
  assert.equal(a.role, "Senior React Web Developer #1");
  assert.equal(a.tools, "write");
});

test("parsePoolAgent falls back to filename id when name missing", () => {
  const md = `---\ndescription: A helper agent that does things and more things here.\ntools: Read\n---\n\nBody persona text long enough to pass the minimum length check easily.`;
  const a = parsePoolAgent(md, "helper.md");
  assert.equal(a.id, "helper");
  assert.equal(a.tools, "read");
});

test("parsePoolAgent returns null for a doc with no frontmatter", () => {
  const a = parsePoolAgent("# Just a governance doc\n\nNo frontmatter here.", "ORCHESTRATION.md");
  assert.equal(a, null);
});

test("parsePoolAgent returns null when persona too short", () => {
  const a = parsePoolAgent("---\nname: x\ndescription: d\ntools: Read\n---\n\nshort", "x.md");
  assert.equal(a, null);
});

test("parsePoolAgent never exposes a secret-shaped persona unmodified beyond cap", () => {
  const big = "x".repeat(9000);
  const a = parsePoolAgent(`---\nname: big\ndescription: Big agent role here.\ntools: Read\n---\n\n${big}`, "big.md");
  assert.ok(a.persona.length <= 6000, "persona capped at 6000");
});

// PHASE 4 TASK 4.0 — the XSS guard, written BEFORE any approve-with-edit UI code.
//
// WHAT IT PROTECTS: ReviewPane.tsx renders agent-authored diffs as TEXT NODES ONLY. That
// is not a style preference, it is the live security control for this surface — diff
// content comes out of a sandboxed agent and is untrusted by definition. Phase 4 makes
// that diff EDITABLE, which is exactly the change that historically reintroduces
// innerHTML ("just for the highlighting").
//
// The control was documented in a comment. A comment is not enforcement. This is.
//
// SELF-TEST FIRST: this suite proves the scanner can actually FAIL before it is allowed
// to certify the tree as clean. A guard test that cannot fail is worse than no guard —
// it manufactures confidence. (This session already shipped one such fake assertion in
// the visual harness; it is not shipping a second.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL("../../", import.meta.url)));
const BANNED = /\b(innerHTML|outerHTML|dangerouslySetInnerHTML|insertAdjacentHTML)\b/;

/**
 * Strip comments and string/template literals, so a mention of the identifier inside
 * prose or a test fixture is not a false positive — while an actual assignment is.
 *
 * Hand-rolled rather than regex-only because `"https://x"` must not start a line comment
 * and `// it's fine` must not open a string. Small state machine, no dependencies.
 */
export function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      // Replace the literal with a placeholder so token boundaries survive.
      out += '""';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(p);
  }
  return acc;
}

/** Every non-comment, non-string occurrence in the tree, as `path:line: text`. */
export function findUnsafeHtmlSinks(root: string): string[] {
  const hits: string[] = [];
  for (const file of walk(root)) {
    const stripped = stripCommentsAndStrings(readFileSync(file, "utf-8"));
    stripped.split("\n").forEach((line, idx) => {
      if (BANNED.test(line)) hits.push(`${relative(root, file)}:${idx + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

test("SELF-TEST: the scanner detects a real innerHTML assignment", () => {
  const bad = `const el = document.querySelector("#x");\nel.innerHTML = untrusted;\n`;
  assert.match(stripCommentsAndStrings(bad), BANNED, "scanner is blind to a live sink");
});

test("SELF-TEST: the scanner detects dangerouslySetInnerHTML in JSX", () => {
  const bad = `<div dangerouslySetInnerHTML={{ __html: patch }} />`;
  assert.match(stripCommentsAndStrings(bad), BANNED);
});

test("SELF-TEST: comments and strings are NOT counted", () => {
  const ok = [
    `// there is no innerHTML anywhere in this file`,
    `/* dangerouslySetInnerHTML deliberately does not ship */`,
    `const doc = "see https://example.com/innerHTML-considered-harmful";`,
    `const note = 'avoid outerHTML';`,
  ].join("\n");
  assert.doesNotMatch(stripCommentsAndStrings(ok), BANNED);
});

test("SELF-TEST: a URL in a string does not open a comment and hide a real sink", () => {
  // If "//" inside the string were treated as a line comment, the sink on the SAME line
  // would be swallowed and the guard would silently pass a genuine vulnerability.
  const bad = `fetch("https://x/y"); el.innerHTML = payload;`;
  assert.match(stripCommentsAndStrings(bad), BANNED, "string handling swallowed a real sink");
});

test("GUARD: src/ contains zero non-comment HTML-injection sinks", () => {
  const hits = findUnsafeHtmlSinks(SRC);
  assert.deepEqual(
    hits,
    [],
    `HTML-injection sink introduced. The diff surface renders untrusted agent output;\n` +
      `every string must reach the DOM as a React text node.\n${hits.join("\n")}`,
  );
});

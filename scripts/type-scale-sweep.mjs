#!/usr/bin/env node
// PHASE 9 — the type-scale sweep runner.
//
//   node scripts/type-scale-sweep.mjs                 # DRY RUN over everything (default)
//   node scripts/type-scale-sweep.mjs --report        # per-file counts, no writes
//   node scripts/type-scale-sweep.mjs --write --batch 10
//   node scripts/type-scale-sweep.mjs --write src/components/inbox
//
// DEFAULT IS DRY RUN. A codemod that writes by default is a codemod that will one day
// rewrite 64 files while someone is reading the help text.
//
// --batch N writes only the N most-affected files and then STOPS, printing exactly what
// to do next. That is the plan's "batches of ~10 with a visual-regression run between
// each", enforced by the tool instead of by memory — with zero component tests, the
// screenshot diff is the only net, and it is worthless if a batch is too big to review.
//
// The transform itself lives in scripts/lib/type-scale.mjs and is unit-tested under
// `npm run test:vendor`. This file is I/O and ergonomics only.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { FLOOR_PX, subFloorSizes, sweepCss, sweepTsx } from "./lib/type-scale.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const REPORT = argv.includes("--report");
const batchIdx = argv.indexOf("--batch");
const BATCH = batchIdx >= 0 ? Math.max(1, Number(argv[batchIdx + 1]) || 10) : Infinity;
const roots = argv.filter((a) => !a.startsWith("--") && a !== String(BATCH));

const DEFAULT_ROOTS = ["src"];
const SKIP = new Set(["node_modules", "dist", "build", ".git", "__tests__", "__fixtures__"]);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if ([".tsx", ".ts", ".css"].includes(extname(entry))) acc.push(p);
  }
  return acc;
}

const files = (roots.length ? roots : DEFAULT_ROOTS).flatMap((r) => {
  const abs = join(REPO, r);
  return statSync(abs).isDirectory() ? walk(abs) : [abs];
});

const results = [];
for (const file of files) {
  const src = readFileSync(file, "utf-8");
  const out = extname(file) === ".css" ? sweepCss(src) : sweepTsx(src);
  if (out.changed === 0 && out.unmapped.length === 0) continue;
  results.push({ file, rel: relative(REPO, file), ...out, before: src });
}

results.sort((a, b) => b.changed - a.changed);

const totalChanged = results.reduce((n, r) => n + r.changed, 0);
const unmapped = [...new Set(results.flatMap((r) => r.unmapped))].sort((a, b) => a - b);

console.log(`type-scale sweep — ${files.length} files scanned`);
console.log(`  ${totalChanged} size(s) to rewrite across ${results.length} file(s)`);
if (unmapped.length) {
  console.log(`  ⚠ ${unmapped.length} UNDECIDED size(s) found: ${unmapped.join(", ")}px`);
  console.log("    These are NOT in docs/superpowers/specs/type-scale.md §3 and were left");
  console.log("    untouched. Decide them in the spec first — do not let the tool guess.");
}

if (REPORT || !WRITE) {
  for (const r of results.slice(0, 40)) {
    console.log(`  ${String(r.changed).padStart(4)}  ${r.rel}${r.unmapped.length ? `   (unmapped: ${r.unmapped.join(",")})` : ""}`);
  }
  if (results.length > 40) console.log(`  … and ${results.length - 40} more file(s)`);
  if (!WRITE) console.log("\nDRY RUN — nothing written. Re-run with --write --batch 10 to apply one batch.");
  process.exit(unmapped.length ? 1 : 0);
}

const batch = results.slice(0, BATCH);
for (const r of batch) writeFileSync(r.file, r.code, "utf-8");

console.log(`\nWROTE ${batch.length} file(s):`);
for (const r of batch) console.log(`  ${r.rel}  (${r.changed})`);

const remaining = results.length - batch.length;
console.log("\nNEXT — do these IN ORDER, and do not skip the review:");
console.log("  1. npm run typecheck && npm run lint && npm run build");
console.log("  2. npm run test:visual        (run it ALONE — it loses races against a busy CPU)");
console.log("  3. Review EVERY diff by eye. Rows get taller; that is intended. Investigate anything else.");
console.log(remaining > 0
  ? `  4. ${remaining} file(s) still to sweep — re-run with --write --batch ${Number.isFinite(BATCH) ? BATCH : 10}`
  : `  4. Sweep complete. Verify the floor holds:\n       grep -rhoE 'text-\\[([0-9]|1[01])(\\.[0-9]+)?px\\]' src --include='*.tsx' | wc -l   # expect 0`);

// Final self-check on what we just wrote — the tool must never claim a clean batch it
// did not produce.
const dirty = batch.flatMap((r) => subFloorSizes(readFileSync(r.file, "utf-8")));
if (dirty.length) {
  console.error(`\n✖ ${dirty.length} sub-${FLOOR_PX}px size(s) survived in the batch just written: ${[...new Set(dirty)].join(", ")}px`);
  process.exit(1);
}

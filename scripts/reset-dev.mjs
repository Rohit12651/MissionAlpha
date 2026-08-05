#!/usr/bin/env node
// scripts/reset-dev.mjs — wipe the gitignored dev runtime stores for a CLEAN dogfood.
//
// Test-run residue (dead tasks, throwaway deliveries) accumulates in two gitignored
// runtime-data dirs. This clears them so BOSS can start a fresh Inbox with a clean slate:
//   • agent-runtime/data/          — SQLite mission.db (+ -wal/-shm) and patches/
//   • agent-runtime/engine-store/  — the durable engine task store (ADR-024/027)
//
// Both are RUNTIME DATA, never source (see .gitignore). Run only while the runtime is
// STOPPED, or SQLite may recreate the WAL under you.
//
//   npm run reset:dev                # wipe + recreate empty (0700)
//   npm run reset:dev -- --dry-run   # show what WOULD be cleared, delete nothing
//
// Safety: refuses to touch anything outside the repo root. Tests point it at a throwaway
// tree via RESET_DEV_ROOT so this file is never exercised against the live repo.
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.env.RESET_DEV_ROOT || join(scriptDir, ".."));
const dryRun = process.argv.includes("--dry-run");

// The gitignored runtime stores, relative to the repo root.
const TARGETS = ["agent-runtime/data", "agent-runtime/engine-store"];

let cleared = 0;
for (const rel of TARGETS) {
  const dir = resolve(repoRoot, rel);
  // Containment guard — never delete anything outside the repo root.
  const within = relative(repoRoot, dir);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    console.error(`[reset:dev] REFUSED — ${rel} escapes the repo root`);
    process.exitCode = 1;
    continue;
  }
  if (!existsSync(dir)) {
    console.log(`[reset:dev] ${rel} — absent, nothing to clear`);
    continue;
  }
  if (dryRun) {
    console.log(`[reset:dev] would clear ${rel}`);
    continue;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  console.log(`[reset:dev] cleared ${rel}`);
  cleared++;
}
if (!dryRun) console.log(`[reset:dev] done — ${cleared} store(s) reset. Start the runtime for a clean dogfood.`);

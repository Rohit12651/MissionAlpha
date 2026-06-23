# C1 — Vendor the Skill Catalog into the Repo (`.claude/` local copy) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Vendor the global `~/.claude/skills/` (1439) + `~/.claude/commands/` (178) into MissionAlpha's
local `.claude/` as a PRUNED (markdown-only) tree, so the repo is self-contained — verified by
`security-reviewer` to contain no secrets and no symlink-escape before commit.

**Architecture:** A node ESM script (`scripts/vendor-skills.mjs`) walks each source root, copies only
prune-eligible files (`*.md`) into the matching local destination, skipping symlinks and all heavy/binary
assets, and refusing any path that resolves outside the destination root. All decision logic lives in a
pure, unit-tested helper module (`scripts/lib/vendor.mjs`) so the rules are RED→GREEN tested independently
of the filesystem walk. A manifest (`.claude/VENDOR_MANIFEST.json`) records counts + total size for the
acceptance check.

**Tech Stack:** Node 22 ESM (`.mjs`), `node:fs`, `node:path`, `node:test` + `node:assert/strict`
(matches the repo's existing `node --test` harness).

---

## Recon facts (measured 2026-06-23)

- Source: `~/.claude/skills` = **1439** dirs, **1.2 GB** full. `~/.claude/commands` = **178**, **944 KB**.
- Pruned (`*.md` only): skills **44.0 MB** + commands **0.5 MB** = **~44.5 MB** → **under the 50 MB cap →
  PRUNED commit proceeds (no stop-and-ask).**
- ⚠ **60 symlinks** under `~/.claude/skills` (0 under commands) → symlink-escape risk → script SKIPS symlinks.
- Heavy assets to prune: `.ts` (4340), `.js` (4104), `.map` (3108), `.json`, `.ttf`, `.py`, `.sh`, `.html`, …
- ⚠ `.gitignore:32` currently has `.claude/skills/` → must be un-ignored so the pruned tree commits.
- Local `.claude/skills` today: 51 entries (partial) → will be replaced by the full pruned set.

---

## File Structure

- Create: `scripts/lib/vendor.mjs` — pure helpers: `isVendoredFile`, `safeJoin`, `familyRootFor`.
- Create: `scripts/lib/__tests__/vendor.test.mjs` — `node --test` unit tests for the pure helpers.
- Create: `scripts/vendor-skills.mjs` — the filesystem walk + copy (imports the pure helpers).
- Modify: `package.json` — add `"vendor:skills"` + `"test:vendor"` scripts.
- Modify: `.gitignore:32` — stop ignoring `.claude/skills/`; add targeted heavy-asset ignores instead.
- Generated (by the script, committed): `.claude/skills/**/*.md`, `.claude/commands/**/*.md`,
  `.claude/VENDOR_MANIFEST.json`.

---

## Task 1: Pure helper — `isVendoredFile` (prune rule)

**Files:**
- Create: `scripts/lib/vendor.mjs`
- Test: `scripts/lib/__tests__/vendor.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/lib/__tests__/vendor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isVendoredFile } from "../vendor.mjs";

test("isVendoredFile keeps markdown, prunes everything else", () => {
  assert.equal(isVendoredFile("SKILL.md"), true);
  assert.equal(isVendoredFile("reference/usage.md"), true);
  assert.equal(isVendoredFile("README.MD"), true); // case-insensitive
  assert.equal(isVendoredFile("index.ts"), false);
  assert.equal(isVendoredFile("bundle.js"), false);
  assert.equal(isVendoredFile("bundle.js.map"), false);
  assert.equal(isVendoredFile("font.ttf"), false);
  assert.equal(isVendoredFile("data.json"), false);
  assert.equal(isVendoredFile("script.py"), false);
  assert.equal(isVendoredFile("notes"), false); // no extension
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Downloads/WaahyuFOLDER/MissonAlpha && node --test scripts/lib/__tests__/vendor.test.mjs`
Expected: FAIL — `Cannot find module '../vendor.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/vendor.mjs
import path from "node:path";

/** Prune rule: vendor markdown only (SKILL.md + any *.md). Strip all heavy/binary assets. */
export function isVendoredFile(relPath) {
  return path.extname(relPath).toLowerCase() === ".md";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/lib/__tests__/vendor.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/vendor.mjs scripts/lib/__tests__/vendor.test.mjs
git commit -m "feat(c1): add isVendoredFile prune rule (md-only) with unit test"
```

---

## Task 2: Pure helper — `safeJoin` (path-safety / no escape)

**Files:**
- Modify: `scripts/lib/vendor.mjs`
- Test: `scripts/lib/__tests__/vendor.test.mjs`

- [ ] **Step 1: Write the failing test** (append)

```js
import { safeJoin } from "../vendor.mjs";

test("safeJoin returns a path inside root for normal names", () => {
  const root = "/repo/.claude/skills";
  assert.equal(safeJoin(root, "impeccable/SKILL.md"), "/repo/.claude/skills/impeccable/SKILL.md");
});

test("safeJoin throws on traversal escape", () => {
  const root = "/repo/.claude/skills";
  assert.throws(() => safeJoin(root, "../../etc/passwd"), /escape/i);
  assert.throws(() => safeJoin(root, "a/../../../outside.md"), /escape/i);
});

test("safeJoin allows '..' that stays inside root", () => {
  const root = "/repo/.claude/skills";
  assert.equal(safeJoin(root, "a/b/../c.md"), "/repo/.claude/skills/a/c.md");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/lib/__tests__/vendor.test.mjs`
Expected: FAIL — `safeJoin is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `vendor.mjs`)

```js
/** Join + resolve `rel` under `root`, throwing if the result escapes `root`. */
export function safeJoin(root, rel) {
  const resolvedRoot = path.resolve(root);
  const dest = path.resolve(resolvedRoot, rel);
  if (dest !== resolvedRoot && !dest.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`path escape blocked: ${rel} -> ${dest}`);
  }
  return dest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/lib/__tests__/vendor.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/vendor.mjs scripts/lib/__tests__/vendor.test.mjs
git commit -m "feat(c1): add safeJoin path-escape guard with unit tests"
```

---

## Task 3: Pure helper — `familyRootFor` (which dest root for a source)

**Files:**
- Modify: `scripts/lib/vendor.mjs`
- Test: `scripts/lib/__tests__/vendor.test.mjs`

- [ ] **Step 1: Write the failing test** (append)

```js
import { familyRootFor } from "../vendor.mjs";

test("familyRootFor maps source kind to dest subdir", () => {
  assert.equal(familyRootFor("skills"), "skills");
  assert.equal(familyRootFor("commands"), "commands");
  assert.throws(() => familyRootFor("nope"), /unknown source/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/lib/__tests__/vendor.test.mjs`
Expected: FAIL — `familyRootFor is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `vendor.mjs`)

```js
/** Map a source kind ("skills"|"commands") to its dest subdir under .claude/. */
export function familyRootFor(sourceKind) {
  if (sourceKind === "skills" || sourceKind === "commands") return sourceKind;
  throw new Error(`unknown source kind: ${sourceKind}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/lib/__tests__/vendor.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/vendor.mjs scripts/lib/__tests__/vendor.test.mjs
git commit -m "feat(c1): add familyRootFor source->dest mapping with unit test"
```

---

## Task 4: The vendoring script — `scripts/vendor-skills.mjs`

**Files:**
- Create: `scripts/vendor-skills.mjs`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Write the script**

```js
// scripts/vendor-skills.mjs
// Vendor ~/.claude/{skills,commands} into local .claude/ — PRUNED (md only),
// skip symlinks, path-safe, deterministic. Writes .claude/VENDOR_MANIFEST.json.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isVendoredFile, safeJoin, familyRootFor } from "./lib/vendor.mjs";

const SRC_HOME = path.join(os.homedir(), ".claude");
const DEST = path.resolve(process.cwd(), ".claude");
const SOURCES = ["skills", "commands"];

let copied = 0;
let skippedSymlinks = 0;
let prunedFiles = 0;
const perSource = {};

/** Recursively walk src dir, copying vendored files into dest, skipping symlinks. */
function walk(srcDir, destRoot, relBase) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const ent of entries) {
    const srcPath = path.join(srcDir, ent.name);
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    // lstat-based symlink guard (do not follow).
    const lst = fs.lstatSync(srcPath);
    if (lst.isSymbolicLink()) { skippedSymlinks++; continue; }
    if (lst.isDirectory()) { walk(srcPath, destRoot, rel); continue; }
    if (!isVendoredFile(rel)) { prunedFiles++; continue; }
    const dest = safeJoin(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(srcPath, dest);
    copied++;
  }
}

for (const sourceKind of SOURCES) {
  const srcRoot = path.join(SRC_HOME, sourceKind);
  const destRoot = path.join(DEST, familyRootFor(sourceKind));
  if (!fs.existsSync(srcRoot)) {
    console.warn(`[vendor] source missing, skipping: ${srcRoot}`);
    perSource[sourceKind] = 0;
    continue;
  }
  // Clean replace: remove existing dest tree so output is deterministic.
  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.mkdirSync(destRoot, { recursive: true });
  const before = copied;
  walk(srcRoot, destRoot, "");
  perSource[sourceKind] = copied - before;
}

// Compute total vendored size.
let bytes = 0;
function sizeOf(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) sizeOf(p);
    else bytes += fs.statSync(p).size;
  }
}
for (const s of SOURCES) sizeOf(path.join(DEST, familyRootFor(s)));

const manifest = {
  generatedFrom: SRC_HOME,
  sources: perSource,
  copied,
  prunedFiles,
  skippedSymlinks,
  totalBytes: bytes,
  totalMB: +(bytes / 1048576).toFixed(2),
};
fs.writeFileSync(path.join(DEST, "VENDOR_MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`[vendor] copied=${copied} pruned=${prunedFiles} skippedSymlinks=${skippedSymlinks} size=${manifest.totalMB}MB`);
console.log(`[vendor] per-source: ${JSON.stringify(perSource)}`);
```

- [ ] **Step 2: Add npm scripts**

In `package.json` `"scripts"`, add:

```json
"vendor:skills": "node scripts/vendor-skills.mjs",
"test:vendor": "node --test scripts/lib/__tests__/vendor.test.mjs"
```

- [ ] **Step 3: Run the vendoring script**

Run: `cd ~/Downloads/WaahyuFOLDER/MissonAlpha && npm run vendor:skills`
Expected: prints `copied=<~3300>`, `skippedSymlinks=60`, `size≈44.5MB`; writes `.claude/VENDOR_MANIFEST.json`.

- [ ] **Step 4: Verify acceptance — full set present, self-contained**

```bash
# skill dirs present (expect ~1439)
ls .claude/skills | wc -l
# every vendored file is markdown (expect 0 non-md)
find .claude/skills .claude/commands -type f ! -name '*.md' ! -name 'VENDOR_MANIFEST.json' | wc -l
# no symlinks vendored (expect 0)
find .claude/skills .claude/commands -type l | wc -l
# size under cap (expect totalMB < 50)
cat .claude/VENDOR_MANIFEST.json
```

Expected: `~1439` dirs; `0` non-md; `0` symlinks; `totalMB < 50`.

- [ ] **Step 5: Commit the script + manifest only (NOT the vendored tree yet)**

```bash
git add scripts/vendor-skills.mjs package.json
git commit -m "feat(c1): add vendor-skills script (pruned, symlink-safe) + npm scripts"
```

---

## Task 5: Un-ignore the pruned tree in `.gitignore`

**Files:**
- Modify: `.gitignore:32`

- [ ] **Step 1: Replace the blanket skills ignore**

Change line 32 from:

```
.claude/skills/
```

to (ignore only heavy assets that must never enter git, allow md):

```
# Vendored skill catalog is committed PRUNED (md only). Block heavy assets if any slip in:
.claude/skills/**/*.ts
.claude/skills/**/*.js
.claude/skills/**/*.map
.claude/skills/**/*.ttf
.claude/skills/**/*.woff
.claude/skills/**/*.woff2
.claude/skills/**/*.png
.claude/skills/**/*.jpg
.claude/skills/**/*.gif
.claude/skills/**/*.zip
```

- [ ] **Step 2: Verify git now sees the md tree**

Run: `git status --short .claude/skills | head` and `git check-ignore .claude/skills/impeccable/SKILL.md; echo "ignored=$?"`
Expected: md files show as untracked (`??`); `git check-ignore` exits non-zero (`ignored=1` → NOT ignored).

- [ ] **Step 3: Commit the gitignore change**

```bash
git add .gitignore
git commit -m "chore(c1): un-ignore pruned .claude/skills md tree for vendoring"
```

---

## Task 6: SECURITY GATE (BLOCKING) — `security-reviewer` before committing the tree

**This gate MUST pass before Task 7. Do not commit the vendored tree until PASS.**

- [ ] **Step 1: Run a secret scan over the vendored md (evidence for the reviewer)**

```bash
# Common secret signatures across all vendored md (expect: no real secrets).
grep -rEn 'sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xoxb-[0-9A-Za-z-]+|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35}' .claude/skills .claude/commands | head -50
# Re-confirm structural guarantees:
find .claude/skills .claude/commands -type l | wc -l          # symlinks: expect 0
find .claude/skills .claude/commands -type f ! -name '*.md' ! -name 'VENDOR_MANIFEST.json' | wc -l  # non-md: expect 0
```

- [ ] **Step 2: Dispatch the `security-reviewer` agent (BLOCKING)**

Dispatch `security-reviewer` with: the diff of `scripts/vendor-skills.mjs` + `scripts/lib/vendor.mjs`,
the grep evidence above, and the manifest. Reviewer must confirm:
- No secrets/keys/tokens/private-keys present in any vendored file (scan PASS).
- No symlinks vendored (escape-safe); copy uses `lstat` + skips symlinks; `safeJoin` blocks traversal.
- Pruned to md-only; total size recorded and < 50 MB.
- No new runtime execution path introduced (build-time tooling only).

Expected: **PASS**. If any real secret is flagged → STOP, redact/exclude that file, re-run, do not commit.

- [ ] **Step 3: Record the verdict**

Append the reviewer verdict + evidence summary to this plan file under a "C1 Security Gate" note,
then proceed to Task 7 only on PASS.

---

## Task 7: Commit the vendored catalog (gated on Task 6 PASS)

**Files:**
- Add: `.claude/skills/**/*.md`, `.claude/commands/**/*.md`, `.claude/VENDOR_MANIFEST.json`

- [ ] **Step 1: Stage only the vendored md tree + manifest**

```bash
git add .claude/skills .claude/commands .claude/VENDOR_MANIFEST.json
git status --short | head    # confirm: only .claude md + manifest staged, nothing unrelated
```

- [ ] **Step 2: Confirm no heavy asset slipped into the staged set**

Run: `git diff --cached --name-only | grep -vE '\.md$|VENDOR_MANIFEST\.json$' | head`
Expected: empty (only md + manifest staged).

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(c1): vendor pruned skill catalog (~1439 skills + 178 commands, md-only)"
```

---

## Task 8: Self-contained verification (acceptance: `~/.claude` renamed away)

- [ ] **Step 1: Temporarily rename the global catalog**

```bash
mv ~/.claude/skills ~/.claude/skills__hidden && mv ~/.claude/commands ~/.claude/commands__hidden
```

- [ ] **Step 2: Confirm the local catalog is intact without the global source**

```bash
ls .claude/skills | wc -l       # expect ~1439 — unchanged
cat .claude/VENDOR_MANIFEST.json  # counts unchanged
```

Expected: local tree fully present (proves repo is self-contained).

- [ ] **Step 3: Restore the global catalog**

```bash
mv ~/.claude/skills__hidden ~/.claude/skills && mv ~/.claude/commands__hidden ~/.claude/commands
```

- [ ] **Step 4: Run `sp-verification-before-completion`**

Confirm all C1 acceptance bullets are green:
- Full set vendored (skills ~1439 + commands ~178), each skill's `SKILL.md` intact.
- `.claude/` committed, no secrets, no symlinks, md-only, size < 50 MB (manifest).
- Self-contained (passes with `~/.claude` renamed away).
- `security-reviewer`: PASS.

---

## Self-Review (plan vs C1 spec)

- **Acceptance 1 (copy script → full set, SKILL.md intact):** Tasks 4 (copy) + 4.4 (count check). ✔
- **Acceptance 2 (.claude committed, no secrets):** Tasks 5 (un-ignore) + 6 (security gate) + 7 (commit). ✔
- **Acceptance 3 (self-contained, ~/.claude renamed away):** Task 8. ✔
- **Fire order — node-specialist (copy script):** Tasks 1–4 authored as node-specialist work. ✔
- **Fire order — terminal-ops (safe bulk copy):** copy is in-script (`copyFileSync`) — terminal-ops covers
  the run/verify shell steps (4.3–4.4, 8). ✔
- **Fire order — security-reviewer BLOCKING:** Task 6 gates Task 7. ✔
- **sp-verification-before-completion:** Task 8.4. ✔
- **Blocking open question (vendor-to-git, >50MB):** resolved — pruned = 44.5 MB < 50 MB → commit. ✔
- **Placeholder scan:** every code/command step has real content. ✔
- **Type consistency:** `isVendoredFile`/`safeJoin`/`familyRootFor` names identical across tasks. ✔

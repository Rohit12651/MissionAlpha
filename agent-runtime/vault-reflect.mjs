// MUNDER-ADOPTION A4 — the vault CONDENSER: bounded memory with a paranoid ladder.
//
// WHY: every finished task writes a vault record (engine onDone), so a busy (venture,
// node) lane grows without bound — and unbounded memory is what makes retrieval (R6)
// useless: the signal drowns. This module bounds each lane to "the newest K records +
// ONE rolling summary of everything older", the exact 3-region shape the source repo's
// reflector used for agent memory (pinned facts / rolling summary / newest-K verbatim).
//
// THE LADDER (every step verified, any failure aborts with ZERO mutation):
//   1. BACKUP  — every record about to be evicted is cold-copied to
//                <root>/.cold/<venture>/<node>/<id>.md and the copy is READ BACK and
//                byte-compared. A backup that cannot be proven is not a backup.
//   2. COMPOSE — summarizeFn folds the evicted records into the PREVIOUS rolling
//                summary. The default is EXTRACTIVE (title + date + first body line per
//                record — deterministic, no model); the seam exists so a model-grade
//                summarizer can be injected later without touching the ladder.
//   3. VERIFY-DON'T-TRUST — the composed summary must (a) mention at least minCoverage
//                of the evicted titles, (b) fit the vault body cap. The gate treats the
//                summarizer as untrusted even while it is our own pure function,
//                because the seam invites replacing it with a model.
//   4. WRITE   — through vault.write(), the ONE record door (scrub, index, symlink
//                containment, vault.written on the bus). Never a direct file write.
//   5. REMOVE  — evicted originals leave through vault.remove(), the ONE removal door.
//                Only AFTER the summary landed; a crash between 4 and 5 leaves harmless
//                duplicates the next sweep re-evicts, never a gap.
//   6. EMIT    — one change-only `vault.condensed` frame per condensed lane.
//
// NEVER EVICTED: the lane's own rolling summary (`summary-<venture>-<node>`) and any
// operator-pinned record (id starting `pinned-`). Pinned facts are region 1 of the
// 3-region shape — the operator's, not the machine's.
//
// IN-PROCESS, NEVER launchd — ported macOS TCC lesson: a launchd-spawned shell is
// denied the folder grants this process holds, so scheduling OUTSIDE the process
// silently reads empty dirs. The sweep rides the runtime's ONE timer, sampled down.

import { mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAX_VAULT_BODY } from "./vault.mjs";

export const SUMMARY_PREFIX = "summary-";
export const PINNED_PREFIX = "pinned-";
export const DEFAULT_KEEP_K = 12;
export const DEFAULT_BUDGET_BYTES = 128 * 1024;
export const DEFAULT_MIN_COVERAGE = 0.6;

/** The default summarizer: deterministic, extractive, bounded. Newest lines first so
 *  trimming the tail always drops the OLDEST condensed knowledge. */
export function extractiveSummary(prevBody, evicted) {
  const header = "# Rolling summary (auto-condensed)\n\nOldest records folded in place; originals in .cold/.\n";
  const lines = evicted.map((r) => {
    const day = new Date(r.createdAt || 0).toISOString().slice(0, 10);
    const first = String(r.firstLine || "").trim();
    return `- ${day} · **${r.title}**${first ? ` — ${first}` : ""}`;
  });
  const prev = String(prevBody || "")
    .split("\n")
    .filter((l) => l.startsWith("- "));
  let body = `${header}\n${[...lines, ...prev].join("\n")}\n`;
  if (body.length > MAX_VAULT_BODY) {
    // Trim whole lines from the tail (the oldest entries), never mid-line.
    const keep = [];
    let size = header.length + 2;
    for (const l of [...lines, ...prev]) {
      if (size + l.length + 1 > MAX_VAULT_BODY - 64) break;
      keep.push(l); size += l.length + 1;
    }
    body = `${header}\n${keep.join("\n")}\n\n_(older entries trimmed to budget)_\n`;
  }
  return body;
}

export function createVaultReflect(deps = {}) {
  const vault = deps.vault;
  if (!vault) throw new Error("createVaultReflect: vault required");
  const db = deps.db; // better-sqlite3 handle (the vault's own index)
  if (!db) throw new Error("createVaultReflect: db required");
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const summarizeFn = typeof deps.summarizeFn === "function" ? deps.summarizeFn : extractiveSummary;
  const keepK = posInt(deps.keepK, DEFAULT_KEEP_K);
  const budgetBytes = posInt(deps.budgetBytes, DEFAULT_BUDGET_BYTES);
  const minCoverage = Number.isFinite(Number(deps.minCoverage)) ? Math.min(1, Math.max(0, Number(deps.minCoverage))) : DEFAULT_MIN_COVERAGE;
  const coldRoot = deps.coldDir || join(vault.root, ".cold");

  let last = null; // the most recent sweep result, for the status route

  function posInt(v, d) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  }

  const lanesStmt = () => db.prepare(
    "SELECT id, venture, node, title, created_at AS createdAt, path FROM vault_records ORDER BY created_at ASC",
  ).all();

  function fileSize(p) {
    try { return statSync(p).size; } catch { return 0; }
  }

  function firstBodyLine(path) {
    try {
      const text = readFileSync(path, "utf8");
      const at = text.indexOf("\n---", 4); // after front matter
      const body = at >= 0 ? text.slice(text.indexOf("\n", at + 4)) : text;
      for (const l of body.split("\n")) { const t = l.trim(); if (t && !t.startsWith("#")) return t.slice(0, 160); }
    } catch { /* unreadable body reads as empty — the title still carries the entry */ }
    return "";
  }

  /** One sweep over every (venture,node) lane. Returns per-lane outcomes. */
  function sweep() {
    const rows = lanesStmt();
    const lanes = new Map();
    for (const r of rows) {
      const k = `${r.venture}/${r.node}`;
      if (!lanes.has(k)) lanes.set(k, []);
      lanes.get(k).push(r);
    }
    const results = [];
    for (const [lane, all] of lanes) {
      const [venture, node] = lane.split("/");
      const live = all.filter((r) => !r.id.startsWith(SUMMARY_PREFIX) && !r.id.startsWith(PINNED_PREFIX));
      const bytes = live.reduce((s, r) => s + fileSize(r.path), 0);
      if (live.length <= keepK || bytes <= budgetBytes) continue; // under budget — untouched
      const out = condenseLane({ venture, node, live, bytes });
      results.push(out);
      if (out.aborted) log(`[vault-reflect] condense-abort ${lane}: ${out.reason}`);
    }
    last = { at: Date.now(), results, keepK, budgetBytes };
    return results;
  }

  function condenseLane({ venture, node, live, bytes }) {
    const evictRows = live.slice(0, live.length - keepK); // oldest first, newest K stay verbatim
    const summaryId = `${SUMMARY_PREFIX}${venture}-${node}`;

    // 1 — BACKUP, then PROVE the backup.
    const coldDir = join(coldRoot, venture, node);
    try { mkdirSync(coldDir, { recursive: true, mode: 0o700 }); }
    catch (e) { return abort(venture, node, `cold dir: ${e?.message}`); }
    const evicted = [];
    for (const r of evictRows) {
      let text;
      try { text = readFileSync(r.path, "utf8"); }
      catch (e) { return abort(venture, node, `unreadable original ${r.id}: ${e?.message}`); }
      const coldPath = join(coldDir, `${r.id}.md`);
      try {
        writeFileSync(coldPath, text, { mode: 0o600 });
        if (readFileSync(coldPath, "utf8") !== text) return abort(venture, node, `backup mismatch for ${r.id}`);
      } catch (e) { return abort(venture, node, `backup failed for ${r.id}: ${e?.message}`); }
      evicted.push({ id: r.id, title: r.title, createdAt: r.createdAt, firstLine: firstBodyLine(r.path) });
    }

    // 2 — COMPOSE onto the previous rolling summary.
    let prevBody = "";
    try { const prev = vault.get(summaryId); if (prev && prev.body) prevBody = prev.body; } catch { prevBody = ""; }
    let body;
    try { body = String(summarizeFn(prevBody, evicted) || ""); }
    catch (e) { return abort(venture, node, `summarizer threw: ${e?.message}`); }

    // 3 — VERIFY-DON'T-TRUST.
    if (!body.trim()) return abort(venture, node, "empty summary");
    if (body.length > MAX_VAULT_BODY) return abort(venture, node, `summary over body cap (${body.length})`);
    const mentioned = evicted.filter((r) => r.title && body.includes(r.title)).length;
    if (evicted.length && mentioned / evicted.length < minCoverage) {
      return abort(venture, node, `coverage ${mentioned}/${evicted.length} below ${minCoverage}`);
    }

    // 4 — WRITE through the one record door.
    const w = vault.write({
      venture, node, id: summaryId, author: "vault-reflect",
      title: `Rolling summary — ${node} (auto-condensed)`, body,
    });
    if (!w || w.error) return abort(venture, node, `summary write refused: ${w?.error || "unknown"}`);

    // 5 — REMOVE originals through the one removal door. Best-effort per record: a
    // record that refuses to remove stays live as a duplicate (harmless; next sweep).
    let removed = 0;
    for (const r of evicted) {
      try { const out = vault.remove(r.id); if (out && out.removed) removed += 1; }
      catch { /* duplicate stays; re-swept next pass */ }
    }

    // 6 — EMIT, change-only by construction (a lane only reaches here when it moved).
    const bytesAfter = live.slice(live.length - keepK).reduce((s, r) => s + fileSize(r.path), 0);
    try { emit("vault.condensed", { venture, node, evicted: removed, bytesBefore: bytes, bytesAfter }); }
    catch { /* bus is observational */ }
    return { venture, node, aborted: false, evicted: removed, bytesBefore: bytes, bytesAfter, summaryId };
  }

  const abort = (venture, node, reason) => ({ venture, node, aborted: true, reason: String(reason).slice(0, 300) });

  /** Read model for the gated status GET. */
  function status() {
    return { keepK, budgetBytes, minCoverage, coldRoot, last };
  }

  return { sweep, status, extractiveSummary };
}

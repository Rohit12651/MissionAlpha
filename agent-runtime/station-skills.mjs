// CC-Primitives P3 — per-station SKILLS list (Claude Code "skills as training").
// JSON-file store mirroring station-perms.mjs. Attaching a skill shapes the station's
// SYSTEM PROMPT on its next spawn (interactive AND engine — both flow through
// server.mjs systemFor). It grants NO tools: real capability stays governed by the
// runtime TOOLS mode / factory G5 spec — this is training, not privilege.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isValidAgentId } from "./perm-mode.mjs";

const MAX_SKILLS = 12;

export function createStationSkills({ file, validIds }) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
  let map = Object.create(null); // null-proto: __proto__/constructor are ordinary keys (sr-security P4 LOW-1)

  function load() {
    map = Object.create(null);
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(raw || {})) {
        // Off-charset keys and unknown skill ids are DROPPED on load — a hand-edited
        // file can never smuggle un-cataloged prompt text in via ids.
        if (!isValidAgentId(k) || !Array.isArray(v)) continue;
        const ids = [...new Set(v.filter((s) => valid.has(s)))].slice(0, MAX_SKILLS);
        if (ids.length) map[k] = ids;
      }
    } catch { map = Object.create(null); }
  }

  // sr-security P8: an fs fault must be a clean error, never an uncaughtException
  // (persist fires synchronously inside an HTTP req 'end' callback). True on success.
  function persist() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(map, null, 2) + "\n");
      return true;
    } catch { return false; }
  }

  load();

  return {
    get(agentId) {
      return map[agentId] ? [...map[agentId]] : [];
    },
    // Replace the station's skill list. Rejects off-charset ids, unknown skills and
    // over-cap lists (explicit 400 material — never a silent trim of a BOSS request).
    set(agentId, ids) {
      if (!isValidAgentId(agentId)) return { error: "invalid agentId" };
      if (!Array.isArray(ids)) return { error: "skills must be an array of skill ids" };
      const unique = [...new Set(ids)];
      if (unique.length > MAX_SKILLS) return { error: `too many skills (max ${MAX_SKILLS})` };
      const unknown = unique.filter((s) => !valid.has(s));
      if (unknown.length) return { error: `unknown skill id(s): ${unknown.join(", ")}` };
      if (unique.length === 0) { delete map[agentId]; persist(); return { agentId, skills: [] }; }
      map[agentId] = unique;
      persist();
      return { agentId, skills: [...unique] };
    },
    all() {
      return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v]]));
    },
    reload: load,
  };
}


// ── Phase 2 / R8 — the ON-DISK skill catalog reader ──────────────────────────
//
// SEPARATE FROM EVERYTHING ABOVE, on purpose. The store above governs BOSS-ASSIGNED
// skills from factory.SKILL_CATALOG — fourteen entries that grant a documented playbook. This
// reads the Claude Code skill DIRECTORIES on disk (1,439 of them on this install), which
// grant nothing and are merely discoverable by name. Conflating the two would let a
// filesystem directory look like a governed grant.
//
// COST DISCIPLINE: the curated tier is READ (a handful of small files); the bulk catalog
// is only LISTED (readdir, no file opens). Opening 1,439 SKILL.md files to harvest
// descriptions that a 6,000-character budget will discard 95% of is work done to be thrown
// away. Callers read this ONCE at boot — the catalog does not change under a running
// process, and re-walking it per prompt would be absurd.

/** Upper bound on curated entries actually parsed. A curated tier is small by definition. */
export const MAX_CURATED = 32;

function descFrom(md) {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(String(md || ""));
  if (!fm) return "";
  const m = /^description:\s*(.*)$/im.exec(fm[1]);
  if (!m) return "";
  const inline = m[1].trim();
  // YAML folded/literal block scalars ('>' or '|') put the text on the FOLLOWING lines.
  if (inline && inline !== ">" && inline !== "|" && inline !== ">-" && inline !== "|-") return inline;
  const after = fm[1].slice(m.index + m[0].length);
  const first = after.split("\n").map((l) => l.trim()).find((l) => l && !/^[a-z_-]+:/i.test(l));
  return first || "";
}

function dirsIn(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch { return []; }
}

/**
 * readSkillCatalog({ curatedDir, allDir }) → { curated: [{name, desc}], names: [string] }
 * Never throws — a missing directory is an empty tier, not a boot failure.
 */
export function readSkillCatalog({ curatedDir, allDir } = {}) {
  const curated = [];
  for (const name of dirsIn(curatedDir).slice(0, MAX_CURATED)) {
    let desc = "";
    try { desc = descFrom(readFileSync(join(curatedDir, name, "SKILL.md"), "utf8")); } catch { /* name only */ }
    curated.push({ name, desc });
  }
  return { curated, names: dirsIn(allDir) };
}


// ── Phase 7 / task 7.3 — SKILL BODIES for a roster seat ──────────────────────
//
// The distinction this function exists to make: today a seat is told the NAMES of its
// skills (`skillsNote` above renders "- Label: desc"). A name is not a playbook. A seat
// told "you hold the ui skill" knows nothing it did not already know; a seat handed the
// ui SKILL.md knows which directories are its own and which are somebody else's.
//
// A body is VENDORED TEXT that ends up inside another agent's system prompt, so it is
// treated exactly like every other untrusted artifact on that path:
//   • CAPPED per body (6 KB) and in COUNT (12) — a prompt budget, not a hope.
//   • SCRUBBED through the shared egress scrub when one is injected.
//   • Truncation is ANNOUNCED in the text, never silent: a seat that reads half a rule
//     and cannot tell it is half a rule is worse off than one told the rule was cut.
// A missing SKILL.md is SKIPPED, never a boot failure — same posture as readSkillCatalog.

/** Max SKILL bodies injected into one seat's system prompt. */
export const MAX_SKILL_BODIES = 12;
/** Max bytes of any single SKILL body. */
export const MAX_SKILL_BODY_BYTES = 6 * 1024;

export function readSkillBodies(ids, { curatedDir, maxBodies = MAX_SKILL_BODIES, maxBytes = MAX_SKILL_BODY_BYTES, scrub } = {}) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids.slice(0, maxBodies) : []) {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) continue; // never a path segment from the wire
    let raw;
    try { raw = readFileSync(join(curatedDir, id, "SKILL.md"), "utf8"); } catch { continue; }
    let body = typeof scrub === "function" ? scrub(raw) : raw;
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      body = `${Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8")}\n[...SKILL body truncated at ${maxBytes} bytes]`;
    }
    out.push({ id, body });
  }
  return out;
}

// CC-Primitives P3 — per-station SKILLS list (Claude Code "skills as training").
// JSON-file store mirroring station-perms.mjs. Attaching a skill shapes the station's
// SYSTEM PROMPT on its next spawn (interactive AND engine — both flow through
// server.mjs systemFor). It grants NO tools: real capability stays governed by the
// runtime TOOLS mode / factory G5 spec — this is training, not privilege.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

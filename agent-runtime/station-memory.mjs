// CC-Primitives P4 — per-station MEMORY (the station's CLAUDE.md). BOSS-maintained
// markdown injected into the station's system prompt on EVERY wake (chat + engine, via
// the systemFor choke point). JSON-file store, station-perms/skills pattern.
//
// Deviation from the original plan (disclosed): NOT vault-backed — the vault's closed
// node taxonomy makes a new record type a migration-grade change; station memory is a
// small operator config, so it follows the established JSON-config pattern instead.
// The text is scrubbed BY THE SERVER before set() (server owns the scrub chain).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isValidAgentId } from "./perm-mode.mjs";

export const MEMORY_MAX = 8_000; // chars stored per station — prompt budget, not a transport cap

export function createStationMemory({ file, max = MEMORY_MAX }) {
  let map = Object.create(null); // null-proto: __proto__/constructor are ordinary keys (sr-security P4 LOW-1)

  function load() {
    map = Object.create(null);
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(raw || {})) {
        if (!isValidAgentId(k) || typeof v !== "string") continue;
        const t = v.slice(0, max).trim();
        if (t) map[k] = t;
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
      return map[agentId] || "";
    },
    // Replace the station's memory. Over-cap is an explicit error (a silently truncated
    // BOSS instruction is worse than a refusal). Empty/whitespace clears.
    set(agentId, text) {
      if (!isValidAgentId(agentId)) return { error: "invalid agentId" };
      if (typeof text !== "string") return { error: "memory must be a string" };
      if (text.length > max) return { error: `memory too long (max ${max} chars)` };
      const t = text.trim();
      if (!t) { delete map[agentId]; persist(); return { agentId, memory: "", size: 0 }; }
      map[agentId] = t;
      persist();
      return { agentId, memory: t, size: t.length };
    },
    all() {
      return { ...map };
    },
    reload: load,
  };
}

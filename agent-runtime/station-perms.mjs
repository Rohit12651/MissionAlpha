// Per-station INTERACTIVE permission mode (CC-Primitives P1). Small JSON-file config,
// mirroring the factory/adapters.json + factory/policy.json persistence pattern.
//
// SCOPE — this governs the INTERACTIVE chat path (cliReply) ONLY. The AUTONOMOUS engine
// loop (server.mjs engineDispatch) intentionally pins `acceptEdits` and MUST NOT read
// this store: a UI flip to bypassPermissions must never turn the unattended loop loose.
// That invariant is enforced at the engine spawn site, not here.
//
// Validation reuses perm-mode.mjs so the allowlist is single-sourced.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isValidPermMode, normalizePermMode, isValidAgentId } from "./perm-mode.mjs";

export function createStationPerms({ file, fallback = "acceptEdits" }) {
  let map = Object.create(null); // null-proto: __proto__/constructor are ordinary keys (sr-security P4 LOW-1)

  function load() {
    map = Object.create(null);
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(raw || {})) {
        // Drop anything off-allowlist on load — a hand-edited or corrupt file can never
        // smuggle in an invalid mode OR an off-charset agentId key (sr-security P1 LOW/INFO).
        if (isValidAgentId(k) && isValidPermMode(v)) map[k] = v;
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
    // Effective mode for an interactive spawn: explicit station override wins; otherwise
    // the caller's global default, normalized (never returns an off-allowlist value).
    resolve(agentId, globalMode) {
      return map[agentId] || normalizePermMode(globalMode ?? fallback);
    },
    // The raw override, or null when the station inherits the global default.
    get(agentId) {
      return map[agentId] || null;
    },
    // Set a validated override. Returns {agentId, permMode} on success, {error} on a
    // rejected mode (nothing persisted).
    set(agentId, mode) {
      // Reject off-charset ids too — no storage pollution from a crafted key (sr-security P1 LOW).
      if (!isValidAgentId(agentId)) return { error: "invalid agentId" };
      if (!isValidPermMode(mode)) return { error: "invalid permissionMode" };
      map[agentId] = mode;
      persist();
      return { agentId, permMode: mode };
    },
    // Remove an override → the station falls back to the global default again.
    clear(agentId) {
      if (!(agentId in map)) return false;
      delete map[agentId];
      persist();
      return true;
    },
    all() {
      return { ...map };
    },
    reload: load,
  };
}

// sr-security P5 re-review #3 — the ma:set-repo-root gate.
//
// `ma:set-repo-root` used to accept ANY existing path, and the RUNTIME_REPO_ROOT it
// pins has the HIGHEST precedence in guards.mjs (L39-41) — above the validated
// persisted config. A renderer bug or a compromised dependency calling
// setRepoRoot("/") therefore pinned REPO_ROOT to the filesystem root on the next
// supervisor restart, handing every agent the whole disk.
//
// The fix is NOT a second validator: main routes the choice through the runtime's
// OWN validateWorkspace (agent-runtime/workspace.mjs) and uses ONLY the repoPath it
// returns. One rule, two callers — the HTTP route and Electron cannot drift.
//
// This lives in its own CJS shim so (a) main.cjs stays require()-only while the
// validator stays ESM, and (b) the gate is unit-testable without booting Electron.
"use strict";

const { pathToFileURL } = require("node:url");

/**
 * @param {string} folderPath   operator-picked directory (renderer-supplied → DATA)
 * @param {string} workspaceModulePath  absolute path to agent-runtime/workspace.mjs
 * @returns {Promise<{ok:true, repoPath:string} | {ok:false, error:string}>}
 */
async function validateRepoRoot(folderPath, workspaceModulePath) {
  if (typeof folderPath !== "string" || !folderPath.trim()) {
    return { ok: false, error: "Path required" };
  }
  let validateWorkspace;
  try {
    ({ validateWorkspace } = await import(pathToFileURL(workspaceModulePath).href));
  } catch (err) {
    // Fail CLOSED. No validator reachable ⇒ no repo root pinned.
    return { ok: false, error: `workspace validator unavailable: ${err.message}` };
  }
  const v = validateWorkspace(folderPath);
  return v.ok ? { ok: true, repoPath: v.repoPath } : { ok: false, error: v.error };
}

module.exports = { validateRepoRoot };

// Story-Pipeline S7 — the DETERMINISTIC engine spawner. TEST-HARNESS INFRASTRUCTURE, NOT a
// production path. It exists so the whole SDLC (build → test-gate → review → deploy → accept) can
// be proven UNATTENDED with no live model: under RUNTIME_BACKEND=none the read-only legs (pm-
// analyst / architect / docs-writer text artifacts) already run via the mock, but the ENGINE BUILD
// dispatch — the one leg that must write CODE DIFFS into the worktree — produces nothing, so build
// goals fail and the story blocks at build. This module substitutes ONLY that one step: instead of
// spawning `claude` to author the diff, it writes a small deterministic canned diff into the task
// worktree, so the engine's REAL machinery runs over it end to end.
//
// It is wired in server.mjs ONLY when RUNTIME_ENGINE_SPAWNER=deterministic (default OFF ⇒ this
// module is never constructed and engineDispatch behaves exactly as before — cli/api/none).
//
// SECURITY (containment — this must NOT bypass or weaken anything but the MODEL's diff authoring):
//   • It writes ONLY inside ctx.workdir (the per-task git worktree, or the injected copy-sandbox
//     fallback — the SAME dir the model would have written into). Nothing else on the host is
//     touched. The seat id is sanitized to [a-z0-9-] so a hostile seat can never traverse out.
//   • The canned file is PLAIN-SAFE (src/<name>.txt): it still flows through the UNCHANGED policy
//     gate (isAutoSafe requires top==='src' + a non-exec extension), the SAME broker.applyChanges,
//     and the SAME Docker-jailed unit-test gate (network:false). It cannot reach an exec path,
//     cannot widen the seat, and cannot skip the jail.
//   • Fail-first mode writes STATUS=FAIL on a designated seat's FIRST attempt so the REAL test gate
//     fails and the REAL red→green retry loop runs — it drives the gate, it never bypasses it.
//   • It returns the SAME {acc}|{error} contract engineDispatch already returns; it adds no route,
//     no privilege, no network, no secret access.

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

// The engine's own red→green enrich text (engine.mjs handleRetryable, kind==='test-failed').
// Its presence in the task text is how we tell a retry from a first attempt — no engine change.
const RETRY_MARKER = /unit-test gate FAILED/i;

export function createDeterministicSpawner(deps = {}) {
  const seedSandbox = typeof deps.seedSandbox === "function" ? deps.seedSandbox : null;
  const loopSteps = deps.loopSteps && typeof deps.loopSteps.record === "function" ? deps.loopSteps : null;
  const failFirstSeat = String(deps.failFirstSeat || "").trim();
  const write = typeof deps.writeFile === "function" ? deps.writeFile : writeFile;
  const mkdirp = typeof deps.mkdir === "function" ? deps.mkdir : mkdir;
  // The factory audit sink (wired to factory.audit in server.mjs). It fires ONLY when this
  // module is constructed — i.e. RUNTIME_ENGINE_SPAWNER=deterministic — so a canned-diff run
  // lands in the persistent audit trail (not just stdout), the same way every other privileged
  // action audits. Absent/no-op by default; observational, never in the dispatch's failure path.
  const audit = typeof deps.audit === "function" ? deps.audit : () => {};

  // Namespaced, PLAIN-SAFE relative path under src/ (auto-apply eligible). The seat id is
  // sanitized so nothing an agent controls can escape src/ or reach an exec extension.
  function fileFor(agentId) {
    const safe = String(agentId || "seat").replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "seat";
    return `src/build-${safe}.txt`;
  }

  async function dispatch(ctx = {}) {
    const workdir = ctx.workdir ?? (seedSandbox ? await seedSandbox(ctx.agentId) : null);
    if (!workdir) return { error: "deterministic spawner: no workdir (and no seedSandbox seam)" };
    const isRetry = RETRY_MARKER.test(String(ctx.task || ""));
    const shouldFail = !!failFirstSeat && ctx.agentId === failFirstSeat && !isRetry;
    const status = shouldFail ? "FAIL" : "PASS";
    const rel = fileFor(ctx.agentId);
    const abs = join(workdir, rel);
    await mkdirp(dirname(abs), { recursive: true });
    await write(
      abs,
      `STATUS=${status}\nseat=${String(ctx.agentId || "")}\nattempt=${isRetry ? "retry" : "first"}\nts=${new Date().toISOString()}\n`,
    );
    if (loopSteps && ctx.taskId) {
      try {
        loopSteps.record(ctx.agentId, ctx.taskId, {
          type: "assistant",
          message: { content: [{ type: "text", text: `[deterministic-spawner] wrote ${rel} (STATUS=${status})` }] },
        });
      } catch { /* the loop-step store is observational — never break the dispatch */ }
    }
    // Audit the canned-diff run so a deterministic-spawner build is observable in the audit
    // trail (test-harness provenance), not just stdout. Observational: an audit fault never
    // breaks the dispatch contract.
    try {
      audit("spawner.canned-diff", { seat: String(ctx.agentId || ""), taskId: String(ctx.taskId || ""), status, file: rel });
    } catch { /* audit is best-effort */ }
    return { acc: `deterministic canned diff → ${rel} (STATUS=${status})` };
  }

  return { dispatch, fileFor };
}

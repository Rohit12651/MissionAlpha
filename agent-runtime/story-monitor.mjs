// Story-Pipeline S5 — the SRE MONITOR (the `monitor-tick` cadence's work). It polls the deployed
// surface's health URL + scans the error-log for a breach pattern; on a health spike / error-
// window breach it AUTO-CREATES a bug story LINKED to the origin (shipped) story and — via a
// DEDUPE window — makes sure one incident mints ONE bug story, not a storm. The new bug story
// then runs the pipeline itself, closing the 🔧 loop.
//
// PURE orchestration over injected seams (a health probe, an error-log scanner, the story store)
// so it is deterministically testable AND wires to the real health check + log in production.
//
// SECURITY:
//   • The auto-bug-story content is built from UNTRUSTED inputs (an error-log sample can carry a
//     secret or a prompt-injection payload). Every value is SCRUBBED + control-stripped + capped
//     before it lands in the story's title/idea — the story store scrubs again at rest, so a
//     poisoned log line can neither persist a secret nor balloon the row.
//   • The bug story's title is a FIXED template (never attacker-controlled), so a crafted log line
//     cannot forge a title. The origin link is a plain story id (server-minted), never a path.
//   • The DEDUPE window means a flapping health check or a log flood cannot be turned into a
//     story-creation flood (a self-DoS). One incident window → one bug story.
//   • The monitor NEVER executes anything — it reads health + a log and writes a story row. It is
//     driven by the sre `monitor-tick` cadence's enabled flag; disabled ⇒ it never runs.

// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const DEFAULT_DEDUPE_MS = 15 * 60 * 1000; // 15 min — one incident window
const MAX_SAMPLE = 1_500;

export function createStoryMonitor(deps = {}) {
  const stories = deps.stories;
  if (!stories || typeof stories.createStory !== "function" || typeof stories.listStories !== "function") {
    throw new Error("createStoryMonitor: stories store with createStory/listStories required");
  }
  const loadDeployConfig = typeof deps.loadDeployConfig === "function" ? deps.loadDeployConfig : () => ({ config: { healthUrl: null } });
  // probeHealth(url) → { healthy:boolean, status } ; scanErrorLog() → { breach:boolean, sample }
  const probeHealth = typeof deps.probeHealth === "function" ? deps.probeHealth : null;
  const scanErrorLog = typeof deps.scanErrorLog === "function" ? deps.scanErrorLog : () => ({ breach: false });
  const onBugStoryCreated = typeof deps.onBugStoryCreated === "function" ? deps.onBugStoryCreated : null;
  const mintAlert = typeof deps.mintAlert === "function" ? deps.mintAlert : null;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const scrub = typeof deps.scrub === "function" ? deps.scrub : (s) => s;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const dedupeWindowMs = Number.isFinite(Number(deps.dedupeWindowMs)) && Number(deps.dedupeWindowMs) > 0 ? Math.floor(Number(deps.dedupeWindowMs)) : DEFAULT_DEDUPE_MS;

  const clean = (s, cap) => scrub(String(s ?? "").replace(CTRL, " ")).trim().slice(0, cap);
  // Per-incident-signature last-mint clock (dedupe). Keyed by the origin story id (or 'global'),
  // so repeated breaches on the same deployed surface within the window collapse to one bug story.
  const lastMintAt = new Map();

  // The most-recent SHIPPED story is the incident's origin (the release that is now misbehaving).
  function originStory() {
    try {
      const shipped = stories.listStories({ status: "shipped", limit: 1 });
      return shipped && shipped.length ? shipped[0] : null;
    } catch (e) { log(`[monitor] origin lookup skipped: ${e?.message}`); return null; }
  }

  /**
   * One monitor tick. Never throws.
   * @returns {Promise<{breach:boolean, created?:boolean, deduped?:boolean, bugStoryId?:string,
   *                    originStoryId?:string|null, reason?:string}>}
   */
  async function tick() {
    let healthUrl = null;
    try { const cfg = loadDeployConfig(); healthUrl = cfg && cfg.config ? cfg.config.healthUrl || null : null; }
    catch (e) { log(`[monitor] deploy config read skipped: ${e?.message}`); }

    // Probe the deployed surface (when a health URL is configured) + scan the error log.
    let healthy = true, healthStatus = null;
    if (healthUrl && probeHealth) {
      try { const h = await probeHealth(healthUrl); healthy = !!(h && h.healthy); healthStatus = h && h.status != null ? h.status : null; }
      catch (e) { healthy = false; log(`[monitor] health probe failed: ${e?.message}`); }
    }
    let logScan = { breach: false };
    try { logScan = scanErrorLog() || { breach: false }; } catch (e) { log(`[monitor] error-log scan skipped: ${e?.message}`); }

    const breach = (healthUrl && probeHealth && !healthy) || !!logScan.breach;
    if (!breach) return { breach: false };

    // Dedupe — one incident window → one bug story (per origin signature).
    const origin = originStory();
    const sig = origin ? origin.id : "global";
    const t = now();
    const last = lastMintAt.get(sig) || 0;
    if (t - last < dedupeWindowMs) return { breach: true, deduped: true, originStoryId: origin ? origin.id : null };

    // Build the bug-story from SCRUBBED, capped, untrusted signals.
    const reasonBits = [];
    if (healthUrl && probeHealth && !healthy) reasonBits.push(`health check failed (status ${healthStatus === null ? "unreachable" : healthStatus})`);
    if (logScan.breach) reasonBits.push(`error-log breach: ${clean(logScan.sample, 400) || "pattern matched"}`);
    const reason = reasonBits.join("; ") || "monitor breach";
    const originId = origin ? origin.id : null;
    const title = `Bug: deployed surface unhealthy${origin ? ` (from ${origin.id})` : ""}`.slice(0, 180);
    const idea = clean(
      [
        `Auto-filed by the SRE monitor.`,
        originId ? `Origin story: ${originId}.` : `No origin story found (monitoring the standing deployed surface).`,
        `Detected: ${reason}`,
        `Investigate the regression and ship a fix.`,
      ].join("\n"),
      MAX_SAMPLE,
    );

    let bug;
    try { bug = stories.createStory({ title, idea }); }
    catch (e) { log(`[monitor] bug story create failed: ${e?.message}`); return { breach: true, error: e?.message }; }
    lastMintAt.set(sig, t);

    // Link the bug back to its origin via a story-log ref (no new column — an append-only ref).
    if (originId) {
      try { stories.update(originId, { event: "monitor-bug", ref: bug.id }); }
      catch (e) { log(`[monitor] origin link skipped for ${originId}: ${e?.message}`); }
    }
    if (mintAlert) {
      try { mintAlert({ agentId: deps.sreSeat || "sre", taskId: bug.id, kind: "monitor-breach", attempts: 1, detail: `SRE monitor filed bug ${bug.id}${originId ? ` for ${originId}` : ""}: ${reason.slice(0, 300)}` }); }
      catch (e) { log(`[monitor] alert skipped: ${e?.message}`); }
    }
    // Kick the new bug story into the pipeline (the 🔧 loop). Isolated + optional.
    if (onBugStoryCreated) {
      try { Promise.resolve(onBugStoryCreated(bug.id, originId)).catch((e) => log(`[monitor] bug-story kick rejected: ${e?.message}`)); }
      catch (e) { log(`[monitor] bug-story kick skipped: ${e?.message}`); }
    }
    return { breach: true, created: true, bugStoryId: bug.id, originStoryId: originId };
  }

  return { tick };
}

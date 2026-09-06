// Story-Pipeline S5 — the DEPLOY-WATCH stage driver (stage 7). Runs when a story enters
// `deploy-watch` (review-qa already cleared its gates). Two halves:
//
//   enterDeployWatch(storyId) — dispatch the `docs-writer` (read-only) to produce RELEASE NOTES →
//     land them in the Vault + a ref on the story → mint the RELEASE-ACCEPT gate (kind
//     `release-approval`) in the Inbox. The gate payload = release notes + diffstat + task list +
//     the deploy NETWORK flag, so the human approving the release SEES whether the deploy has
//     egress. Story → `waiting-you`. This is the SECOND (and last) of the program's two human taps
//     (the first is S2 `design-approval`).
//
//   onReleaseDecided(row, info) — the release-gate decision router (server routes it here):
//     • APPROVE → run the deploy EXECUTOR (deploy.mjs — jailed, `--network` = cfg.network, cwd-
//       locked, fail-closed no-daemon, output scrubbed). A successful deploy + a healthy health-
//       check advances `deploy-watch → accept` (status `shipped`). A failed deploy or a failed
//       health check BLOCKS the story (status `blocked`) + one Inbox alert — honest, never a
//       silent ship.
//     • REQUEST-CHANGES / REJECT → bounce the story back to `review-qa` (STORY_BACK already lists
//       deploy-watch → review-qa, so no rule change is needed).
//
// So the human taps across the whole pipeline are EXACTLY two: design-approval [S2] + release-
// accept [S5]. `accept` is reached AUTOMATICALLY on a healthy deploy — it is not a third tap.
//
// SECURITY: the deploy runs ONLY on the APPROVE path of the release gate — never a viewer-
// triggerable route (the gate decision is approver-gated at the /inbox decide route, and the
// executor is only reachable from here). The release notes are agent-authored (untrusted): they
// are scrubbed + control-stripped + capped before they land in the vault or the gate body, and a
// gate never auto-applies (high band + non-code → autoApprove refuses) and never reaches a broker.

const DEPLOY_STAGE = "deploy-watch";
const REVIEW_QA_STAGE = "review-qa";
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const MAX_NOTES = 32_000;
const MAX_GATE_BODY = 4_000;


/**
 * Phase 6.4 — which repo paths a story's APPROVED work touched. Pure: takes the build
 * aggregate (task ids per story) and the Delivery store, returns a sorted, de-duplicated
 * list. Only `code` Deliveries with status `approved` whose taskId belongs to this story
 * count — pending, rejected, failure rows and other stories' rows never do. Any fault yields
 * [] so the executor falls back to the FULL deploy command (never narrow blindly).
 */
export function changedPathsForStory(storyId, { aggregate, deliveries } = {}) {
  try {
    const agg = typeof aggregate === "function" ? aggregate(storyId) : null;
    const taskIds = new Set();
    for (const g of (agg && Array.isArray(agg.goals)) ? agg.goals : []) {
      for (const t of Array.isArray(g.tasks) ? g.tasks : []) if (t && t.taskId) taskIds.add(String(t.taskId));
    }
    if (!taskIds.size || !deliveries || typeof deliveries.list !== "function") return [];
    const rows = deliveries.list({ status: "approved", limit: 200 }) || [];
    const out = new Set();
    for (const d of rows) {
      if (!d || d.kind !== "code" || !taskIds.has(String(d.taskId))) continue;
      for (const p of Array.isArray(d.changedPaths) ? d.changedPaths : []) if (typeof p === "string" && p) out.add(p);
    }
    return [...out].sort();
  } catch {
    return [];
  }
}

export function createStoryDeploy(deps = {}) {
  const stories = deps.stories;
  if (!stories || typeof stories.getStory !== "function") throw new Error("createStoryDeploy: stories store required");
  const deliveries = deps.deliveries;
  if (!deliveries || typeof deliveries.mintGate !== "function") throw new Error("createStoryDeploy: deliveries with mintGate required");
  const vault = deps.vault || null;
  const docsDispatch = typeof deps.docsDispatch === "function" ? deps.docsDispatch : null;
  const deployExecutor = deps.deployExecutor && typeof deps.deployExecutor.run === "function" ? deps.deployExecutor : null;
  const aggregate = typeof deps.aggregate === "function" ? deps.aggregate : () => ({ goals: [], counts: {}, total: 0 });
  const loadDeployConfig = typeof deps.loadDeployConfig === "function" ? deps.loadDeployConfig : () => ({ config: { network: false, healthUrl: null } });
  const deployRoot = deps.deployRoot || null;
  // Phase 6.4 — which paths the story's approved work touched, so the executor can scope the
  // deploy command. Default: none → the executor runs the FULL configured command (never
  // narrow blindly). server.mjs wires it from the story's decided Deliveries.
  const changedPathsFor = typeof deps.changedPathsFor === "function" ? deps.changedPathsFor : () => [];
  const mintAlert = typeof deps.mintAlert === "function" ? deps.mintAlert : null;
  const scrub = typeof deps.scrub === "function" ? deps.scrub : (s) => s;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const vaultVenture = deps.vaultVenture || "waahyu";
  const docsSeat = deps.docsSeat || "docs-writer";
  const sreSeat = deps.sreSeat || "sre";

  const clean = (s, cap) => scrub(String(s ?? "").replace(CTRL, " ")).trim().slice(0, cap);
  const inFlight = new Set();

  // Fold the build aggregate into a compact diffstat + task-list the release gate carries.
  function buildSummary(storyId) {
    let build;
    try { build = aggregate(storyId); } catch { build = { goals: [] }; }
    const lines = [];
    let files = 0, tasks = 0;
    for (const g of build.goals || []) {
      lines.push(`- ${g.seat} (${g.state}): ${(g.steps || []).length} step(s)`);
      for (const t of g.tasks || []) {
        tasks++;
        const paths = String(t.result || "").replace(/^applied \d+:\s*/, "").split(",").map((s) => s.trim()).filter(Boolean);
        files += paths.length;
      }
    }
    return { text: clean(lines.join("\n"), 2000), files, tasks, goals: (build.goals || []).length };
  }

  // The NETWORK line surfaced in the gate payload — LOUD when a deploy will have egress.
  function networkLine(net) {
    return net
      ? "⚠ DEPLOY NETWORK: ENABLED — this deploy runs WITH network egress (operator opt-in). Approve only if a cloud deploy is intended."
      : "Deploy network: none (isolated jail, no egress).";
  }

  function landNotes(storyId, story, text) {
    if (!vault) return null;
    try {
      const rec = vault.write({
        id: `release-${String(storyId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56)}`,
        venture: vaultVenture, node: "tech",
        title: `Release notes: ${story?.title || storyId}`.slice(0, 180),
        author: docsSeat, sourceRun: storyId,
        body: text || "(no release notes)",
      });
      return rec && rec.id ? `vault:${rec.id}` : null;
    } catch (e) { log(`[deploy] release-notes write skipped for ${storyId}: ${e?.message}`); return null; }
  }

  // ── enterDeployWatch ─────────────────────────────────────────────────────────
  // Dispatch docs-writer → release notes → mint the release-accept gate. Idempotent: an open
  // release gate for this story short-circuits (no double-dispatch, no double-mint).
  async function enterDeployWatch(storyId) {
    const sid = String(storyId || "");
    if (!sid) return { skipped: true, reason: "no story id" };
    const story = stories.getStory(sid);
    if (!story) return { skipped: true, reason: "unknown story" };
    if (story.stage !== DEPLOY_STAGE) return { skipped: true, reason: `story at '${story.stage}'` };
    // Idempotency — an open release gate means this stage already ran.
    try {
      const open = deliveries.listGates(sid, "release-approval");
      if (open && open.length) return { deduped: true, gate: open[0] };
    } catch { /* listGates fault is non-fatal — fall through and mint */ }

    // docs-writer release notes (read-only dispatch; deterministic under the mock backend).
    let notesText = "";
    if (docsDispatch) {
      try {
        const out = await docsDispatch({ storyId: sid, stage: DEPLOY_STAGE, agentId: docsSeat, story });
        notesText = clean(out && out.text, MAX_NOTES);
      } catch (e) { log(`[deploy] docs dispatch failed for ${sid}: ${e?.message}`); }
    }
    if (!notesText) notesText = clean(`# Release notes — ${story.title}\n\nShipping story ${sid}.`, MAX_NOTES);
    const notesRef = landNotes(sid, story, notesText);

    // The deploy config's network flag (the loud opt-in signal) goes into the gate payload.
    let net = false, healthUrl = null;
    try { const cfg = loadDeployConfig(); if (cfg && cfg.config) { net = cfg.config.network === true; healthUrl = cfg.config.healthUrl || null; } }
    catch (e) { log(`[deploy] deploy config read skipped for ${sid}: ${e?.message}`); }

    const sum = buildSummary(sid);
    const body = clean([
      notesText.slice(0, 1800),
      "",
      "## Release summary",
      `Goals: ${sum.goals} · tasks: ${sum.tasks} · files touched: ${sum.files}`,
      sum.text,
      "",
      "## Deploy",
      networkLine(net),
      healthUrl ? "Health check: configured (loopback)." : "Health check: none configured.",
      "",
      "Approve to run the deploy and ship on a healthy check; request changes to send it back to Review-QA.",
    ].join("\n"), MAX_GATE_BODY);

    const gate = deliveries.mintGate({
      kind: "release-approval", agentId: docsSeat, storyId: sid, slot: `${sid}-release`,
      title: `Release approval: ${story.title}`.slice(0, 180), body,
    });
    try { stories.update(sid, { status: "waiting-you", spec: notesRef || undefined, event: "release-drafted", ref: notesRef }); }
    catch (e) { log(`[deploy] release status write skipped for ${sid}: ${e?.message}`); }
    return { status: "waiting-you", gate, notes: notesRef, network: net };
  }

  // ── runDeploy — the APPROVE path (jailed executor + health) ──────────────────
  async function runDeploy(storyId) {
    const sid = String(storyId || "");
    if (inFlight.has(sid)) return { skipped: true, reason: "in flight" };
    const story = stories.getStory(sid);
    if (!story) return { skipped: true, reason: "unknown story" };
    if (story.stage !== DEPLOY_STAGE) return { skipped: true, reason: `story at '${story.stage}'` };
    if (!deployExecutor) {
      try { stories.update(sid, { status: "blocked", event: "deploy-failed", ref: "no deploy executor wired" }); } catch { /* */ }
      return { deployed: false, blocked: true, reason: "no-executor" };
    }
    inFlight.add(sid);
    try {
      let res;
      let changedPaths = [];
      try { changedPaths = changedPathsFor(sid) || []; } catch (e) { log(`[deploy] changedPathsFor failed for ${sid}: ${e?.message} — running the full command`); }
      try { res = await deployExecutor.run({ storyId: sid, deployRoot, changedPaths }); }
      catch (e) { res = { deployed: false, healthy: null, tail: `deploy executor error: ${e?.message || e}`, reason: "executor-error" }; }
      // Ship only on a successful deploy AND a health check that is healthy or not-configured.
      const healthOk = res.deployed && res.healthy !== false;
      if (healthOk) {
        try { stories.advance(sid, { event: "deploy-succeeded", ref: res.healthy === true ? "deployed + healthy" : "deployed" }); } // deploy-watch → accept (shipped)
        catch (e) { log(`[deploy] ship advance skipped for ${sid}: ${e?.message}`); return { deployed: true, error: e?.message }; }
        return { deployed: true, healthy: res.healthy, shipped: true, network: res.network };
      }
      // Deploy failed OR unhealthy — block the story + one honest alert.
      const failEvent = res.deployed ? "health-failed" : "deploy-failed";
      const ref = clean(res.tail || res.reason || failEvent, 480);
      try { stories.update(sid, { status: "blocked", event: failEvent, ref }); }
      catch (e) { log(`[deploy] block write skipped for ${sid}: ${e?.message}`); return { deployed: false, error: e?.message }; }
      if (mintAlert) {
        try { mintAlert({ agentId: sreSeat, taskId: sid, kind: failEvent, attempts: 1, detail: `Story ${sid}: ${res.deployed ? "deploy succeeded but the health check failed" : "the deploy failed"}. ${ref.slice(0, 300)}` }); }
        catch (e) { log(`[deploy] alert skipped for ${sid}: ${e?.message}`); }
      }
      return { deployed: res.deployed, healthy: res.healthy, blocked: true, reason: res.reason || failEvent, network: res.network };
    } finally {
      inFlight.delete(sid);
    }
  }

  // ── onReleaseDecided — routed from the server's deliveries.onDecided ──────────
  // A release-approval APPROVE runs the deploy; a request-changes / reject bounces the story back
  // to review-qa. A non-release row is a no-op (the design gate routes through pipeline.mjs).
  async function onReleaseDecided(row, info = {}) {
    if (!row || row.kind !== "release-approval") return { skipped: true };
    const sid = row.storyId;
    if (!sid) return { skipped: true, reason: "no storyId" };
    if (info.status === "approved") return await runDeploy(sid);
    // changes_requested | rejected — bounce back to review-qa for rework.
    try { stories.reject(sid, { toStage: REVIEW_QA_STAGE, reason: `release ${info.status}${info.feedback ? `: ${clean(info.feedback, 200)}` : ""}` }); }
    catch (e) { log(`[deploy] release bounce skipped for ${sid}: ${e?.message}`); return { error: e?.message }; }
    return { bounced: true, toStage: REVIEW_QA_STAGE };
  }

  return { enterDeployWatch, runDeploy, onReleaseDecided, buildSummary };
}

// Story-Pipeline S4 — the REVIEW-QA stage driver. Runs when a story enters `review-qa`
// (build already ran the unit-test gate on every diff). Three gates, then advance:
//
//   1. REVIEWER GATE — dispatch the `reviewer` station over the story's combined build diff
//      (a summary of what each seat changed) → a verdict artifact in the Vault. A `pass`
//      proceeds; `block` mints per-blocker fix goals and bounces the story back to `build`
//      (bounded rounds; exhausted → the story blocks), exactly like the test gate's red→green.
//   2. QA GATE — if quality.json configures an e2eCmd, run it INSIDE the SAME Docker jail as
//      the unit-test gate (sandbox.mjs: `--network none`, no host fs, no HOME/secrets, timeout-
//      killed, scrubbed output). No daemon ⇒ FAIL CLOSED (the story blocks) — never a silent
//      pass and never an un-jailed host run. If NOT configured, record an HONEST `qa-skipped`.
//   3. PR STAGE (best-effort) — if `gh` is present AND authenticated, land the approved work
//      through pr.mjs; otherwise record a disclosed `pr-skipped` (reason gh-unauthed). With
//      gh unauthenticated (the standing BOSS open item) the skip path IS the expected path.
//
// All pass → advance `review-qa → deploy-watch`. Pure orchestration over injected seams; it
// owns no storage/transport. Read-only over the build; its only writes are the verdict
// artifact, story-log events, fix goals, and the stage transition.
//
// SECURITY: the reviewer verdict is AGENT-AUTHORED (untrusted) — it is validated to a closed
// contract ({verdict∈{pass,block}, blockers:string[]}), scrubbed + capped; a malformed/hostile
// verdict fails CLOSED to `block` (never an unearned pass). The e2e command runs in the SAME
// Docker jail the unit-test gate uses (no host fs / no network / no secrets), built only from
// the allow-listed, validated argv. No route here lets a viewer trigger a run — the driver
// fires only off the internal stage-entry seam.

// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const REVIEW_QA_STAGE = "review-qa";
const MAX_BLOCKERS = 20;
const MAX_BLOCKER_TEXT = 500;
const DEFAULT_MAX_REVIEW_ROUNDS = 2;

export function createStoryReviewQa(deps = {}) {
  const stories = deps.stories;
  const vault = deps.vault || null;
  const reviewerDispatch = typeof deps.reviewerDispatch === "function" ? deps.reviewerDispatch : null;
  const aggregate = typeof deps.aggregate === "function" ? deps.aggregate : () => ({ goals: [], counts: {}, total: 0 });
  const enqueueGoal = typeof deps.enqueueGoal === "function" ? deps.enqueueGoal : null;
  const mintAlert = typeof deps.mintAlert === "function" ? deps.mintAlert : null;
  // ADR-056 remediation — the QA/e2e gate runs agent-affected code, so it executes INSIDE the
  // SAME Docker jail (sandbox.mjs) as the unit-test gate and the tool-loop: `--network none`,
  // no host fs, no HOME/secrets. Injected so unit tests stay hermetic without a real daemon.
  const sandbox = deps.sandbox && typeof deps.sandbox.runInSandbox === "function" && typeof deps.sandbox.dockerAvailable === "function" ? deps.sandbox : null;
  const loadQualityConfig = typeof deps.loadQualityConfig === "function" ? deps.loadQualityConfig : () => ({ config: { e2eCmd: null } });
  const qaCwd = deps.qaCwd || null;               // the mount source for an e2e run (the repo root)
  const pr = deps.pr || null;                      // { ghStatus, deliverApproved } (pr.mjs)
  const scrub = typeof deps.scrub === "function" ? deps.scrub : (s) => s;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  // S5 — fired ONCE right after a successful `review-qa → deploy-watch` advance, so the deploy-
  // watch stage driver (docs-writer release notes + release-accept gate) kicks in. Optional:
  // unset ⇒ pre-S5 behaviour (the story simply sits at deploy-watch). Isolated — a driver fault
  // never un-advances.
  const onEnterDeployWatch = typeof deps.onEnterDeployWatch === "function" ? deps.onEnterDeployWatch : null;
  const vaultVenture = deps.vaultVenture || "waahyu";
  const reviewerSeat = deps.reviewerSeat || "reviewer";
  const fixSeat = deps.fixSeat || "sr-backend";
  const maxReviewRounds = Number.isFinite(Number(deps.maxReviewRounds)) && Number(deps.maxReviewRounds) > 0
    ? Math.floor(Number(deps.maxReviewRounds)) : DEFAULT_MAX_REVIEW_ROUNDS;

  if (!stories || typeof stories.getStory !== "function") throw new Error("createStoryReviewQa: stories store required");

  const inFlight = new Set();          // per-story re-entrancy guard for the async run
  const reviewRounds = new Map();      // storyId → completed reviewer-block rounds
  const clean = (s, cap) => scrub(String(s ?? "").replace(CTRL, " ")).trim().slice(0, cap);

  // Fold the build aggregate into a compact, scrubbed diff summary the reviewer reviews. The
  // engine already applied each seat's diff; result strings read "applied N: p1, p2".
  function diffSummary(storyId, story) {
    let build;
    try { build = aggregate(storyId); } catch { build = { goals: [] }; }
    const lines = [`# Combined build diff — ${story?.title || storyId}`, ""];
    for (const g of build.goals || []) {
      const paths = (g.tasks || []).map((t) => clean(t.result, 300)).filter(Boolean).join(" | ");
      lines.push(`## ${g.seat} (${g.state})`);
      if (paths) lines.push(paths);
    }
    return clean(lines.join("\n"), 8000);
  }

  // Validate an agent-authored verdict into the closed contract. Fail closed to `block`.
  function validateVerdict(raw) {
    const verdict = raw?.verdict === "pass" ? "pass" : raw?.verdict === "block" ? "block" : null;
    const blockers = (Array.isArray(raw?.blockers) ? raw.blockers : [])
      .map((b) => clean(b, MAX_BLOCKER_TEXT)).filter(Boolean).slice(0, MAX_BLOCKERS);
    if (verdict === null) return { verdict: "block", blockers: blockers.length ? blockers : ["reviewer returned no valid verdict"] };
    if (verdict === "block" && !blockers.length) return { verdict: "block", blockers: ["reviewer blocked without a stated reason"] };
    return { verdict, blockers };
  }

  function landVerdict(storyId, story, verdict, blockers) {
    if (!vault) return null;
    try {
      const rec = vault.write({
        id: `review-${String(storyId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56)}`,
        venture: vaultVenture, node: "decisions",
        title: `Review verdict (${verdict}): ${story?.title || storyId}`.slice(0, 180),
        author: reviewerSeat, sourceRun: storyId,
        body: `## Verdict\n\n${verdict}\n\n## Blockers\n\n${blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "none"}\n`,
      });
      return rec && rec.id ? `vault:${rec.id}` : null;
    } catch (e) { log(`[reviewqa] verdict write skipped for ${storyId}: ${e?.message}`); return null; }
  }

  // ── reviewer gate ─────────────────────────────────────────────────────────────
  // Returns { pass:true } to proceed, or { pass:false } after handling a block (bounce+fix, or
  // — once the rounds budget is spent — a blocked story + one alert).
  async function reviewerGate(storyId, story) {
    if (!reviewerDispatch) return { pass: true, skipped: "no reviewer dispatch" };
    let raw;
    try { raw = await reviewerDispatch({ storyId, stage: REVIEW_QA_STAGE, agentId: reviewerSeat, story, diffSummary: diffSummary(storyId, story) }); }
    catch (e) { raw = { verdict: "block", blockers: [`reviewer dispatch failed: ${e?.message || e}`] }; }
    const { verdict, blockers } = validateVerdict(raw);
    const ref = landVerdict(storyId, story, verdict, blockers);
    if (verdict === "pass") { reviewRounds.delete(storyId); return { pass: true, ref }; }

    // BLOCK. Bounded rounds — like the test gate's red→green, but at story granularity.
    const round = (reviewRounds.get(storyId) || 0) + 1;
    reviewRounds.set(storyId, round);
    if (round > maxReviewRounds || !enqueueGoal) {
      try { stories.update(storyId, { status: "blocked", event: "review-blocked", ref: `${blockers.length} blocker(s) after ${round - 1} round(s)` }); }
      catch (e) { log(`[reviewqa] review block write skipped for ${storyId}: ${e?.message}`); return { pass: false }; }
      if (mintAlert) {
        try { mintAlert({ agentId: reviewerSeat, taskId: storyId, kind: "review-blocked", attempts: round, detail: `Story ${storyId}: the reviewer still blocks after ${round - 1} fix round(s). Blockers: ${blockers.slice(0, 5).join("; ")}` }); }
        catch (e) { log(`[reviewqa] review block alert skipped for ${storyId}: ${e?.message}`); }
      }
      return { pass: false, blocked: true, blockers };
    }
    // Mint per-blocker fix goals for the fixer seat, then bounce the story back to build so
    // the fixes re-enter the pipeline and the reviewer re-runs when they complete.
    const steps = blockers.map((b) => `Reviewer blocker to resolve: ${b}`);
    try { enqueueGoal({ agentId: fixSeat, tier: "sonnet", priority: "high", storyId, steps }); }
    catch (e) { log(`[reviewqa] fix goal enqueue skipped for ${storyId}: ${e?.message}`); }
    try { stories.reject(storyId, { toStage: "build", reason: `reviewer requested fixes (round ${round})` }); }
    catch (e) { log(`[reviewqa] review bounce skipped for ${storyId}: ${e?.message}`); }
    return { pass: false, bounced: true, blockers, ref };
  }

  // ── QA gate ───────────────────────────────────────────────────────────────────
  // Run e2eCmd if configured (honest skip otherwise). A configured-but-failing e2e blocks.
  async function qaGate(storyId) {
    const loaded = loadQualityConfig();
    const cfg = loaded && loaded.config;
    if (!cfg || !cfg.e2eCmd) {
      try { stories.update(storyId, { event: "qa-skipped", ref: "no e2eCmd configured" }); } catch (e) { log(`[reviewqa] qa-skip log skipped for ${storyId}: ${e?.message}`); }
      return { skipped: true };
    }
    if (!sandbox || !qaCwd) { try { stories.update(storyId, { event: "qa-skipped", ref: "no qa sandbox" }); } catch { /* */ } return { skipped: true }; }
    // FAIL CLOSED when the jail is unavailable — a CONFIGURED e2e gate must never be silently
    // skipped or run un-jailed on the host. No daemon ⇒ the story blocks with a clear alert.
    if (!(await sandbox.dockerAvailable())) {
      const ref = "sandbox unavailable — Docker daemon not reachable; e2e gate cannot run in the jail";
      try { stories.update(storyId, { status: "blocked", event: "qa-failed", ref }); } catch (e) { log(`[reviewqa] qa-unavailable write skipped for ${storyId}: ${e?.message}`); }
      if (mintAlert) { try { mintAlert({ agentId: reviewerSeat, taskId: storyId, kind: "qa-failed", attempts: 1, detail: `Story ${storyId}: ${ref}` }); } catch { /* */ } }
      return { ran: false, pass: false, blocked: true, reason: "sandbox-unavailable" };
    }
    // The validated e2e argv (allow-listed binary + SAFE_ARG + node-flag denylist) has no shell
    // metachars, so joining is a clean single string for the container's `sh -c`.
    const command = cfg.e2eCmd.join(" ");
    let res;
    try { res = await sandbox.runInSandbox(qaCwd, command, { network: false, timeoutMs: cfg.timeoutMs, callId: storyId }); }
    catch (e) { res = { stderr: String(e?.message || e), timedOut: false, exitCode: -1 }; }
    const exitCode = typeof res.exitCode === "number" ? res.exitCode : -1;
    const pass = exitCode === 0 && !res.timedOut && !res.killed && !res.diskExceeded;
    const tail = clean(`${res.stdout || ""}\n${res.stderr || ""}${res.error ? `\n${res.error}` : ""}`, 1000);
    if (pass) { try { stories.update(storyId, { event: "qa-passed", ref: "e2e green" }); } catch { /* */ } return { ran: true, pass: true }; }
    try { stories.update(storyId, { status: "blocked", event: "qa-failed", ref: tail || `e2e exit ${res.exitCode}` }); } catch (e) { log(`[reviewqa] qa-fail write skipped for ${storyId}: ${e?.message}`); }
    if (mintAlert) { try { mintAlert({ agentId: reviewerSeat, taskId: storyId, kind: "qa-failed", attempts: 1, detail: `Story ${storyId}: the e2e/QA gate failed. ${tail.slice(0, 300)}` }); } catch { /* */ } }
    return { ran: true, pass: false, blocked: true };
  }

  // ── PR stage (best-effort) ──────────────────────────────────────────────────────
  async function prStage(storyId) {
    if (!pr || typeof pr.ghStatus !== "function") { try { stories.update(storyId, { event: "pr-skipped", ref: "no pr ladder" }); } catch { /* */ } return { skipped: "no-pr" }; }
    let status;
    try { status = await pr.ghStatus(); } catch (e) { status = { authenticated: false, installed: false, reason: e?.message }; }
    if (!status || !status.authenticated) {
      try { stories.update(storyId, { event: "pr-skipped", ref: "gh-unauthed" }); } catch (e) { log(`[reviewqa] pr-skip log skipped for ${storyId}: ${e?.message}`); }
      return { skipped: "gh-unauthed" };
    }
    // gh IS authenticated — attempt to land each build seat's branch (best-effort, honestly
    // reported per pr.mjs's own mode ladder). Lightly exercised: gh is unauthenticated on the
    // reference machine (BOSS open item), so the skip path above is the proven one.
    const modes = [];
    let build;
    try { build = aggregate(storyId); } catch { build = { goals: [] }; }
    for (const g of build.goals || []) {
      for (const t of g.tasks || []) {
        if (t.status !== "done" || !t.taskId) continue;
        const paths = String(t.result || "").replace(/^applied \d+:\s*/, "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!paths.length) continue;
        try {
          const out = await pr.deliverApproved({ taskId: t.taskId, paths, title: `Story ${storyId} — ${g.seat}`, summary: "review-qa PR stage", agentId: g.seat, kind: "code" });
          modes.push(out.mode);
        } catch (e) { log(`[reviewqa] pr deliver skipped for ${t.taskId}: ${e?.message}`); }
      }
    }
    try { stories.update(storyId, { event: "pr-landed", ref: modes.join(",") || "no branches" }); } catch { /* */ }
    return { ran: true, modes };
  }

  // ── run — the whole stage ───────────────────────────────────────────────────────
  async function run(storyId) {
    const sid = String(storyId || "");
    if (!sid || inFlight.has(sid)) return { skipped: true, reason: "in flight" };
    const story = stories.getStory(sid);
    if (!story) return { skipped: true, reason: "unknown story" };
    if (story.stage !== REVIEW_QA_STAGE) return { skipped: true, reason: `story at '${story.stage}'` };
    inFlight.add(sid);
    try {
      const rev = await reviewerGate(sid, story);
      if (!rev.pass) return { stopped: "reviewer", ...rev };
      const qa = await qaGate(sid);
      if (qa.blocked) return { stopped: "qa", qa };
      const prOut = await prStage(sid);
      // All gates clear → advance into deploy-watch (stage 7).
      try { stories.advance(sid, { event: "review-qa-complete", ref: rev.ref || null }); }
      catch (e) { log(`[reviewqa] advance skipped for ${sid}: ${e?.message}`); return { error: e?.message }; }
      // S5 — kick the deploy-watch stage driver (release notes + release-accept gate). Isolated +
      // fire-and-forget: the advance already committed, so a driver fault must never un-advance.
      if (onEnterDeployWatch) {
        try { Promise.resolve(onEnterDeployWatch(sid)).catch((e) => log(`[reviewqa] deploy-watch driver rejected for ${sid}: ${e?.message}`)); }
        catch (e) { log(`[reviewqa] deploy-watch driver kick skipped for ${sid}: ${e?.message}`); }
      }
      return { advanced: true, reviewer: rev, qa, pr: prOut };
    } finally {
      inFlight.delete(sid);
    }
  }

  return { run, reviewerGate, qaGate, prStage, validateVerdict, diffSummary };
}

// Story-Pipeline S2 — the STAGE DRIVER. Pure orchestration that walks a Story through the
// early SDLC stages by dispatching each stage's agent, capturing the markdown artifact it
// produces, landing that artifact in the Knowledge Vault + a ref on the Story, and then
// either AUTO-ADVANCING (a non-gate stage) or LANDING A HUMAN GATE in the Inbox (a gate
// stage). It owns NO storage of its own and NO transport: every side effect flows through
// injected seams the runtime already ships —
//   dispatchFn   : the READ-ONLY agent dispatch (a stage agent produces a markdown doc, NEVER
//                  a code diff / worktree). Injected so tests run deterministically with no
//                  live model, exactly as engine.mjs injects its own dispatchFn.
//   stories      : the S1 story store (getStory / advance / update).
//   deliveries   : the Inbox (mintGate for a diff-less gate, listGates for idempotency,
//                  decide to resolve a question once answered).
//   vault        : shared memory (write) — the artifact's record of truth.
//
// Stage → agent (S2 scope; S3+ wire plan/build/…):
//   requirements → pm-analyst   (may raise clarify QUESTIONS → question gates; else advances)
//   design       → architect    (always a design-approval GATE the BOSS decides)
//
// GATE vs AUTO-ADVANCE: a stage auto-advances the moment its artifact lands UNLESS the stage
// is a human gate. `design` is always a gate (design-approval). `requirements` is a gate ONLY
// when the agent raises clarify questions; with no questions it advances straight into design.
//
// IDEMPOTENCY per (storyId, stage): re-entry must not double-dispatch or double-mint. The
// guard is the Inbox itself — if a pending gate for this (story, stage) already exists,
// enterStage() is a no-op. A LEGITIMATE re-run (all questions answered, or a design change
// requested) passes `rerun:true` to bypass that guard on purpose; the vault write is keyed on
// a stable per-(stage,story) id so a re-run UPDATES the one artifact instead of piling up
// near-duplicates, and the design gate re-mints on a stable slot (the prior gate is already
// decided, so it is no longer pending and the new one is not a dedupe).
//
// SECURITY (S2 — an artifact is agent-authored, i.e. UNTRUSTED, and it is fed FORWARD into a
// downstream agent's context — a prompt-injection surface):
//   • Every artifact + every clarify question is scrubbed (shared scrub) and control-char
//     stripped and CAPPED before it lands in the vault, on a Story field, or in a gate row.
//   • A gate row is diff-less and high-band; it never auto-applies and never reaches a broker.
//   • The answer path is approver-gated at the route; answer text is scrubbed + capped at rest.
//   • Errors NEVER reflect the question/answer text back (an "unknown question" is generic),
//     so a crafted id/answer cannot echo attacker content into a response.
//   • The FENCING of a prior artifact as untrusted DATA before it enters the next agent's
//     prompt lives in the server's dispatchFn (that is where a prompt is assembled); this
//     module treats dispatch output purely as data and never executes any instruction in it.

// S16 — the appliable scope, as the build seats are told it. A PURE sibling (no I/O, no
// state), so importing it does not give this module storage or transport; the seed list
// itself still arrives through the injected `deps.seedDirs` seam.
import { fileScopeHint } from "./plan-scope.mjs";

// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// The stages this phase drives, and the seat that owns each. S4+ append build gates/… here.
export const STAGE_AGENTS = Object.freeze({
  requirements: "pm-analyst",
  design: "architect",
  plan: "tech-lead", // S3 — decomposes the approved design into per-seat engine goals
});
// Which gate kind a stage lands in the Inbox (when it gates). `plan` is NOT a gate — its
// artifact is the decompose, and the story flows straight on into `build`.
const KIND_FOR_STAGE = Object.freeze({ requirements: "question", design: "design-approval" });
// Which Vault node an artifact lands in: a requirement is engineering reference (`tech`); a
// design is a decision record (`decisions`); a plan is engineering reference (`tech`).
const NODE_FOR_STAGE = Object.freeze({ requirements: "tech", design: "decisions", plan: "tech" });
const TITLE_FOR_STAGE = Object.freeze({ requirements: "Requirement spec", design: "Design", plan: "Plan" });
const VAULT_PREFIX = Object.freeze({ requirements: "req", design: "design", plan: "plan" });
// SESSION 14 — who receives the work when a stage hands it on. Derived from the ORDER of
// the pipeline, not a second hand-maintained table: `design` hands to a HUMAN gate (not a
// seat) and `plan` hands to the build seats the decompose actually chose, so both are
// absent here rather than guessed. An absent value renders nothing; a guessed one would
// render a lie.
const NEXT_SEAT = Object.freeze({ requirements: "architect" });

// S3 — the ONLY seats the decompose may spawn a build goal for. A seat outside this set is
// DROPPED, never run: the engine's task dispatch is worktree-fenced + argv (no shell), but the
// decompose is agent-authored (untrusted), so the seat a task runs as must come from this
// validated allow-list — an artifact can never smuggle a privileged/unknown seat.
const ALLOWED_PLAN_SEATS = Object.freeze(new Set(["sr-backend", "sr-frontend"]));
const MAX_STEPS_PER_GOAL = 10;  // a bounded per-seat step list — never an unbounded flood
const MAX_GOALS = 8;            // a bounded goal set per story
const MAX_STEP_TEXT = 4_000;    // matches the engine's own per-step text cap

// Caps — artifacts are documents, questions/answers are lines. All belt-and-braces on top of
// the store-level caps (a value is capped wherever it is written).
const MAX_ARTIFACT = 32_000;
const MAX_QUESTION = 2_000;
const MAX_ANSWER = 4_000;
const MAX_QUESTIONS = 10;      // a bounded clarify round — never an unbounded question flood
const MAX_GATE_BODY = 4_000;   // the design-approval gate carries a preview, the full doc is in the vault

// Fold the Story's answers JSON into a stable shape: { questions: [{ id, q, a|null }] }.
function parseAnswers(raw) {
  if (raw === null || raw === undefined || raw === "") return { questions: [] };
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    const questions = Array.isArray(o?.questions) ? o.questions : [];
    return { questions };
  } catch { return { questions: [] }; }
}

// A slug-safe, stable vault record id for a (stage, story) — so a re-run UPSERTS one record.
function vaultId(stage, storyId) {
  const s = String(storyId || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56);
  return `${VAULT_PREFIX[stage] || stage}-${s}`.replace(/^-+|-+$/g, "").slice(0, 64) || VAULT_PREFIX[stage] || stage;
}

export function createPipeline(deps = {}) {
  const stories = deps.stories;
  const deliveries = deps.deliveries;
  const vault = deps.vault;
  const dispatchFn = deps.dispatchFn;
  if (!stories || !deliveries || !vault) throw new Error("createPipeline: stories, deliveries and vault are required");
  if (typeof dispatchFn !== "function") throw new Error("createPipeline: dispatchFn is required");
  const scrub = typeof deps.scrub === "function" ? deps.scrub : (s) => s;
  const vaultVenture = deps.vaultVenture || "waahyu";
  const log = typeof deps.log === "function" ? deps.log : () => {};
  // S3 — the engine's goal enqueuer (engine.enqueueGoal). Optional: when it is not wired the
  // `plan` stage is a clean no-op (the raw S1/S2 harness has no engine), so pre-S3 callers and
  // tests are unaffected. Present ⇒ the decompose spawns per-seat build goals tagged storyId.
  const enqueueGoal = typeof deps.enqueueGoal === "function" ? deps.enqueueGoal : null;
  // S16 — the file-scope header stamped on step 0 of each build goal, derived ONCE from the
  // single source of truth (guards.SEED_DIRS, injected by server.mjs). It is the same for
  // every seat because this header states the REPO-WIDE appliable roots. (Phase 7 gave
  // guards.applyAllowed an optional per-seat writeScope that narrows a `role:"worker"` seat
  // BELOW these roots. That does not change this header: SEED_DIRS remains the outer bound,
  // and a header quoting the superset is safe — the broker still refuses anything outside the
  // seat's own scope. It was previously true that applyAllowed took no seat; it no longer is.)
  // The value it replaces was invented per seat and named
  // `services/**`, a directory of a different repo: live, a decompose step that correctly
  // said "CREATE new file src/lib/buildHealth.ts" was prefixed with a header declaring the
  // seat's scope to be `services/**`, and the seat was blamed for the wandering that
  // followed. No seed list ⇒ NO header, never a literal fallback (see plan-scope.mjs).
  const fileScope = fileScopeHint(deps.seedDirs);

  // Re-entrancy guard for the async decompose window: enterStage('plan') awaits a dispatch, so
  // a second entry could slip in before the first advances the story off `plan`. A per-story
  // in-flight flag makes the decompose spawn goals exactly once per story.
  const decomposing = new Set();

  const clean = (s, cap) => scrub(String(s ?? "").replace(CTRL, " ")).trim().slice(0, cap);

  // Validate an agent-authored decompose into a safe, bounded [{seat, steps[]}] set. A seat
  // outside ALLOWED_PLAN_SEATS is dropped; steps are scrubbed + control-stripped + capped;
  // empty steps/goals are discarded; the whole set is bounded (MAX_GOALS × MAX_STEPS_PER_GOAL).
  function validatePlan(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
      if (out.length >= MAX_GOALS) break;
      const seat = String(entry?.seat || "").trim();
      if (!ALLOWED_PLAN_SEATS.has(seat)) continue;
      const steps = (Array.isArray(entry?.steps) ? entry.steps : [])
        .map((s) => clean(s, MAX_STEP_TEXT))
        .filter(Boolean)
        .slice(0, MAX_STEPS_PER_GOAL);
      if (!steps.length) continue;
      out.push({ seat, steps });
    }
    return out;
  }

  // Land a stage's artifact in the Vault (idempotent upsert per stage+story). Returns a
  // `vault:<recordId>` ref, or null if the write was refused (which never blocks the stage —
  // the pipeline still gates/advances; the artifact ref is a pointer, not the gate itself).
  function landArtifact(stage, story, text) {
    const id = vaultId(stage, story.id);
    const rec = vault.write({
      id,
      venture: vaultVenture,
      node: NODE_FOR_STAGE[stage],
      title: `${TITLE_FOR_STAGE[stage]}: ${story.title}`.slice(0, 180),
      author: STAGE_AGENTS[stage],
      sourceRun: story.id,
      body: text,
    });
    if (rec && rec.error) { log(`[pipeline] vault write refused for ${story.id}/${stage}: ${rec.error}`); return null; }
    return rec && rec.id ? `vault:${rec.id}` : null;
  }

  // ── failStage ─────────────────────────────────────────────────────────────────
  // A stage agent could not produce an artifact. Park the story where it stands and make
  // the failure VISIBLE. Three rules, each learned the hard way in this program:
  //   • NEVER advance and NEVER roll back. The blast radius of a dead engine is ONE
  //     stage; an approved requirement spec survives a failed design.
  //   • The story goes `blocked`, not `active`. An `active` story nothing is working on
  //     is exactly the silent non-event that hid the three-day outage.
  //   • ONE Delivery per (story, stage). mintFailure dedupes on (taskId, agentId) while a
  //     pending row exists, so a stage retried on a timer cannot mint a row per retry.
  // The row is diff-less by construction (mintFailure hard-codes diffFiles=0 /
  // changedPaths='[]'), so Law 3 holds: approving it can carry no paths.
  // Every side effect is isolated — a bookkeeping fault must not replace a clear failure
  // with an obscure one.
  function failStage(story, stage, agentId, reason) {
    const storyId = story.id;
    try {
      stories.update(storyId, { status: "blocked", event: `${stage}-failed`, ref: reason.slice(0, 200), byAgent: agentId });
    } catch (e) { log(`[pipeline] could not park ${storyId} at ${stage}: ${e?.message}`); }
    let alert = null;
    try {
      alert = deliveries.mintFailure({
        agentId, taskId: `${storyId}-${stage}`, kind: "stage-dispatch", attempts: 1, detail: reason,
      });
    } catch (e) { log(`[pipeline] could not surface ${storyId}/${stage} failure: ${e?.message}`); }
    log(`[pipeline] ${stage} failed for ${storyId}: ${reason}`);
    return { failed: true, stage, error: reason, alert: alert ? alert.id : null };
  }

  // ── enterStage ────────────────────────────────────────────────────────────────
  // Run the stage's agent, capture its artifact, gate-or-advance. Returns a structured
  // result (never throws for a control-flow verdict; a store error on an illegal transition
  // still propagates as an exception the caller logs).
  async function enterStage(storyId, stage, opts = {}) {
    const rerun = !!opts.rerun;
    const feedback = opts.feedback ? clean(opts.feedback, MAX_QUESTION) : null;
    const story = stories.getStory(storyId);
    if (!story) return { code: 404, error: "unknown story" };
    if (story.stage !== stage) return { skipped: true, reason: `story is at '${story.stage}', not '${stage}'` };
    const agentId = STAGE_AGENTS[stage];
    if (!agentId) return { skipped: true, reason: `no pipeline agent for stage '${stage}'` };

    // S3 — the `plan` stage needs the engine's goal enqueuer. Absent (raw S1/S2 harness) ⇒
    // a clean no-op, so a story parked at `plan` simply waits (pre-S3 behaviour).
    if (stage === "plan" && !enqueueGoal) return { skipped: true, reason: "no enqueueGoal wired" };

    // Idempotency: an open gate for this (story, GATE stage) means the stage already ran. Do
    // NOT re-dispatch or re-mint — a re-run is only ever a DELIBERATE `rerun:true`. `plan` is
    // NOT a gate stage; its re-entrancy is guarded by `decomposing` + the post-decompose
    // stage advance instead (an open-gate check would false-match on ANY pending story gate).
    if (!rerun && KIND_FOR_STAGE[stage]) {
      const open = deliveries.listGates(storyId, KIND_FOR_STAGE[stage]);
      if (open.length) return { deduped: true, deliveries: open };
    }
    if (stage === "plan" && decomposing.has(storyId)) return { deduped: true, reason: "decompose in flight" };
    if (stage === "plan") decomposing.add(storyId); // cleared in the plan branch / the catch below

    const answers = parseAnswers(story.answers);
    let dispatched;
    try {
      dispatched = await dispatchFn({ storyId, stage, agentId, story, answers, feedback });
    } catch (e) {
      if (stage === "plan") decomposing.delete(storyId);
      return { code: 502, error: `dispatch failed: ${scrub(String(e?.message || e)).slice(0, 200)}` };
    }
    const text = clean(dispatched && dispatched.text, MAX_ARTIFACT);
    // SESSION 14 — a FAILED dispatch must NEVER become an artifact.
    //
    // Observed live: with the Claude CLI's OAuth expired, `claude -p` writes its auth
    // error to stdout as the `result` string, sets is_error:true and EXITS 0. The
    // dispatch resolved with that text, and this function — which knew only how to
    // handle a THROWN dispatch, never a failed one — wrote "Failed to authenticate.
    // API Error: 401 ..." into the Vault as the requirement spec, stamped it on
    // story.spec, auto-advanced, and minted a design-approval GATE asking a human to
    // approve an auth error. A dead engine looked exactly like a working one.
    //
    // `ok === false` is the explicit signal; an EMPTY artifact is the implicit one (an
    // empty document is not a document). `ok` ABSENT is success — every historical
    // caller returns { text, questions } with no such field, and making an absent value
    // mean "refuse" is precisely the mistake that cost 17 tests in session 13b.
    const dispatchFailed = (dispatched && dispatched.ok === false) || !text;
    if (dispatchFailed) {
      if (stage === "plan") decomposing.delete(storyId);
      const reason = clean(
        (dispatched && dispatched.error) || (text ? "dispatch failed" : "the agent produced an empty artifact"),
        MAX_QUESTION,
      );
      return failStage(story, stage, agentId, reason);
    }
    const rawQuestions = Array.isArray(dispatched && dispatched.questions) ? dispatched.questions : [];
    const ref = landArtifact(stage, story, text);

    if (stage === "requirements") {
      const questions = rawQuestions
        .map((q) => clean(q, MAX_QUESTION))
        .filter(Boolean)
        .slice(0, MAX_QUESTIONS);
      if (questions.length) {
        // Clarify round — one question gate per question, story parked `waiting-you`, no advance.
        const qrecords = [];
        for (let i = 0; i < questions.length; i++) {
          const g = deliveries.mintGate({
            kind: "question", agentId, storyId, slot: `${storyId}-q${i}`,
            title: `Clarify: ${questions[i].slice(0, 80)}`, body: questions[i],
          });
          qrecords.push({ id: g.id, q: questions[i], a: null });
        }
        stories.update(storyId, {
          status: "waiting-you", spec: ref, answers: JSON.stringify({ questions: qrecords }),
          event: "requirements-questions", ref, byAgent: agentId,
        });
        return { status: "waiting-you", questions: qrecords, spec: ref };
      }
      // No open questions — the spec is done. Advance into design and land its gate.
      stories.update(storyId, {
        status: "active", spec: ref, answers: JSON.stringify({ questions: answers.questions }),
        event: "requirements-drafted", ref, byAgent: agentId,
      });
      // requirements → design, naming both ends of the handoff.
      stories.advance(storyId, { event: "advance", ref, byAgent: agentId, toAgent: NEXT_SEAT[stage] });
      return await enterStage(storyId, "design");
    }

    if (stage === "plan") {
      // S3 — the tech-lead decompose. Validate the agent-authored plan into a bounded,
      // allow-listed [{seat, steps[]}] set, land the plan artifact (vault node `tech`) + a
      // `plan-drafted` log row, advance the story `plan → build`, then spawn ONE engine goal
      // per seat (parallel — the engine handles cross-agent concurrency), each tagged storyId
      // so the Build panel can find it. The plan artifact lives in the vault + story_log
      // (event `plan-drafted`, ref → vault record); there is NO dedicated story column (a
      // `plan_ref` column would be a migration, and the Build panel reads goals from the
      // engine, not from a story field — so an additive-only S3 needs none).
      try {
        const planGoals = validatePlan(dispatched && dispatched.plan);
        if (!planGoals.length) {
          // A degenerate decompose (no valid goals): do NOT advance into a dead build. Leave
          // the story at `plan` for the BOSS, log it, and surface nothing silently.
          stories.update(storyId, { status: "active", event: "plan-empty", ref, byAgent: agentId });
          log(`[pipeline] decompose produced no valid goals for ${storyId} — parked at plan`);
          return { status: "plan", goals: [], plan: ref, warning: "no valid goals" };
        }
        stories.update(storyId, { status: "active", event: "plan-drafted", ref, byAgent: agentId });
        // plan → build. NO toAgent: the decompose spawns one goal PER SEAT, so "who picks
        // it up" is the goal set (real data the Build panel already holds), not one name.
        stories.advance(storyId, { event: "plan-drafted", ref, byAgent: agentId }); // plan → build
        const spawned = [];
        for (const g of planGoals) {
          const withScope = fileScope ? g.steps.map((s, i) => (i === 0 ? `${fileScope} ${s}` : s)) : g.steps;
          const r = enqueueGoal({ agentId: g.seat, tier: "sonnet", priority: "normal", storyId, steps: withScope });
          if (r && r.goalId) spawned.push({ goalId: r.goalId, seat: g.seat, firstTaskId: r.firstTaskId });
          else log(`[pipeline] enqueueGoal failed for ${storyId}/${g.seat}: ${r?.error || "unknown"}`);
        }
        return { status: "build", goals: spawned, plan: ref };
      } finally {
        decomposing.delete(storyId);
      }
    }

    if (stage === "design") {
      // Always a human gate — mint design-approval, park `waiting-you`, no advance. The gate
      // carries a preview; the full design doc is the vault record `ref` points at.
      const gate = deliveries.mintGate({
        kind: "design-approval", agentId, storyId, slot: `${storyId}-design`,
        title: `Design approval: ${story.title}`.slice(0, 180), body: text.slice(0, MAX_GATE_BODY),
      });
      stories.update(storyId, { status: "waiting-you", designRef: ref, event: "design-drafted", ref, byAgent: agentId });
      return { status: "waiting-you", gate, designRef: ref };
    }

    return { skipped: true, reason: `stage '${stage}' has no S2 handler` };
  }

  // Convenience the runtime calls right after a Story advances into a new stage: kick the
  // stage's agent if the pipeline handles it. Idempotent (enterStage's own guard).
  function onStageEntered(storyId, stage) {
    if (!STAGE_AGENTS[stage]) return Promise.resolve({ skipped: true, reason: `no pipeline stage '${stage}'` });
    return enterStage(storyId, stage);
  }

  // ── answerQuestion ──────────────────────────────────────────────────────────
  // POST /runtime/stories/:id/answer {deliveryId, answer}. Store the answer on the Story,
  // resolve that question gate, and — once EVERY question is answered — re-run requirements
  // with the answers fed back (which then produces the spec and advances into design).
  async function answerQuestion(storyId, input = {}) {
    const story = stories.getStory(storyId);
    if (!story) return { code: 404, error: "unknown story" };
    if (story.stage !== "requirements" || story.status !== "waiting-you") {
      return { code: 409, error: "this story has no clarify question awaiting an answer" };
    }
    const deliveryId = String(input.deliveryId || "");
    const state = parseAnswers(story.answers);
    const q = state.questions.find((x) => x && x.id === deliveryId && (x.a === null || x.a === undefined));
    // Generic 404 — never reflect the (attacker-supplied) id or the question text back.
    if (!q) return { code: 404, error: "unknown or already-answered question" };
    const answer = clean(input.answer, MAX_ANSWER);
    if (!answer) return { code: 400, error: "answer required" };

    q.a = answer;
    stories.update(storyId, { answers: JSON.stringify(state), event: "answer", ref: deliveryId });
    // Resolve the gate — the decide() gate-branch flips it + emits, runs NO apply/rerun.
    try { await deliveries.decide(deliveryId, "approve", { by: input.by || "BOSS" }); }
    catch (e) { log(`[pipeline] question gate resolve hiccup for ${deliveryId}: ${e?.message}`); }

    const remaining = state.questions.filter((x) => x && (x.a === null || x.a === undefined)).length;
    if (remaining > 0) return { status: "waiting-you", remaining };

    // Every question answered — re-run requirements WITH the answers, then it advances itself.
    stories.update(storyId, { status: "active", event: "answers-complete" });
    const rerun = await enterStage(storyId, "requirements", { rerun: true });
    return { status: "active", remaining: 0, rerun };
  }

  // ── onGateDecided ───────────────────────────────────────────────────────────
  // The runtime routes EVERY committed gate decision here (from deliveries.onDecided). A
  // design-approval APPROVE advances the story into plan; a request-changes / reject re-runs
  // design with the feedback appended and lands a fresh gate. A question decision is driven by
  // answerQuestion, so it is a no-op here. The APPROVE advance is intentionally SYNCHRONOUS
  // (no await precedes it) so the story is already at `plan` the instant decide() returns.
  async function onGateDecided(row, info = {}) {
    if (!row || row.kind !== "design-approval") return; // questions flow through answerQuestion
    const storyId = row.storyId;
    if (!storyId) return;
    if (info.status === "approved") {
      // The advance is SYNCHRONOUS (no await precedes it) so the story is at `plan` the instant
      // decide() returns. The S3 plan decompose then runs — isolated, so a decompose fault can
      // never un-approve the design.
      try { stories.advance(storyId, { event: "design-approved", ref: row.id }); } // design → plan
      catch (e) { log(`[pipeline] design approve advance skipped for ${storyId}: ${e?.message}`); return; }
      try { await enterStage(storyId, "plan"); } // S3 — tech-lead decompose → build goals
      catch (e) { log(`[pipeline] plan decompose skipped for ${storyId}: ${e?.message}`); }
      return;
    }
    // changes_requested | rejected — re-run design with the feedback appended, fresh gate.
    try { await enterStage(storyId, "design", { rerun: true, feedback: info.feedback || "" }); }
    catch (e) { log(`[pipeline] design re-run skipped for ${storyId}: ${e?.message}`); }
  }

  return { enterStage, onStageEntered, answerQuestion, onGateDecided, STAGE_AGENTS };
}
